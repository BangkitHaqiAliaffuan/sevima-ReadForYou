<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Commands
- `npm run dev` — dev server (regenerates block above; commit it with work)
- `npm run build` / `npm start` — production build / serve
- `npm run lint` — eslint (flat config, `eslint-config-next` core-web-vitals + typescript)
- Typecheck: `npx tsc --noEmit` (no `typecheck`/`test` script, no test runner, no CI)
- Full verification before declaring done: `npx tsc --noEmit && npm run lint && npm run build`
- Probes (need network / live keys, run manually, never in build):
  `node --experimental-strip-types scripts/probe-tts.mts` (Edge TTS + Indonesian voices),
  `... scripts/probe-gemini.mts`, `... scripts/probe-supabase.mts`, `... scripts/probe-supabase-deep.mts`

# Structure
- App Router: `app/layout.tsx`, `app/page.tsx`, `app/api/{process-document,tts,voices}/route.ts`
- `components/UploadModule.tsx`, `components/AudioPlayer.tsx`, `components/LiveStatus.tsx`
- `hooks/useServerAudio.ts` (sentence queue + preload + speechSynthesis fallback), `hooks/useAnnouncer.ts`
- `lib/supabase.ts`, `lib/gemini.ts`, `lib/rate-limit.ts`, `lib/chunk-text.ts`, `lib/validate-file.ts`, `lib/api-error.ts`, `lib/tts/{synthesize,estimate}.ts`
- Path alias: `@/*` → repo root (`./*`), per `tsconfig.json`
- Styling: Tailwind v4 — `@import "tailwindcss"` in `app/globals.css` (NO `tailwind.config.ts` — v4 ignores it)
- Stack: Next 16.3.6, React 19, TS strict. Keep `LayoutProps<"/">` on root layout (Next 16 convention).
- Supabase DDL + RLS + bucket lives in `supabase/schema.sql` — run whole file in SQL Editor on new project.

# Env & secrets
- Setup: `cp .env.local.example .env.local`, fill Supabase URL/anon key + `SUPABASE_SERVICE_ROLE_KEY` + `GEMINI_API_KEY`; `.env*` is gitignored, never commit.
- `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` are SERVER ONLY — never add `NEXT_PUBLIC_` prefix. `lib/supabase.ts:assertServerOnly` throws if service client is called from browser.
- Model chain is env-driven: `GEMINI_MODEL` + `GEMINI_FALLBACK_MODELS` (+ `MAX_CHUNKS_PER_DOCUMENT`). No TTS key exists — `msedge-tts` uses Edge Read Aloud WebSocket directly.
- Bucket `modules` is private, 20 MB cap, PDF/JPEG/PNG/WEBP only — must match `MAX_FILE_BYTES` in `lib/validate-file.ts`.

# CRITICAL: process.env must use literal keys in browser-reachable code
- Turbopack/webpack only inlines `process.env` into the browser bundle when the key is literal (`process.env.NEXT_PUBLIC_X`). Computed access (`process.env[name]`) is NEVER inlined → always `undefined` in the browser (Node/server unaffected).
- `lib/supabase.ts` is imported by Client Components — `readPublicEnv`/`readServiceEnv` use literal access by design. Never refactor into generic `readEnv(name)`; that exact bug broke all uploads with "Konfigurasi Supabase publik belum lengkap" despite a complete `.env.local`.
- Exception: `scripts/probe-*.mts` run in Node, computed access is fine there.

# CRITICAL: msedge-tts is server-only — do not leak into client bundle
- `lib/tts/synthesize.ts` imports `msedge-tts` (`fs`, `stream`, WebSocket). Any client-component import of it fails build with `Module not found: Can't resolve 'fs'`.
- **Neither `tsc` nor `eslint` catches this** — only `npm run build` does. Always build before declaring work done.
- Client-safe: `lib/tts/estimate.ts`. Pure helpers (`chunk-text.ts`, `validate-file.ts`, `api-error.ts`) must never import `synthesize.ts`.

# Gemini model gotchas
- `@google/genai` v2: `responseSchema` is DEPRECATED → use `responseJsonSchema` with standard JSON Schema (lowercase `type: 'object'`). See `lib/gemini.ts`.
- `gemini-1.5-flash` is SHUT DOWN; `gemini-2.0-flash` shut down 2026-06-01. Default `gemini-3.8-flash` + fallbacks, auto-switch on 404/not-supported. Ref: https://ai.google.dev/gemini-api/docs/deprecations
- Hard output ceiling ~65k tokens: `extractDocument` warns on PDFs > ~60 estimated pages and surfaces truncation via `ada_bagian_gagal`. Always pass normalized `kind` through (a past bug dropped it).

# Validation, rate limits, errors
- Files: client check (`validateFileOnClient`) is UX-only; server re-validates via magic bytes (`validateFileOnServer`) — never trust `File.type`. Keep both in sync.
- Rate limiter is in-memory (`lib/rate-limit.ts`): extraction 20/min, TTS 120/min — use distinct `keyPrefix` per route (TTS is per-sentence, sharing a bucket starves extraction). Multi-instance deploys multiply the limit; swap file for Redis in production.
- API errors go through `AppError` codes in `lib/api-error.ts` — reuse codes, don't invent ad-hoc shapes.

# Accessibility contract (project's core requirement — do not regress)
- `aria-disabled`, NOT `disabled`, on playback buttons (keeps tab order/focus).
- File input hidden with `sr-only` (clip-rect), never `display:none`/`hidden`.
- Two separate live regions: `role="status"` for progress, `role="alert"` for errors. Focus moved in `useEffect`, never in the handler.
- All icons `aria-hidden="true"` + `focusable="false"` with visually hidden text; touch targets ≥ 44px (`min-h-11`).
- `app/layout.tsx`: keep `lang="id"`, skip link as first focusable element, `maximumScale: 5` (never 1 — kills zoom, WCAG 1.4.4).

# MVP auth warning
- No Supabase Auth yet: `mvp_anon_*` RLS policies let anon upload/insert. Bucket has NO anon SELECT (server downloads via service_role). Do not add anon read policies or ship to production without auth — see README "Mengaktifkan Auth" (`owner_*` policies + `createRouteHandlerSupabase` are ready).
