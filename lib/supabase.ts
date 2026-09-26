/**
 * Supabase Client — AI ReadForYou
 * ================================
 *
 * DELIVERABLE 1
 *
 * Prinsip yang saya pegang di file ini:
 *
 * 1. TIDAK ada klien yang diam-diam dibuat dengan kredensial kosong.
 *    Klien dengan URL kosong tidak gagal saat dibuat — ia gagal jauh
 *    kemudian dengan pesan yang menyesatkan ("fetch failed"). Karena itu
 *    setiap fungsi di sini memvalidasi env lebih dulu dan melempar pesan
 *    bahasa Indonesia yang menjelaskan cara memperbaikinya.
 *
 * 2. `service_role` TIDAK PERNAH menyentuh browser. Fungsi server
 *    memverifikasi bahwa ia benar-benar berjalan di server; jika dipanggil
 *    dari komponen klien, ia melempar error alih-alih membocorkan key.
 *
 * 3. Browser client memakai anon key + RLS. Server client memakai
 *    service_role HANYA untuk mengunduh objek dari Storage (Storage RLS
 *    tidak menjangkau tanda tangan model, jadi service_role diperlukan).
 */

import {
  createBrowserClient,
  createServerClient,
  type CookieOptions,
} from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/* ============================================================
 * Konstanta
 * ============================================================ */

export const STORAGE_BUCKET =
  process.env.NEXT_PUBLIC_SUPABASE_BUCKET ??
  process.env.SUPABASE_BUCKET ??
  'modules';

/* ============================================================
 * Validasi lingkungan
 * ============================================================ */

/**
 * Baca satu nilai env dan normalisasi string kosong menjadi undefined.
 */
function trimValue(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return value.trim();
}

/**
 * CATATAN BUNDLER — JANGAN refactor fungsi-fungsi di bawah menjadi
 * `readEnv(name: string)` generik dengan `process.env[name]`.
 *
 * Turbopack/webpack hanya meng-inline `process.env` ke bundle browser
 * bila kuncinya ditulis literal (`process.env.NEXT_PUBLIC_X`). Akses
 * komputasi (`process.env[name]`) tidak dapat dianalisis saat compile,
 * sehingga SELALU `undefined` di browser — dan FILE INI diimpor oleh
 * Client Component (`app/page.tsx`), sehingga polanya wajib literal.
 * Di server (Node) kedua pola bekerja karena `process.env` asli tersedia.
 */
