import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger";

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 7_200;
const AUDIO_SEGMENT_SECONDS = 120;
const SEGMENT_RETRY_ATTEMPTS = 3;
const execFileAsync = promisify(execFile);

type AssemblyAIUploadResponse = {
  upload_url?: string;
  error?: string;
};

type AssemblyAIUtterance = {
  speaker: string;
  text: string;
  start: number;
  end: number;
};

type AssemblyAITranscriptResponse = {
  id?: string;
  status?: "queued" | "processing" | "completed" | "error";
  error?: string | null;
  text?: string | null;
  utterances?: AssemblyAIUtterance[] | null;
};

function getApiKey(): string {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error("ASSEMBLYAI_API_KEY is not configured");
  }
  return apiKey;
}

async function parseJson<T>(response: Response, action: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;

  if (!response.ok) {
    throw new Error(
      body?.error ?? `AssemblyAI ${action} returned HTTP ${response.status}`,
    );
  }
  if (!body) {
    throw new Error(`AssemblyAI ${action} returned an empty response`);
  }
  return body;
}

async function uploadAudio(inputPath: string, apiKey: string): Promise<string> {
  const response = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/upload`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/octet-stream",
    },
    body: createReadStream(inputPath) as unknown as RequestInit["body"],
    duplex: "half",
    signal: AbortSignal.timeout(15 * 60 * 1000),
  } as RequestInit & { duplex: "half" });

  const body = await parseJson<AssemblyAIUploadResponse>(response, "upload");
  if (!body.upload_url) {
    throw new Error("AssemblyAI upload did not return an audio URL");
  }
  return body.upload_url;
}

async function createTranscript(
  audioUrl: string,
  apiKey: string,
): Promise<string> {
  const response = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speaker_labels: true,
      speech_models: ["universal-3-5-pro", "universal-2"],
      format_text: true,
      punctuate: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const body = await parseJson<AssemblyAITranscriptResponse>(
    response,
    "transcript creation",
  );
  if (!body.id) {
    throw new Error("AssemblyAI did not return a transcript ID");
  }
  return body.id;
}

async function pollTranscript(
  transcriptId: string,
  apiKey: string,
): Promise<AssemblyAITranscriptResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(
      `${ASSEMBLYAI_BASE_URL}/v2/transcript/${transcriptId}`,
      {
        headers: { authorization: apiKey },
        signal: AbortSignal.timeout(60_000),
      },
    );
    const body = await parseJson<AssemblyAITranscriptResponse>(
      response,
      "transcript polling",
    );

    if (body.status === "completed") return body;
    if (body.status === "error") {
      throw new Error(body.error ?? "AssemblyAI transcription failed");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error("AssemblyAI transcription timed out");
}

function formatSpeakerTranscript(
  transcript: AssemblyAITranscriptResponse,
): string {
  const utterances = transcript.utterances ?? [];
  if (utterances.length === 0) {
    throw new Error(
      "AssemblyAI completed without speaker utterances; diarization is required",
    );
  }

  return utterances
    .map((utterance) => {
      const speaker = utterance.speaker.trim() || "Unknown";
      return `Speaker ${speaker}: ${utterance.text.trim()}`;
    })
    .filter((line) => !line.endsWith(":"))
    .join("\n\n");
}

async function transcribeSingleAudioFile(
  inputPath: string,
  apiKey: string,
): Promise<string> {
  const audioUrl = await uploadAudio(inputPath, apiKey);
  const transcriptId = await createTranscript(audioUrl, apiKey);
  const transcript = await pollTranscript(transcriptId, apiKey);
  return formatSpeakerTranscript(transcript);
}

async function getAudioDurationSeconds(inputPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (err) {
    logger.warn({ err }, "Could not inspect audio duration; using single-pass transcription");
    return null;
  }
}

async function splitAudioFile(inputPath: string): Promise<{
  directory: string;
  segmentPaths: string[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "transcriber-segments-"));
  const outputPattern = join(directory, "segment-%05d.mp3");

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-f",
        "segment",
        "-segment_time",
        String(AUDIO_SEGMENT_SECONDS),
        "-reset_timestamps",
        "1",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        outputPattern,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const segmentPaths = (await readdir(directory))
      .filter((name) => name.endsWith(".mp3"))
      .sort()
      .map((name) => join(directory, name));
    if (segmentPaths.length === 0) {
      throw new Error("Audio segmentation produced no playable segments");
    }
    return { directory, segmentPaths };
  } catch (err) {
    await rm(directory, { recursive: true, force: true });
    throw err;
  }
}

async function transcribeSegmentWithRetries(
  segmentPath: string,
  apiKey: string,
  segmentNumber: number,
  totalSegments: number,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SEGMENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      logger.info(
        { segmentNumber, totalSegments, attempt },
        "Transcribing audio segment",
      );
      return await transcribeSingleAudioFile(segmentPath, apiKey);
    } catch (err) {
      lastError = err;
      logger.warn(
        { err, segmentNumber, totalSegments, attempt },
        "Audio segment transcription attempt failed",
      );
      if (attempt < SEGMENT_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Audio segment ${segmentNumber} failed`);
}

export type TranscriptionSegmentProgress = {
  segmentNumber: number;
  totalSegments: number;
  segmentText: string;
  combinedText: string;
};

export async function transcribeAudioFile(
  inputPath: string,
  options?: {
    onSegmentCompleted?: (
      progress: TranscriptionSegmentProgress,
    ) => Promise<void> | void;
  },
): Promise<string> {
  const apiKey = getApiKey();
  const duration = await getAudioDurationSeconds(inputPath);
  if (duration === null || duration <= AUDIO_SEGMENT_SECONDS) {
    const segmentText = await transcribeSingleAudioFile(inputPath, apiKey);
    const combinedText = `=== Interval 1 of 1 ===\n${segmentText}`;
    await options?.onSegmentCompleted?.({
      segmentNumber: 1,
      totalSegments: 1,
      segmentText,
      combinedText,
    });
    return combinedText;
  }

  const { directory, segmentPaths } = await splitAudioFile(inputPath);
  logger.info(
    {
      durationSeconds: Math.round(duration),
      segmentSeconds: AUDIO_SEGMENT_SECONDS,
      totalSegments: segmentPaths.length,
    },
    "Long recording divided into transcription segments",
  );

  try {
    const transcriptParts: string[] = [];
    for (let index = 0; index < segmentPaths.length; index += 1) {
      const segmentText = await transcribeSegmentWithRetries(
        segmentPaths[index],
        apiKey,
        index + 1,
        segmentPaths.length,
      );
      transcriptParts.push(
        `=== Interval ${index + 1} of ${segmentPaths.length} ===\n${segmentText}`,
      );
      const combinedText = transcriptParts.join("\n\n");
      await options?.onSegmentCompleted?.({
        segmentNumber: index + 1,
        totalSegments: segmentPaths.length,
        segmentText,
        combinedText,
      });
      if (index + 1 < segmentPaths.length) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return transcriptParts.join("\n\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const transcriptionProvider = {
  name: "AssemblyAI direct API with speaker diarization",
  model:
    "universal-3-5-pro (universal-2 fallback), 90-second long-audio segments",
  credentialSource: "ASSEMBLYAI_API_KEY",
} as const;