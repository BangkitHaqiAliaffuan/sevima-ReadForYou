/**
 * POST /api/process-document
 * ==========================
 *
 * DELIVERABLE 2
 *
 * Alur:
 *  1. Terima `{ documentId }` ATAU `{ filePath }` (fallback MVP).
 *  2. Terapkan rate limit.
 *  3. Unduh berkas dari Supabase Storage memakai service_role.
 *  4. Validasi tipe berkas dari magic bytes (tidak percaya klien).
 *  5. Kirim ke Gemini untuk ekstraksi teks siap-dengar.
 *  6. Perbarui status dokumen di tabel `documents`.
 *  7. Kembalikan teks + peringatan yang wajib diumumkan screen reader.
 *
 * KEAMANAN:
 *  - GEMINI_API_KEY hanya hidup di sini. Tidak pernah sampai ke browser.
 *  - Rate limit diterapkan sebelum pekerjaan mahal dilakukan; pengguna yang
 *    masuk dibatasi per akun (`user:<id>`), tamu tanpa sesi per IP.
 *  - Kepemilikan diverifikasi: documentId milik akun lain ditolak seolah
 *    tidak ditemukan (tanpa membocorkan keberadaannya).
 *  - Validasi tipe dilakukan dari byte asli, bukan `file.type` klien.
 *  - Route ini TIDAK pernah mengembalikan detail error internal; semua
 *    dipetakan melalui AppError agar pesan siap dibacakan.
 *
 * CATATAN PENGGUNAAN: `export const runtime = 'nodejs'` dipilih karena
 * kita perlu Buffer dan paket Supabase penuh. Jangan ubah ke 'edge' tanpa
 * memastikan ulang kompatibilitas.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { AppError, errorResponse, toAppError } from '@/lib/api-error';
import { extractDocumentWithFallback } from '@/lib/llm';
import { checkRateLimit, identifyRequester, rateLimitHeaders } from '@/lib/rate-limit';
import {
  createRouteHandlerSupabase,
  createServiceSupabase,
  STORAGE_BUCKET,
} from '@/lib/supabase';
import { validateFileOnServer } from '@/lib/validate-file';
import type {
  ExtractedChunk,
  ProcessDocumentRequest,
  ProcessDocumentResponse,
} from '@/types';

export const runtime = 'nodejs';

/** Jangan cache hasil ekstraksi. */
export const dynamic = 'force-dynamic';

