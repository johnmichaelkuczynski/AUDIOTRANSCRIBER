import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, sql, count } from "drizzle-orm";
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

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.get("/transcriptions", async (_req, res): Promise<void> => {
  const transcriptions = await db
    .select()
    .from(transcriptionsTable)
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

  const [record] = await db
    .insert(transcriptionsTable)
    .values({
      filename: file.originalname,
      fileSize: file.size,
      status: "processing",
      text: "",
    })
    .returning();

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

  res.sendStatus(204);
});

export default router;
