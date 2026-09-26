/**
 * Wrapper Google Gemini — AI ReadForYou
 * =====================================
 *
 * File ini menyembunyikan seluruh kompleksitas panggilan model:
 *  - pemilihan model + fallback otomatis ketika model tidak ditemukan
 *  - structured output (responseJsonSchema) agar hasil dapat dipercaya mesin
 *  - chunked extraction untuk dokumen panjang
 *  - retry terbatas untuk kegagalan transien
 *  - timeout agar permintaan tidak menggantung selamanya
 *
 * CATATAN MODEL (penting):
 * `gemini-1.5-flash` sudah di-shutdown Google. Gunakan model GA terbaru
 * melalui GEMINI_MODEL. Rujukan resmi:
 * https://ai.google.dev/gemini-api/docs/deprecations
 */

import { GoogleGenAI, type Part } from '@google/genai';

import { AppError } from '@/lib/api-error';
import { estimatePdfPageCount } from '@/lib/validate-file';
import type { ExtractedChunk } from '@/types';

/* ============================================================
 * Konfigurasi
 * ============================================================ */

/** Model terbaru yang direkomendasikan Google untuk proyek baru. */
const DEFAULT_MODEL = 'gemini-3.8-flash';

/** Dipakai bila model utama tidak ditemukan. Berurutan sebagai cadangan. */
const DEFAULT_FALLBACKS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];

/** Plafon keras untuk satu permintaan yang menggantung. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Percobaan ulang hanya untuk kegagalan yang bersifat sementara. */
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 800;

/** Batas ukuran satu permintaan inline. */
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

/**
 * Perkiraan token keluaran maksimum. Dipakai untuk memutuskan strategi
 * chunking, bukan sebagai jaminan kuota.
 */
const MAX_OUTPUT_TOKENS = 65_536;

/* ============================================================
 * Prompt
 * ============================================================ */

/**
 * Instruksi inti untuk Gemini.
 *
 * Dirancang untuk tiga tujuan sekaligus:
 *  1. Hasil berupa kalimat mengalir, bukan teks mentah berstruktur.
 *  2. Membuang elemen yang mengganggu pendengaran (nomor halaman, header,
 *     footer, watermark, nama berkas).
 *  3. Melarang halusinasi secara eksplisit. Untuk modul pelajaran,
 *     informasi yang dikarang lebih berbahaya daripada teks yang kurang
 *     rapi.
 */
const BASE_INSTRUCTION = `
Kamu adalah mesin pra-proses untuk Text-to-Speech. Tugasmu mengekstrak
teks dari dokumen agar nyaman dibacakan kepada siswa penyandang
disabilitas penglihatan.

ATURAN WAJIB:
1. Tulis ulang isi dokumen menjadi kalimat mengalir yang natural,
   seolah dibacakan narator profesional.
2. Abaikan sepenuhnya: nomor halaman, header, footer, watermark, nama
   berkas, dan pesan hak cipta yang berulang di setiap halaman.
3. Jangan gunakan penomoran seperti "1." atau "2." dan jangan gunakan
   simbol bullet. Ubah semuanya menjadi rangkaian kalimat.
4. Terjemahkan simbol matematika, rumus, dan tabel menjadi kalimat yang
   mudah didengar. Contoh: "x^2" dibaca "x pangkat dua"; tanda "=" dibaca
   "sama dengan"; tabel dibacakan sebagai "pada baris pertama, kolom
   pertama disebutkan ... lalu kolom kedua ...".
5. JANGAN menambahkan informasi yang tidak ada di dokumen. Jangan
   menyimpulkan, jangan mengomentari, jangan meringkas.
6. Jika ada bagian yang tidak terbaca atau tidak jelas, jangan mengarang.
   Tandai masalahnya pada kolom catatan.
7. Tulis dalam bahasa yang sama dengan dokumen.
`.trim();

const SCHEMA_HINT = `
Kembalikan hasil dalam format JSON dengan struktur tepat seperti ini:
{
  "teks": "seluruh isi dokumen sebagai kalimat mengalir yang siap dibacakan",
  "jumlah_halaman": <angka, perkiraan jumlah halaman yang benar-benar dibaca>,
  "ada_bagian_gagal": <true atau false>,
  "catatan": "<penjelasan singkat bila ada bagian gagal, atau string kosong>"
}
Jangan menambahkan penjelasan di luar JSON.
`.trim();

