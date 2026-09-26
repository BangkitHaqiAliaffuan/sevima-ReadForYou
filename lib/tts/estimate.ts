/**
 * Estimasi durasi audio.
 *
 * KENAPA BERKAS TERPISAH, BUKAN DI DALAM chunk-text.ts ATAU synthesize.ts:
 *
 * Awalnya fungsi ini tinggal di `chunk-text.ts`. Ketika TTS pindah ke
 * server, `synthesize.ts` juga membutuhkannya — dan `chunk-text.ts`
 * butuh estimasi untuk mengisi tiap chunk. Menaruhnya di salah satu
 * berkas itu menciptakan impor melingkar (`chunk-text` ← `synthesize` ←
 * `chunk-text`), yang pada Turbopack dapat menghasilkan nilai `undefined`
 * secara diam-diam saat modul dimuat.
 *
 * Modul kecil ini memutus siklus tersebut dan menjadi satu-satunya
 * sumber kebenaran untuk perhitungan durasi.
 */

/**
 * Laju bicara suara neural bahasa Indonesia pada tempo normal.
 *
 * Angka 14 karakter per detik diturunkan dari sekitar 170 kata per menit
 * dengan rata-rata 5 karakter per kata. Nilai ini bukan kebenaran mutlak —
 * setiap suara dan tempo sedikit berbeda — tetapi cukup akurat untuk
 * menampilkan estimasi dan mengukur progres.
 */
export const CHARS_PER_SECOND = 14;

/**
 * Perkiraan durasi bicara satu potong teks, dalam milidetik.
 *
 * Faktor 1,25 mewakili jeda alami antar kalimat; tambahan 400 ms
 * memastikan kalimat yang sangat pendek ("Ya.") tetap punya durasi yang
 * wajar sehingga indikator progres tidak melompat.
 */
export function estimateDurationMs(text: string): number {
  const base = (text.length / CHARS_PER_SECOND) * 1000;
  const withPause = (base + 400) * 1.25;
  return Math.max(withPause, 900);
}

/** Total estimasi untuk sekumpulan kalimat. */
export function estimateTotalDurationMs(
  chunks: readonly { estimatedMs: number }[],
): number {
  return chunks.reduce((total, chunk) => total + chunk.estimatedMs, 0);
}
