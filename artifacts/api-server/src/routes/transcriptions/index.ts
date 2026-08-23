import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql, count } from "drizzle-orm";
import { db, reconstructionJobsTable, transcriptionsTable } from "@workspace/db";
import {
  GetTranscriptionParams,
  GetTranscriptionResponse,
  ListTranscriptionsResponseItem,
  DeleteTranscriptionParams,
  GetTranscriptionStatsResponse,
  TransformTranscriptionParams,
  TransformTranscriptionBody,
  TransformTranscriptionResponse,
  ImportTranscriptionTextBody,
  CreateCoherenceJobParams,
  CreateCoherenceJobBody,
  ListCoherenceJobsParams,
  ListCoherenceJobsResponse,
  GetCoherenceJobParams,
  GetCoherenceJobResponse,
  GetCombinedTranscriptParams,
  GetCombinedTranscriptResponse,
} from "@workspace/api-zod";
import { logger } from "../../lib/logger";
import { transformTranscript } from "../../lib/llm";
import { ObjectStorageService, ObjectNotFoundError } from "../../lib/objectStorage";
import {
  transcribeAudioFile,
  transcribeVerifiedAudioFile,
} from "../../lib/transcription";
import { countWords, createPersistedCoherenceJob, enqueueCoherenceJob } from "../../lib/coherenceEngine";

const router: IRouter = Router();

const objectStorage = new ObjectStorageService();
const MAX_AUDIO_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TRANSCRIPT_FILE_BYTES = 256 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000;

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, callback) => {
      callback(null, `transcriber-upload-${randomUUID()}`);
    },
  }),
  limits: { fileSize: MAX_AUDIO_FILE_BYTES },
});

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, callback) => {
      callback(null, `transcriber-chunk-${randomUUID()}`);
    },
  }),
  limits: { fileSize: UPLOAD_CHUNK_BYTES + 64 * 1024 },
});

const uploadSingleAudio: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "Audio files must be smaller than 1 GB." });
      return;
    }
    if (err) {
      req.log.error({ err }, "Audio upload failed");
      res.status(400).json({ error: "The audio file could not be uploaded." });
      return;
    }
    next();
  });
};

const uploadSingleChunk: RequestHandler = (req, res, next) => {
  chunkUpload.single("chunk")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "Upload chunk is too large." });
      return;
    }
    if (err) {
      req.log.error({ err }, "Audio chunk upload failed");
      res.status(400).json({ error: "The audio chunk could not be uploaded." });
      return;
    }
    next();
  });
};

type DiskAudioUpload = {
  path: string;
  originalname: string;
  size: number;
  mimetype: string;
};

type UploadSession = {
  id: string;
  path: string;
  filename: string;
  mimetype: string;
  totalSize: number;
  receivedBytes: number;
  nextChunkIndex: number;
  updatedAt: number;
  processingMode?: "segmented" | "verified";
  knownTerms?: string | null;
  batchId?: string | null;
};

const uploadSessions = new Map<string, UploadSession>();
const textUploadSessions = new Map<string, UploadSession>();

async function removeUploadSession(session: UploadSession): Promise<void> {
  uploadSessions.delete(session.id);
  textUploadSessions.delete(session.id);
  await unlink(session.path).catch(() => {});
}

const uploadSessionCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - UPLOAD_SESSION_TTL_MS;
  for (const session of uploadSessions.values()) {
    if (session.updatedAt < cutoff) {
      void removeUploadSession(session);
    }
  }
  for (const session of textUploadSessions.values()) {
    if (session.updatedAt < cutoff) {
      void removeUploadSession(session);
    }
  }
}, 15 * 60 * 1000);
uploadSessionCleanupTimer.unref();

type AudioProcessingOptions = {
  processingMode: "segmented" | "verified";
  knownTerms: string | null;
  batchId: string | null;
};

function readAudioProcessingOptions(
  body: Record<string, unknown> | undefined,
): AudioProcessingOptions {
  const processingMode = body?.processingMode ?? "segmented";
  if (processingMode !== "segmented" && processingMode !== "verified") {
    throw new Error("processingMode must be either segmented or verified.");
  }
  const knownTerms =
    typeof body?.knownTerms === "string" && body.knownTerms.trim()
      ? body.knownTerms.trim()
      : null;
  const batchId =
    typeof body?.batchId === "string" && body.batchId.trim()
      ? body.batchId.trim()
      : null;
  if (processingMode === "verified" && !batchId) {
    throw new Error("Verified transcription requires a session ID.");
  }
  return { processingMode, knownTerms, batchId };
}

