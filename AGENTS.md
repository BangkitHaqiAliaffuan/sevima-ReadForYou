<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Commands
- `npm run dev` / `npm run build` / `npm start`; `npm run lint` (flat config, `eslint-config-next`)
- No `typecheck`/`test` script, no test runner, no CI. Typecheck: `npx tsc --noEmit`
- Full verification before declaring done: `npx tsc --noEmit && npm run lint && npm run build`
- Probes need network + live keys, run manually, never in build:
  `node --experimental-strip-types scripts/probe-{tts,gemini,supabase,supabase-deep}.mts`

# Structure (non-obvious only)
- `app/api/process-document/route.ts` = Gemini extraction; `tts/route.ts` = per-sentence synthesis; `voices/route.ts` = cached Indonesian voice list
- `hooks/useSession.ts` is the sole auth-state source; `hooks/useServerAudio.ts` owns the sentence queue + preload + `speechSynthesis` fallback; `middleware.ts` only refreshes Supabase cookies, never blocks guests
- `@/*` → repo root (`./*`), not `./src/*`. Tailwind v4: `@import "tailwindcss"` in `app/globals.css`, no `tailwind.config.ts`
- Next 16: keep `LayoutProps<"/">` on root layout. Supabase DDL + RLS + bucket: run whole `supabase/schema.sql`, then `supabase/migration_auth_anon.sql`, in SQL Editor on new projects

# Stale prose (trust code over these)
- `README.md` §"Keputusan..." point 1 ("berjalan tanpa autentikasi") is pre-auth — auth exists now, see Auth model below.
- `lib/supabase.ts` header comments ("MVP belum memakai Auth", "disiapkan untuk saat Auth ditambahkan") are stale — the cookie-based route-handler client is live and used.

# Provider LLM (9router saat dev → Gemini sebagai jaring)
- Titik masuk tunggal: `lib/llm.ts` — `extractDocumentWithFallback` (dokumen) & `generateTextWithFallback` (teks bebas, dipakai `lib/qa.ts`). `*Detailed` mengembalikan metadata provider. Jangan panggil `lib/gemini.ts` langsung dari route: nama `*WithGemini` menandai "ini satu lapis provider", bukan "ini seluruh app".
- Urutan provider dari `LLM_PROVIDER_ORDER` (default `9router,gemini`), dibaca kiri-ke-kanan. Provider yang kuncinya kosong **dilewati**, bukan menggagalkan permintaan → app tetap jalan dari clone bersih (Gemini-only) atau tanpa Gemini (9router-only).
- 9router = gateway OpenAI-compatible via `fetch` ke `LLM_BASE_URL` (`/chat/completions`). **Tidak memakai SDK OpenAI** — sengaja, hanya satu rute & bentuk permintaan sederhana.

# CRITICAL: 9router TIDAK bisa baca PDF — render dulu ke gambar
- Endpoint `chat/completions` hanya menerima **GAMBAR** di `image_url`. PDF di `image_url` → `400 model_param_invalid`.
- Part `file`, `file_data`, dan `input_file` semuanya **diterima HTTP 200 tapi isinya TIDAK sampai ke model**: model menjawab "berkas tidak dilampirkan" atau, lebih berbahaya, **MENGARANG** isi dokumen dengan yakin. Tidak ada error yang muncul — ini kegagalan senyap.
- Karena itu `lib/llm.ts` merender PDF → PNG per halaman lebih dulu (`lib/pdf-render.ts`, `pdftoppm`/Poppler) dan mengirim tiap halaman sebagai `image_url` + `image/png`. Ini **bukan optimasi**, syarat agar AI-nya bisa dipakai.
- Gambar asli (JPG/PNG/WEBP) dikirim langsung tanpa render — jalur itu memang bekerja.
- Bila `pdftoppm` tidak ada, `renderPdfPages` melempar `AppError('CONFIG')` dengan instruksi pemasangan; provider chain lalu jatuh ke Gemini yang menerima PDF native. **Jangan** kembalikan perilaku "kirim PDF apa adanya ke 9router".
- Bukti lengkap: `scripts/probe-9router-pdf.py` (A: image_url 400 · B: file kosong · C: file_data mengarang · D: PNG ok).
- Batas halaman render: `MAX_RENDERED_PAGES` (40) di `lib/pdf-render.ts`; DPI 150.

