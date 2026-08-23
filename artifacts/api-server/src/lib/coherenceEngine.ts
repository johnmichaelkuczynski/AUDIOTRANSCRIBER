import OpenAI from "openai";
import { and, asc, eq, isNull, lt, ne, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  reconstructionChunksTable,
  reconstructionJobsTable,
  type ReconstructionJob,
} from "@workspace/db";
import { logger } from "./logger";
import { ANTI_SYCOPHANCY } from "./coherencePrompts";
import { buildTieredPromptContext, loadAllTiers, skeletonToTier0, updateLiveTier } from "./tractatusMemory";

type JobType = "polish" | "play";
type FidelityMode = "verbatim" | "adaptive" | "fictionalized";
type Skeleton = Record<string, unknown>;
const activeJobs = new Set<string>();
const JOB_LEASE_MS = 30 * 60 * 1000;
const DIRECT_SKELETON_SOURCE_LIMIT = 70_000;

export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function openai(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return new OpenAI({ apiKey });
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/u).map((value) => value.trim()).filter(Boolean);
}

export function chunkAtParagraphs(text: string, wordsPerChunk = 500): string[] {
  const result: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const paragraph of paragraphs(text)) {
    const size = countWords(paragraph);
    if (current.length && words + size > wordsPerChunk) {
      result.push(current.join("\n\n"));
      current = [];
      words = 0;
    }
    if (size > wordsPerChunk * 1.5 && current.length === 0) {
      const tokens = paragraph.split(/\s+/u);
      while (tokens.length > wordsPerChunk) result.push(tokens.splice(0, wordsPerChunk).join(" "));
      if (tokens.length) {
        current.push(tokens.join(" "));
        words = tokens.length;
      }
    } else {
      current.push(paragraph);
      words += size;
    }
  }
  if (current.length) result.push(current.join("\n\n"));
  return result;
}

