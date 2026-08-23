import type { Transcription } from "@workspace/api-client-react";

type UploadSessionResponse = {
  id: string;
  chunkSize: number;
};

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(
      body?.error || `Transcript import failed with HTTP ${response.status}`,
    );
  }
  if (!body) {
    throw new Error("Transcript import server returned an empty response");
  }
  return body;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadChunkWithRetries(
  sessionId: string,
  chunkIndex: number,
  chunk: Blob,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException("Import cleared", "AbortError");
    }
    try {
      const formData = new FormData();
      formData.append("chunk", chunk, `transcript-chunk-${chunkIndex}`);
      const response = await fetch(
        `/api/transcriptions/text-upload-sessions/${sessionId}/chunks/${chunkIndex}`,
        { method: "POST", body: formData, signal },
      );
      await readResponse(response);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5 && !signal?.aborted) {
        await delay(750 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Transcript chunk ${chunkIndex + 1} failed`);
}

export async function importTranscriptInChunks(
  source: Blob,
  filename: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<Transcription> {
  const initResponse = await fetch("/api/transcriptions/text-upload-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, fileSize: source.size }),
    signal,
  });
  const session = await readResponse<UploadSessionResponse>(initResponse);

  try {
    const totalChunks = Math.ceil(source.size / session.chunkSize);
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * session.chunkSize;
      const end = Math.min(start + session.chunkSize, source.size);
      await uploadChunkWithRetries(
        session.id,
        chunkIndex,
        source.slice(start, end),
        signal,
      );
      onProgress?.(Math.round((end / source.size) * 100));
    }

    const completeResponse = await fetch(
      `/api/transcriptions/text-upload-sessions/${session.id}/complete`,
      { method: "POST", signal },
    );
    return readResponse<Transcription>(completeResponse);
  } catch (error) {
    await fetch(`/api/transcriptions/text-upload-sessions/${session.id}`, {
      method: "DELETE",
    }).catch(() => {});
    throw error;
  }
}