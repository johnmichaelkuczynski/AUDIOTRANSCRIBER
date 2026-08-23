import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { eq, sql, count } from "drizzle-orm";
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
} from "@workspace/api-zod";
import { logger } from "../../lib/logger";
import { transformTranscript } from "../../lib/llm";
import { ObjectStorageService, ObjectNotFoundError } from "../../lib/objectStorage";
import { transcribeAudioFile } from "../../lib/transcription";
import { countWords, createPersistedCoherenceJob, enqueueCoherenceJob } from "../../lib/coherenceEngine";

const router: IRouter = Router();

const objectStorage = new ObjectStorageService();

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, _file, callback) => {
      callback(null, `transcriber-upload-${randomUUID()}`);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
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

  let record;
  try {
    [record] = await db
      .insert(transcriptionsTable)
      .values({
        filename: file.originalname,
        fileSize: file.size,
        status: "processing",
        text: "",
        audioPath: null,
      })
      .returning();
  } catch (err) {
    await unlink(file.path).catch(() => {});
    throw err;
  }

  res.status(201).json(GetTranscriptionResponse.parse(record));

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
      logger.error({ err, id: record.id }, "Failed to persist audio to object storage");
      return null;
    }
  })();

  const transcriptionTask = transcribeAudioFile(file.path);

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
      .where(eq(transcriptionsTable.id, record.id));

    if (!current) {
      if (audioPath) {
        try {
          const orphan = await objectStorage.getObjectEntityFile(audioPath);
          await orphan.delete();
        } catch (cleanupErr) {
          if (!(cleanupErr instanceof ObjectNotFoundError)) {
            logger.error(
              { err: cleanupErr, id: record.id },
              "Failed to remove audio for a deleted transcription",
            );
          }
        }
      }
      return;
    }

    if (transcriptionResult.status === "fulfilled") {
      await db
        .update(transcriptionsTable)
        .set({
          text: transcriptionResult.value,
          status: "completed",
          errorMessage: null,
          audioPath,
        })
        .where(eq(transcriptionsTable.id, record.id));
    } else {
      logger.error(
        { err: transcriptionResult.reason, id: record.id },
        "Transcription failed",
      );
      const errorMessage =
        transcriptionResult.reason instanceof Error
          ? transcriptionResult.reason.message
          : "Unknown error";
      await db
        .update(transcriptionsTable)
        .set({ status: "failed", errorMessage, audioPath })
        .where(eq(transcriptionsTable.id, record.id));
    }
  } finally {
    await unlink(file.path).catch(() => {});
  }
});

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
