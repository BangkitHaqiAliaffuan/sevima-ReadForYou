-- ============================================================
-- AI ReadForYou — Migrasi Auth Sederhana (tanpa tamu anonim)
-- ============================================================
-- Jalankan berkas ini di Supabase SQL Editor SETELAH supabase/schema.sql.
-- Aman dijalankan berulang (pola drop-if-exists + create).
--
-- MODEL AKSES (disederhanakan):
--  1. BELUM MASUK (role `anon`, tanpa sesi):
--     - boleh mengunggah ke bucket `modules` HANYA di folder `anonim/`;
--     - boleh menambah/membaca baris `documents` HANYA yang `user_id IS NULL`
--       (tidak punya riwayat; baris ini sekadar jejak sementara);
--     - TIDAK dapat melihat dokumen milik akun mana pun.
--  2. SUDAH MASUK (role `authenticated`, akun email):
--     - tercakup kebijakan `owner_*` (schema.sql): path storage segmen
--       pertama = auth.uid(), baris terikat user_id = auth.uid();
--     - riwayat bacaan inilah yang tampil di UI.
--
-- CATATAN: TIDAK perlu lagi mengaktifkan "Anonymous Sign-Ins" di dashboard.
-- Cukup aktifkan provider Email. Berkas ini menggantikan
-- migration_auth_anon.sql — jangan jalankan keduanya; jalankan yang ini.
-- ============================================================

-- ---------- documents: anon hanya boleh baca baris tanpa pemilik ----------
-- Perbaikan privasi: sebelumnya `mvp_anon_select ... using (true)`
-- mengizinkan anon membaca SEMUA baris, termasuk dokumen milik akun lain.
-- Diperketat menjadi baris tanpa pemilik (user_id IS NULL).

drop policy if exists "mvp_anon_select" on public.documents;
create policy "mvp_anon_select"
  on public.documents
  for select
  to anon
  using (user_id is null);

-- Pastikan insert anon tidak dapat mengaku sebagai pemilik akun lain.
drop policy if exists "mvp_anon_insert" on public.documents;
create policy "mvp_anon_insert"
  on public.documents
  for insert
  to anon
  with check (user_id is null);

-- ---------- Storage: anon hanya boleh mengunggah ke folder anonim/ ----------
-- Klien tanpa sesi selalu memakai scope 'anonim' (lihat app/page.tsx),
-- sehingga pembatasan ini selaras tanpa mengubah alur unggah.
-- Unduhan tetap lewat service_role di server (tidak ada anon SELECT).

drop policy if exists "mvp_anon_upload" on storage.objects;
create policy "mvp_anon_upload"
  on storage.objects
  for insert
  to anon
  with check (
    bucket_id = 'modules'
    and (storage.foldername(name))[1] = 'anonim'
  );

-- ---------- Kebijakan owner_* (sudah ada di schema.sql, tidak diubah) ----------
-- documents: owner_select / owner_insert / owner_update / owner_delete
--   (authenticated, syarat auth.uid() = user_id)
-- storage.objects: owner_read_files / owner_upload_files /
--   owner_delete_files (authenticated, folder = auth.uid())
--
-- Tidak ada kebijakan yang memberi user anonim akses lintas akun, karena
-- anonim kini murni berarti "belum masuk" — bukan sesi Supabase.
