import type { Transcription } from "@workspace/api-client-react";

type UploadSessionResponse = {
  id: string;
  chunkSize: number;
  receivedBytes: number;
  nextChunkIndex: number;
};

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(body?.error || `Upload failed with HTTP ${response.status}`);
  }
  if (!body) {
    throw new Error("Upload server returned an empty response");
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
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const formData = new FormData();
      formData.append("chunk", chunk, `chunk-${chunkIndex}`);
      const response = await fetch(
        `/api/transcriptions/upload-sessions/${sessionId}/chunks/${chunkIndex}`,
        {
          method: "POST",
          body: formData,
        },
      );
      await readResponse<{
        receivedBytes: number;
        nextChunkIndex: number;
      }>(response);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 5) {
        await delay(750 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Upload chunk ${chunkIndex + 1} failed`);
}

export async function uploadAudioFileInChunks(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Transcription> {
  const initResponse = await fetch("/api/transcriptions/upload-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      fileSize: file.size,
      mimetype: file.type || "application/octet-stream",
    }),
  });
  const session = await readResponse<UploadSessionResponse>(initResponse);

  try {
    const totalChunks = Math.ceil(file.size / session.chunkSize);
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * session.chunkSize;
      const end = Math.min(start + session.chunkSize, file.size);
      await uploadChunkWithRetries(
        session.id,
        chunkIndex,
        file.slice(start, end),
      );
      onProgress?.(Math.round((end / file.size) * 100));
    }

    const completeResponse = await fetch(
      `/api/transcriptions/upload-sessions/${session.id}/complete`,
      { method: "POST" },
    );
    return readResponse<Transcription>(completeResponse);
  } catch (err) {
    await fetch(`/api/transcriptions/upload-sessions/${session.id}`, {
      method: "DELETE",
    }).catch(() => {});
    throw err;
  }
}