function readPublicEnv(): { url?: string; anonKey?: string } {
  return {
    url: trimValue(process.env.NEXT_PUBLIC_SUPABASE_URL),
    anonKey: trimValue(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };
}

function readServiceEnv(): { url?: string; serviceKey?: string } {
  return {
    url: trimValue(process.env.NEXT_PUBLIC_SUPABASE_URL),
    serviceKey: trimValue(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

function assertPublicEnv(): {
  url: string;
  anonKey: string;
} {
  const { url, anonKey } = readPublicEnv();

  const missing: string[] = [];
  if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Konfigurasi Supabase publik belum lengkap. Variabel yang hilang: ` +
        `${missing.join(', ')}. ` +
        `Salin berkas .env.local.example menjadi .env.local lalu isi nilainya ` +
        `dari dasbor Supabase (Project Settings, API).`,
    );
  }

  return { url: url as string, anonKey: anonKey as string };
}

/**
 * Pastikan kode ini TIDAK berjalan di browser. `service_role` melewati
 * seluruh Row Level Security, jadi kebocorannya setara kompromi penuh.
 */
function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'Kesalahan keamanan: klien service_role dipanggil di sisi klien. ' +
        'SUPABASE_SERVICE_ROLE_KEY tidak boleh dipakai di komponen klien. ' +
        'Panggil kode ini hanya dari Route Handler, Server Action, atau ' +
        'Server Component.',
    );
  }
}

function assertServiceEnv(): { url: string; serviceKey: string } {
  assertServerOnly();

  const { url, serviceKey } = readServiceEnv();

  if (!url || !serviceKey) {
    throw new Error(
      'Konfigurasi Supabase server belum lengkap. Diperlukan ' +
        'NEXT_PUBLIC_SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY. ' +
        'PENTING: SUPABASE_SERVICE_ROLE_KEY hanya boleh ada di server dan ' +
        'tidak boleh memakai awalan NEXT_PUBLIC_.',
    );
  }

  return { url, serviceKey };
}

/* ============================================================
 * Browser client (anon key, tunduk RLS)
 * ============================================================ */

let browserClient: SupabaseClient | null = null;

/**
 * Klien untuk dipakai di Client Component. Aman diekspos ke browser karena
 * memakai anon key dan tunduk pada RLS.
 *
 * Memakai singleton agar Supabase Auth tidak membuat banyak listener.
 */
export function getBrowserSupabase(): SupabaseClient {
  if (browserClient) return browserClient;

  const { url, anonKey } = assertPublicEnv();

  browserClient = createBrowserClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return browserClient;
}

/**
 * Alias `supabase` untuk kenyamanan impor di komponen klien:
 *   import { supabase } from '@/lib/supabase';
 */
export const supabase = /* @__PURE__ */ (() => {
  if (typeof window === 'undefined') return null;
  try {
    return getBrowserSupabase();
  } catch {
    // Jangan bikin aplikasi crash saat modul dimuat; pemanggil akan
    // mendapat error yang jelas ketika benar-benar menekan tombol unggah.
    return null;
  }
})();

/* ============================================================
 * Server client (service_role) — Route Handler / Server Action
 * ============================================================ */

/**
 * Klien istimewa untuk sisi server. Melewati RLS.
 *
 * Dipakai route handler untuk:
 *  - `storage.from(bucket).download(path)` — mengunduh berkas modul
 *  - menulis status ke tabel `documents`
 *
 * Panggil hanya dari server. Fungsi ini melempar bila dipanggil di browser.
 */
export function createServiceSupabase(options?: {
  /** Default false. Jangan hidupkan kecuali ada alasan kuat. */
  persistSession?: boolean;
}): SupabaseClient {
  const { url, serviceKey } = assertServiceEnv();

  return createClient(url, serviceKey, {
    auth: {
      persistSession: options?.persistSession ?? false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-application-name': 'ai-readforyou-server' },
    },
  });
}

/* ============================================================
 * SSR client berbasis cookie (disiapkan untuk saat Auth ditambahkan)
 * ============================================================
 *
 * Meski MVP ini belum memakai Auth, fungsi ini disertakan supaya ketika
 * Anda menambahkan login nanti, verifikasi kepemilikan dokumen
 * (user_id === user.id) bisa langsung diaktifkan tanpa refactor besar.
 * Lihat README bagian "Mengaktifkan Auth".
 */
export function createRouteHandlerSupabase(
  cookies: {
    getAll(): { name: string; value: string }[];
    setAll(
      cookies: { name: string; value: string; options?: CookieOptions }[],
    ): void;
  },
): SupabaseClient {
  const { url, anonKey } = assertPublicEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookies.getAll(),
      setAll: (list) => cookies.setAll(list),
    },
  });
}

/* ============================================================
 * Util Storage
 * ============================================================ */

/**
 * Susun path objek di Storage.
 *
 * Bentuk: `{scope}/{tahun-bulan}/{uuid}.{ext}`
 *
 * Kenapa berpola seperti ini:
 *  - `scope` memisahkan berkas antar pengguna/perangkat, memudahkan
 *    pembersihan massal dan audit.
 *  - Partisi bulan mencegah satu direktori menampung puluhan ribu objek,
 *    yang memperlambat operasi list.
 *  - Nama asli TIDAK dipakai apa adanya karena bisa mengandung karakter
 *    aneh, spasi ganda, atau tabrakan nama.
 */
export function buildStoragePath(params: {
  scope?: string | null;
  fileName: string;
}): string {
  const scope = sanitizeSegment(params.scope ?? 'anonim');
  const now = new Date();
  const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ext = extractSafeExtension(params.fileName);
  const id = crypto.randomUUID();

  return `${scope}/${yyyymm}/${id}${ext}`;
}

function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'anonim';
}

/**
 * Ambil ekstensi yang aman. Hanya huruf/angka, maksimal 5 karakter.
 * Kalau tidak jelas, kembalikan string kosong (bukan menebak).
 */
function extractSafeExtension(fileName: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(fileName.trim());
  if (!match || !match[1]) return '';
  return `.${match[1].toLowerCase()}`;
}

/**
 * Ubah nama berkas dari Storage menjadi nama yang enak dibacakan screen
 * reader: buang ekstensi, ganti pemisah dengan spasi.
 */
export function humanizeFileName(fileName: string): string {
  return fileName
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
