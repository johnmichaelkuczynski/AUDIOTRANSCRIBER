---
name: Verified upload serialization
description: Why verified transcription sessions need both upload-time reservation and processing-time locking.
---

Reserve a verified batch when an upload session begins, keep that reservation through transcription-record creation, and retain the transactional processing-row lock as the final invariant.

**Why:** Locking only when the processing row is created allows the file uploader and browser recorder to transfer concurrently. One recording is then rejected only after its upload finishes, causing avoidable data loss and re-upload work.

**How to apply:** Any new verified input path must participate in the shared client busy state and the server upload-session reservation. Direct or alternate API paths must still pass the transactional one-processing-record check.