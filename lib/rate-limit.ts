/**
 * Rate limiter sederhana — penjaga kuota.
 *
 * KENAPA INI ADA:
 * Route ini memakai `service_role` (melewati RLS) dan memanggil API
 * berbayar. Tanpa pembatas, satu skrip bisa menghabiskan kuota Gemini
 * dalam hitungan menit. Karena keputusan MVP Anda adalah "tanpa Auth",
 * pembatas ini menjadi satu-satunya pertahanan terhadap penyalahgunaan.
 *
 * BATASAN YANG HARUS DISADARI:
 * Penyimpanan di memori proses. Pada deployment serverless multi-instance
 * (Vercel), setiap instansi memiliki penghitung sendiri, sehingga batas
 * efektif berlipat sebanyak jumlah instansi hangat. Cukup untuk tahap
 * MVP, TIDAK cukup untuk produksi serius.
 *
 * Untuk produksi, ganti implementasi ini dengan Upstash Redis atau tabel
 * Supabase. Antarmuka fungsinya sengaja dibuat kecil supaya penggantian
 * hanya menyentuh file ini.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Konfigurasi bawaan untuk pembatasan pada jalur ekstraksi dokumen. */
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 20;
const WINDOW_MS = 60_000;

/** Buang bucket kedaluwarsa agar memori tidak tumbuh tanpa batas. */
const CLEANUP_INTERVAL_MS = 5 * 60_000;
let lastCleanup = Date.now();

function cleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milidetik sampai kuota diisi ulang. */
  retryAfterMs: number;
  /** Batas yang berlaku untuk bucket ini. */
  limit: number;
}

export interface RateLimitOptions {
  /** Jumlah maksimum permintaan per jendela waktu. */
  max?: number;
  /**
   * Awalan kunci.
   *
   * KENAPA INI PERLU: jalur yang berbeda memiliki pola pemakaian yang
   * sangat berbeda. Ekstraksi dokumen dipanggil sekali per berkas, tetapi
   * sintesis suara dipanggil sekali per kalimat. Bila keduanya berbagi
   * penghitung yang sama, memutar satu modul akan langsung menghabiskan
   * kuota ekstraksi. Awalan memisahkan keduanya.
   */
  keyPrefix?: string;
}

/**
 * Periksa dan catat satu permintaan.
 *
 * `identifier` sebaiknya merupakan kombinasi yang stabil namun tidak
 * mudah dipalsukan, misalnya hash alamat IP. Jangan pakai header yang
 * dikendalikan klien (`x-forwarded-for` mentah) tanpa validasi dari proxy.
 */
export function checkRateLimit(
  identifier: string,
  options?: RateLimitOptions,
): RateLimitResult {
  const max = options?.max ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
  const key = options?.keyPrefix ? `${options.keyPrefix}:${identifier}` : identifier;

  const now = Date.now();
  cleanup(now);

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return {
      allowed: true,
      remaining: max - 1,
      retryAfterMs: 0,
      limit: max,
    };
  }

  if (existing.count >= max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: existing.resetAt - now,
      limit: max,
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: max - existing.count,
    retryAfterMs: 0,
    limit: max,
  };
}

/**
 * Turunkan tanda pengenal dari header permintaan dengan hati-hati.
 *
 * `x-forwarded-for` dapat berisi rantai alamat; entri pertama adalah
 * klien menurut proxy terdekat. Bila header tidak ada (pengembangan
 * lokal), gunakan nilai tetap supaya tetap ada pembatasan.
 */
export function identifyRequester(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first && isPlausibleIp(first)) return `ip:${first}`;
  }

  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp && isPlausibleIp(realIp)) return `ip:${realIp}`;

  const cfIp = headers.get('cf-connecting-ip')?.trim();
  if (cfIp && isPlausibleIp(cfIp)) return `ip:${cfIp}`;

  return 'ip:tidak-diketahui';
}

function isPlausibleIp(value: string): boolean {
  // IPv4 sederhana atau IPv6 (mengandung titik dua, tanpa spasi).
  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) ||
    /^[0-9a-f:]{3,45}$/i.test(value)
  );
}

/** Header standar yang menyertai respons 429. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
  };
  if (!result.allowed) {
    headers['Retry-After'] = String(Math.ceil(result.retryAfterMs / 1000));
  }
  return headers;
}