# Diagnostik: pesan error TIDAK boleh buta
- `AppError.toBody()` mengisi `debug` (rincian penyebab) **hanya bila `NODE_ENV !== 'production'`**. Di produksi `detail` tetap tersembunyi — jangan hapus gerbang itu.
- `lib/llm.ts` mengklasifikasikan galat jadi `FailureReason`: `quota` | `auth` | `network` | `bad-request` | `missing-key` | `timeout` | `empty` | `unknown`, dan `describeFailure()` merangkainya jadi pesan multi-baris yang bisa ditindaklanjuti. Ini yang mengubah "AI bermasalah" menjadi "9router: jaringan mati · gemini: kuota habis".
- Klasifikasi WAJIB menelusuri `err.cause` berantai (`collectErrorText`), bukan hanya `err.message`.
- Diagnostik: `curl -X POST localhost:3000/api/llm/test` (teks) dan `curl -X POST 'localhost:3000/api/llm/test?mode=extract'` (menjalankan pipeline ekstraksi nyata). Aktif bila `NODE_ENV !== 'production'` atau `ALLOW_LLM_TEST=1`; balas 404 di luar itu.
- `AppError` menyimpan `detail` sebagai field publik; `ERROR_SPECS[code].message` tetap pesan ramah untuk pengguna. Jangan pernah memakai `detail` sebagai pesan yang dibacakan.
- **Ketergantungan sistem:** Poppler (`pdftoppm`) harus terpasang di server untuk ekstraksi PDF via 9router: `sudo apt install poppler-utils`. Tidak ada di `package.json` karena ini biner sistem, bukan paket npm.

# Env & secrets
- Setup: `cp .env.local.example .env.local`, fill Supabase URL/anon key + `SUPABASE_SERVICE_ROLE_KEY` + `GEMINI_API_KEY`; `.env*` is gitignored, never commit.
- `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` are SERVER ONLY — never add `NEXT_PUBLIC_` prefix. `lib/supabase.ts:assertServerOnly` throws if the service client is called from the browser.
- Model chain is env-driven: `GEMINI_MODEL` + `GEMINI_FALLBACK_MODELS` (+ `MAX_CHUNKS_PER_DOCUMENT`). No TTS key exists — `msedge-tts` uses the Edge Read Aloud WebSocket directly.
- Bucket `modules` is private, 20 MB cap, PDF/JPEG/PNG/WEBP only — must match `MAX_FILE_BYTES` in `lib/validate-file.ts`. Bucket name overridable via `SUPABASE_BUCKET` / `NEXT_PUBLIC_SUPABASE_BUCKET` (`lib/supabase.ts:STORAGE_BUCKET`).

# CRITICAL: process.env must use literal keys in browser-reachable code
- Turbopack/webpack only inlines `process.env` into the browser bundle when the key is literal (`process.env.NEXT_PUBLIC_X`). Computed access (`process.env[name]`) is NEVER inlined → always `undefined` in the browser (Node/server unaffected).
- `lib/supabase.ts` is imported by Client Components — `readPublicEnv`/`readServiceEnv` use literal access by design. Never refactor into generic `readEnv(name)`; that exact bug broke all uploads with "Konfigurasi Supabase publik belum lengkap" despite a complete `.env.local`.
- Exception: `scripts/probe-*.mts` run in Node, computed access is fine there.

# CRITICAL: msedge-tts is server-only — do not leak into client bundle
- `lib/tts/synthesize.ts` imports `msedge-tts` (`fs`, `stream`, WebSocket). Any client-component import of it fails build with `Module not found: Can't resolve 'fs'`.
- **Neither `tsc` nor `eslint` catches this** — only `npm run build` does. Always build before declaring work done.
- Client-safe: `lib/tts/estimate.ts`. Pure helpers (`chunk-text.ts`, `validate-file.ts`, `api-error.ts`) must never import `synthesize.ts`.

# API routes & TTS constraints
- `process-document` and `tts` routes must stay `runtime = 'nodejs'` + `dynamic = 'force-dynamic'` (msedge-tts needs WebSocket/Buffer; edge runtime breaks). Keep `maxDuration` 120 (process-document) / 30 (tts) — do not lower. `voices` is the exception: `runtime = 'nodejs'` + `revalidate = 3600` (cached voice list, no `force-dynamic`).
- TTS is per-sentence: one `POST /api/tts` per sentence, each ≤ `MAX_TTS_CHARS` (1000, see `lib/tts/synthesize.ts`). Voice must start with `id-ID-` (default `id-ID-ArdiNeural`); other locales are rejected as `INVALID_VOICE`.
- `hooks/useServerAudio.ts` falls back to `speechSynthesis` after 3 consecutive TTS failures (`FAILURES_BEFORE_FALLBACK`) — keep that fallback path working.
- Playback honesty is a correctness rule, not polish: `SpeechState` has `'stalled'`; `runQueue` counts `playedCount` and must NEVER report completion (`ended`/`onComplete`) when 0 sentences played — route to `onInterrupted` instead. Stall watchdog: frozen `currentTime` 10s (`STALL_AFTER_MS`); fetch ceiling 25s (`FETCH_CEILING_MS`). Generation is owned by `runQueue` only — `playSingle` verifies, never bumps.

