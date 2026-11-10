# Coolify deployment

## Deployment configuration

1. Deploy the `main` branch using **Dockerfile**, repository base directory `/`, Dockerfile `/Dockerfile`.
2. Use a Linux ARM64 server. The official Node 22 Debian image and restored native dependencies support `linux/arm64`; no x86-only image, native binary, or dependency override is pinned. For a separate CI builder: `docker buildx build --platform linux/arm64 -t transcriber:latest --load .`.
3. Set internal port **5000**, domain `https://your-domain.example`, and route the entire domain to this container (both `/` and `/api`). Traefik supplies TLS and forwarded headers. Do not enable HTTPS inside Node or expose the container directly to untrusted traffic: Express trusts one proxy hop.
4. Add runtime `DATABASE_URL`, plus `ASSEMBLYAI_API_KEY` and `OPENAI_API_KEY` for full transcription/generation. Add other provider keys only if you use those model choices. See `ENV_VARS.md`.
5. Mount a named persistent volume at **`/data`**, and ensure ownership is UID/GID **1000:1000**. A newly initialized Docker named volume inherits the image's ownership. For a host bind mount, prepare permissions on the host first. Never store audio only in the container's writable layer. Back up both PostgreSQL and this volume.
6. Use one replica, and stop/drain uploads and running transcription jobs before deployments. Chunk-upload reservations and temporary chunks are process-local. Coherence jobs have database resume support; in-flight audio transcription is not restart-resumable. Do not enable rolling overlap for this single-instance app.
7. Health check: HTTP `GET /api/healthz`, port 5000. The Docker image includes this check. Configure Coolify to use it rather than a login page. Health is liveness only; run in-app diagnostics separately after setting provider keys.
8. For a fresh database, initialize the schema before accepting traffic: run **`cd /app/lib/db && node node_modules/drizzle-kit/bin.cjs push --config ./drizzle.config.ts`** in the container terminal with `DATABASE_URL` set, or run `pnpm db:push` in a trusted development environment connected to the target database. This is deliberately not an automatic/destructive migration on every restart. Reusing the existing Neon database needs no data copy or schema change. If applying future schema changes, back up first and review Drizzle's proposed changes; never use `--force` blindly.
9. Deploy. The image command is `node --enable-source-maps artifacts/api-server/dist/index.mjs`; it serves the built frontend and API from one process on `0.0.0.0:5000`. Leave Coolify's start-command override empty so Docker's CMD is used. No pnpm launcher, Vite server, Replit proxy, Replit storage, or Replit AI service is required at runtime.

The Docker build upgrades npm to 11 first, installs pinned pnpm, installs workspace dependencies exactly once with the frozen lockfile, and builds. The runtime reuses application dependencies, but does not copy global npm/pnpm launchers from the builder. Schema tools can be invoked directly with Node. No secrets belong in build arguments or the image.

## Large uploads and reverse-proxy behavior

The browser sends retryable 8 MiB audio chunks; allow at least 10 MiB request bodies at every upstream proxy. Direct uploads support up to 1 GiB and need a larger request limit if used. Avoid buffering huge direct uploads in Traefik; chunked uploads are preferred. Allow sufficient proxy timeouts for long text-transform responses (e.g. 15 minutes where operationally appropriate). Async audio jobs return promptly and are polled. Allocate temporary disk space for incoming audio, converted/split audio, and the persistent copy. Browser microphone capture requires a secure HTTPS origin.

## Existing recordings must be migrated separately

PostgreSQL contains transcripts and object keys, not audio bytes. Changing hosts does not copy audio out of the old storage service. This repository does not embed private hearing recordings in its Docker image.

Export the old private storage prefix while the old environment is available. Copy its contents into `/data/objects`, preserving the key suffix: a database `audio_path` of `/objects/uploads/UUID` maps to `/data/objects/uploads/UUID`. Do not prepend the old bucket name or private prefix. Preserve the database value unchanged. For each file, optionally add a neighboring `UUID.json` containing `{"contentType":"audio/mpeg"}` (use the original MIME type). Without that metadata, downloads still work as `application/octet-stream`; MIME metadata is recommended for playback. New uploads create metadata automatically.

Verify representative old recordings play/download before retiring the original environment. Back up data first; this change does not delete or migrate the original bucket or database. If you supply a new PostgreSQL database, export/import the original database using your PostgreSQL tooling as well.

## Access model

The app remains unauthenticated as requested: anyone with network access can view, download, and delete stored transcripts/audio. For private legal material, restrict access at the network or reverse-proxy level before exposing it publicly. No authentication redesign is included.

## Assets and local verification

No application source imports `@assets/...` or reads a file from `attached_assets/`; only an unused Vite alias existed. Public UI assets live in `artifacts/transcriber/public` and are tracked. There are therefore no required `attached_assets` files to force-add. Private hearing samples and generated transcripts are excluded from Docker context. If future code adds an asset reference, force-add that exact required file and explicitly include it in `.dockerignore`.

Local production verification:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:deployment
pnpm start
```

Run from repository root with a valid `DATABASE_URL` and prepared schema. `test:deployment` starts an isolated production process with optional provider keys deliberately omitted, disables background job resumption, validates the UI/API and storage, then terminates its own process. It does not transcribe audio or call AI services.
