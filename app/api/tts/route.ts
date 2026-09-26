/**
 * POST /api/tts
 * =============
 *
 * Mengubah SATU potong teks (satu kalimat) menjadi audio MP3.
 *
 * KENAPA PER KALIMAT, BUKAN SELURUH DOKUMEN SEKALIGUS:
 *
 *  1. Waktu menuju suara pertama jauh lebih pendek. Untuk modul 20
 *     halaman, memproses seluruh dokumen lebih dulu berarti pengguna
 *     menunggu puluhan detik tanpa mendengar apa pun. Per kalimat,
 *     suara mulai dalam sekitar satu detik.
 *
 *  2. Kontrol pemutar menjadi presisi. Tombol "kalimat berikutnya" dan
 *     "lompat ke kalimat" dapat bekerja seketika, karena setiap kalimat
 *     adalah satuan audio yang berdiri sendiri.
 *
 *  3. Hemat memori server. Kami hanya menahan satu kalimat di memori,
 *     bukan seluruh rekaman modul.
 *
 * Klien memuat kalimat berikutnya lebih awal (preload), sehingga jeda
 * antar kalimat nyaris tidak terasa.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { checkRateLimit, identifyRequester, rateLimitHeaders } from '@/lib/rate-limit';
import {
  MAX_TTS_CHARS,
  synthesizeSpeech,
  TtsError,
} from '@/lib/tts/synthesize';
import type { TtsRequest } from '@/types';

/**
 * runtime nodejs WAJIB.
 *
 * msedge-tts memerlukan WebSocket dan modul Node. Pada runtime edge,
 * modul ini tidak akan dapat dimuat sama sekali.
 */
export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

export const maxDuration = 30;

/**
 * Batas laju khusus TTS lebih ketat daripada ekstraksi dokumen.
 *
 * Alasan: satu dokumen panjang memicu banyak permintaan TTS (satu per
 * kalimat). Bila batasnya sama dengan ekstraksi, pemutaran normal akan
 * langsung terkena pembatasan. Namun bila tanpa batas, endpoint ini
 * dapat disalahgunakan sebagai layanan suara gratis.
 *
 * Angka 120 per menit menampung pemutaran wajar (2 kalimat per detik
 * pada tempo cepat) sambil tetap membatasi penyalahgunaan.
 */
const TTS_RATE_LIMIT_PER_MINUTE = 120;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    /* ---------------- Batas laju ---------------- */
    const requester = identifyRequester(request.headers);
    const limit = checkRateLimit(requester, {
      max: TTS_RATE_LIMIT_PER_MINUTE,
      keyPrefix: 'tts',
    });

    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message:
              'Terlalu banyak permintaan suara dalam waktu singkat. ' +
              'Mohon tunggu sebentar, lalu tekan Putar lagi.',
          },
        },
        { status: 429, headers: rateLimitHeaders(limit) },
      );
    }

    /* ---------------- Parsing body ---------------- */
    let body: TtsRequest;
    try {
      body = (await request.json()) as TtsRequest;
    } catch {
      return errorJson(
        'BAD_REQUEST',
        'Permintaan tidak dapat dibaca. Silakan coba lagi.',
        400,
      );
    }

    const text = typeof body.text === 'string' ? body.text : '';

    if (text.trim().length === 0) {
      return errorJson(
        'EMPTY_TEXT',
        'Tidak ada teks yang dapat dibacakan.',
        400,
      );
    }

    if (text.length > MAX_TTS_CHARS) {
      return errorJson(
        'TEXT_TOO_LONG',
        `Teks melebihi batas ${MAX_TTS_CHARS} karakter. ` +
          'Sistem seharusnya mengirim teks per kalimat.',
        413,
      );
    }

    /* ---------------- Sintesis ---------------- */
    const audio = await synthesizeSpeech({
      text,
      voice: typeof body.voice === 'string' ? body.voice : undefined,
      rate: typeof body.rate === 'number' ? body.rate : undefined,
      pitch: typeof body.pitch === 'string' ? body.pitch : undefined,
    });

    /*
     * Kirim sebagai audio/mpeg dengan tipe Buffer yang benar.
     *
     * `new Uint8Array(audio)` dipakai karena NextResponse tidak menerima
     * Buffer Node secara langsung pada tipe TypeScript-nya. Konversi ini
     * tanpa salinan memori tambahan.
     */
    return new NextResponse(new Uint8Array(audio), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.length),
        // Audio tidak boleh di-cache secara publik: setiap permintaan
        // mewakili teks pengguna. Namun pemutaran ulang dalam sesi yang
        // sama tidak perlu memanggil Microsoft lagi.
        'Cache-Control': 'private, max-age=3600',
        ...rateLimitHeaders(limit),
      },
    });
  } catch (err) {
    if (err instanceof TtsError) {
      // Catat detail di server untuk diagnosis.
      console.error('[api/tts]', err.code, err.message);
      return errorJson(err.code, err.message, err.httpStatus);
    }

    console.error('[api/tts] kesalahan tak terduga', err);

    /*
     * PENTING: klien WAJIB dapat membedakan kegagalan ini dari audio
     * yang valid. Karena itu kita mengembalikan JSON dengan status galat,
     * bukan status 200 berisi audio kosong. Tanpa pemisahan ini, klien
     * akan mencoba memutar audio rusak dan gagal tanpa penjelasan.
     */
    return errorJson(
      'TTS_UNAVAILABLE',
      'Layanan suara sedang tidak tersedia. ' +
        'Anda masih dapat membaca teks menggunakan pembaca layar Anda.',
      502,
    );
  }
}

function errorJson(code: string, message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
