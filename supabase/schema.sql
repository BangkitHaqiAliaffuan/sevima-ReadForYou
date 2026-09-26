-- ============================================================
-- AI ReadForYou — Skema Database & Storage
-- ============================================================
-- Jalankan berkas ini di Supabase SQL Editor.
-- Aman dijalankan berulang (idempoten) untuk bagian CREATE IF NOT EXISTS.
--
-- CATATAN untuk MVP tanpa Auth:
-- Kebijakan di bawah mengizinkan anon key MENULIS ke bucket, karena
-- klien mengunggah berkas tanpa login. Ini disengaja untuk tahap MVP
-- (lihat keputusan C pada PLANNING.md). Risiko: siapa pun yang memiliki
-- anon key publik dapat mengunggah berkas. Batasi dengan:
--   - membatasi ukuran berkas pada pengaturan bucket,
--   - rate limit di sisi server (sudah ada di lib/rate-limit.ts),
--   - segera mengaktifkan Auth bila aplikasi masuk produksi.
-- ============================================================

-- ---------- Tabel dokumen ----------

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  -- Nullable selama MVP belum memakai Auth.
  user_id uuid references auth.users (id) on delete cascade,
  file_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'processing', 'ready', 'error')),
  extracted_text text,
  error_message text,
  page_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.documents is
  'Menyimpan metadata berkas modul dan hasil ekstraksi teks.';

-- ---------- Indeks ----------
-- Berkas sering ditelusuri berdasarkan status (mis. untuk memantau
-- pekerjaan yang gagal) dan diurutkan berdasarkan waktu terbaru.

create index if not exists documents_status_idx
  on public.documents (status);

create index if not exists documents_created_at_idx
  on public.documents (created_at desc);

create index if not exists documents_user_id_idx
  on public.documents (user_id);

-- ---------- Trigger updated_at ----------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;

create trigger documents_set_updated_at
  before update on public.documents
  for each row
  execute function public.set_updated_at();

-- ---------- Row Level Security ----------

alter table public.documents enable row level security;

-- MVP: anon boleh menambah dan membaca baris. Ini sengaja untuk
-- pengembangan tanpa Auth.
--
-- !!! SEBELUM PRODUKSI, GANTI KEBIJAKAN INI !!!
-- Hapus dua kebijakan di bawah dan aktifkan yang berbasis auth.uid().

drop policy if exists "mvp_anon_insert" on public.documents;
create policy "mvp_anon_insert"
  on public.documents
  for insert
  to anon
  with check (user_id is null);

drop policy if exists "mvp_anon_select" on public.documents;
create policy "mvp_anon_select"
  on public.documents
  for select
  to anon
  using (true);

-- Kebijakan berbasis Auth, siap diaktifkan ketika login ditambahkan.
-- Cara mengaktifkan: ganti "to authenticated" dan pastikan klien
-- mengirim sesi. Lihat README bagian "Mengaktifkan Auth".

drop policy if exists "owner_select" on public.documents;
create policy "owner_select"
  on public.documents
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "owner_insert" on public.documents;
create policy "owner_insert"
  on public.documents
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "owner_update" on public.documents;
create policy "owner_update"
  on public.documents
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "owner_delete" on public.documents;
create policy "owner_delete"
  on public.documents
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- ============================================================
-- Storage
-- ============================================================

-- Buat bucket privat. Berkas TIDAK dibuat publik: modul pelajaran bisa
-- berisi catatan pribadi siswa, dan pengiriman ke Gemini sudah dilakukan
-- di sisi server memakai service_role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'modules',
  'modules',
  false,
  20971520, -- 20 MB, selaras dengan MAX_FILE_BYTES
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Kebijakan Storage untuk MVP anon.
-- Anon boleh mengunggah, TETAPI TIDAK boleh membaca (download) berkas
-- milik orang lain. Download untuk ekstraksi dilakukan server memakai
-- service_role yang melewati kebijakan ini.

drop policy if exists "mvp_anon_upload" on storage.objects;
create policy "mvp_anon_upload"
  on storage.objects
  for insert
  to anon
  with check (bucket_id = 'modules');

-- Sengaja TIDAK ada kebijakan SELECT untuk anon. Ini berarti berkas di
-- bucket 'modules' tidak dapat diunduh melalui anon key. Itu memang
-- tujuannya.

-- Kebijakan berbasis Auth untuk tahap berikutnya.
drop policy if exists "owner_read_files" on storage.objects;
create policy "owner_read_files"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'modules'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owner_upload_files" on storage.objects;
create policy "owner_upload_files"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'modules'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owner_delete_files" on storage.objects;
create policy "owner_delete_files"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'modules'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
