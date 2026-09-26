# File claims — koordinasi multi-session (sumber kebenaran: tabel di bawah)

> Aturan main ada di `AGENTS.md` ("File claims"). File ini HANYA data:
> satu baris per file yang pernah/sedang dikerjakan. Tanpa baris = bebas.

| File | Status | Owner | Updated | Note |
|---|---|---|---|---|
| `hooks/useServerAudio.ts` | done | session-playback-stall | 2026-09-26 | Fase 1-2: stalled, watchdog, prefetch gate (commit `75cd264`) |
| `components/AudioPlayer.tsx` | done | session-playback-stall | 2026-09-26 | Label stalled, gate aria-disabled, baris layanan suara (commit `75cd264`) |
| `types/index.ts` | done | session-playback-stall | 2026-09-26 | Tambah `'stalled'` ke `SpeechState` (commit `75cd264`) |
| `app/page.tsx` | done | session-playback-stall + auth-workstream | 2026-09-26 | Hunk playback (`75cd264`) + hunk auth (`912fa5f`) — keduanya commit, tree bersih |
| `AGENTS.md` | done | 2026-09-26-agents-refresh | 2026-09-26 | Refresh selesai; markdown-only, tak sentuh kode (uncommitted) |
| `components/AuthPanel.tsx` | done | auth-workstream | 2026-09-26 | Commit `912fa5f` |
| `components/DocumentHistory.tsx` | done | auth-workstream | 2026-09-26 | Commit `912fa5f` |
| `hooks/useSession.ts` | done | auth-workstream | 2026-09-26 | Commit `912fa5f` |
| `middleware.ts` | done | auth-workstream | 2026-09-26 | Commit `912fa5f` |
| `supabase/migration_auth_anon.sql` | done | auth-workstream | 2026-09-26 | Commit `912fa5f` |
| `app/api/process-document/route.ts` | done | auth-workstream | 2026-09-26 | Ownership + rate-limit per user (commit `912fa5f`) |
| `README.md` | done | auth-workstream | 2026-09-26 | Hunk auth (commit `912fa5f`) |
| `lib/gemini.ts` | done | session-voiceqa | 2026-09-26 | VoiceQA: `generateTextWithFallback` (tsc/lint/build hijau) |
| `lib/qa.ts` | done | session-voiceqa | 2026-09-26 | VoiceQA: berkas baru (tsc/lint/build hijau) |
| `app/api/ask/route.ts` | done | session-voiceqa | 2026-09-26 | VoiceQA: rute baru, ownership+rate-limit (tsc/lint/build hijau) |
| `hooks/useSpeechInput.ts` | done | session-voiceqa | 2026-09-26 | VoiceQA: berkas baru (tsc/lint/build hijau) |
| `types/web-speech.d.ts` | done | session-voiceqa | 2026-09-26 | VoiceQA: deklarasi penuh (lib.dom kosong) |
| `components/VoiceQA.tsx` | done | session-voiceqa | 2026-09-26 | VoiceQA: panel + instans jawaban (tsc/lint/build hijau) |
| `types/index.ts` | done | session-voiceqa | 2026-09-26 | VoiceQA: AskRequest/AskResponse |
| `hooks/useServerAudio.ts` | done | session-voiceqa | 2026-09-26 | VoiceQA: initialVoice/initialRate |
| `components/AudioPlayer.tsx` | done | session-voiceqa | 2026-09-26 | VoiceQA: prop title? |
| `app/page.tsx` | claimed | 2026-09-26-ux-accessible-flow | 2026-09-26 | Progressive disclosure, hotkeys global Alt+P/K/J/R/Q, sentence highlighting (reconciles with voiceqa + auth) |
| `components/UploadModule.tsx` | claimed | 2026-09-26-ux-accessible-flow | 2026-09-26 | Coba modul contoh, visual modern anti-slop, feedback ramah |
| `components/AudioPlayer.tsx` | claimed | 2026-09-26-ux-accessible-flow | 2026-09-26 | Tombol putar primer 56px, aria-keyshortcuts, pembersihan accordion kalimat |
| `lib/sample-document.ts` | claimed | 2026-09-26-ux-accessible-flow | 2026-09-26 | Berkas modul contoh statis instan untuk onboarding tunanetra |
| `tsconfig.json` | claimed | 2026-09-26-ux-accessible-flow | 2026-09-26 | Exclude war-kit dari kompilasi app |
| `components/AuthPanel.tsx` | claimed | auth-workstream | 2026-09-26 | /masuk: prop onDismiss opsional (was done `912fa5f`); tsc/lint/build hijau |
| `components/DocumentHistory.tsx` | claimed | auth-workstream | 2026-09-26 | /masuk: tautan Link /masuk di pesan tamu (was done `912fa5f`); tsc/lint/build hijau |
| `app/masuk/page.tsx` | claimed | auth-workstream | 2026-09-26 | /masuk: server page baru, metadata + searchParams; build mendaftarkan ƒ /masuk |
| `app/layout.tsx` | claimed | auth-workstream | 2026-09-26 | Navbar: pasang <Navbar/>, hapus brand ganda di header |
| `components/Navbar.tsx` | claimed | auth-workstream | 2026-09-26 | Navbar baru: brand + Masuk/daftar highlight + akun & Keluar |
| `app/masuk/MasukClient.tsx` | claimed | auth-workstream | 2026-09-26 | /masuk: redirect permanen + guard open-redirect; tsc/lint/build hijau |
| `lib/llm.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | Selesai. tsc 0 error, build hijau, uji live: 9router dilayani (1264 ms), fallback terbukti via log server. **Bug ditemukan+diperbaiki:** `fetch failed` undici menaruh `ECONNREFUSED` di `err.cause.errors[]`, bukan di `message` → tanpa `collectErrorText()` rantai galat tak terbaca transien dan fallback ke Gemini tidak pernah jalan |
| `lib/gemini.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | Rename `extractDocument`→`extractDocumentWithGemini`, `generateTextWithFallback`→`generateTextWithGemini`. Logika internal tak disentuh; tsc/lint/build hijau |
| `app/api/process-document/route.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | Pakai `extractDocumentWithFallback` dari `@/lib/llm`; `joinChunks`→helper lokal `joinExtractedChunks` (perilaku identik). tsc/lint/build hijau |
| `lib/qa.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | Impor `generateTextWithFallback` dari `@/lib/llm`. tsc/lint/build hijau |
| `app/api/llm/test/route.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | Rute diagnostik; aktif bila NODE_ENV≠production atau `ALLOW_LLM_TEST=1`, balas 404 di luar itu. Terdaftar sebagai ƒ di build |
| `.env.local.example` | done | 2026-09-26-llm-9router | 2026-09-26 | Bagian 9router + `LLM_PROVIDER_ORDER` + `ALLOW_LLM_TEST` terdokumentasi |
| `AGENTS.md` | done | 2026-09-26-llm-9router | 2026-09-26 | Bagian "Provider LLM" (8 poin) ditambah |
| `README.md` | done | 2026-09-26-llm-9router | 2026-09-26 | Bagian "4b. Pakai 9router saat development" ditambah |
| `lib/llm.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | **BUKTI UJI:** `POST /api/llm/test?mode=extract` → `ok:true, provider:9router, 1.6s`; PDF 2 halaman → kedua kode unik (ALFA-111/BETA-222) terbaca tepat. tsc 0 error, lint(scope saya) 0, build hijau. Bug diperbaiki: PDF di `image_url` → 400; gateway TIDAK bisa baca PDF (4 bentuk diuji) → render per halaman; `ECONNREFUSED` tersembunyi di `cause` → fallback tak jalan; error buta → `FailureReason` + `debug` non-produksi |
| `lib/pdf-render.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | Selesai. `pdftoppm` 150 DPI per halaman, urutan numerik (bukan localeCompare), `AppError('CONFIG')` jelas bila Poppler absen, `finally` selalu bersihkan tmpdir. tsc/lint/build hijau |
| `lib/api-error.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | `detail` jadi field publik + `toBody()` isi `debug` hanya bila `NODE_ENV!=='production'`. Diverifikasi: pesan error kini menyebut "9router: koneksi gagal" + "gemini: kuota habis" |
| `types/index.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | Tambah `debug?: string` opsional ke `ApiErrorBody` (backward-compatible) |
| `app/api/llm/test/route.ts` | done | 2026-09-26-llm-9router | 2026-09-26 | Mode `?mode=extract` + `error.cause`; terdaftar ƒ di build |
| `scripts/probe-9router-pdf.py` | done | 2026-09-26-llm-9router | 2026-09-26 | Probe terbukti: A 400 · B kosong · C mengarang · D PNG ok |

Status yang sah: `claimed` (sedang dikerjakan) atau `done` (selesai + terverifikasi).
