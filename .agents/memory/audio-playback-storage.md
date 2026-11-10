---
name: Persistent audio across hosting migration
description: Storage decisions and migration constraints for self-hosting on Coolify.
---

Persist uploaded audio server-side, independently of transcript text, and preserve original object keys when moving recordings between hosts.

**Why:** The user requested Coolify hosting with all Replit runtime integrations removed. A persistent filesystem volume fits the existing single-instance upload/processing design; old storage records contain paths, not the audio bytes. Moving the database alone cannot restore playback.

**How to apply:** Follow COOLIFY.md for volume configuration and migration. Do not reintroduce the platform storage sidecar or presigned Replit URLs. Keep source playback/download and byte-range seeking intact. Do not claim old audio was migrated unless the actual exported files have been copied and tested. Adding replicas requires redesigning both upload reservations and storage access together.
