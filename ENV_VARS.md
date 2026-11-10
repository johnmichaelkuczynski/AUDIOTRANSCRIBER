# Environment variables

Set these as runtime variables in Coolify, not Docker build arguments. Do not commit secret values. Names are case-sensitive: use `OPENAI_API_KEY`, not `openai_api_key`. The application calls providers directly; no Replit AI proxy or managed credentials are used. No secrets are needed to build the image.

## Required to start

| Variable | Expected value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@HOST:5432/DATABASE` | PostgreSQL connection URL. Reuse your existing Neon database to retain transcripts, or supply a separate PostgreSQL database. For Neon/public TLS connections, use the provider's URL with `sslmode=verify-full`. URL-encode special characters in passwords. A database with the application schema is required for working API operations. |

`NEON_DATABASE_API` and `NEON_DATABASE_URL` are legacy, direct-PostgreSQL connection-string aliases. For compatibility with the existing installation, precedence is `NEON_DATABASE_API`, then `NEON_DATABASE_URL`, then `DATABASE_URL`. Set only `DATABASE_URL` in Coolify to avoid ambiguity. They are not Replit integrations, HTTP API endpoints, or Neon management API keys. Prefer `DATABASE_URL` for new installations. Missing all three fails startup explicitly; missing AI keys does not.

## Runtime settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Set to `production` by Docker and `pnpm start` | Enables static frontend serving and JSON logging. |
| `PORT` | `5000` | Integer 1–65535. HTTP listens on `0.0.0.0`; Traefik terminates HTTPS. Keep Coolify's internal target port aligned. |
| `STORAGE_DIR` | `/data/objects` in Docker; `./data/objects` otherwise | Persistent audio directory. Mount a persistent volume at `/data`; writable by UID/GID 1000. Relative paths resolve from the process working directory. |
| `STATIC_DIR` | `artifacts/transcriber/dist/public` | Built frontend directory, relative to the process working directory or absolute. Start from repository root. |
| `LOG_LEVEL` | `info` | Pino log level, e.g. `debug`, `info`, `warn`, `error`. |
| `RESUME_JOBS_ON_START` | Enabled unless exactly `false` | Resume/sweep persisted coherence jobs. Set `false` for smoke tests against a shared database to avoid running background generation. Normally leave unset. |

## Optional provider credentials — required only for their features

| Variable | Expected value | Feature |
| --- | --- | --- |
| `ASSEMBLYAI_API_KEY` | Direct AssemblyAI API key | All audio transcription, diarization, and the two-run verified workflow. |
| `OPENAI_API_KEY` | Direct OpenAI API key | OpenAI text transforms, transcript polishing, coherence and play generation. |
| `ANTHROPIC_API_KEY` | Direct Anthropic API key | Anthropic model choices in text transformation. |
| `DEEPSEEK_API_KEY` | Direct DeepSeek API key | DeepSeek model choices in text transformation. |
| `VENICE_API_KEY` | Direct Venice API key | Venice model choices in text transformation. |

Clients are initialized when a feature is requested. An unconfigured provider returns an explicit feature error rather than preventing the server from starting. Full in-app diagnostics intentionally report missing feature credentials as failed checks; `/api/healthz` is a lightweight startup/liveness check that does not spend API credits.

## Build/development variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_PATH` | `/` | Vite public asset base, also for the optional design sandbox. Production deployment is supported at the domain root; keep `/` for Coolify. |
| `PORT` | `5173` for Vite | Development/preview port only. The production HTTP server defaults to 5000. |
| `import.meta.env.BASE_URL` | Derived from `BASE_PATH` by Vite | Compiled frontend routing prefix, not a separately configured runtime variable. |
| `PUPPETEER_SKIP_DOWNLOAD` | `true` in Docker | Installer safeguard; Puppeteer is not currently an application dependency. |
| `npm_config_user_agent` | Set by pnpm | Package-manager hook checks that pnpm is used. Do not configure manually. |

## Not used

`PUBLIC_BASE_URL`, `SESSION_SECRET`, Google OAuth, Clerk, Stripe, `REPLIT_*`, `REPL_ID`, `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL`, `PRIVATE_OBJECT_DIR`, `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, and `PUBLIC_OBJECT_SEARCH_PATHS` are not read by this application. Do not copy these into Coolify. There is no active login/session/OAuth flow; historical user/login tables are preserved to avoid deleting data. Express trusts exactly one reverse-proxy hop. If login is added later, use a fixed `PUBLIC_BASE_URL` for callbacks, production secure/httpOnly/sameSite-lax cookies, session `proxy: true`, save sessions before redirects, and log callback errors.
