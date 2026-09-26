/**
 * Uji koneksi Supabase: URL, kunci, dan keberadaan bucket.
 *
 * TIDAK menampilkan kunci. Hanya melaporkan status.
 * Jalankan:
 *   node --experimental-strip-types --env-file=.env.local scripts/probe-supabase.mts
 */

import { createClient } from '@supabase/supabase-js';

const URL_KEY = 'NEXT_PUBLIC_SUPABASE_URL';
const ANON_KEY = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';
const SERVICE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

async function main(): Promise<void> {
  const url = process.env[URL_KEY]?.trim();
  const anon = process.env[ANON_KEY]?.trim();
  const service = process.env[SERVICE_KEY]?.trim();
  const bucket = process.env.SUPABASE_BUCKET?.trim() || 'modules';

  console.log('--- Konfigurasi ---');
  console.log(`URL           : ${url ?? '(tidak ada)'}`);
  console.log(`anon key      : ${anon ? `${anon.length} karakter` : '(tidak ada)'}`);
  console.log(`service key   : ${service ? `${service.length} karakter` : '(tidak ada)'}`);
  console.log(`bucket        : ${bucket}`);
  console.log('');

  if (!url || !anon || !service) {
    console.error('GAGAL: konfigurasi Supabase belum lengkap.');
    process.exitCode = 1;
    return;
  }

  const client = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('--- Daftar bucket ---');
  const { data: buckets, error: bucketError } = await client.storage.listBuckets();

  if (bucketError) {
    console.error(`  GAGAL: ${bucketError.message}`);
    process.exitCode = 1;
    return;
  }

  if (!buckets || buckets.length === 0) {
    console.log('  (tidak ada bucket sama sekali)');
  } else {
    for (const b of buckets) {
      const mark = b.id === bucket ? ' <-- dipakai aplikasi' : '';
      console.log(`  - ${b.id} (public=${b.public})${mark}`);
    }
  }
  console.log('');

  const target = buckets?.find((b) => b.id === bucket);
  if (!target) {
    console.error(`GAGAL: bucket "${bucket}" TIDAK ADA.`);
    console.error('  Jalankan supabase/schema.sql di SQL Editor Supabase.');
    process.exitCode = 1;
  } else {
    console.log(`Bucket "${bucket}" ditemukan.`);
    console.log(`  public          : ${target.public}`);
    console.log(`  batas ukuran    : ${target.file_size_limit ?? '(default)'}`);
    console.log(`  tipe diizinkan  : ${target.allowed_mime_types?.join(', ') ?? '(semua)'}`);
  }
  console.log('');

  console.log('--- Tabel documents ---');
  const { error: tableError } = await client
    .from('documents')
    .select('id', { head: true, count: 'exact' });

  if (tableError) {
    console.error(`  GAGAL: ${tableError.message}`);
    console.error('  Tabel "documents" belum dibuat. Jalankan supabase/schema.sql.');
    process.exitCode = 1;
  } else {
    console.log('  Tabel "documents" dapat diakses.');
  }
}

main().catch((err: unknown) => {
  console.error('Pengecualian:', err);
  process.exitCode = 1;
});
