---
name: Persisting upload audio for playback (object storage)
description: How/why audio files are persisted to object storage so transcription cards can replay the original recording, plus reuse pitfalls of the object-storage skill template.
---

# Persisting audio for playback

To let a completed transcription card replay its original audio, the audio itself must be persisted — the DB only stored transcript text before.

## Approach chosen: server-side persistence, not the client Uppy/presigned flow
The audio already arrives at the backend as a multipart upload on `POST /api/transcriptions`. So we persist it server-side rather than wiring the object-storage skill's client (Uppy `ObjectUploader` / `useUpload`) presigned-URL flow.

**Why:** the client upload flow is for files the browser sends directly to GCS. Here the file is already in the server's memory buffer; reusing the existing endpoint avoids a second round-trip and a redundant client package. We only copy the server pieces (`objectStorage.ts`, `objectAcl.ts`) — not `storage.ts` routes nor `object-storage-web`.

**How to apply:** server calls `objectStorage.getObjectEntityUploadURL()` → `fetch(url, {method:'PUT', body, headers:{'Content-Type'}})` → `normalizeObjectEntityPath(url)` to get the `/objects/...` path, stored in `transcriptions.audioPath` (nullable). Serve via a streaming route, not the skill's generic `/api/storage/objects/*`.

## Gotchas
- The object-storage skill's `objectStorage.ts` template has `const { signed_url } = await response.json()` which fails strict typecheck (`response.json()` is `unknown`). Cast it: `as { signed_url: string }`. Editing this line is fine — the skill's "don't modify" rule is about the GCS sidecar auth setup, not response parsing.
- `@google-cloud/*` is already in the api-server esbuild `external` list, so the SDK is required from node_modules at runtime (not bundled) — just add it as a dependency.
- For audio **seeking**, don't use the template's `downloadObject()` (returns a full-body web `Response`, no Range). Use the GCS `File` directly: read `file.getMetadata()` for size, parse the `Range` header, respond `206` + `Content-Range` + `Accept-Ranges: bytes`, and stream `file.createReadStream({start, end})`.
- Clean up the stored object on transcription delete, and compensate (delete the just-uploaded object) if the DB insert fails after a successful upload — otherwise objects orphan.
