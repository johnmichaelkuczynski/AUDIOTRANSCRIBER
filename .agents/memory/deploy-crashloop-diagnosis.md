---
name: Deploy crash-loop diagnosis (healthcheck 500 + port never opened)
description: How to read "healthcheck returned 500" + "not all artifact ports opened detected=0" in autoscale deploys.
---

# Deploy crash-loop: healthcheck 500 + port never opened

When an autoscale deploy crash-loops with system logs showing `healthcheck /api returned status 500`
**together with** `not all artifact ports opened within timeout detected=0 expected=[PORT]`, the app
process is **crashing at startup before it binds the port** — the router returns 500 in its place.
This is NOT a build/path mismatch, even if a user pastes an error suggesting `node dist/index.cjs`
MODULE_NOT_FOUND from another cloned app.

**Why:** In this pnpm-workspace + artifact router setup, the deploy run command comes from each
artifact's `.replit-artifact/artifact.toml` (`[services.production.run]`), not a manual `.replit`
run command. The api-server build correctly emits `dist/index.mjs` (ESM, via esbuild `build.mjs`),
and the toml already points there. So `.cjs`/path narratives are usually noise from a different repl.

**Most common real cause:** a module-level throw at import time. The OpenAI AI integration client
(`lib/integrations-openai-ai-server/src/*/client.ts`) throws immediately if
`AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` are missing. If a deploy was
built/run before `setupReplitAIIntegrations` was called, the server never binds → crash loop.
Object-storage env checks are lazy (empty constructor), so those do NOT crash startup.

**How to apply / verify quickly:**
- Confirm build output: `pnpm --filter @workspace/api-server run build` then `ls artifacts/api-server/dist/` (expect `index.mjs`).
- Smoke-test the exact prod command locally: `PORT=8099 NODE_ENV=production node --enable-source-maps artifacts/api-server/dist/index.mjs`, then `curl /api/healthz` (expect `200 {"status":"ok"}`). Binding cleanly = crash loop fixed.
- Ensure integration + object storage are provisioned (global secrets, available in prod) and DB schema pushed before republish.
