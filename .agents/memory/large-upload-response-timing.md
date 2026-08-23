---
name: Large upload response timing
description: Why large audio uploads can look timed out and the required staging behavior.
---

Large audio requires two independent layers of chunking:

1. The browser sends the file in retryable 8 MB requests instead of one large request.
2. After assembly, the server divides audio into fixed two-minute intervals, transcribes them sequentially, and persists each completed interval immediately while the overall record remains processing.

After the server assembles the upload, create the processing record and return it before copying the file to object storage. Run object-storage persistence and segmented provider transcription concurrently in the background.

**Why:** Waiting for a second full copy before responding made a successful 396 MB upload hold the request open for roughly 90 seconds. A later large upload was dropped before reaching the API at all. Users also must see finished intervals instead of waiting hours for an all-or-nothing result.

**How to apply:** Use retryable/idempotent upload chunks with visible progress. For transcription, keep two-minute interval order, retry each interval, update the database after every completed interval, and let UI polling print partial text. Preserve temporary files until background operations settle and clean up orphaned audio.