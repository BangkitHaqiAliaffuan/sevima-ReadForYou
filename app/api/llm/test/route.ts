/**
 * POST /api/llm/test
 * ==================
 *
 * ALAT DIAGNOSTIK PENGEMBANGAN — bukan fitur produk.
 *
 * Tujuan: membuktikan jalur provider LLM bekerja (9router → Gemini) tanpa
 * harus mengunggah dokumen dan tanpa menunggu gesekan UI. Ini penting
 * karena mode kegagalan yang mahal adalah fallback yang "diam-diam
 * tidak pernah jalan": semuanya tampak normal sampai 9router mati.
 *
 * Alur:
 *  1. Tolak permintaan bila tidak diizinkan (lihat gerbang di bawah).
 *  2. Kirim prompt kecil ke 9router.
 *  3. Bila gagal, kirim prompt yang sama ke Gemini.
 *  4. Kembalikan provider yang menang + jejak percobaan.
 *
 * GERBANG KEAMANAN:
 *  - Aktif hanya saat `process.env.NODE_ENV !== 'production'`, ATAU bila
 *    `ALLOW_LLM_TEST=1` diatur eksplisit.
 *  - Di produksi tanpa flag tersebut rute membalas 404 — sengaja bukan
 *    403, agar keberadaannya tidak terungkap ke pemanggil luar.
 *  - Tidak pernah mengembalikan nilai kunci, hanya boolean `hasKey`.
 *  - Respons diberi `Cache-Control: no-store`.
 *
 * KEAMANAN: seperti `process-document`, kunci hanya hidup di server dan
 * tidak pernah ikut ke badan respons.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { AppError } from '@/lib/api-error';
import { extractDocumentDetailed } from '@/lib/llm';
import type { ExtractionResult } from '@/lib/gemini';
import {
  checkRateLimit,
  identifyRequester,
  rateLimitHeaders,
} from '@/lib/rate-limit';
import {
  describeLlmConfig,
  generateTextDetailed,
  type LlmMeta,
  type LlmResult,
} from '@/lib/llm';

export const runtime = 'nodejs';

/** Diagnostik tidak boleh di-cache. */
export const dynamic = 'force-dynamic';

export const maxDuration = 120;

/** Diagnostik itu murah, tapi tetap dibatasi agar tidak jadi alat bakar kuota. */
const TEST_RATE_LIMIT_PER_MINUTE = 10;

interface TestResponse {
  ok: boolean;
  /** Mode yang diuji: 'text' (jawab singkat) atau 'extract' (dokumen). */
  mode: TestMode;
  provider: LlmMeta['provider'] | null;
  attempts: LlmMeta['attempts'];
  /** Cuplikan jawaban model — dibatasi agar tidak membocorkan prompt penuh. */
  sample: string | null;
  latencyMs: number;
  config: ReturnType<typeof describeLlmConfig>;
}

type TestMode = 'text' | 'extract';