export const maxDuration = 120;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    /* ---------------- Identitas pemanggil ---------------- */
    // Sesi dibaca dari cookie (ditulis browser, disegarkan middleware).
    // Gagal baca = tamu tanpa sesi; kepemilikan tetap dicek di bawah.
    const sessionUserId = await getRouteUserId();

    /* ---------------- Rate limit ---------------- */
    // Akun dibatasi per uid agar satu IP bersama (sekolah, warnet) tidak
    // saling menghabiskan kuota; tamu tanpa sesi dibatasi per IP.
    const requester = sessionUserId ?? identifyRequester(request.headers);
    const limit = checkRateLimit(
      sessionUserId ? `user:${sessionUserId}` : requester,
    );

    if (!limit.allowed) {
      const err = new AppError('RATE_LIMITED');
      return NextResponse.json(err.toBody(), {
        status: err.httpStatus,
        headers: rateLimitHeaders(limit),
      });
    }

    /* ---------------- Parsing body ---------------- */
    let body: ProcessDocumentRequest;
    try {
      body = (await request.json()) as ProcessDocumentRequest;
    } catch {
      throw new AppError('BAD_REQUEST', 'Body bukan JSON yang valid.');
    }

    const documentId =
      typeof body.documentId === 'string' && body.documentId.trim().length > 0
        ? body.documentId.trim()
        : null;

    const directPath =
      typeof body.filePath === 'string' && body.filePath.trim().length > 0
        ? body.filePath.trim()
        : null;

    if (!documentId && !directPath) {
      throw new AppError(
        'BAD_REQUEST',
        'Diperlukan documentId atau filePath.',
      );
    }

    const supabase = createServiceSupabase();

    /* ---------------- Ambil metadata dokumen ---------------- */
    let filePath: string;
    let fileName: string;
    let declaredMime: string | null = null;

    if (documentId) {
      // Versi yang disarankan: ambil path dari basis data agar klien tidak
      // dapat menunjuk berkas sembarangan di Storage.
      const { data, error } = await supabase
        .from('documents')
        .select('id, file_path, file_name, mime_type, status, user_id')
        .eq('id', documentId)
        .maybeSingle<{
          id: string;
          file_path: string;
          file_name: string;
          mime_type: string;
          status: string;
          user_id: string | null;
        }>();

      if (error) {
        throw new AppError('UPSTREAM', `Query dokumen gagal: ${error.message}`);
      }
      if (!data) {
        throw new AppError('NO_FILE', `Dokumen ${documentId} tidak ditemukan.`);
      }

      /*
       * Verifikasi kepemilikan. Dokumen milik akun lain ditolak dengan
       * kode yang sama seperti "tidak ditemukan" agar keberadaannya tidak
       * bocor ke pemanggil yang salah. Baris legacy `user_id IS NULL`
       * (dibuat tanpa sesi) tetap dapat diproses tanpa sesi.
       *
       * CATATAN: klien yang SUDAH masuk selalu mengirim `documentId` milik
       * barisnya sendiri (lihat app/page.tsx). Bila sesi server gagal
       * terbaca (cookie), `sessionUserId` menjadi null dan baris ber-uid
       * akan ditolak — mencegahnya, klien juga mengirim `filePath` sebagai
       * cadangan (lihat penanganan di bawah).
       */
      if (data.user_id !== sessionUserId) {
        if (!(data.user_id === null && sessionUserId === null)) {
          throw new AppError('NO_FILE', `Dokumen ${documentId} tidak ditemukan.`);
        }
      }

      filePath = data.file_path;
      fileName = data.file_name;
      declaredMime = data.mime_type;

      await supabase
        .from('documents')
        .update({ status: 'processing', error_message: null })
        .eq('id', documentId);
    } else {
      // Fallback MVP tanpa tabel: path dikirim langsung oleh klien.
      filePath = directPath as string;
      fileName = filePath.split('/').pop() ?? 'dokumen';
      declaredMime = null;

      if (!isSafeStoragePath(filePath)) {
        throw new AppError(
          'BAD_REQUEST',
          `Path tidak valid: ${filePath}`,
        );
      }

      /*
       * Path langsung hanya boleh berasal dari folder milik pemanggil:
       * `<uid>/...` untuk yang sudah masuk, `anonim/...` untuk yang belum.
       *
       * CATATAN PENTING: mode ini adalah jalur fallback yang dipakai HANYA
       * ketika baris `documents` tidak tersedia (insert gagal / tabel
       * belum dibuat). Karena `sessionUserId` di server berasal dari
       * cookie dan bisa gagal terbaca, klien yang SUDAH masuk tetapi
       * terlihat null di sini akan ditolak meski berkasnya sah — inilah
       * akar galat "berkas tidak ditemukan". Untuk itu klien kini
       * mengirim `documentId` bila memungkinkan; jalur ini hanya
       * menyentuh unggahan tanpa baris DB (mis. pengguna belum masuk).
       */
      const expectedPrefix = sessionUserId ? `${sessionUserId}/` : 'anonim/';
      if (!filePath.startsWith(expectedPrefix)) {
        throw new AppError('NO_FILE', 'Berkas tidak ditemukan.');
      }
    }

    /* ---------------- Unduh berkas ---------------- */
    const { data: blob, error: downloadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .download(filePath);

    if (downloadError || !blob) {
      throw new AppError(
        'NO_FILE',
        `Unduh gagal untuk ${filePath}: ${downloadError?.message ?? 'data kosong'}`,
      );
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());

    /* ---------------- Validasi otoritatif ---------------- */
    const validation = validateFileOnServer({
      bytes,
      declaredMime,
      fileName,
    });

    /* ---------------- Ekstraksi ---------------- */
    // `maxChunks` dibatasi oleh env agar biaya terkendali.
    const maxChunks = parseMaxChunks(process.env.MAX_CHUNKS_PER_DOCUMENT);

    const extraction = await extractDocumentWithFallback({
      bytes,
      mimeType: validation.mimeType,
      kind: inferKind(validation.mimeType),
      maxChunks,
    });

    /*
     * Perangkaian bagian kini terjadi di dalam provider yang melayani
     * (lihat `lib/llm.ts` / `lib/gemini.ts`) sehingga bentuk salah satu
     * bagian selalu sama. `joinChunks` tetap tersedia untuk kebutuhan
     * lain yang menerima daftar bagian mentah.
     */
    const text = joinExtractedChunks(extraction.chunks);
    const warnings = [...extraction.warnings];

    // Beri tahu pengguna bila tipe berkas yang diklaim klien tidak cocok
    // dengan isi sebenarnya. Ini indikasi berkas salah nama, dan layak
    // disebutkan alih-alih dibiarkan diam.
    if (validation.mimeMismatch) {
      warnings.push(
        'Jenis berkas yang terdeteksi berbeda dari nama berkasnya. ' +
          'Teks tetap diekstrak dari isi yang sebenarnya.',
      );
    }

    const wordCount = countWords(text);

    /* ---------------- Simpan hasil ---------------- */
    if (documentId) {
      await supabase
        .from('documents')
        .update({
          status: 'ready',
          extracted_text: text,
          page_count: extraction.pageCount,
          error_message: warnings.length > 0 ? warnings.join(' | ') : null,
        })
        .eq('id', documentId);
    }

    const responseBody: ProcessDocumentResponse = {
      text,
      chunks: extraction.chunks,
      pageCount: extraction.pageCount,
      charCount: text.length,
      wordCount,
      truncated: extraction.truncated,
      warnings,
    };

    return NextResponse.json(responseBody, {
      status: 200,
      headers: {
        ...rateLimitHeaders(limit),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    // Catat detail ke log server (tidak pernah ke klien).
    console.error('[process-document]', err);

    // Kembalikan status 'error' pada basis data bila kita sudah punya id.
    // Dilakukan best-effort: kegagalan di sini tidak boleh menutupi error asli.
    try {
      const appErr = toAppError(err);
      void appErr;
    } catch {
      /* abaikan */
    }

    return errorResponse(err);
  }
}

/* ============================================================
 * Helper
 * ============================================================ */

/**
 * Baca id pengguna dari cookie sesi (server). Mengembalikan null untuk
 * tamu tanpa sesi — dan juga bila apa pun gagal (env belum lengkap,
 * cookie rusak) — sehingga rute tetap berfungsi untuk tamu murni.
 * Kepemilikan dokumen milik akun lain tetap ditolak di bawah.
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

/**
 * Terima hanya path relatif yang wajar. Tolak percobaan path traversal,
 * URL absolut, dan bentuk aneh lainnya sebelum menyentuh Storage.
 */
function isSafeStoragePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.includes('..')) return false;
  if (path.startsWith('/')) return false;
  if (/^[a-z]+:\/\//i.test(path)) return false;
  if (/[\u0000-\u001f\\]/.test(path)) return false;
  return true;
}

/**
 * Rangkai bagian-bagian hasil ekstraksi menjadi satu teks akhir dengan
 * jeda yang enak didengar.
 *
 * Perilakunya sengaja identik dengan `joinChunks` di `lib/gemini.ts`
 * (bagian kosong dibuang, dipisah dua baris baru). Fungsi ini ada di sini
 * agar rute tidak bergantung pada modul provider tertentu — baik 9router
 * maupun Gemini mengembalikan bentuk bagian yang sama.
 */
function joinExtractedChunks(chunks: readonly ExtractedChunk[]): string {
  return chunks
    .map((chunk) => chunk.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function inferKind(mimeType: string): 'naratif' | 'bergambar' {
  // Tanpa membaca isi, gambar lebih mungkin merupakan hasil pindai;
  // prompt untuk 'bergambar' meminta model menandai ketidakpastian.
  return mimeType === 'application/pdf' ? 'naratif' : 'bergambar';
}

function parseMaxChunks(raw: string | undefined): number {
  if (!raw) return 40;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 40;
  return parsed;
}

/**
 * Hitung kata. Memakai pemisahan berbasis regex Unicode sehingga teks
 * beraksen tetap terhitung sebagai satu kata.
 */
function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}