export function planCoherenceChunks(args: { text: string; jobType: JobType; targetWordCount: number }) {
  const sourceChunks = chunkAtParagraphs(args.text, 500);
  const count = args.jobType === "polish"
    ? Math.max(1, sourceChunks.length)
    : Math.max(1, Math.ceil(args.targetWordCount / 1_000));
  return Array.from({ length: count }, (_, index) => {
    const input = args.jobType === "polish"
      ? sourceChunks[index]!
      : sourceChunks.slice(Math.floor(index * sourceChunks.length / count), Math.max(Math.floor((index + 1) * sourceChunks.length / count), Math.floor(index * sourceChunks.length / count) + 1)).join("\n\n") || args.text;
    const target = args.jobType === "polish"
      ? Math.max(1, Math.round(args.targetWordCount * countWords(input) / Math.max(1, countWords(args.text))))
      : Math.max(1, Math.round(args.targetWordCount / count));
    return {
      index,
      input,
      inputWords: countWords(input),
      target,
      minimum: Math.max(1, Math.floor(target * 0.85)),
      maximum: Math.ceil(target * 1.15),
    };
  });
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```[\s\S]*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("OpenAI returned invalid JSON");
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenAI returned an invalid object");
  return parsed as Record<string, unknown>;
}

async function jsonCall(system: string, user: string): Promise<Record<string, unknown>> {
  const result = await openai().chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return parseJsonObject(result.choices[0]?.message.content ?? "");
}

export async function extractCoherenceSkeleton(text: string, specifications: string, jobType: JobType): Promise<Skeleton> {
  const contract = `Return exactly this shape: {"purpose":"","thesis":"","steps":[""],"terms":[{"term":"","definition":""}],"commitmentLedger":{"asserts":[],"rejects":[],"assumes":[],"open":[]},"entities":[],"audience":"","rigor":"","speakerMap":[]}. The steps array MUST contain at least 8 distinct ordered strings, even for a short source; use structural verification and preservation steps when the source has fewer than 8 events. Keep the complete JSON under 5,000 characters so immutable Tier 0 remains within its prompt budget.`;
  let sourceForSkeleton = text;
  if (text.length > DIRECT_SKELETON_SOURCE_LIMIT) {
    const sourceChunks = chunkAtParagraphs(text, 2_500);
    const partials: Record<string, unknown>[] = [];
    for (let index = 0; index < sourceChunks.length; index += 1) {
      partials.push(
        await jsonCall(
          "Extract a compact structural and factual memory map. Return valid JSON only.",
          `Return {"steps":[],"asserts":[],"rejects":[],"assumes":[],"open":[],"terms":[],"entities":[],"speakers":[]}. Preserve exact names, numbers, dates, citations, quotations, negative findings, conflicts, and uncertainty. Do not rewrite prose. Source section ${index + 1}/${sourceChunks.length}.\n\n${sourceChunks[index]}`,
        ),
      );
    }
    sourceForSkeleton = `HIERARCHICAL SOURCE MAPS:\n${partials.map((partial, index) => `SECTION ${index + 1}: ${JSON.stringify(partial)}`).join("\n")}`;
  }
  let skeleton = await jsonCall(
    "Extract structure only, not rewritten prose. Return valid JSON only.",
    `${contract} Preserve exact names, numbers, dates, citations, quotations, negative findings, speaker identities, and explicit uncertainty. For a play, steps are a sufficient scene plan for the requested length. Job type: ${jobType}. Manual specifications: ${specifications || "(none)"}.\n\nSOURCE:\n${sourceForSkeleton}`,
  );
  const ledger = skeleton.commitmentLedger as Record<string, unknown> | undefined;
  if (
    !Array.isArray(skeleton.steps) ||
    skeleton.steps.length < 8 ||
    !ledger ||
    !Array.isArray(ledger.asserts) ||
    !Array.isArray(ledger.rejects) ||
    !Array.isArray(ledger.assumes) ||
    !Array.isArray(ledger.open)
  ) {
    skeleton = await jsonCall(
      "Repair the supplied coherence skeleton to the exact contract. Return valid JSON only.",
      `${contract} Do not lose or alter any existing exact name, number, date, citation, quotation, rejection, negative finding, speaker identity, or uncertainty. Job type: ${jobType}.\n\nCANDIDATE SKELETON:\n${JSON.stringify(skeleton)}\n\nSOURCE:\n${sourceForSkeleton}`,
    );
  }
  return skeleton;
}

function chunkSystem(job: ReconstructionJob, target: number, minimum: number, maximum: number): string {
  const common = `${ANTI_SYCOPHANCY}\n\nTarget ${target} words; acceptable range ${minimum}-${maximum}. Return valid JSON only: {"text":"...", "delta":{"claims":[],"terms":[],"conflicts":[]}}. Never include a preamble outside JSON.`;
  if (job.jobType === "polish") {
    return `${common}\nPerfect a legal/hearing transcript. Preserve every substantive word, proposition, denial, qualification, speaker turn, and sequence. Apply formal hearing typography: uppercase speaker labels, accurate punctuation, headings, interruptions, and bracketed stage directions. Correct obvious transcription/formatting errors only. Do not summarize, fictionalize, invent facts, names, or dialogue.`;
  }
  return `${common}\nWrite one coherent stage-play scene derived from the source and global plan. Honor the manual specifications and fidelity mode ${job.fidelityMode}. Verbatim means no invented factual content; adaptive allows dramatic restructuring without changing source facts; fictionalized permits creative adaptation while retaining the skeleton's controlling commitments. Use playable dialogue, scene headings, stage directions, continuity, and distinct consistent speakers.`;
}

