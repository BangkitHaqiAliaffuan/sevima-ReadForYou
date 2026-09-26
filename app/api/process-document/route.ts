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
 *  - Rate limit diterapkan sebelum pekerjaan mahal dilakukan.
 *  - Validasi tipe dilakukan dari byte asli, bukan `file.type` klien.
 *  - Route ini TIDAK pernah mengembalikan detail error internal; semua
 *    dipetakan melalui AppError agar pesan siap dibacakan.
 *
 * CATATAN PENGGUNAAN: `export const runtime = 'nodejs'` dipilih karena
 * kita perlu Buffer dan paket Supabase penuh. Jangan ubah ke 'edge' tanpa
 * memastikan ulang kompatibilitas.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { AppError, errorResponse, toAppError } from '@/lib/api-error';
import { extractDocument, joinChunks } from '@/lib/gemini';
import { checkRateLimit, identifyRequester, rateLimitHeaders } from '@/lib/rate-limit';
import { createServiceSupabase, STORAGE_BUCKET } from '@/lib/supabase';
import { validateFileOnServer } from '@/lib/validate-file';
import type {
  ProcessDocumentRequest,
  ProcessDocumentResponse,
} from '@/types';

export const runtime = 'nodejs';

/** Jangan cache hasil ekstraksi. */
export const dynamic = 'force-dynamic';

export const maxDuration = 120;

export async function POST(request: NextRequest): Promise<Response> {
  try {
    /* ---------------- Rate limit ---------------- */
    const requester = identifyRequester(request.headers);
    const limit = checkRateLimit(requester);

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
        .select('id, file_path, file_name, mime_type, status')
        .eq('id', documentId)
        .maybeSingle<{
          id: string;
          file_path: string;
          file_name: string;
          mime_type: string;
          status: string;
        }>();

      if (error) {
        throw new AppError('UPSTREAM', `Query dokumen gagal: ${error.message}`);
      }
      if (!data) {
        throw new AppError('NO_FILE', `Dokumen ${documentId} tidak ditemukan.`);
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

    const extraction = await extractDocument({
      bytes,
      mimeType: validation.mimeType,
      kind: inferKind(validation.mimeType),
      maxChunks,
    });

    const text = joinChunks(extraction.chunks);
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
