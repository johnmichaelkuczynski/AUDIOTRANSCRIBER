---
name: Neon database and speaker diarization
description: Provider requirements for persistence and speaker-aware transcription.
---

Use `NEON_DATABASE_API` as the preferred PostgreSQL connection source. Audio transcription must use AssemblyAI speaker diarization and return utterance-derived speaker labels; post-processing plain text is not an acceptable substitute.

**Why:** The user explicitly identified the Neon connection and true speaker-aware transcription as core requirements the app cannot function without.

**How to apply:** Preserve legacy Neon alias precedence in the existing workspace. For Coolify, configure only the standard `DATABASE_URL` with the existing Neon connection. The workspace's auto-provided `DATABASE_URL` points at a different database with an older schema; don't mistake a successful connection for the correct product database. Test with the actual product connection without printing credentials. Require `ASSEMBLYAI_API_KEY` when transcription is requested, not at server startup, and fail explicitly rather than producing unlabeled text.