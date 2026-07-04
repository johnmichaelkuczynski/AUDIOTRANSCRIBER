import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, sql, count, and } from "drizzle-orm";
import { db, transcriptionsTable } from "@workspace/db";
import { speechToText, ensureCompatibleFormat } from "@workspace/integrations-openai-ai-server/audio";
import {
  GetTranscriptionParams,
  GetTranscriptionResponse,
  ListTranscriptionsResponseItem,
  DeleteTranscriptionParams,
  GetTranscriptionStatsResponse,
  TransformTranscriptionParams,
  TransformTranscriptionBody,
  TransformTranscriptionResponse,
} from "@workspace/api-zod";
import { logger } from "../../lib/logger";
import { transformTranscript } from "../../lib/llm";
import { ObjectStorageService, ObjectNotFoundError } from "../../lib/objectStorage";
import type { AuthedRequest } from "../../middlewares/requireAuth";

const router: IRouter = Router();

const objectStorage = new ObjectStorageService();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.get("/transcriptions", async (req: AuthedRequest, res): Promise<void> => {
  const transcriptions = await db
    .select()
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.userId, req.userId!))
    .orderBy(sql`${transcriptionsTable.createdAt} DESC`);

  const parsed = transcriptions.map((t) => ListTranscriptionsResponseItem.parse(t));
  res.json(parsed);
});

router.post("/transcriptions", upload.single("file"), async (req, res): Promise<void> => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  let audioPath: string | null = null;
  try {
    const uploadURL = await objectStorage.getObjectEntityUploadURL();
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      body: new Uint8Array(file.buffer),
      headers: { "Content-Type": file.mimetype || "application/octet-stream" },
    });
    if (!putRes.ok) {
      throw new Error(`Storage upload failed with status ${putRes.status}`);
    }
    audioPath = objectStorage.normalizeObjectEntityPath(uploadURL);
  } catch (err) {
    req.log.error({ err }, "Failed to persist audio to object storage");
  }

  let record;
  try {
    [record] = await db
      .insert(transcriptionsTable)
      .values({
        userId: (req as AuthedRequest).userId!,
        filename: file.originalname,
        fileSize: file.size,
        status: "processing",
        text: "",
        audioPath,
      })
      .returning();
  } catch (err) {
    if (audioPath) {
      try {
        const orphan = await objectStorage.getObjectEntityFile(audioPath);
        await orphan.delete();
      } catch (cleanupErr) {
        if (!(cleanupErr instanceof ObjectNotFoundError)) {
          req.log.error({ err: cleanupErr }, "Failed to clean up orphaned audio after insert failure");
        }
      }
    }
    throw err;
  }

  res.status(201).json(GetTranscriptionResponse.parse(record));

  try {
    const audioBuffer = Buffer.from(file.buffer);
    const { buffer, format } = await ensureCompatibleFormat(audioBuffer);
    const transcribedText = await speechToText(buffer, format);

    await db
      .update(transcriptionsTable)
      .set({ text: transcribedText, status: "completed" })
      .where(eq(transcriptionsTable.id, record.id));
  } catch (err) {
    logger.error({ err, id: record.id }, "Transcription failed");
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    await db
      .update(transcriptionsTable)
      .set({ status: "failed", errorMessage })
      .where(eq(transcriptionsTable.id, record.id));
  }
});

router.post("/transcriptions/:id/transform", async (req: AuthedRequest, res): Promise<void> => {
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
    .where(and(eq(transcriptionsTable.id, params.data.id), eq(transcriptionsTable.userId, req.userId!)));

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

router.get("/transcriptions/stats", async (req: AuthedRequest, res): Promise<void> => {
  const [stats] = await db
    .select({
      totalCount: count(),
      completedCount: sql<number>`count(*) filter (where ${transcriptionsTable.status} = 'completed')`,
      totalFileSize: sql<number>`coalesce(sum(${transcriptionsTable.fileSize}), 0)`,
    })
    .from(transcriptionsTable)
    .where(eq(transcriptionsTable.userId, req.userId!));

  res.json(
    GetTranscriptionStatsResponse.parse({
      totalCount: stats.totalCount,
      completedCount: Number(stats.completedCount),
      totalFileSize: Number(stats.totalFileSize),
    }),
  );
});

router.get("/transcriptions/:id", async (req: AuthedRequest, res): Promise<void> => {
  const params = GetTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [transcription] = await db
    .select()
    .from(transcriptionsTable)
    .where(and(eq(transcriptionsTable.id, params.data.id), eq(transcriptionsTable.userId, req.userId!)));

  if (!transcription) {
    res.status(404).json({ error: "Transcription not found" });
    return;
  }

  res.json(GetTranscriptionResponse.parse(transcription));
});

router.get("/transcriptions/:id/audio", async (req: AuthedRequest, res): Promise<void> => {
  const params = GetTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [transcription] = await db
    .select()
    .from(transcriptionsTable)
    .where(and(eq(transcriptionsTable.id, params.data.id), eq(transcriptionsTable.userId, req.userId!)));

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

router.delete("/transcriptions/:id", async (req: AuthedRequest, res): Promise<void> => {
  const params = DeleteTranscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(transcriptionsTable)
    .where(and(eq(transcriptionsTable.id, params.data.id), eq(transcriptionsTable.userId, req.userId!)))
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
