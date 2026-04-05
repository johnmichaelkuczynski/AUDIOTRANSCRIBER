# MP3 Transcriber

## Overview

An audio transcription web app. Users upload MP3/WAV/M4A/OGG files and get AI-powered text transcriptions. Built as a pnpm workspace monorepo.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS
- **AI**: OpenAI (via Replit AI Integrations) — `gpt-4o-mini-transcribe` for speech-to-text
- **File uploads**: Multer (memory storage, 50MB limit)

## Architecture

- `artifacts/transcriber/` — React frontend (upload UI, transcription list, stats)
- `artifacts/api-server/` — Express backend with transcription routes
- `lib/integrations-openai-ai-server/` — OpenAI SDK wrapper for audio transcription
- `lib/db/` — Drizzle ORM schema (transcriptions table)
- `lib/api-spec/` — OpenAPI spec (source of truth)
- `lib/api-client-react/` — Generated React Query hooks
- `lib/api-zod/` — Generated Zod validation schemas

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## API Endpoints

- `POST /api/transcriptions` — upload audio file (multipart/form-data), creates transcription
- `GET /api/transcriptions` — list all transcriptions
- `GET /api/transcriptions/:id` — get single transcription
- `DELETE /api/transcriptions/:id` — delete transcription
- `GET /api/transcriptions/stats` — transcription statistics

## Database Schema

- `transcriptions` table: id, filename, file_size, text, status (processing/completed/failed), error_message, created_at

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
