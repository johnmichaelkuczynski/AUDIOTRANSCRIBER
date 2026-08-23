---
name: Large upload response timing
description: Why large audio uploads can look timed out and the required staging behavior.
---

After the server has received an audio file into temporary disk storage, create the processing record and return it before copying the file to object storage. Run object-storage persistence and provider transcription concurrently in the background.

**Why:** Waiting for a second full copy before responding made a successful 396 MB upload hold the request open for roughly 90 seconds, which looked like a timeout even though transcription later completed.

**How to apply:** Keep the client-visible request limited to receiving the original upload and creating its record. Preserve the temporary file until both background operations settle, clean up orphaned stored audio if the record was deleted, and expose status through polling.