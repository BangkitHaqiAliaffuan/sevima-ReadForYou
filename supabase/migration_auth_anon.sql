-- ============================================================
-- AI ReadForYou — Migrasi Auth (anon + akun)
-- ============================================================
-- Jalankan berkas ini di Supabase SQL Editor SETELAH supabase/schema.sql,
-- atau pada proyek yang sudah menjalankan schema.sql sebelumnya.
-- Aman dijalankan berulang (pola drop-if-exists + create).
--
-- Model akses setelah migrasi:
--  1. Tamu murni (tanpa sesi, role `anon`): boleh mengunggah HANYA ke
--     folder `anonim/` dan membaca HANYA baris tanpa pemilik
--     (`user_id IS NULL`). Tidak dapat melihat dokumen milik akun mana pun.
--  2. Pengguna masuk (tamu anonim maupun permanen, role `authenticated`):
--     tercakup kebijakan `owner_*` yang sudah ada — path storage segmen
--     pertama = auth.uid(), baris terikat user_id = auth.uid().
--
-- Prasyarat dashboard: Authentication → Providers → aktifkan
-- "Anonymous Sign-Ins" (+ Email bila ingin upgrade permanen).
-- ============================================================

-- ---------- Tabel documents: anon hanya boleh baca baris tanpa pemilik ----------
-- Sebelumnya `mvp_anon_select ... using (true)` mengizinkan anon membaca
-- SEMUA baris, termasuk dokumen milik akun lain. Itu kebocoran privasi
-- sejak Auth diaktifkan, jadi dipersempit ke baris tamu (user_id NULL).

drop policy if exists "mvp_anon_select" on public.documents;
create policy "mvp_anon_select"
  on public.documents
  for select
  to anon
  using (user_id is null);

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

-- ---------- Pengingat (tidak dieksekusi): kebijakan owner_* ----------
-- Kebijakan di bawah sudah ada di schema.sql dan TIDAK diubah di sini:
--   documents: owner_select / owner_insert / owner_update / owner_delete
--     (authenticated, syarat auth.uid() = user_id — mencakup uid anonim
--      karena user anonim ber-role `authenticated`)
--   storage.objects: owner_read_files / owner_upload_files /
--     owner_delete_files (authenticated, folder = auth.uid())