# Gemini model gotchas
- `@google/genai` v2: `responseSchema` is DEPRECATED → use `responseJsonSchema` with standard JSON Schema (lowercase `type: 'object'`). See `lib/gemini.ts`.
- `gemini-1.5-flash` is SHUT DOWN; `gemini-2.0-flash` shut down 2026-06-01. Default `gemini-3.8-flash` + fallbacks, auto-switch on 404/not-supported. Ref: https://ai.google.dev/gemini-api/docs/deprecations
- Hard output ceiling ~65k tokens: `extractDocument` warns on PDFs > ~60 estimated pages and surfaces truncation via `ada_bagian_gagal`. Always pass normalized `kind` through (a past bug dropped it).

# Validation, rate limits, errors
- Files: client check (`validateFileOnClient`) is UX-only; server re-validates via magic bytes (`validateFileOnServer`) — never trust `File.type`. Keep both in sync.
- Rate limiter is in-memory (`lib/rate-limit.ts`): extraction defaults to 20/min (no prefix), TTS 120/min with `keyPrefix: 'tts'` — keep them on distinct buckets (TTS is per-sentence; sharing one starves extraction). Multi-instance deploys multiply the limit; swap file for Redis in production.
- API errors go through `AppError` codes in `lib/api-error.ts` — reuse codes, don't invent ad-hoc shapes. `detail` arg is server-log only, never sent to client.

# Accessibility contract (project's core requirement — do not regress)
- `aria-disabled`, NOT `disabled`, on playback buttons (keeps tab order/focus).
- File input hidden with `sr-only` (clip-rect), never `display:none`/`hidden`.
- Two separate live regions: `role="status"` for progress, `role="alert"` for errors. Focus moved in `useEffect`, never in the handler.
- All icons `aria-hidden="true"` + `focusable="false"` with visually hidden text; touch targets ≥ 44px (`min-h-11`).
- `app/layout.tsx`: keep `lang="id"`, skip link as first focusable element, `maximumScale: 5` (never 1 — kills zoom, WCAG 1.4.4).

# Auth model (anon + email, guest allowed)
- Entry: `components/AuthPanel.tsx` (1-tap `signInAnonymously`, upgrade via `updateUser({email,password})` — NOT `linkIdentity`, which in installed auth-js only supports OAuth/IdToken), session via `hooks/useSession.ts`, cookie refresh in `middleware.ts`.
- Upload scope is `user.id ?? 'anonim'` and insert sets `user_id` (`app/page.tsx`); storage prefix enforced server-side too. Run `supabase/schema.sql` then `supabase/migration_auth_anon.sql` on the project (narrows `mvp_anon_select` to `user_id IS NULL`, locks anon uploads to `anonim/`).
- `app/api/process-document/route.ts` verifies ownership (`row.user_id === session uid`, legacy NULL rows allowed session-less) and keys rate limit per `user:<id>` (guests per IP). `/api/tts` stays IP-limited on purpose (per-sentence `getUser` would be wasteful; no user data involved).
- Dashboard prerequisite: enable Anonymous Sign-Ins + Email providers, or guest sign-in fails with a friendly message.

# File claims (multi-session — WAJIB sebelum edit file apa pun)
- `claims.md` di root adalah registry-nya. SEBELUM mengedit: baca `claims.md` dulu.
- Tanpa baris = bebas → tulis baris `claimed` (Owner = id sesimu, cth `2026-09-26-topik`, + Updated hari ini) SEBELUM menyentuh file. Klaim semua file target di awal, bukan satu-per-satu.
- `done` = boleh edit (ganti dulu ke `claimed` milikmu). `claimed` milik sesi lain yang fresh (<30 menit) = JANGAN sentuh — tunggu atau tanya user via question tool.
- Klaim >30 menit tanpa update = stale → boleh ambil alih, catat di kolom Note.
- Selesai + terverifikasi (`tsc`/`lint`/`build`) → ubah ke `done` + tulis bukti (hash commit) di Note.
- Jangan klaim: `claims.md` itu sendiri (edit langsung tanpa klaim), `/docs/`, `.env*`, file untracked milik alur lain.
