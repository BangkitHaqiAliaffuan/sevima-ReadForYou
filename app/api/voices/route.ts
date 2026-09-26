/**
 * GET /api/voices
 * ===============
 *
 * Mengembalikan daftar suara bahasa Indonesia yang tersedia.
 *
 * KENAPA DI-ROUTE, BUKAN DIKERASKAN DI KLIEN:
 * Daftar suara berasal dari layanan Microsoft dan dapat berubah (suara
 * baru ditambah, suara lama ditarik). Bila dikeraskan di kode klien, UI
 * akan menawarkan suara yang sudah tidak ada dan pengguna akan mendapat
 * kegagalan yang membingungkan.
 *
 * Hasil di-cache selama satu jam karena daftar ini jarang berubah.
 */

import { NextResponse } from 'next/server';

import { listIndonesianVoices, TtsError } from '@/lib/tts/synthesize';

export const runtime = 'nodejs';

/** Daftar suara jarang berubah, jadi boleh di-cache lebih lama. */
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  try {
    const voices = await listIndonesianVoices();

    /*
     * Bila tidak ada suara Indonesia sama sekali, itu bukan galat HTTP —
     * server berfungsi dengan benar, hanya saja layanan tidak menyediakan
     * suara yang kita butuhkan. Klien perlu tahu ini supaya dapat
     * memberi tahu pengguna dan beralih ke suara bawaan peramban.
     */
    return NextResponse.json(
      {
        voices,
        count: voices.length,
        fallbackRecommended: voices.length === 0,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=3600, s-maxage=3600',
        },
      },
    );
  } catch (err) {
    const message =
      err instanceof TtsError
        ? err.message
        : 'Daftar suara sedang tidak dapat diambil. ' +
          'Anda masih dapat memakai suara bawaan peramban.';

    console.error('[api/voices]', err);

    /*
     * Sengaja mengembalikan 200 dengan daftar kosong, bukan galat.
     *
     * Alasan: daftar suara adalah fitur pelengkap. Bila gagal, pengguna
     * tetap harus dapat memutar audio dengan suara default. Mengirim
     * galat HTTP akan membuat klien menampilkan pesan kesalahan padahal
     * fungsinya masih berjalan.
     */
    return NextResponse.json(
      {
        voices: [],
        count: 0,
        fallbackRecommended: true,
        notice: message,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
