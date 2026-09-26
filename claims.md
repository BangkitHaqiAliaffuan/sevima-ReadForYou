# File claims — koordinasi multi-session (sumber kebenaran: tabel di bawah)

> Aturan main ada di `AGENTS.md` ("File claims"). File ini HANYA data:
> satu baris per file yang pernah/sedang dikerjakan. Tanpa baris = bebas.

| File | Status | Owner | Updated | Note |
|---|---|---|---|---|
| `hooks/useServerAudio.ts` | done | session-playback-stall | 2026-09-26 | Fase 1-2: stalled, watchdog, prefetch gate (commit `75cd264`) |
| `components/AudioPlayer.tsx` | done | session-playback-stall | 2026-09-26 | Label stalled, gate aria-disabled, baris layanan suara (commit `75cd264`) |
| `types/index.ts` | done | session-playback-stall | 2026-09-26 | Tambah `'stalled'` ke `SpeechState` (commit `75cd264`) |
| `app/page.tsx` | done | session-playback-stall + auth-workstream | 2026-09-26 | Hunk playback (`75cd264`) + hunk auth (`912fa5f`) — keduanya commit, tree bersih |
| `AGENTS.md` | done | session-playback-stall + auth-workstream | 2026-09-26 | Kontrak playback honesty (`75cd264`); seksi Auth model + File claims (`912fa5f`) |
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
| `app/page.tsx` | claimed | session-voiceqa + auth-workstream | 2026-09-26 | VoiceQA: documentId state + orkestrasi; auth: hapus AuthPanel + kartu ringkas Masuk/daftar (/masuk) — hunk berbeda, rekonsiliasi saat commit; tsc/lint/build hijau |
| `components/AuthPanel.tsx` | claimed | auth-workstream | 2026-09-26 | /masuk: prop onDismiss opsional (was done `912fa5f`); tsc/lint/build hijau |
| `components/DocumentHistory.tsx` | claimed | auth-workstream | 2026-09-26 | /masuk: tautan Link /masuk di pesan tamu (was done `912fa5f`); tsc/lint/build hijau |
| `app/masuk/page.tsx` | claimed | auth-workstream | 2026-09-26 | /masuk: server page baru, metadata + searchParams; build mendaftarkan ƒ /masuk |
| `app/masuk/MasukClient.tsx` | claimed | auth-workstream | 2026-09-26 | /masuk: redirect permanen + guard open-redirect; tsc/lint/build hijau |

Status yang sah: `claimed` (sedang dikerjakan) atau `done` (selesai + terverifikasi).
