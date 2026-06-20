---
name: MediaRecorder recording reliability
description: Pitfalls when building in-browser audio recording (getUserMedia + MediaRecorder) that cause Stop to hang or recordings to be lost.
---

# In-browser audio recording reliability

Building a recorder with `getUserMedia` + `MediaRecorder` has two non-obvious failure modes that leave the UI frozen on the "Recording…" state after the user clicks Stop.

## 1. A "disposed" guard ref set in effect cleanup must be reset on mount
If you add `disposedRef.current = true` in a `useEffect` cleanup to prevent post-unmount work, you MUST also set `disposedRef.current = false` at the top of the effect body. Otherwise, under React StrictMode (mount → cleanup → re-mount on the same refs) or fast-refresh/HMR, the cleanup sets it `true` and nothing ever resets it, so every later callback that early-returns on `disposedRef.current` (e.g. `recorder.onstop`) silently bails — the recording never finalizes.

**Why:** refs persist across StrictMode's simulated unmount/remount and across HMR fast-refresh, so a one-way `true` flip is permanent.

## 2. `MediaRecorder.onstop` is not reliable on its own (especially in iframes)
The Replit preview runs the app inside an iframe; `onstop` can fail to fire there. Do not depend solely on `onstop` to assemble the blob / transition UI. Pattern that works:
- `recorder.start(1000)` with a timeslice so `ondataavailable` accumulates chunks every second (don't wait for a single flush at stop).
- An idempotent `finalize()` (guarded by a `finalizedRef`) that assembles the blob from already-collected chunks.
- Call `finalize()` from `onstop` AND `onerror`, AND from a fallback `setTimeout(~700ms)` armed inside the Stop handler. Whichever fires first wins; the rest no-op.
- Handle `blob.size === 0` explicitly with a visible error ("No audio captured") so an empty/blocked mic is not silent.

**How to apply:** any time you implement browser audio/video recording in this repo's artifacts (they render in an iframe), use the timeslice + idempotent-finalize + fallback-timer pattern rather than the naive `onstop`-only approach.
