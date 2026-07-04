---
name: Clerk managed prod publish provisioning
description: Why a Replit-managed Clerk app's first publish can "fail to publish" even though the build succeeds, and how to diagnose it.
---

# Clerk managed-Clerk first-publish failure (proxy-health 404)

A Replit-managed Clerk app can report "build failed to publish" while the build actually **succeeded**. The failure is at the publish/promote stage, driven by Clerk's production proxy validation — not the build.

## How to diagnose (fast path)
- `listDeploymentBuilds` + `getDeploymentBuild(id)` (deployment-failure-debugging skill) show the real build logs. If they show both artifacts building and "Deployment successful", the build is NOT the problem — stop chasing build/typecheck/lockfile/deps.
- `fetchDeploymentLogs` for the failed deploy's time window: look for repeated `GET /api/__clerk/v1/proxy-health → 404`. That is Clerk's production proxy health check failing. The app's own startup probe (`/api/healthz`) passes (200), so Replit logs "Deployment successful", then marks the publish **failed** ~3 min later when Clerk proxy validation never returns 200. The previous (pre-Clerk) version keeps serving.

## Root cause
Replit-managed Clerk uses `pk_test`/`sk_test` in dev and **swaps in live keys + registers the proxy URL at publish time** ("separate system"; not visible from dev). On the first Clerk-enabled publish this provisioning may not be in place yet, so the deployed proxy 404s on proxy-health.

**Why:** production Clerk setup is platform-managed and finalized during publish, not baked into dev secrets/code.

## Fix
- Do NOT change code if it already matches canonical (verify: `clerkProxyMiddleware.ts` byte-identical to the skill template; `ClerkProvider` has `publishableKey` + `proxyUrl`; `app.ts` mounts proxy before `express.json` with `clerkMiddleware`; api-server `artifact.toml` run.env sets `NODE_ENV=production`).
- Do NOT hand-edit Clerk secrets or add NODE_ENV/PROD gates.
- The fix is to **re-publish** — the live-key swap + proxy registration complete on retry. (Confirmed: re-publishing made prod login work with zero code changes.)
- If it still fails after retry, per skill: update `@clerk/*` to latest allowed by `minimumReleaseAge`, re-diff against canonical, then check Clerk production setup via the Auth pane.