async function processDiskAudio(
  recordId: number,
  file: DiskAudioUpload,
  options: AudioProcessingOptions,
): Promise<void> {
  const storageTask = (async (): Promise<string | null> => {
    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const stream = createReadStream(file.path);
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        body: stream as unknown as RequestInit["body"],
        headers: { "Content-Type": file.mimetype || "application/octet-stream" },
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      if (!putRes.ok) {
        throw new Error(`Storage upload failed with status ${putRes.status}`);
      }
      return objectStorage.normalizeObjectEntityPath(uploadURL);
    } catch (err) {
      logger.error({ err, id: recordId }, "Failed to persist audio to object storage");
      return null;
    }
  })();

  const transcriptionTask =
    options.processingMode === "verified"
      ? transcribeVerifiedAudioFile(file.path, options.knownTerms)
      : transcribeAudioFile(file.path, {
          onSegmentCompleted: async ({
            segmentNumber,
            totalSegments,
            combinedText,
          }) => {
            await db
              .update(transcriptionsTable)
              .set({ text: combinedText })
              .where(eq(transcriptionsTable.id, recordId));
            logger.info(
              { id: recordId, segmentNumber, totalSegments },
              "Published completed transcription interval",
            );
          },
        });

  try {
    const [storageResult, transcriptionResult] = await Promise.allSettled([
      storageTask,
      transcriptionTask,
    ]);
    const audioPath =
      storageResult.status === "fulfilled" ? storageResult.value : null;

    const [current] = await db
      .select({ id: transcriptionsTable.id })
      .from(transcriptionsTable)
      .where(eq(transcriptionsTable.id, recordId));

    if (!current) {
      if (audioPath) {
        try {
          const orphan = await objectStorage.getObjectEntityFile(audioPath);
          await orphan.delete();
        } catch (cleanupErr) {
          if (!(cleanupErr instanceof ObjectNotFoundError)) {
            logger.error(
              { err: cleanupErr, id: recordId },
              "Failed to remove audio for a deleted transcription",
            );
          }
        }
      }
      return;
    }

    if (transcriptionResult.status === "fulfilled") {
      if (options.processingMode === "verified") {
        const result = transcriptionResult.value;
        if (typeof result === "string") {
          throw new Error("Verified transcription returned an invalid result.");
        }
        const errorMessage = result.passed
          ? null
          : `Verification failed: word-count variance ${result.variancePercent.toFixed(2)}% exceeds 1.0%.`;
        await db
          .update(transcriptionsTable)
          .set({
            text: result.passed ? result.selectedText : "",
            status: result.passed ? "completed" : "failed",
            errorMessage,
            audioPath,
            verificationStatus: result.passed ? "passed" : "failed",
            verificationRunA: result.runA,
            verificationRunB: result.runB,
            verificationWordCountA: result.wordCountA,
            verificationWordCountB: result.wordCountB,
            verificationVarianceBps: result.varianceBps,
          })
          .where(eq(transcriptionsTable.id, recordId));
        return;
      }
      if (typeof transcriptionResult.value !== "string") {
        throw new Error("Segmented transcription returned an invalid result.");
      }
      await db
        .update(transcriptionsTable)
        .set({
          text: transcriptionResult.value,
          status: "completed",
          errorMessage: null,
          audioPath,
        })
        .where(eq(transcriptionsTable.id, recordId));
    } else {
      logger.error(
        { err: transcriptionResult.reason, id: recordId },
        "Transcription failed",
      );
      const errorMessage =
        transcriptionResult.reason instanceof Error
          ? transcriptionResult.reason.message
          : "Unknown error";
      await db
        .update(transcriptionsTable)
        .set({
          status: "failed",
          errorMessage,
          audioPath,
          ...(options.processingMode === "verified"
            ? { verificationStatus: "failed" }
            : {}),
        })
        .where(eq(transcriptionsTable.id, recordId));
    }
  } finally {
    await unlink(file.path).catch(() => {});
  }
}

