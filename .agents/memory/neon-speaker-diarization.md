---
name: Neon database and speaker diarization
description: Provider requirements for persistence and speaker-aware transcription.
---

Use `NEON_DATABASE_API` as the preferred PostgreSQL connection source. Audio transcription must use AssemblyAI speaker diarization and return utterance-derived speaker labels; post-processing plain text is not an acceptable substitute.

**Why:** The user explicitly identified the Neon connection and true speaker-aware transcription as core requirements the app cannot function without.

**How to apply:** Keep `NEON_DATABASE_URL` and `DATABASE_URL` only as lower-priority database fallbacks. Require `ASSEMBLYAI_API_KEY` before activating the diarization build, and fail explicitly rather than silently producing unlabeled text.