async function processChunk(job: ReconstructionJob, chunk: typeof reconstructionChunksTable.$inferSelect): Promise<void> {
  await db.update(reconstructionChunksTable).set({ status: "processing", error: null }).where(eq(reconstructionChunksTable.id, chunk.id));
  const context = await buildTieredPromptContext(job.id, job.jobType);
  let output = await jsonCall(
    chunkSystem(job, chunk.targetWordCount, chunk.minimumWordCount, chunk.maximumWordCount),
    `CHUNK ${chunk.chunkIndex + 1}/${job.totalChunks}\nMANUAL SPECIFICATIONS:\n${job.manualSpecifications || "(none)"}\n\nMEMORY:\n${context}\n\nSOURCE MATERIAL:\n${chunk.inputText}`,
  );
  let text = typeof output.text === "string" ? output.text.trim() : "";
  let actual = countWords(text);
  let retries = chunk.retries;

  while (
    text &&
    (actual < chunk.minimumWordCount || actual > chunk.maximumWordCount) &&
    retries < 3
  ) {
    retries += 1;
    const direction =
      actual < chunk.minimumWordCount
        ? `EXPAND it by at least ${chunk.minimumWordCount - actual} words`
        : `COMPRESS it by at least ${actual - chunk.maximumWordCount} words`;
    output = await jsonCall(
      chunkSystem(job, chunk.targetWordCount, chunk.minimumWordCount, chunk.maximumWordCount),
      `Revise the complete output below because it is ${actual} words. ${direction}. The revised complete output must be ${chunk.minimumWordCount}-${chunk.maximumWordCount} words, ideally ${chunk.targetWordCount}. Preserve all commitments, exact values, continuity, and substantive content. Return the entire revised output, not only additions.\n\nPREVIOUS OUTPUT:\n${text}`,
    );
    text = typeof output.text === "string" ? output.text.trim() : "";
    actual = countWords(text);
  }
  if (!text) throw new Error(`Chunk ${chunk.chunkIndex + 1} returned empty text`);
  if (actual < chunk.minimumWordCount || actual > chunk.maximumWordCount) {
    throw new Error(`Chunk ${chunk.chunkIndex + 1} failed length enforcement after retry (${actual} words)`);
  }
  await db.update(reconstructionChunksTable).set({
    outputText: text,
    outputWordCount: actual,
    delta: output.delta ?? {},
    retries,
    status: "complete",
    error: null,
  }).where(eq(reconstructionChunksTable.id, chunk.id));
  await updateLiveTier(job.id, job.jobType, text);
  const completed = chunk.chunkIndex + 1;
  await db.update(reconstructionJobsTable).set({
    currentChunk: completed,
    progress: Math.min(95, Math.round((completed / job.totalChunks) * 90) + 5),
  }).where(eq(reconstructionJobsTable.id, job.id));
}

async function runJob(jobId: string): Promise<void> {
  const leaseOwner = randomUUID();
  const now = new Date();
  const [job] = await db
    .update(reconstructionJobsTable)
    .set({
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MS),
    })
    .where(
      and(
        eq(reconstructionJobsTable.id, jobId),
        ne(reconstructionJobsTable.status, "complete"),
        ne(reconstructionJobsTable.status, "failed"),
        or(
          isNull(reconstructionJobsTable.leaseExpiresAt),
          lt(reconstructionJobsTable.leaseExpiresAt, now),
        ),
      ),
    )
    .returning();
  if (!job) {
    logger.info({ jobId }, "Coherence job is already leased by another worker");
    return;
  }
  try {
    let skeleton = job.skeleton as Skeleton | null;
    if (!skeleton) {
      await db.update(reconstructionJobsTable).set({ status: "skeleton_extraction", progress: 2, error: null }).where(eq(reconstructionJobsTable.id, job.id));
      skeleton = await extractCoherenceSkeleton(job.originalText, job.manualSpecifications, job.jobType as JobType);
      await db.update(reconstructionJobsTable).set({ skeleton, progress: 5 }).where(eq(reconstructionJobsTable.id, job.id));
      await skeletonToTier0(skeleton, job.id, job.jobType);
    } else {
      await skeletonToTier0(skeleton, job.id, job.jobType);
    }
    await db.update(reconstructionJobsTable).set({ status: "chunk_processing" }).where(eq(reconstructionJobsTable.id, job.id));
    const chunks = await db.select().from(reconstructionChunksTable).where(eq(reconstructionChunksTable.jobId, job.id)).orderBy(asc(reconstructionChunksTable.chunkIndex));
    for (const chunk of chunks) {
      if (chunk.status === "complete" && chunk.outputText) continue;
      await db
        .update(reconstructionJobsTable)
        .set({ leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS) })
        .where(
          and(
            eq(reconstructionJobsTable.id, job.id),
            eq(reconstructionJobsTable.leaseOwner, leaseOwner),
          ),
        );
      try {
        await processChunk(job, chunk);
      } catch (error) {
        await db.update(reconstructionChunksTable).set({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown chunk processing error",
        }).where(eq(reconstructionChunksTable.id, chunk.id));
        throw error;
      }
    }
    const persisted = await db.select().from(reconstructionChunksTable).where(and(eq(reconstructionChunksTable.jobId, job.id), eq(reconstructionChunksTable.status, "complete"))).orderBy(asc(reconstructionChunksTable.chunkIndex));
    if (persisted.length !== job.totalChunks || persisted.some((chunk) => !chunk.outputText)) throw new Error("Not all persisted chunks completed; refusing to assemble partial output");
    await db.update(reconstructionJobsTable).set({ status: "stitching", progress: 96 }).where(eq(reconstructionJobsTable.id, job.id));
    const tiers = await loadAllTiers(job.id, job.jobType);
    const review = await jsonCall(
      `Review cross-chunk coherence and conflicts. Return JSON only: {"warnings":[],"conflicts":[],"specificationSatisfied":true}. Never rewrite or silently resolve a conflict.\n\n${ANTI_SYCOPHANCY}`,
      `SKELETON:\n${JSON.stringify(skeleton)}\n\nMEMORY TIERS AND DELTAS:\n${JSON.stringify(tiers.map((tier) => tier.tree))}\n\nMANUAL SPECIFICATIONS:\n${job.manualSpecifications || "(none)"}`,
    );
    const warnings = [
      ...(Array.isArray(review.warnings) ? review.warnings.filter((item): item is string => typeof item === "string") : []),
      ...(Array.isArray(review.conflicts) ? review.conflicts.map((item) => `CONFLICT_FLAG: ${String(item)}`) : []),
    ];
    if (review.specificationSatisfied === false) throw new Error("Final coherence review found the manual specifications were not satisfied");
    const finalOutput = persisted.map((chunk) => chunk.outputText).join("\n\n");
    const finalWordCount = countWords(finalOutput);
    if (finalWordCount > 60_000) throw new Error(`Final output exceeds 60,000 words (${finalWordCount})`);
    if (finalWordCount < job.targetWordCount * 0.8 || finalWordCount > job.targetWordCount * 1.2) {
      throw new Error(`Final output failed target check: ${finalWordCount} words for target ${job.targetWordCount}`);
    }
    await db.update(reconstructionJobsTable).set({
      status: "complete",
      progress: 100,
      finalOutput,
      finalWordCount,
      warnings,
      error: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
    }).where(eq(reconstructionJobsTable.id, job.id));
    logger.info({ jobId: job.id, jobType: job.jobType, finalWordCount }, "Coherence job completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown coherence processing error";
    await db
      .update(reconstructionJobsTable)
      .set({
        status: "failed",
        error: message,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(reconstructionJobsTable.id, jobId),
          eq(reconstructionJobsTable.leaseOwner, leaseOwner),
        ),
      );
    logger.error({ err: error, jobId }, "Coherence job failed");
  }
}

