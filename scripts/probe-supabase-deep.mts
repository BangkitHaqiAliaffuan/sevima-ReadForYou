/**
 * Diagnosis lanjutan: apa saja yang SUDAH ada di Supabase?
 * Berguna ketika schema.sql dijalankan sebagian.
 */

import { createClient } from '@supabase/supabase-js';

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !service) {
    console.error('Konfigurasi Supabase tidak lengkap.');
    process.exitCode = 1;
    return;
  }

  const client = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('=== 1. Raw storage.listBuckets() ===');
  const { data: buckets, error } = await client.storage.listBuckets();
  console.log('  error :', error ? `YA -> ${error.message}` : 'tidak ada');
  console.log('  jumlah:', buckets?.length ?? 0);
  if (buckets) {
    for (const b of buckets) {
      console.log(`    - id="${b.id}" name="${b.name}" public=${b.public}`);
    }
  }

  console.log('');
  console.log('=== 2. Coba akses bucket "modules" langsung ===');
  const { data: listed, error: listError } = await client.storage
    .from('modules')
    .list('', { limit: 1 });
  console.log('  list error:', listError ? `YA -> ${listError.message}` : 'tidak ada');
  console.log('  isi       :', listed?.length ?? 0, 'objek');

  console.log('');
  console.log('=== 3. Struktur tabel documents ===');
  const { data: rows, error: rowError } = await client
    .from('documents')
    .select('*')
    .limit(1);
  if (rowError) {
    console.log('  error:', rowError.message);
  } else {
    const sample = rows?.[0];
    console.log('  kolom:', sample ? Object.keys(sample).join(', ') : '(tabel kosong)');
    console.log('  jumlah baris (perkiraan):', rows?.length ?? 0);
  }

  console.log('');
  console.log('=== 4. Uji tulis-lalu-hapus ke bucket modules (jika ada) ===');
  const testPath = `diagnostik/uji-${Date.now()}.txt`;
  const { error: uploadError } = await client.storage
    .from('modules')
    .upload(testPath, new Blob(['uji'], { type: 'text/plain' }), {
      contentType: 'text/plain',
      upsert: true,
    });

  if (uploadError) {
    console.log('  unggah GAGAL ->', uploadError.message);
  } else {
    console.log('  unggah BERHASIL');
    const { error: removeError } = await client.storage.from('modules').remove([testPath]);
    console.log('  hapus:', removeError ? `GAGAL -> ${removeError.message}` : 'berhasil');
  }
}

main().catch((err: unknown) => {
  console.error('Pengecualian:', err);
  process.exitCode = 1;
});
