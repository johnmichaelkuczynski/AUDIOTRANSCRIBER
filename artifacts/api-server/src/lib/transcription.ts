import { createReadStream } from "node:fs";

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 7_200;

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

export async function transcribeAudioFile(inputPath: string): Promise<string> {
  const apiKey = getApiKey();
  const audioUrl = await uploadAudio(inputPath, apiKey);
  const transcriptId = await createTranscript(audioUrl, apiKey);
  const transcript = await pollTranscript(transcriptId, apiKey);
  return formatSpeakerTranscript(transcript);
}

export const transcriptionProvider = {
  name: "AssemblyAI direct API with speaker diarization",
  model: "universal-3-5-pro (universal-2 fallback)",
  credentialSource: "ASSEMBLYAI_API_KEY",
} as const;