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
- TTS probe: `node --experimental-strip-types scripts/probe-tts.mts`

# Structure
- Fresh `create-next-app` (App Router): `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `public/`
- Path alias: `@/*` → repo root (`./*`), per `tsconfig.json`
- Styling: Tailwind CSS v4 — `@import "tailwindcss"` in `globals.css`, `@theme inline` tokens, `@utility` for custom classes (NO `tailwind.config.ts` — v4 ignores it)
- Stack: Next 16.3.6, React 19, TS strict, `LayoutProps<"/">` typed layout (Next 16 convention — keep it)
- TTS: `msedge-tts@2.0.8` via `lib/tts/synthesize.ts` → `app/api/tts/route.ts`. SERVER ONLY.
- Features built: document upload → Gemini extraction → per-sentence Edge TTS playback

# CRITICAL: msedge-tts is server-only — do not leak into client bundle

`lib/tts/synthesize.ts` imports `msedge-tts`, which requires `fs`, `stream`,
and WebSocket (Node built-ins). If any client component imports from
`synthesize.ts`, the whole server chain enters the browser bundle and
`npm run build` fails with:

```
Module not found: Can't resolve 'fs'
```

**Neither `tsc` nor `eslint` catches this** — both only check types, not the
module graph. Only `next build` catches it. Always run `npm run build` before
declaring work done.

Client-safe shared code lives in `lib/tts/estimate.ts`. Pure helpers
(`chunk-text.ts`, `validate-file.ts`, `api-error.ts`) must never import from
`lib/tts/synthesize.ts`.

# Guest model
- `@google/genai` is v2. `responseSchema` is DEPRECATED → use `responseJsonSchema`
  with standard JSON Schema (lowercase `type: 'object'`, supports `description`,
  `additionalProperties`). See `lib/gemini.ts`.
- `gemini-1.5-flash` is SHUT DOWN by Google. `gemini-2.0-flash` shut down
  2026-06-01. Default here is `gemini-3.8-flash` + fallback chain, both from env vars.
  Ref: https://ai.google.dev/gemini-api/docs/deprecations

# Accessibility contract (project's core requirement — do not regress)
- `aria-disabled`, NOT `disabled`, on playback buttons — buttons with `disabled`
  drop out of tab order and the user loses focus position.
- File input hidden with `sr-only` (clip-rect), never `display:none`/`hidden`
  (those make it unfocusable).
- Two separate live regions: `role="status"` for progress, `role="alert"` for errors.
  Never one shared region.
- All icons: `aria-hidden="true"` + `focusable="false"`, plus visually hidden text.
- Focus moved in `useEffect`, never in the event handler (React hasn't committed DOM yet).
- Touch targets ≥ 44px (`min-h-11`).

# Gotchas
- `.env*` is gitignored; a local `.env` exists — never commit secrets
- No `.github/workflows`, no `opencode.json` — local `npm run build` + `npm run lint` + `npx tsc --noEmit` is the full verification
- `scripts/probe-tts.mts` hits the live Microsoft endpoint; needs network
