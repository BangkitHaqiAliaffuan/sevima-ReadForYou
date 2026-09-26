/**
 * POST /api/ask
 * ==============
 *
 * Tanya-jawab berbasis dokumen yang sudah diekstrak.
 *
 * Alur:
 *  1. Terima `{ documentId, question }` (DIUTAMAKAN) atau `{ text, question }`.
 *  2. Terapkan rate limit per pengguna (jalur sendiri: 'ask').
 *  3. Bila documentId: ambil `extracted_text` dari tabel + verifikasi
 *     kepemilikan dengan pola yang SAMA seperti process-document (milik
 *     akun lain ditolak sebagai NO_FILE; legacy NULL lolos tanpa sesi).
 *  4. Minta jawaban ringkas siap-dengar ke Gemini via lib/qa.ts.
 *
 * KEAMANAN:
 *  - GEMINI_API_KEY hanya hidup di sini.
 *  - Jalur fallback `text` dibatasi panjangnya agar tak jadi celah
 *    bakar-kuota (aturan ada di lib/qa.ts).
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { AppError, errorResponse } from '@/lib/api-error';
import { answerQuestion } from '@/lib/qa';
import { checkRateLimit, identifyRequester, rateLimitHeaders } from '@/lib/rate-limit';
import {
  createRouteHandlerSupabase,
  createServiceSupabase,
} from '@/lib/supabase';
import type { AskRequest, AskResponse } from '@/types';

export const runtime = 'nodejs';

/** Jangan cache jawaban. */
export const dynamic = 'force-dynamic';

export const maxDuration = 60;

/** Satu pertanyaan = 1 call Gemini konteks-penuh; samakan dengan ekstraksi. */
const ASK_RATE_LIMIT_PER_MINUTE = 20;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    /* ---------------- Identitas pemanggil ---------------- */
    const sessionUserId = await getRouteUserId();

    /* ---------------- Rate limit ---------------- */
    // Jalur sendiri ('ask'): pola pemakaian tanya-jawab berbeda dari TTS
    // per kalimat — berbagi bucket akan saling menghabiskan kuota.
    const requester = sessionUserId ?? identifyRequester(request.headers);
    const limit = checkRateLimit(
      sessionUserId ? `user:${sessionUserId}` : requester,
      { max: ASK_RATE_LIMIT_PER_MINUTE, keyPrefix: 'ask' },
    );

    if (!limit.allowed) {
      const err = new AppError('RATE_LIMITED');
      return NextResponse.json(err.toBody(), {
        status: err.httpStatus,
        headers: rateLimitHeaders(limit),
      });
    }

    /* ---------------- Parsing body ---------------- */
    let body: AskRequest;
    try {
      body = (await request.json()) as AskRequest;
    } catch {
      throw new AppError('BAD_REQUEST', 'Body bukan JSON yang valid.');
    }

    const question =
      typeof body.question === 'string' ? body.question.trim() : '';
    if (question.length === 0) {
      throw new AppError('BAD_REQUEST', 'Pertanyaan belum diisi.');
    }

    const documentId =
      typeof body.documentId === 'string' && body.documentId.trim().length > 0
        ? body.documentId.trim()
        : null;

    /* ---------------- Ambil teks dokumen ---------------- */
    let docText: string;
    let docName: string;

    if (documentId) {
      const supabase = createServiceSupabase();
      const { data, error } = await supabase
        .from('documents')
        .select('id, file_name, extracted_text, user_id')
        .eq('id', documentId)
        .maybeSingle<{
          id: string;
          file_name: string;
          extracted_text: string | null;
          user_id: string | null;
        }>();

      if (error) {
        throw new AppError('UPSTREAM', `Query dokumen gagal: ${error.message}`);
      }
      if (!data) {
        throw new AppError('NO_FILE', `Dokumen ${documentId} tidak ditemukan.`);
      }

      // Kepemilikan: pola yang sama seperti process-document.
      if (data.user_id !== sessionUserId) {
        if (!(data.user_id === null && sessionUserId === null)) {
          throw new AppError('NO_FILE', `Dokumen ${documentId} tidak ditemukan.`);
        }
      }

      if (!data.extracted_text || data.extracted_text.trim().length === 0) {
        throw new AppError(
          'BAD_REQUEST',
          'Dokumen ini belum memiliki teks hasil ekstraksi.',
        );
      }

      docText = data.extracted_text;
      docName = data.file_name;
    } else {
      // Fallback: teks dikirim langsung (mis. bacaan dari riwayat tanpa id).
      const directText = typeof body.text === 'string' ? body.text : '';
      if (directText.trim().length === 0) {
        throw new AppError(
          'BAD_REQUEST',
          'Diperlukan documentId atau text.',
        );
      }
      docText = directText;
      docName =
        typeof body.docName === 'string' && body.docName.trim().length > 0
          ? body.docName.trim()
          : 'dokumen';
    }

    /* ---------------- Jawab ---------------- */
    const answer = await answerQuestion({ question, docText, docName });

    const responseBody: AskResponse = { answer };
    return NextResponse.json(responseBody, {
      status: 200,
      headers: {
        ...rateLimitHeaders(limit),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[api/ask]', err);
    return errorResponse(err);
  }
}

/* ============================================================
 * Helper
 * ============================================================ */

/**
 * Baca id pengguna dari cookie sesi (server). Pola yang sama seperti
 * process-document: gagal baca = tamu tanpa sesi.
 */
async function getRouteUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createRouteHandlerSupabase({
      getAll: () =>
        cookieStore.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value, options } of list) {
          try {
            cookieStore.set(name, value, options);
          } catch {
            // Konteks hanya-baca: abaikan, sesi tetap terbaca.
          }
        }
      },
    });
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}
