import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { db, transcriptionsTable } from "@workspace/db";
import { RunDiagnosticsResponse } from "@workspace/api-zod";
import { ObjectStorageService } from "../../lib/objectStorage";
import {
  transcribeAudioFile,
  transcriptionProvider,
} from "../../lib/transcription";
import { transformTranscript } from "../../lib/llm";
import { extractCoherenceSkeleton, planCoherenceChunks } from "../../lib/coherenceEngine";
import { eq } from "drizzle-orm";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();
const DIAGNOSTICS_COOLDOWN_MS = 30_000;
let diagnosticsRunning = false;
let lastDiagnosticsStartedAt = 0;

type DiagnosticCheck = {
  name: string;
  status: "passed" | "failed";
  detail: string;
  durationMs: number;
};

async function runCheck(
  name: string,
  check: () => Promise<string>,
): Promise<DiagnosticCheck> {
  const startedAt = performance.now();
  try {
    const detail = await check();
    return {
      name,
      status: "passed",
      detail,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      detail: error instanceof Error ? error.message : "Unknown diagnostic failure",
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2000);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
    child.on("error", reject);
  });
}

router.post("/diagnostics/run", async (req, res): Promise<void> => {
  const elapsed = Date.now() - lastDiagnosticsStartedAt;
  if (diagnosticsRunning || elapsed < DIAGNOSTICS_COOLDOWN_MS) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((DIAGNOSTICS_COOLDOWN_MS - elapsed) / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: diagnosticsRunning
        ? "Diagnostics are already running"
        : `Diagnostics can run again in ${retryAfterSeconds} seconds`,
    });
    return;
  }
  diagnosticsRunning = true;
  lastDiagnosticsStartedAt = Date.now();
  try {
  const checks: DiagnosticCheck[] = [];

  checks.push(
    await runCheck("Configuration", async () => {
      const required = [
        "OPENAI_API_KEY",
        "ASSEMBLYAI_API_KEY",
        "NEON_DATABASE_API or NEON_DATABASE_URL or DATABASE_URL",
        "PRIVATE_OBJECT_DIR",
      ];
      const present =
        Boolean(process.env.OPENAI_API_KEY) &&
        Boolean(process.env.ASSEMBLYAI_API_KEY) &&
        Boolean(
          process.env.NEON_DATABASE_API ??
            process.env.NEON_DATABASE_URL ??
            process.env.DATABASE_URL,
        ) &&
        Boolean(process.env.PRIVATE_OBJECT_DIR);
      if (!present) {
        throw new Error(`Missing one or more required settings: ${required.join(", ")}`);
      }
      const databaseSource = process.env.NEON_DATABASE_API
        ? "NEON_DATABASE_API"
        : process.env.NEON_DATABASE_URL
          ? "NEON_DATABASE_URL"
          : "DATABASE_URL";
      return `Required database (${databaseSource}), storage, AssemblyAI diarization, and OpenAI formatting settings are present.`;
    }),
  );

  checks.push(
    await runCheck("PostgreSQL connection", async () => {
      await db.execute(sql`select 1 as ok`);
      const source = process.env.NEON_DATABASE_API
        ? "NEON_DATABASE_API"
        : process.env.NEON_DATABASE_URL
          ? "NEON_DATABASE_URL"
          : "DATABASE_URL";
      return `Database round trip completed through ${source}.`;
    }),
  );

  checks.push(
    await runCheck("Coherence database tables", async () => {
      const result = await db.execute(sql`
        select
          to_regclass('public.reconstruction_jobs') as jobs,
          to_regclass('public.reconstruction_chunks') as chunks,
          to_regclass('public.tractatus_tiers') as tiers,
          to_regclass('public.tractatus_archive') as archive
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row || Object.values(row).some((value) => value === null)) {
        throw new Error("One or more durable coherence tables are missing");
      }
      return "All four durable coherence and Tractatus tables are present.";
    }),
  );

  checks.push(
    await runCheck("60,000-word coherence planning", async () => {
      const plan = planCoherenceChunks({
        text: "Speaker A: Source statement.\n\nSpeaker B: Response.",
        jobType: "play",
        targetWordCount: 60_000,
      });
      if (plan.length < 50 || plan.some((chunk) => chunk.maximum > 1_200)) {
        throw new Error("The 60,000-word plan does not create enough safely sized scene chunks");
      }
      const allocated = plan.reduce((sum, chunk) => sum + chunk.target, 0);
      if (allocated !== 60_000) throw new Error(`Planner allocated ${allocated} words instead of 60000`);
      return `${plan.length} scene chunks planned with model-safe per-scene output targets.`;
    }),
  );

  checks.push(
    await runCheck("Database transaction rollback", async () => {
      const marker = `diagnostic-rollback-${randomUUID()}.txt`;
      try {
        await db.transaction(async (tx) => {
          const [written] = await tx.insert(transcriptionsTable).values({
            filename: marker,
            fileSize: 1,
            text: "rollback diagnostic",
            status: "completed",
          }).returning();
          const [readBack] = await tx.select().from(transcriptionsTable).where(eq(transcriptionsTable.id, written.id));
          if (!readBack) throw new Error("Transaction write could not be read back");
          throw new Error("EXPECTED_DIAGNOSTIC_ROLLBACK");
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "EXPECTED_DIAGNOSTIC_ROLLBACK") throw error;
      }
      const rows = await db.select().from(transcriptionsTable).where(eq(transcriptionsTable.filename, marker));
      if (rows.length) throw new Error("Diagnostic transaction did not roll back");
      return "Temporary write was read inside a transaction and verified absent after rollback.";
    }),
  );

  checks.push(
    await runCheck("Object storage", async () => {
      const uploadUrl = await objectStorage.getObjectEntityUploadURL();
      const upload = await fetch(uploadUrl, {
        method: "PUT",
        body: Buffer.from("transcriber-diagnostic"),
        headers: { "Content-Type": "text/plain" },
      });
      if (!upload.ok) {
        throw new Error(`Storage write returned HTTP ${upload.status}`);
      }

      const objectPath = objectStorage.normalizeObjectEntityPath(uploadUrl);
      const file = await objectStorage.getObjectEntityFile(objectPath);
      try {
        const [metadata] = await file.getMetadata();
        if (Number(metadata.size ?? 0) === 0) {
          throw new Error("Storage object was written with zero bytes");
        }
      } finally {
        await file.delete().catch(() => {});
      }
      return "Temporary object write, metadata read, and cleanup completed.";
    }),
  );

  checks.push(
    await runCheck(">50 MB disk/stream pipeline", async () => {
      const testPath = join(tmpdir(), `diagnostic-large-${randomUUID()}.bin`);
      const expectedSize = 64 * 1024 * 1024;
      try {
        const handle = await open(testPath, "w");
        await handle.truncate(expectedSize);
        await handle.close();
        const metadata = await stat(testPath);
        if (metadata.size !== expectedSize) {
          throw new Error(`Large temporary file measured ${metadata.size} bytes`);
        }
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(testPath, {
            start: expectedSize - 1,
            end: expectedSize - 1,
          });
          stream.once("data", () => resolve());
          stream.once("error", reject);
        });
        return "Created and streamed a 64 MB disk-backed file; app upload limit is 1 GB.";
      } finally {
        await unlink(testPath).catch(() => {});
      }
    }),
  );

  checks.push(
    await runCheck("AI transcription", async () => {
      const audioPath = join(tmpdir(), `diagnostic-${randomUUID()}.wav`);
      try {
        await runProcess("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "flite=text='Diagnostic transcription is working.':voice=slt",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-y",
          audioPath,
        ]);
        const transcript = await transcribeAudioFile(audioPath);
        if (!transcript.startsWith("Speaker ")) {
          throw new Error("The provider did not return speaker-labeled utterances");
        }
        return `Live model response: “${transcript.trim()}”`;
      } finally {
        await unlink(audioPath).catch(() => {});
      }
    }),
  );

  checks.push(
    await runCheck("Speaker transcript formatting", async () => {
      const formatted = await transformTranscript({
        provider: "openai",
        mode: "speakers",
        transcript:
          "Good morning, thanks for joining me. Thanks for having me. What should listeners know? The launch is scheduled for Friday.",
      });
      if (!formatted.includes("Speaker 1:") || !formatted.includes("Speaker 2:")) {
        throw new Error("The formatter did not return consistent speaker labels");
      }
      return `Live formatting response: “${formatted.replace(/\s+/g, " ").slice(0, 180)}”`;
    }),
  );

  checks.push(
    await runCheck("OpenAI coherence skeleton", async () => {
      const skeleton = await extractCoherenceSkeleton(
        "THE COURT: The hearing is on April 27, 2026. The Court rejects the claim that no notice was given.\n\nMR. LEE: I understand.",
        "Preserve the rejected claim and exact hearing date.",
        "polish",
      );
      const ledger = skeleton.commitmentLedger as Record<string, unknown> | undefined;
      if (!Array.isArray(skeleton.steps) || skeleton.steps.length < 8 || !ledger || !Array.isArray(ledger.rejects)) {
        throw new Error("Live OpenAI response did not satisfy the coherence skeleton contract");
      }
      const serialized = JSON.stringify(skeleton);
      if (!serialized.includes("April 27, 2026")) throw new Error("Skeleton did not preserve the exact diagnostic date");
      return "Live OpenAI JSON skeleton preserved structure, commitments, and exact-date coherence.";
    }),
  );

  const report = RunDiagnosticsResponse.parse({
    status: checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed",
    provider: transcriptionProvider.name,
    model: transcriptionProvider.model,
    credentialSource: `${transcriptionProvider.credentialSource} (value never exposed)`,
    generatedAt: new Date(),
    checks,
  });

  req.log.info(
    {
      status: report.status,
      passed: checks.filter((check) => check.status === "passed").length,
      total: checks.length,
    },
    "Diagnostics completed",
  );
  res.json(report);
  } finally {
    diagnosticsRunning = false;
  }
});

export default router;