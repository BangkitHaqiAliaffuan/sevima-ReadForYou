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

Status yang sah: `claimed` (sedang dikerjakan) atau `done` (selesai + terverifikasi).