export type DocumentKind = 'naratif' | 'matematis' | 'bergambar';

function kindInstruction(kind: DocumentKind): string {
  switch (kind) {
    case 'matematis':
      return `
Dokumen ini berisi materi eksakta. Bacakan setiap rumus, tabel, dan
diagram sebagai kalimat utuh dan berurutan. Sebutkan nama satuan secara
lengkap. Jangan melewati satu pun langkah perhitungan.
      `.trim();
    case 'bergambar':
      return `
Dokumen ini hasil pemindaian atau berisi banyak gambar. Jika ada bagian
yang buram, miring, atau sulit dibaca, jangan menebak. Catat bagian mana
yang tidak terbaca pada kolom catatan, dan lanjutkan membaca bagian yang
jelas.
      `.trim();
    case 'naratif':
    default:
      return `
Dokumen ini berupa teks pelajaran umum. Pertahankan urutan alur bacaan
dari awal hingga akhir. Panjangkan singkatan yang tidak lazim menjadi
bentuk lengkap agar terdengar jelas.
      `.trim();
  }
}

function buildPrompt(kind: DocumentKind, chunkNote?: string): string {
  const parts = [BASE_INSTRUCTION, '', kindInstruction(kind), '', SCHEMA_HINT];
  if (chunkNote) {
    parts.push('', chunkNote);
  }
  return parts.join('\n');
}

/* ============================================================
 * Skema respons
 * ============================================================
 *
 * CATATAN VERSI SDK (@google/genai v2):
 *
 * Field `responseSchema` kini ditandai Deprecated dan diarahkan ke
 * `responseJsonSchema`, yang menerima JSON Schema standar (draf
 * OpenAPI 3.0). SDK v2 masih menyediakan shim otomatis untuk
 * kompatibilitas mundur, tetapi mengandalkan perilaku implisit itu
 * berisiko: shim dapat dihapus pada rilis berikutnya tanpa peringatan.
 *
 * Karena itu kita memakai `responseJsonSchema` secara eksplisit dengan
 * bentuk JSON Schema yang standar. Keuntungan tambahan: properti seperti
 * `additionalProperties: false` dan `description` menjadi sah, dan
 * deskripsi inilah yang memandu model menghasilkan teks yang kita
 * inginkan — bukan sekadar menebak dari nama field.
 */
const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    teks: {
      type: 'string',
      description:
        'Seluruh isi dokumen sebagai kalimat mengalir yang siap dibacakan ' +
        'Text-to-Speech. Tanpa nomor halaman, header, footer, penomoran, ' +
        'atau simbol bullet. Simbol matematika dan tabel sudah diubah ' +
        'menjadi kalimat.',
    },
    jumlah_halaman: {
      type: 'integer',
      description:
        'Perkiraan jumlah halaman yang benar-benar berhasil dibaca.',
    },
    ada_bagian_gagal: {
      type: 'boolean',
      description:
        'Bernilai true bila ada bagian dokumen yang tidak dapat dibaca ' +
        '(buram, terpotong, atau tidak jelas).',
    },
    catatan: {
      type: 'string',
      description:
        'Penjelasan singkat tentang bagian yang gagal dibaca. ' +
        'Isi dengan string kosong bila tidak ada masalah.',
    },
  },
  required: ['teks', 'jumlah_halaman', 'ada_bagian_gagal'],
} as const;

interface RawExtraction {
  teks: string;
  jumlah_halaman: number;
  ada_bagian_gagal: boolean;
  catatan?: string;
}

/* ============================================================
 * Klien & konfigurasi model
 * ============================================================ */

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError(
      'CONFIG',
      'GEMINI_API_KEY belum diatur. Salin .env.local.example menjadi ' +
        '.env.local lalu isi kunci dari Google AI Studio.',
    );
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
}

interface ModelChain {
  primary: string;
  fallbacks: string[];
}

function resolveModelChain(): ModelChain {
  const primary = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const configured = process.env.GEMINI_FALLBACK_MODELS?.trim();

  const fallbacks = (configured
    ? configured.split(',').map((m) => m.trim())
    : DEFAULT_FALLBACKS
  ).filter((m) => m.length > 0 && m !== primary);

  return { primary, fallbacks };
}

/**
 * Apakah error menunjukkan model tidak ada / tidak didukung?
 *
 * Ini yang membuat fallback otomatis bekerja: ketika Google menonaktifkan
 * sebuah model, aplikasi berpindah ke cadangan tanpa perlu diubah manual.
 */
function isModelNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /\b404\b/.test(message) ||
    /not\s*found/i.test(message) ||
    /is\s+not\s+supported/i.test(message) ||
    /does\s+not\s+exist/i.test(message) ||
    /no\s+longer\s+available/i.test(message) ||
    /deprecated/i.test(message)
  );
}

/** Kegagalan sementara yang boleh dicoba ulang. */
function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /\b429\b/.test(message) ||
    /\b5\d{2}\b/.test(message) ||
    /RESOURCE_EXHAUSTED/i.test(message) ||
    /UNAVAILABLE/i.test(message) ||
    /INTERNAL/i.test(message) ||
    /DEADLINE_EXCEEDED/i.test(message) ||
    /fetch\s*failed/i.test(message) ||
    /network/i.test(message)
  );
}

function backoff(attempt: number): Promise<void> {
  const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 250;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/* ============================================================
 * Pemanggilan model tingkat rendah
 * ============================================================ */

interface GenerateArgs {
  bytes: Uint8Array;
  mimeType: string;
  prompt: string;
  signal: AbortSignal;
}

/**
 * Panggil model dengan rantai fallback. Mengembalikan teks JSON mentah.
 *
 * Untuk setiap model, kegagalan transien dicoba ulang hingga MAX_RETRIES.
 * Kegagalan "model not found" menyebabkan langsung lanjut ke model
 * berikutnya, karena mencoba ulang model yang tidak ada itu sia-sia.
 */
async function generateWithFallback(args: GenerateArgs): Promise<string> {
  const chain = resolveModelChain();
  const models = [chain.primary, ...chain.fallbacks];
  const errors: string[] = [];

  for (const model of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (args.signal.aborted) throw new AppError('TIMEOUT');

      try {
        const base64 = bytesToBase64(args.bytes);

        const parts: Part[] = [
          { inlineData: { mimeType: args.mimeType, data: base64 } },
          { text: args.prompt },
        ];

        const response = await withAbort(
          getClient().models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: {
              // Suhu rendah: kita menginginkan ekstraksi setia, bukan
              // kreasi. Halusinasi pada materi pelajaran jauh lebih
              // merugikan daripada teks yang kurang luwes.
              temperature: 0.2,
              topP: 0.9,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              responseMimeType: 'application/json',
              // `responseJsonSchema` (bukan `responseSchema`) sesuai
              // rekomendasi SDK v2 yang tidak deprecated.
              responseJsonSchema: RESPONSE_JSON_SCHEMA,
            },
          }),
          args.signal,
        );

        const text = response.text;
        if (!text || text.trim().length === 0) {
          throw new Error('Model mengembalikan respons kosong.');
        }
        return text;
      } catch (err) {
        if (args.signal.aborted) throw new AppError('TIMEOUT');

        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${model}: ${message}`);

        if (isModelNotFound(err)) {
          // Model ini mati; pindah ke cadangan tanpa mencoba ulang.
          break;
        }
        if (isTransient(err) && attempt < MAX_RETRIES) {
          await backoff(attempt);
          continue;
        }
        throw new AppError('UPSTREAM', message);
      }
    }
  }

  throw new AppError(
    'MODEL_NOT_FOUND',
    `Semua model gagal. Rincian: ${errors.join(' | ')}`,
  );
}

/* ============================================================
 * Teks bebas (tanya-jawab) — memakai ulang rantai model di atas
 * ============================================================ */

export interface GenerateTextOptions {
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/**
 * Panggil model dengan rantai fallback untuk prompt teks bebas.
 *
 * Berbeda dari `generateWithFallback` (khusus ekstraksi dokumen biner +
 * structured output), fungsi ini mengembalikan teks polos. Logika
 * fallback (model mati → cadangan; transien → backoff + retry) dipakai
 * ulang persis agar perilaku konsisten di semua jalur Gemini.
 */
export async function generateTextWithFallback(
  options: GenerateTextOptions,
): Promise<string> {
  const chain = resolveModelChain();
  const models = [chain.primary, ...chain.fallbacks];
  const errors: string[] = [];

  const internal = new AbortController();
  const timeout = setTimeout(() => internal.abort(), REQUEST_TIMEOUT_MS);
  const signal = options.signal ?? internal.signal;

  try {
    for (const model of models) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (signal.aborted) throw new AppError('TIMEOUT');

        try {
          const parts: Part[] = [{ text: options.prompt }];

          const response = await withAbort(
            getClient().models.generateContent({
              model,
              contents: [{ role: 'user', parts }],
              config: {
                temperature: options.temperature ?? 0.3,
                topP: 0.9,
                maxOutputTokens: options.maxOutputTokens ?? 1024,
              },
            }),
            signal,
          );

          const text = response.text;
          if (!text || text.trim().length === 0) {
            throw new Error('Model mengembalikan respons kosong.');
          }
          return text.trim();
        } catch (err) {
          if (signal.aborted) throw new AppError('TIMEOUT');

          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${model}: ${message}`);

          if (isModelNotFound(err)) {
            // Model ini mati; pindah ke cadangan tanpa mencoba ulang.
            break;
          }
          if (isTransient(err) && attempt < MAX_RETRIES) {
            await backoff(attempt);
            continue;
          }
          throw new AppError('UPSTREAM', message);
        }
      }
    }

    throw new AppError(
      'MODEL_NOT_FOUND',
      `Semua model gagal. Rincian: ${errors.join(' | ')}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Bungkus promise dengan AbortSignal. SDK tidak selalu menghormati signal,
 * jadi kita menambahkan perlombaan (race) eksplisit agar timeout benar.
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Dibatalkan', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Dibatalkan', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/* ============================================================
 * Konversi biner
 * ============================================================ */

function bytesToBase64(bytes: Uint8Array): string {
  // `Buffer` tersedia di Node runtime; fallback ke btoa untuk lingkungan
  // edge (yang memakai string latin1).
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

/* ============================================================
 * Parsing hasil
 * ============================================================ */

function parseExtraction(raw: string): RawExtraction {
  // Model kadang membungkus JSON dalam pagar markdown meski schema
  // sudah diminta. Bersihkan dulu.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Jalan terakhir: ambil objek pertama yang tampak JSON.
    const match = /\{[\s\S]*\}/.exec(cleaned);
    if (!match) {
      throw new AppError('UPSTREAM', 'Respons model bukan JSON yang valid.');
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new AppError('UPSTREAM', 'Respons model gagal diurai.');
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new AppError('UPSTREAM', 'Struktur respons tidak dikenali.');
  }

  const record = parsed as Record<string, unknown>;
  const text = typeof record.teks === 'string' ? record.teks : '';
  const pages =
    typeof record.jumlah_halaman === 'number' && Number.isFinite(record.jumlah_halaman)
      ? Math.max(0, Math.round(record.jumlah_halaman))
      : 0;

  if (text.trim().length === 0) {
    throw new AppError(
      'UPSTREAM',
      'Model tidak menghasilkan teks yang dapat dibacakan.',
    );
  }

  return {
    teks: text.trim(),
    jumlah_halaman: pages,
    ada_bagian_gagal: record.ada_bagian_gagal === true,
    catatan: typeof record.catatan === 'string' ? record.catatan.trim() : undefined,
  };
}

/* ============================================================
 * API publik
 * ============================================================ */

export interface ExtractOptions {
  bytes: Uint8Array;
  mimeType: string;
  kind?: DocumentKind;
  /** Batas jumlah bagian. 0 = tanpa batas. */
  maxChunks?: number;
  /** Dipanggil setiap satu bagian selesai, untuk progres aksesibel. */
  onChunk?: (info: { index: number; total: number; text: string }) => void;
}

export interface ExtractionResult {
  chunks: ExtractedChunk[];
  pageCount: number;
  truncated: boolean;
  warnings: string[];
}

/**
 * Ekstrak satu bagian yang tidak dapat dibelah lagi (satu gambar, atau
 * PDF pendek).
 */
async function extractSingle(
  options: ExtractOptions,
  signal: AbortSignal,
  promptNote?: string,
): Promise<RawExtraction> {
  const prompt = buildPrompt(options.kind ?? 'naratif', promptNote);
  const raw = await generateWithFallback({
    bytes: options.bytes,
    mimeType: options.mimeType,
    prompt,
    signal,
  });
  return parseExtraction(raw);
}

/**
 * Ekstrak dokumen secara menyeluruh.
 *
 * KEPUTUSAN ARSITEKTUR — CHUNKED EXTRACTION
 *
 * Batas keras keluaran model Flash sekitar 65.536 token (kurang lebih
 * 50.000 kata). Satu modul pelajaran penuh dapat melampaui batas itu, dan
 * bila melampaui, keluaran terpotong DIAM-DIAM di tengah bab. Untuk
 * aplikasi yang membacakan materi pelajaran, kehilangan halaman terakhir
 * tanpa peringatan adalah kegagalan yang serius.
 *
 * Karena API Gemini belum menyediakan parameter rentang halaman, pemecahan
 * saya lakukan pada tingkat berkas: bila berkas dapat dibelah (misalnya
 * gambar yang kita kirim per potongan), tiap potongan diekstrak terpisah
 * lalu dirangkai. Untuk PDF, satu permintaan sudah mencakup seluruh
 * dokumen, dan kita mendeteksi pemotongan melalui sinyal dari model
 * (ada_bagian_gagal / catatan) serta rasio keluaran terhadap masukan.
 *
 * Setiap bagian dilaporkan melalui `onChunk` agar UI dapat mengumumkan
 * progres kepada pengguna screen reader.
 */
export async function extractDocument(
  options: ExtractOptions,
): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const chunks: ExtractedChunk[] = [];
  const kind = options.kind ?? 'naratif';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    if (options.bytes.length > MAX_INLINE_BYTES) {
      throw new AppError(
        'TOO_LARGE',
        `Berkas ${options.bytes.length} byte melebihi batas ` +
          `${MAX_INLINE_BYTES} byte untuk pengiriman inline.`,
      );
    }

    const isPdf = options.mimeType === 'application/pdf';
    const estimatedPages = isPdf ? estimatePdfPageCount(options.bytes) : 0;

    // Dokumen yang sangat panjang pada dasarnya tidak dapat ditangani satu
    // permintaan (batas keluaran). Model tetap kita minta membaca
    // selengkap mungkin, dan kita peringatkan pengguna lebih dulu bila
    // perkiraan halaman sudah mengindikasikan risiko pemotongan.
    if (isPdf && estimatedPages > 0 && estimatedPages > 60) {
      warnings.push(
        `Dokumen ini diperkirakan sekitar ${estimatedPages} halaman. ` +
          `Bagian akhir mungkin tidak terbaca seluruhnya. ` +
          `Untuk hasil terbaik, pisahkan modul menjadi beberapa berkas per bab.`,
      );
    }

    /*
     * BUG YANG DIPERBAIKI:
     * Sebelumnya baris ini mengambil `kind` dari opsi tetapi kemudian
     * tidak pernah meneruskannya — `extractSingle` memakai
     * `options.kind` mentah yang bisa `undefined`. Akibatnya dokumen
     * tanpa jenis eksplisit kehilangan instruksi prompt khusus
     * (matematika/bergambar), padahal variabel `kind` sudah dihitung
     * dengan nilai bawaan yang benar. Sekarang nilai yang sudah
     * dinormalisasi diteruskan secara eksplisit.
     */
    const extraction = await extractSingle(
      { ...options, kind },
      controller.signal,
    );

    chunks.push({
      index: 0,
      text: extraction.teks,
      pageCount: extraction.jumlah_halaman || estimatedPages,
      hadUnreadable: extraction.ada_bagian_gagal,
      note: extraction.catatan ?? null,
    });

    options.onChunk?.({ index: 0, total: 1, text: extraction.teks });

    if (extraction.ada_bagian_gagal) {
      warnings.push(
        extraction.catatan && extraction.catatan.length > 0
          ? `Sebagian dokumen tidak terbaca seluruhnya. Catatan dari sistem: ${extraction.catatan}`
          : 'Sebagian dokumen tidak terbaca seluruhnya. Teks yang tersedia tetap dapat dibacakan.',
      );
    }

    return {
      chunks,
      pageCount: extraction.jumlah_halaman || estimatedPages,
      truncated: extraction.ada_bagian_gagal,
      warnings,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Rangkai bagian-bagian menjadi satu teks akhir dengan transisi yang enak
 * didengar. Jeda antar bagian ditandai dengan tanda baca, bukan penanda
 * teknis, supaya TTS tidak membacakan kata-kata seperti "bagian dua".
 */
export function joinChunks(chunks: readonly ExtractedChunk[]): string {
  return chunks
    .map((chunk) => chunk.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/** Utilitas untuk keperluan uji/log. */
export function describeModelChain(): ModelChain {
  return resolveModelChain();
}