export function enqueueCoherenceJob(jobId: string): void {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);
  void runJob(jobId).finally(() => activeJobs.delete(jobId));
}

export async function resumeIncompleteCoherenceJobs(): Promise<void> {
  const jobs = await db.select({ id: reconstructionJobsTable.id }).from(reconstructionJobsTable)
    .where(and(ne(reconstructionJobsTable.status, "complete"), ne(reconstructionJobsTable.status, "failed")));
  for (const job of jobs) enqueueCoherenceJob(job.id);
  logger.info({ count: jobs.length }, "Queued incomplete coherence jobs for resume");
}

export async function createPersistedCoherenceJob(args: {
  transcriptionId: number;
  text: string;
  jobType: JobType;
  manualSpecifications: string;
  targetWordCount: number;
  fidelityMode: FidelityMode;
}) {
  if (args.targetWordCount > 60_000) throw new Error("targetWordCount must not exceed 60000");
  const sourceWordCount = countWords(args.text);
  const plan = planCoherenceChunks({ text: args.text, jobType: args.jobType, targetWordCount: args.targetWordCount });
  return db.transaction(async (tx) => {
    const [job] = await tx.insert(reconstructionJobsTable).values({
      transcriptionId: args.transcriptionId,
      jobType: args.jobType,
      fidelityMode: args.fidelityMode,
      originalText: args.text,
      manualSpecifications: args.manualSpecifications,
      targetWordCount: args.targetWordCount,
      sourceWordCount,
      sourceMetrics: { words: sourceWordCount, paragraphs: paragraphs(args.text).length },
      targetMetrics: { words: args.targetWordCount, chunkWordsMaximum: 1_150 },
      lengthRatio: String(args.targetWordCount / Math.max(1, sourceWordCount)),
      totalChunks: plan.length,
    }).returning();
    await tx.insert(reconstructionChunksTable).values(plan.map((chunk) => ({
      jobId: job.id,
      chunkIndex: chunk.index,
      inputText: chunk.input,
      inputWordCount: chunk.inputWords,
      targetWordCount: chunk.target,
      minimumWordCount: chunk.minimum,
      maximumWordCount: chunk.maximum,
    })));
    return job;
  });
}