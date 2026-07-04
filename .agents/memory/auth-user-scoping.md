---
name: Auth requires per-user data scoping
description: Adding login to an app with a shared global table is incomplete until every query is user-scoped, or you ship an IDOR.
---

When adding authentication to an existing app whose data tables were previously global (no owner column), gating routes behind `requireAuth` is NOT enough. Any signed-in user can still read/mutate every other user's rows by ID.

**Why:** Broken access control / IDOR. Login without ownership enforcement gives a false sense of security — the review will (correctly) fail the task.

**How to apply:**
- Add a nullable `userId` (text) column to each previously-global table; populate from the auth identity (`req.userId` from Clerk `getAuth`) on insert.
- Filter EVERY read/update/delete by user: `WHERE id = :id AND user_id = :userId`; list/stats filtered by `user_id`. Cross-user access then naturally returns 404.
- Push schema (`pnpm --filter @workspace/db run push`) and restart the API workflow so the bundled schema picks up the new column.
- Verify with two separate accounts that data is isolated end-to-end.