export async function POST(request: NextRequest): Promise<Response> {
  const startedAt = Date.now();

  if (!isTestAllowed()) {
    return NextResponse.json(
      { error: { code: 'NO_FILE', message: 'Tidak ditemukan.' } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const limit = checkRateLimit(identifyRequester(request.headers), {
      max: TEST_RATE_LIMIT_PER_MINUTE,
      keyPrefix: 'llm-test',
    });
    if (!limit.allowed) {
      const err = new AppError('RATE_LIMITED');
      return NextResponse.json(err.toBody(), {
        status: err.httpStatus,
        headers: rateLimitHeaders(limit),
      });
    }

    /*
     * Mode dipilih lewat query `?mode=`:
     *   text    (bawaan) — prompt pendek; membuktikan koneksi & kunci.
     *   extract          — menjalankan pipeline ekstraksi NYATA (PDF dirender
     *                      per halaman untuk 9router). Ini yang paling
     *                      berguna: kegagalan ekstraksi (mis. pengubah PDF
     *                      tidak terpasang) tidak akan terlihat dari mode teks.
     */
    const mode = resolveMode(new URL(request.url).searchParams.get('mode'));

    if (mode === 'extract') {
      const result = await runExtractProbe();
      const body: TestResponse = {
        ok: true,
        mode,
        provider: result.meta.provider,
        attempts: result.meta.attempts,
        sample: summarizeExtraction(result.value),
        latencyMs: Date.now() - startedAt,
        config: describeLlmConfig(),
      };
      return NextResponse.json(body, {
        status: 200,
        headers: { ...rateLimitHeaders(limit), 'Cache-Control': 'no-store' },
      });
    }

    // Prompt sesengaja mungkin mirip tugas asli (instruksi + batas kata)
    // supaya hasil tes mewakili perilaku produksi.
    const prompt =
      'Balas HANYA dengan kalimat: "Koneksi model berhasil.". ' +
      'Jangan menambahkan penjelasan lain.';

    const result = await generateTextDetailed({
      prompt,
      temperature: 0,
      maxOutputTokens: 64,
    });

    const body: TestResponse = {
      ok: true,
      mode,
      provider: result.meta.provider,
      attempts: result.meta.attempts,
      sample: result.value.slice(0, 200),
      latencyMs: Date.now() - startedAt,
      config: describeLlmConfig(),
    };

    return NextResponse.json(body, {
      status: 200,
      headers: {
        ...rateLimitHeaders(limit),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[api/llm/test]', err);

    // Tetap laporkan konfigurasi: saat debug, pertanyaan pertama selalu
    // "apakah kuncinya terbaca?", dan jawabannya harus ada di sini.
    const base = describeLlmConfig();
    const appErr = err instanceof AppError ? err : null;

    return NextResponse.json(
      {
        ok: false,
        mode: resolveMode(new URL(request.url).searchParams.get('mode')),
        provider: null,
        attempts: [],
        sample: null,
        latencyMs: Date.now() - startedAt,
        config: base,
        error: {
          code: appErr?.code ?? 'UPSTREAM',
          // Pesan ramah (sama seperti yang dibaca pengguna)...
          message: appErr?.toBody().error.message ?? 'Gagal menghubungi model.',
          // ...DAN penyebab teknisnya. Ini inti perbaikan: sebelumnya pesan
          // generik ini menyembunyikan sebabnya, sehingga "AI bermasalah"
          // bisa berarti kuota habis, kunci salah, atau jaringan mati.
          cause: appErr?.debugDetail ?? (err instanceof Error ? err.message : String(err)),
        },
      },
      {
        status: appErr?.httpStatus ?? 502,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}

/** Lihat "GERBANG KEAMANAN" di atas. */
function isTestAllowed(): boolean {
  if (process.env.ALLOW_LLM_TEST === '1') return true;
  return process.env.NODE_ENV !== 'production';
}

/** GET hanya memberi ringkasan konfigurasi — tanpa memanggil model. */
export async function GET(request: NextRequest): Promise<Response> {
  if (!isTestAllowed()) {
    return NextResponse.json(
      { error: { code: 'NO_FILE', message: 'Tidak ditemukan.' } },
      { status: 404 },
    );
  }
  void request;
  return NextResponse.json(
    {
      hint: 'Kirim POST ke rute ini untuk benar-benar memanggil model.',
      modes: {
        text: 'POST /api/llm/test — prompt pendek, membuktikan koneksi & kunci',
        extract:
          'POST /api/llm/test?mode=extract — menjalankan pipeline ekstraksi nyata ' +
          '(PDF dirender per halaman bila 9router yang melayani)',
      },
      config: describeLlmConfig(),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}

/* ============================================================
 * Helper
 * ============================================================ */

function resolveMode(raw: string | null): TestMode {
  return raw?.trim().toLowerCase() === 'extract' ? 'extract' : 'text';
}

/**
 * Jalankan pipeline ekstraksi pada PDF kecil yang dibangun di sini.
 *
 * Memakai `extractDocumentDetailed` supaya provider yang benar-benar
 * melayani ikut terlaporkan. PDF-nya dibangun tanpa pustaka luar agar probe
 * ini tidak menambah dependensi hanya demi diagnostik.
 */
async function runExtractProbe(): Promise<LlmResult<ExtractionResult>> {
  return extractDocumentDetailed({
    bytes: buildProbePdf(),
    mimeType: 'application/pdf',
    kind: 'naratif',
  });
}

/**
 * PDF satu halaman minimal, dibangun tanpa pustaka.
 *
 * Objek xref ditulis lengkap supaya Poppler menerimanya — inilah yang
 * membuat mode `extract` benar-benar menguji jalur render.
 */
function buildProbePdf(): Uint8Array {
  const line =
    'Uji ekstraksi ReadForYou. Kalimat ini harus muncul pada jawaban model.';
  const content = `BT /F1 12 Tf 40 760 Td (${line.replace(/[()\\]/g, '')}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(out);
}

/** Ringkas hasil ekstraksi agar muat di respons tanpa membocorkan isi. */
function summarizeExtraction(value: {
  chunks: unknown[];
  pageCount: number;
  warnings: string[];
}): string {
  const first = value.chunks[0] as { text?: string } | undefined;
  const head = first?.text?.slice(0, 160) ?? '(kosong)';
  return (
    `${value.chunks.length} bagian, ${value.pageCount} halaman. ` +
    `Cuplikan: ${head}`
  );
}