async function createTranscriptionFromDisk(
  file: DiskAudioUpload,
  options: AudioProcessingOptions,
) {
  try {
    const record = await db.transaction(async (tx) => {
      let batchPosition: number | null = null;
      if (options.processingMode === "verified" && options.batchId) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${options.batchId}))`,
        );
        const [batchState] = await tx
          .select({
            processingCount: sql<number>`count(*) filter (
              where ${transcriptionsTable.processingMode} = 'verified'
                and ${transcriptionsTable.status} = 'processing'
            )`,
            maximumPosition: sql<number>`coalesce(max(${transcriptionsTable.batchPosition}), 0)`,
          })
          .from(transcriptionsTable)
          .where(eq(transcriptionsTable.batchId, options.batchId));
        if (Number(batchState?.processingCount ?? 0) > 0) {
          throw new Error(
            "A verified recording is already processing in this batch.",
          );
        }
        batchPosition = Number(batchState?.maximumPosition ?? 0) + 1;
      }

      const [created] = await tx
        .insert(transcriptionsTable)
        .values({
          filename: file.originalname,
          fileSize: file.size,
          status: "processing",
          text: "",
          audioPath: null,
          processingMode: options.processingMode,
          verificationStatus:
            options.processingMode === "verified" ? "pending" : null,
          knownTerms: options.knownTerms,
          batchId: options.batchId,
          batchPosition,
        })
        .returning();
      return created;
    });

    void processDiskAudio(record.id, file, options).catch((err) => {
      logger.error({ err, id: record.id }, "Background transcription processing failed");
    });
    return record;
  } catch (err) {
    await unlink(file.path).catch(() => {});
    throw err;
  }
}

router.get("/transcriptions", async (_req, res): Promise<void> => {
  const transcriptions = await db
    .select()
    .from(transcriptionsTable)
    .orderBy(sql`${transcriptionsTable.createdAt} DESC`);

  const parsed = transcriptions.map((t) => ListTranscriptionsResponseItem.parse(t));
  res.json(parsed);
});

router.post("/transcriptions", uploadSingleAudio, async (req, res): Promise<void> => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  try {
    const options = readAudioProcessingOptions(req.body);
    const record = await createTranscriptionFromDisk(file, options);
    res.status(201).json(GetTranscriptionResponse.parse(record));
  } catch (err) {
    await unlink(file.path).catch(() => {});
    const message = err instanceof Error ? err.message : "Invalid upload options.";
    res.status(message.includes("already processing") ? 409 : 400).json({ error: message });
  }
});

router.post("/transcriptions/upload-sessions", async (req, res): Promise<void> => {
  const filename =
    typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
  const mimetype =
    typeof req.body?.mimetype === "string"
      ? req.body.mimetype.trim()
      : "application/octet-stream";
  const totalSize = Number(req.body?.fileSize);
  let options: AudioProcessingOptions;
  try {
    options = readAudioProcessingOptions(req.body);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Invalid upload options.",
    });
    return;
  }

  if (!filename || !Number.isInteger(totalSize) || totalSize <= 0) {
    res.status(400).json({ error: "Filename and a positive file size are required." });
    return;
  }
  if (totalSize > MAX_AUDIO_FILE_BYTES) {
    res.status(413).json({ error: "Audio files must be smaller than 1 GB." });
    return;
  }
  if (
    !mimetype.startsWith("audio/") &&
    !filename.match(/\.(mp3|wav|m4a|ogg|webm)$/i)
  ) {
    res.status(400).json({ error: "Unsupported audio file type." });
    return;
  }

  const id = randomUUID();
  const session: UploadSession = {
    id,
    path: join(tmpdir(), `transcriber-session-${id}`),
    filename,
    mimetype,
    totalSize,
    receivedBytes: 0,
    nextChunkIndex: 0,
    updatedAt: Date.now(),
    ...options,
  };
  uploadSessions.set(id, session);
  try {
    if (
      options.processingMode === "verified" &&
      options.batchId &&
      [...uploadSessions.values()].some(
        (activeSession) =>
          activeSession.id !== id &&
          activeSession.processingMode === "verified" &&
          activeSession.batchId === options.batchId,
      )
    ) {
      uploadSessions.delete(id);
      res.status(409).json({
        error: "A verified recording is already uploading in this batch.",
      });
      return;
    }

    if (options.processingMode === "verified" && options.batchId) {
      const [activeRecord] = await db
        .select({ id: transcriptionsTable.id })
        .from(transcriptionsTable)
        .where(
          and(
            eq(transcriptionsTable.processingMode, "verified"),
            eq(transcriptionsTable.batchId, options.batchId),
            eq(transcriptionsTable.status, "processing"),
          ),
        )
        .limit(1);
      if (activeRecord) {
        uploadSessions.delete(id);
        res.status(409).json({
          error: "A verified recording is already processing in this batch.",
        });
        return;
      }
    }

    await writeFile(session.path, "");
  } catch (err) {
    uploadSessions.delete(id);
    await unlink(session.path).catch(() => {});
    throw err;
  }

  res.status(201).json({
    id,
    chunkSize: UPLOAD_CHUNK_BYTES,
    receivedBytes: 0,
    nextChunkIndex: 0,
  });
});

router.post(
  "/transcriptions/upload-sessions/:sessionId/chunks/:chunkIndex",
  uploadSingleChunk,
  async (req, res): Promise<void> => {
    const chunk = req.file;
    const session = uploadSessions.get(String(req.params.sessionId));
    const chunkIndex = Number(req.params.chunkIndex);

    if (!chunk) {
      res.status(400).json({ error: "No upload chunk provided." });
      return;
    }
    if (!session) {
      await unlink(chunk.path).catch(() => {});
      res.status(404).json({ error: "Upload session expired. Please retry the upload." });
      return;
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      await unlink(chunk.path).catch(() => {});
      res.status(400).json({ error: "Invalid upload chunk number." });
      return;
    }
    if (chunkIndex < session.nextChunkIndex) {
      await unlink(chunk.path).catch(() => {});
      res.json({
        receivedBytes: session.receivedBytes,
        nextChunkIndex: session.nextChunkIndex,
      });
      return;
    }
    if (chunkIndex !== session.nextChunkIndex) {
      await unlink(chunk.path).catch(() => {});
      res.status(409).json({
        error: `Expected chunk ${session.nextChunkIndex}.`,
        nextChunkIndex: session.nextChunkIndex,
      });
      return;
    }

    const expectedSize = Math.min(
      UPLOAD_CHUNK_BYTES,
      session.totalSize - session.receivedBytes,
    );
    if (chunk.size !== expectedSize) {
      await unlink(chunk.path).catch(() => {});
      res.status(400).json({
        error: `Invalid chunk size. Expected ${expectedSize} bytes.`,
      });
      return;
    }

    try {
      await pipeline(
        createReadStream(chunk.path),
        createWriteStream(session.path, { flags: "a" }),
      );
    } finally {
      await unlink(chunk.path).catch(() => {});
    }

    session.receivedBytes += chunk.size;
    session.nextChunkIndex += 1;
    session.updatedAt = Date.now();

    res.json({
      receivedBytes: session.receivedBytes,
      nextChunkIndex: session.nextChunkIndex,
    });
  },
);

router.post(
  "/transcriptions/upload-sessions/:sessionId/complete",
  async (req, res): Promise<void> => {
    const session = uploadSessions.get(String(req.params.sessionId));
    if (!session) {
      res.status(404).json({ error: "Upload session expired. Please retry the upload." });
      return;
    }
    if (session.receivedBytes !== session.totalSize) {
      res.status(409).json({
        error: `Upload is incomplete: ${session.receivedBytes} of ${session.totalSize} bytes received.`,
      });
      return;
    }

    try {
      const record = await createTranscriptionFromDisk(
        {
          path: session.path,
          originalname: session.filename,
          size: session.totalSize,
          mimetype: session.mimetype,
        },
        {
          processingMode: session.processingMode ?? "segmented",
          knownTerms: session.knownTerms ?? null,
          batchId: session.batchId ?? null,
        },
      );
      res.status(201).json(GetTranscriptionResponse.parse(record));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload could not be completed.";
      res.status(message.includes("already processing") ? 409 : 400).json({ error: message });
    } finally {
      uploadSessions.delete(session.id);
    }
  },
);

router.get(
  "/transcription-batches/:batchId/combined",
  async (req, res): Promise<void> => {
    const params = GetCombinedTranscriptParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const recordings = await db
      .select()
      .from(transcriptionsTable)
      .where(
        and(
          eq(transcriptionsTable.batchId, params.data.batchId),
          eq(transcriptionsTable.processingMode, "verified"),
          eq(transcriptionsTable.status, "completed"),
          eq(transcriptionsTable.verificationStatus, "passed"),
        ),
      )
      .orderBy(asc(transcriptionsTable.batchPosition));
    if (recordings.length === 0) {
      res.status(404).json({
        error: "No completed, passed verified recordings exist in this batch.",
      });
      return;
    }
    const text = recordings
      .map(
        (recording, index) =>
          `=== RECORDING ${index + 1}: ${recording.filename} ===\n${recording.text}`,
      )
      .join("\n\n");
    const totalWordCount = recordings.reduce(
      (total, recording) =>
        total +
        Math.max(
          recording.verificationWordCountA ?? 0,
          recording.verificationWordCountB ?? 0,
        ),
      0,
    );
    res.json(
      GetCombinedTranscriptResponse.parse({
        filename: `${params.data.batchId}-combined.txt`,
        text,
        recordingCount: recordings.length,
        totalWordCount,
      }),
    );
  },
);

router.delete(
  "/transcriptions/upload-sessions/:sessionId",
  async (req, res): Promise<void> => {
    const session = uploadSessions.get(String(req.params.sessionId));
    if (session) {
      await removeUploadSession(session);
    }
    res.status(204).end();
  },
);

router.post(
  "/transcriptions/text-upload-sessions",
  async (req, res): Promise<void> => {
    const filename =
      typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
    const totalSize = Number(req.body?.fileSize);

    if (!filename || !Number.isInteger(totalSize) || totalSize <= 0) {
      res
        .status(400)
        .json({ error: "Filename and a positive transcript size are required." });
      return;
    }
    if (totalSize > MAX_TRANSCRIPT_FILE_BYTES) {
      res.status(413).json({
        error: "Transcript files must be smaller than 256 MB.",
      });
      return;
    }

    const id = randomUUID();
    const session: UploadSession = {
      id,
      path: join(tmpdir(), `transcript-text-session-${id}`),
      filename,
      mimetype: "text/plain",
      totalSize,
      receivedBytes: 0,
      nextChunkIndex: 0,
      updatedAt: Date.now(),
    };
    await writeFile(session.path, "");
    textUploadSessions.set(id, session);

    res.status(201).json({
      id,
      chunkSize: UPLOAD_CHUNK_BYTES,
      receivedBytes: 0,
      nextChunkIndex: 0,
    });
  },
);

router.post(
  "/transcriptions/text-upload-sessions/:sessionId/chunks/:chunkIndex",
  uploadSingleChunk,
  async (req, res): Promise<void> => {
    const chunk = req.file;
    const session = textUploadSessions.get(String(req.params.sessionId));
    const chunkIndex = Number(req.params.chunkIndex);

    if (!chunk) {
      res.status(400).json({ error: "No transcript chunk provided." });
      return;
    }
    if (!session) {
      await unlink(chunk.path).catch(() => {});
      res
        .status(404)
        .json({ error: "Transcript upload expired. Please retry the import." });
      return;
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      await unlink(chunk.path).catch(() => {});
      res.status(400).json({ error: "Invalid transcript chunk number." });
      return;
    }
    if (chunkIndex < session.nextChunkIndex) {
      await unlink(chunk.path).catch(() => {});
      res.json({
        receivedBytes: session.receivedBytes,
        nextChunkIndex: session.nextChunkIndex,
      });
      return;
    }
    if (chunkIndex !== session.nextChunkIndex) {
      await unlink(chunk.path).catch(() => {});
      res.status(409).json({
        error: `Expected chunk ${session.nextChunkIndex}.`,
        nextChunkIndex: session.nextChunkIndex,
      });
      return;
    }

    const expectedSize = Math.min(
      UPLOAD_CHUNK_BYTES,
      session.totalSize - session.receivedBytes,
    );
    if (chunk.size !== expectedSize) {
      await unlink(chunk.path).catch(() => {});
      res.status(400).json({
        error: `Invalid transcript chunk size. Expected ${expectedSize} bytes.`,
      });
      return;
    }

    try {
      await pipeline(
        createReadStream(chunk.path),
        createWriteStream(session.path, { flags: "a" }),
      );
    } finally {
      await unlink(chunk.path).catch(() => {});
    }

    session.receivedBytes += chunk.size;
    session.nextChunkIndex += 1;
    session.updatedAt = Date.now();

    res.json({
      receivedBytes: session.receivedBytes,
      nextChunkIndex: session.nextChunkIndex,
    });
  },
);

router.post(
  "/transcriptions/text-upload-sessions/:sessionId/complete",
  async (req, res): Promise<void> => {
    const session = textUploadSessions.get(String(req.params.sessionId));
    if (!session) {
      res
        .status(404)
        .json({ error: "Transcript upload expired. Please retry the import." });
      return;
    }
    if (session.receivedBytes !== session.totalSize) {
      res.status(409).json({
        error: `Transcript upload is incomplete: ${session.receivedBytes} of ${session.totalSize} bytes received.`,
      });
      return;
    }

    try {
      const text = (await readFile(session.path, "utf8")).trim();
      if (!text) {
        res.status(400).json({ error: "Transcript text must not be blank." });
        return;
      }
      const [record] = await db
        .insert(transcriptionsTable)
        .values({
          filename: session.filename,
          fileSize: Buffer.byteLength(text, "utf8"),
          text,
          status: "completed",
          audioPath: null,
        })
        .returning();
      res.status(201).json(GetTranscriptionResponse.parse(record));
    } finally {
      await removeUploadSession(session);
    }
  },
);

router.delete(
  "/transcriptions/text-upload-sessions/:sessionId",
  async (req, res): Promise<void> => {
    const session = textUploadSessions.get(String(req.params.sessionId));
    if (session) {
      await removeUploadSession(session);
    }
    res.status(204).end();
  },
);

router.post("/transcriptions/text", async (req, res): Promise<void> => {
  const body = ImportTranscriptionTextBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const text = body.data.text.trim();
  if (!text) {
    res.status(400).json({ error: "Transcript text must not be blank" });
    return;
  }
  const [record] = await db.insert(transcriptionsTable).values({
    filename: body.data.filename ?? "Manual transcript.txt",
    fileSize: Buffer.byteLength(text, "utf8"),
    text,
    status: "completed",
    audioPath: null,
  }).returning();
  res.status(201).json(GetTranscriptionResponse.parse(record));
});

router.post("/transcriptions/:id/coherence-jobs", async (req, res): Promise<void> => {
  const params = CreateCoherenceJobParams.safeParse(req.params);
  const body = CreateCoherenceJobBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error!.message });
    return;
  }
  const [transcription] = await db.select().from(transcriptionsTable).where(eq(transcriptionsTable.id, params.data.id));
  if (!transcription) {
    res.status(404).json({ error: "Transcription not found" });
    return;
  }
  if (transcription.status !== "completed" || !transcription.text.trim()) {
    res.status(400).json({ error: "Transcription is not completed yet" });
    return;
  }
  const [activity] = await db
    .select({
      activeCount: sql<number>`count(*) filter (
        where ${reconstructionJobsTable.status} not in ('complete', 'failed')
      )`,
    })
    .from(reconstructionJobsTable);
  if (Number(activity?.activeCount ?? 0) >= 3) {
    res.status(429).json({
      error: "Three long-form jobs are already active; wait for one to finish",
    });
    return;
  }
  const sourceWords = countWords(transcription.text);
  const targetWordCount = body.data.targetWordCount ?? sourceWords;
  const job = await createPersistedCoherenceJob({
    transcriptionId: transcription.id,
    text: transcription.text,
    jobType: body.data.jobType,
    manualSpecifications: body.data.manualSpecifications,
    targetWordCount,
    fidelityMode: body.data.fidelityMode,
  });
  res.status(202).json(GetCoherenceJobResponse.parse(job));
  enqueueCoherenceJob(job.id);
});

router.get("/transcriptions/:id/coherence-jobs", async (req, res): Promise<void> => {
  const params = ListCoherenceJobsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const jobs = await db.select().from(reconstructionJobsTable)
    .where(eq(reconstructionJobsTable.transcriptionId, params.data.id))
    .orderBy(sql`${reconstructionJobsTable.createdAt} DESC`);
  res.json(ListCoherenceJobsResponse.parse(jobs));
});

router.get("/coherence-jobs/:id", async (req, res): Promise<void> => {
  const params = GetCoherenceJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [job] = await db.select().from(reconstructionJobsTable).where(eq(reconstructionJobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Coherence job not found" });
    return;
  }
  res.json(GetCoherenceJobResponse.parse(job));
});

router.post("/transcriptions/:id/transform", async (req, res): Promise<void> => {
  const params = TransformTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = TransformTranscriptionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (body.data.mode === "rewrite" && !body.data.instructions?.trim()) {
    res.status(400).json({ error: "instructions are required for rewrite mode" });
    return;
  }

  const [transcription] = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, params.data.id));

  if (!transcription) {
    res.status(404).json({ error: "Transcription not found" });
    return;
  }
  if (transcription.status !== "completed" || !transcription.text) {
    res.status(400).json({ error: "Transcription is not completed yet" });
    return;
  }

  try {
    const text = await transformTranscript({
      provider: body.data.provider,
      mode: body.data.mode,
      transcript: transcription.text,
      instructions: body.data.instructions,
    });
    res.json(
      TransformTranscriptionResponse.parse({
        text,
        mode: body.data.mode,
        provider: body.data.provider,
      }),
    );
  } catch (err) {
    logger.error({ err, id: params.data.id, provider: body.data.provider }, "Transform failed");
    const message = err instanceof Error ? err.message : "Transform failed";
    res.status(500).json({ error: message });
  }
});

router.get("/transcriptions/stats", async (_req, res): Promise<void> => {
  const [stats] = await db
    .select({
      totalCount: count(),
      completedCount: sql<number>`count(*) filter (where ${transcriptionsTable.status} = 'completed')`,
      totalFileSize: sql<number>`coalesce(sum(${transcriptionsTable.fileSize}), 0)`,
    })
    .from(transcriptionsTable);

  res.json(
    GetTranscriptionStatsResponse.parse({
      totalCount: stats.totalCount,
      completedCount: Number(stats.completedCount),
      totalFileSize: Number(stats.totalFileSize),
    }),
  );
});

router.get("/transcriptions/:id", async (req, res): Promise<void> => {
  const params = GetTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [transcription] = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, params.data.id));

  if (!transcription) {
    res.status(404).json({ error: "Transcription not found" });
    return;
  }

  res.json(GetTranscriptionResponse.parse(transcription));
});

router.get("/transcriptions/:id/audio", async (req, res): Promise<void> => {
  const params = GetTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [transcription] = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.id, params.data.id));

  if (!transcription) {
    res.status(404).json({ error: "Transcription not found" });
    return;
  }
  if (!transcription.audioPath) {
    res.status(404).json({ error: "No audio available for this transcription" });
    return;
  }

  try {
    const file = await objectStorage.getObjectEntityFile(transcription.audioPath);
    const [metadata] = await file.getMetadata();
    const totalSize = Number(metadata.size ?? 0);
    const contentType = (metadata.contentType as string) || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");
    if (req.query.download === "1") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(transcription.filename)}`,
      );
    }

    const range = req.headers.range;
    const rangeMatch = totalSize > 0 && range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;

    if (rangeMatch) {
      const startStr = rangeMatch[1];
      const endStr = rangeMatch[2];
      let start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : totalSize - 1;

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
        res.status(416).setHeader("Content-Range", `bytes */${totalSize}`);
        res.end();
        return;
      }
      end = Math.min(end, totalSize - 1);

      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      res.setHeader("Content-Length", String(end - start + 1));
      file.createReadStream({ start, end }).pipe(res);
      return;
    }

    res.status(200);
    if (totalSize > 0) {
      res.setHeader("Content-Length", String(totalSize));
    }
    file.createReadStream().pipe(res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Audio file not found" });
      return;
    }
    req.log.error({ err, id: params.data.id }, "Failed to serve audio");
    res.status(500).json({ error: "Failed to serve audio" });
  }
});

router.delete("/transcriptions/:id", async (req, res): Promise<void> => {
  const params = DeleteTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(transcriptionsTable)
    .where(eq(transcriptionsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Transcription not found" });
    return;
  }

  if (deleted.audioPath) {
    try {
      const file = await objectStorage.getObjectEntityFile(deleted.audioPath);
      await file.delete();
    } catch (err) {
      if (!(err instanceof ObjectNotFoundError)) {
        req.log.error({ err, id: params.data.id }, "Failed to delete stored audio");
      }
    }
  }

  res.sendStatus(204);
});

export default router;
