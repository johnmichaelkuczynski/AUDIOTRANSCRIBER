---
name: Direct transcription credentials
description: Project-level requirement for the transcription provider and credential source.
---

Use direct provider credentials rather than Replit AI Integrations: AssemblyAI for speaker-diarized audio transcription and OpenAI for transcript polishing, rewriting, and play/coherence generation.

**Why:** The user explicitly rejected Replit-managed AI integration credentials and required actual provider API keys, then required true utterance-level speaker diarization.

**How to apply:** Keep diagnostics explicit about both providers, models, and credential variable names without ever exposing secret values. Preserve direct-provider paths during future audio and text-generation work.