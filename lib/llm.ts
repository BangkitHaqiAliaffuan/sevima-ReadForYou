/**
 * Lapisan provider LLM — AI ReadForYou
 * ====================================
 *
 * TUJUAN
 * ------
 * Memberi aplikasi satu pintu masuk ke model bahasa, sehingga pemilihan
 * provider tidak lagi bocor ke seluruh kode bisnis. Saat ini ada dua
 * penyedia:
 *
 *   1. 9router  — gateway OpenAI-compatible di jaringan lokal
 *                 (default http://localhost:20128/v1). Dipakai lebih dulu
 *                 selama pengembangan karena murah, cepat, dan tidak
 *                 menghabiskan kuota Gemini.
 *   2. Gemini   — penyedia produksi. SELALU menjadi jaring pengaman:
 *                 begitu 9router tidak dapat dihubungi, menolak kunci,
 *                 kehabisan kuota, atau mengembalikan galat, permintaan
 *                 yang sama diulang ke Gemini tanpa intervensi pengguna.
 *
 * URUTAN YANG DAPAT DIATUR
 * ------------------------
 * `LLM_PROVIDER_ORDER=9router,gemini` (default). Daftar ini dibaca
 * kiri-ke-kanan. Semua provider dalam daftar akan dicoba sampai ada yang
 * berhasil; kegagalan pada satu provider tidak pernah menjatuhkan
 * permintaan selama masih ada provider berikutnya.
 *
 * CATATAN ARSITEKTUR — kenapa adaptor Gemini dipanggil malah-luar
 * ---------------------------------------------------------------
 * `lib/gemini.ts` sudah memiliki logika internal yang matang: rantai
 * beberapa model (`GEMINI_MODEL` + `GEMINI_FALLBACK_MODELS`), backoff
 * untuk galat transien, deteksi "model tidak ditemukan", pembersihan
 * JSON dari pagar markdown, dan skema respons terstruktur. Logika itu
 * TIDAK kami salin ke sini; kami hanya memanggilnya. Dengan begitu
 * perbaikan di `lib/gemini.ts` otomatis berlaku untuk jalur 9router →
 * Gemini, tanpa risiko dua implementasi yang berbeda perilaku.
 *
 * KEAMANAN
 * --------
 * - Hanya `LLM_API_KEY` (tanpa awalan `NEXT_PUBLIC_`) yang dibaca. Kunci
 *   tidak pernah masuk ke bundel browser.
 * - Modul ini mengimpor `./gemini`, yang pada gilirannya mengimpor
 *   `msedge-tts` pada jalur TTS. Karena itu `lib/llm.ts` HANYA boleh
 *   diimpor dari kode server (route handler / server-only module).
 *
 * CATATAN `process.env` LITERAL
 * -----------------------------
 * Sesuai aturan proyek di `AGENTS.md`, akses `process.env` di sini selalu
 * memakai kunci literal. Tidak ada helper generik `readEnv(name)` — nilai
 * yang diakses secara terhitung tidak akan pernah ter-inline bila modul ini
 * suatu saat tersentuh bundel browser, dan gejalanya adalah `undefined`
 * yang membingungkan.
 */

import { AppError } from '@/lib/api-error';
import { extractDocumentWithGemini, generateTextWithGemini } from '@/lib/gemini';
import type { DocumentKind, ExtractionResult } from '@/lib/gemini';
import { renderPdfPages } from '@/lib/pdf-render';
import type { ExtractedChunk } from '@/types';

/* ============================================================
 * Konstanta
 * ============================================================ */

/** Urutan provider bawaan. 9router dulu (murah), Gemini sebagai jaring. */
const DEFAULT_PROVIDER_ORDER = ['9router', 'gemini'] as const;

/** Base URL gateway 9router. Aman ditebak untuk pengembangan lokal. */
const DEFAULT_9ROUTER_BASE_URL = 'http://localhost:20128/v1';

/**
 * Model bawaan 9router.
 *
 * Model ini dipilih setelah verifikasi langsung ke gateway: ia menerima
 * gambar (vision) DAN mematuhi `response_format: json_object`. Keduanya
 * syarat mutlak, karena ekstraksi dokumen mengirim berkas biner inline
 * dan mengharapkan JSON terstruktur sebagai balasan.
 */
const DEFAULT_9ROUTER_MODEL = 'cbai/deepseek-v4.1-flash';

/** Plafon satu panggilan 9router. */
const ROUTER_TIMEOUT_MS = 60_000;

/** Percobaan ulang untuk galat transien (429/5xx/jaringan). */
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 800;

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/* ============================================================
 * Jenis & tipe
 * ============================================================ */

export type ProviderName = '9router' | 'gemini';

/** Tujuan pemanggilan. Hanya untuk pemisahan statistik dan pesan galat. */
export type LlmPurpose = 'extract' | 'text';

export interface ProviderAttempt {
  provider: ProviderName;
  ok: boolean;
  /** true bila provider ini tidak dikonfigurasi, jadi sengaja dilewati. */
  skipped?: boolean;
  /**
   * Ringkas, stabil, dan AMAN untuk ditampilkan: kategori penyebabnya.
   *
   * KENAPA INI ADA: pesan galat ke pengguna sengaja generik
   * ("Layanan kecerdasan buatan sedang bermasalah"), yang benar untuk
   * produksi tetapi membuat penelusuran buta. `reason` adalah jalan tengah —
   * ia menyebut KATEGORI masalah (kuota habis, kunci ditolak, jaringan mati,
   * bentuk permintaan salah) tanpa membocorkan isi dokumen atau detail
   * internal provider.
   */
  reason?: FailureReason;
  /** Rincian teknis. Hanya untuk log server, tidak pernah ke klien. */
  error?: string;
}

export type FailureReason =
  | 'quota'
  | 'auth'
  | 'network'
  | 'bad-request'
  | 'missing-key'
  | 'timeout'
  | 'empty'
  | 'unknown';

export interface LlmMeta {
  /** Nama provider yang akhirnya melayani permintaan. */
  provider: ProviderName;
  /** Semua provider yang dicoba sebelum berhasil, berurutan. */
  attempts: ProviderAttempt[];
}

/** Hasil lengkap: nilainya plus jejak provider (berguna untuk diagnostik). */
export interface LlmResult<T> {
  value: T;
  meta: LlmMeta;
}

/* ============================================================
 * Konfigurasi
 * ============================================================ */

export interface LlmConfig {
  order: ProviderName[];
  router: { baseUrl: string; model: string; hasKey: boolean };
  gemini: { hasKey: boolean };
}

/** Baca daftar provider dari env, buang duplikat dan nama tak dikenal. */
function resolveProviderOrder(): ProviderName[] {
  const raw = process.env.LLM_PROVIDER_ORDER?.trim();
  const names = (raw ? raw.split(',') : [...DEFAULT_PROVIDER_ORDER])
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is ProviderName =>
      entry === '9router' || entry === 'gemini',
    );

  const unique = Array.from(new Set(names));
  return unique.length > 0 ? unique : [...DEFAULT_PROVIDER_ORDER];
}

function resolveRouterBaseUrl(): string {
  const raw = process.env.LLM_BASE_URL?.trim() || DEFAULT_9ROUTER_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function resolveRouterModel(): string {
  return process.env.LLM_MODEL?.trim() || DEFAULT_9ROUTER_MODEL;
}

function routerApiKey(): string | null {
  const key = process.env.LLM_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

/** Ringkasan konfigurasi untuk log & endpoint diagnostik (tanpa kunci). */
export function describeLlmConfig(): LlmConfig {
  return {
    order: resolveProviderOrder(),
    router: {
      baseUrl: resolveRouterBaseUrl(),
      model: resolveRouterModel(),
      hasKey: routerApiKey() !== null,
    },
    gemini: {
      hasKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
    },
  };
}

/* ============================================================
 * Utilitas galat
 * ============================================================ */

/**
 * Kumpulkan SEMUA teks galat yang tersedia, termasuk `cause` berantai.
 *
 * Ini bukan kerapian belaka — ini pernah jadi bug nyata. Saat 9router mati,
 * `fetch` di Node melempar `TypeError: fetch failed` yang pada `message`
 * hanya berbunyi "fetch failed"; rincian sebenarnya (mis. `ECONNREFUSED`)
 * berada di `err.cause` sebagai `AggregateError`, dan `code`-nya di
 * `cause.errors[]`. Tanpa menelusuri rantai ini, kegagalan jaringan yang
 * paling umum justru TIDAK terbaca sebagai transien, sehingga fallback ke
 * Gemini tidak pernah jalan. Gejalanya menyesatkan: seolah-olah Gemini
 * yang bermasalah, padahal Gemini bahkan belum dicoba.
 */
function collectErrorText(err: unknown, depth = 0): string {
  if (err === null || err === undefined) return '';
  if (depth > 4) return '';

  if (typeof err === 'string') return err;

  if (err instanceof Error) {
    const parts: string[] = [err.name, err.message];

    const withCode = err as Error & { code?: unknown };
    if (typeof withCode.code === 'string') parts.push(withCode.code);

    // `AggregateError.errors` (dipakai undici untuk galat jaringan).
    const withErrors = err as Error & { errors?: unknown };
    if (Array.isArray(withErrors.errors)) {
      for (const nested of withErrors.errors) {
        parts.push(collectErrorText(nested, depth + 1));
      }
    }

    // `Error.cause` (dipakai Fetch API membungkus galat transport).
    const withCause = err as Error & { cause?: unknown };
    if (withCause.cause !== undefined) {
      parts.push(collectErrorText(withCause.cause, depth + 1));
    }

    return parts.filter((p) => p.length > 0).join(' ');
  }

  // Objek/angka tak dikenal: cukup representasi string-nya.
  try {
    return typeof err === 'object' ? JSON.stringify(err) : String(err);
  } catch {
    return '';
  }
}

function errorMessage(err: unknown): string {
  // Pesan ramah untuk log: utamakan `message`, lalu tambahkan rincian
  // rantai bila berbeda supaya penyebabnya (ECONNREFUSED/ENOTFOUND/
  // ETIMEDOUT) benar-benar terlihat saat menelusuri masalah.
  if (err instanceof Error) {
    const full = collectErrorText(err);
    return full.length > 0 ? full : err.message;
  }
  return collectErrorText(err);
}

/**
 * Penanda kegagalan TRANSPORT — jaringan tidak sampai ke siapa pun.
 *
 * Sengaja mendeteksi pada seluruh rantai teks, bukan pada `message` saja,
 * demi alasan yang dijelaskan di `collectErrorText`.
 */
const TRANSPORT_MARKERS = [
  'fetch failed',
  'failed to fetch',
  'network',
  'socket hang up',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR',
  'other side closed',
  'terminated',
];

function isTransportError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // kontrak `fetch` gagal
  const text = collectErrorText(err);
  return TRANSPORT_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Klasifikasikan galat menjadi kategori yang dapat ditindaklanjuti.
 *
 * Inilah yang mengubah "Layanan kecerdasan buatan sedang bermasalah"
 * menjadi sesuatu yang bisa kamu kerjakan: kuota habis → tunggu atau ganti
 * kunci; kunci ditolak → perbaiki `LLM_API_KEY`; jaringan mati → hidupkan
 * gateway. Klasifikasi dilakukan pada SELURUH rantai teks galat, karena
 * penyebab sebenarnya sering tersembunyi di `cause`.
 */
function classifyFailure(err: unknown): FailureReason {
  const text = collectErrorText(err);
  const lower = text.toLowerCase();

  // Kuota / limit laju. Gemini memakai RESOURCE_EXHAUSTED/429; gateway lain
  // memakai kata "quota" atau "rate limit".
  if (
    /\b429\b/.test(text) ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
    return 'quota';
  }

  // Kunci salah / tidak berwenang.
  if (
    /\b40[13]\b/.test(text) ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_api_key') ||
    lower.includes('api key') ||
    lower.includes('permission')
  ) {
    return 'auth';
  }

  // Model tidak ada / sudah dimatikan.
  if (
    /\b404\b/.test(text) ||
    lower.includes('not found') ||
    lower.includes('service info not found') ||
    lower.includes('not supported')
  ) {
    return 'bad-request';
  }

  if (err instanceof AppError && err.code === 'TIMEOUT') return 'timeout';
  if (lower.includes('abort') || lower.includes('timed out')) return 'timeout';

  if (isTransportError(err)) return 'network';

  // Bentuk permintaan ditolak provider (mis. PDF dikirim ke endpoint vision).
  if (/\b400\b/.test(text) || lower.includes('invalid request')) {
    return 'bad-request';
  }

  if (lower.includes('kosong') || lower.includes('empty')) return 'empty';

  return 'unknown';
}

/** Kalimat sebab-akibat dalam Bahasa Indonesia untuk tiap kategori. */
const REASON_TEXT: Record<FailureReason, string> = {
  quota:
    'kuota/limit layanan tercapai — permintaan ditolak karena kuota habis, ' +
    'bukan karena kunci atau jaringan bermasalah',
  auth:
    'kunci API ditolak — kunci salah, kedaluwarsa, atau tidak berwenang',
  network:
    'koneksi ke layanan gagal — alamat tidak dapat dihubungi, DNS gagal, ' +
    'atau gateway belum hidup',
  'bad-request':
    'permintaan ditolak layanan — model tidak tersedia atau bentuk ' +
    'permintaan tidak diterima',
  'missing-key': 'kunci API belum diatur',
  timeout: 'layanan tidak merespons dalam batas waktu',
  empty: 'layanan mengembalikan jawaban kosong',
  unknown: 'penyebab tidak dapat dipastikan dari pesan galat',
};

/**
 * Pesan diagnostik multi-baris untuk LOG dan alat uji.
 *
 * Sengaja tidak dikirim ke pengguna akhir — pengguna tetap menerima pesan
 * ramah. Fungsi ini untuk manusia yang sedang menelusuri masalah.
 */
export function describeFailure(attempts: readonly ProviderAttempt[]): string {
  if (attempts.length === 0) return 'Tidak ada provider yang dicoba.';

  const lines = attempts.map((a) => {
    if (a.ok) return `  ✓ ${a.provider}: berhasil`;
    if (a.skipped) return `  – ${a.provider}: dilewati (${a.error ?? 'tidak dikonfigurasi'})`;
    const cause = a.reason ? REASON_TEXT[a.reason] : 'penyebab tidak dikenal';
    return `  ✗ ${a.provider}: ${cause}`;
  });

  return ['Semua provider LLM gagal:', ...lines].join('\n');
}

/**
 * Apakah galat klien HTTP (4xx selain status yang boleh dicoba ulang)
 * menandakan masalah PERMANEN — kunci salah, model tidak ada, parameter
 * tidak sah? Kalau ya, mencoba provider lain belum tentu menolong, tetapi
 * tetap kita coba (Gemini punya model berbeda) sambil mencatat alasannya.
 */
function isClientFault(status: number): boolean {
  return status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status);
}

/* ============================================================
 * Provider: 9router (OpenAI-compatible)
 * ============================================================ */

interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

type ChatContent = string | ChatContentPart[];

interface ChatMessage {
  role: 'system' | 'user';
  content: ChatContent;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
}

/** Galat khas 9router, membawa status HTTP agar bisa diklasifikasikan. */
class RouterHttpError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RouterHttpError';
    this.status = status;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
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

/**
 * Susun isi pesan. Bila ada lampiran biner, gunakan bentuk multi-bagian
 * (teks + `image_url`) yang dikenal baik oleh endpoint vision maupun oleh
 * PDF-native; bila tidak, kirim teks polos saja agar tak menyentuh jalur
 * lampiran yang lebih rapuh.
 */
function buildContent(
  prompt: string,
  attachment?: { bytes: Uint8Array; mimeType: string },
): ChatContent {
  if (!attachment) return prompt;
  return [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: {
        url: `data:${attachment.mimeType};base64,${bytesToBase64(attachment.bytes)}`,
      },
    },
  ];
}

/**
 * Satu panggilan ke 9router. Mengembalikan teks mentah dari model.
 *
 * Sengaja memakai `fetch` biasa, bukan SDK OpenAI: rutenya hanya satu,
 * bentuk permintaannya sederhana, dan menambah dependensi baru untuk ini
 * tidak sepadan.
 */
async function callRouterOnce(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  jsonMode: boolean;
  signal: AbortSignal;
}): Promise<string> {
  const payload: ChatCompletionRequest = {
    model: args.model,
    messages: args.messages,
    temperature: args.temperature,
    max_tokens: args.maxTokens,
  };
  if (args.jsonMode) {
    payload.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${args.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: args.signal,
  });

  if (!response.ok) {
    // Baca badan galat sebisanya; gateway memberi pesan yang informatif.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const text = await response.text();
      if (text.trim().length > 0) detail = text.slice(0, 500);
    } catch {
      /* abaikan — status sudah cukup untuk klasifikasi */
    }
    throw new RouterHttpError(response.status, detail);
  }

  let body: ChatCompletionResponse;
  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new AppError('UPSTREAM', '9router mengembalikan respons non-JSON.');
  }

  if (body.error?.message) {
    throw new AppError('UPSTREAM', `9router: ${body.error.message}`);
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content || content.trim().length === 0) {
    throw new AppError('UPSTREAM', '9router mengembalikan respons kosong.');
  }
  return content.trim();
}

/**
 * Panggil 9router dengan retry terbatas. Kegagalan transien (429/5xx/
 * jaringan) dicoba ulang dengan backoff; galat 4xx permanen langsung
 * dilempar agar pemanggil dapat berpindah ke provider berikutnya.
 */
async function callRouter(args: {
  prompt: string;
  attachment?: { bytes: Uint8Array; mimeType: string };
  temperature: number;
  maxTokens: number;
  jsonMode: boolean;
  parentSignal?: AbortSignal;
}): Promise<string> {
  const apiKey = routerApiKey();
  if (!apiKey) {
    throw new AppError(
      'CONFIG',
      'LLM_API_KEY belum diatur. Isi kunci 9router di .env.local.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  args.parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: buildContent(args.prompt, args.attachment),
    },
  ];

  try {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (controller.signal.aborted) throw new AppError('TIMEOUT');

      try {
        return await callRouterOnce({
          baseUrl: resolveRouterBaseUrl(),
          apiKey,
          model: resolveRouterModel(),
          messages,
          temperature: args.temperature,
          maxTokens: args.maxTokens,
          jsonMode: args.jsonMode,
          signal: controller.signal,
        });
      } catch (err) {
        lastError = err;

        // Abort karena plafon waktu aplikasi: tidak ada gunanya retry.
        if (controller.signal.aborted) throw new AppError('TIMEOUT');

        const status =
          err instanceof RouterHttpError ? err.status : null;
        const transient =
          isTransportError(err) || // kegagalan jaringan/transport
          (status !== null && RETRYABLE_STATUS.has(status));

        if (transient && attempt < MAX_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 250,
            ),
          );
          continue;
        }

        // Galat 4xx permanen: tandai supaya pemanggil tahu ini bukan
        // masalah sesaat, lalu berhenti mencoba.
        if (status !== null && isClientFault(status)) {
          throw new AppError(
            'UPSTREAM',
            `9router menolak permintaan (${status}): ${errorMessage(err)}`,
          );
        }
        throw new AppError('UPSTREAM', `9router: ${errorMessage(err)}`);
      }
    }

    throw new AppError('UPSTREAM', `9router: ${errorMessage(lastError)}`);
  } finally {
    clearTimeout(timeout);
    args.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

/* ============================================================
 * Inti: jalankan rantai provider
 * ============================================================
 *
 * Satu tempat untuk logika "coba provider berurutan sampai berhasil".
 * Kegagalan provider terakhir dilempar sebagai galat aslinya (mis.
 * `MODEL_NOT_FOUND` dari Gemini) supaya kode yang sudah ada — dan
 * `errorResponse()` — tetap memetakan ke pesan yang benar.
 */
async function runProviderChain<T>(args: {
  purpose: LlmPurpose;
  call9Router: () => Promise<T>;
  callGemini: () => Promise<T>;
}): Promise<LlmResult<T>> {
  const order = resolveProviderOrder();
  const attempts: ProviderAttempt[] = [];
  let lastError: unknown = null;

  for (const provider of order) {
    if (provider === '9router' && !routerApiKey()) {
      attempts.push({
        provider,
        ok: false,
        skipped: true,
        reason: 'missing-key',
        error: 'LLM_API_KEY belum diatur',
      });
      continue;
    }
    if (provider === 'gemini' && !process.env.GEMINI_API_KEY?.trim()) {
      attempts.push({
        provider,
        ok: false,
        skipped: true,
        reason: 'missing-key',
        error: 'GEMINI_API_KEY belum diatur',
      });
      continue;
    }

    try {
      const value =
        provider === '9router' ? await args.call9Router() : await args.callGemini();
      attempts.push({ provider, ok: true });
      logAttempts(args.purpose, attempts, provider);
      return { value, meta: { provider, attempts } };
    } catch (err) {
      lastError = err;
      attempts.push({
        provider,
        ok: false,
        reason: classifyFailure(err),
        error: errorMessage(err),
      });
    }
  }

  logAttempts(args.purpose, attempts, null);

  /*
   * Semua provider gagal.
   *
   * Kode galat dipertahankan bila provider terakhir memberi kode yang
   * bermakna bagi pemanggil (MODEL_NOT_FOUND / TIMEOUT), karena route di
   * atasnya memetakannya ke pesan yang sudah disesuaikan. Untuk sisanya,
   * `AppError('UPSTREAM')` tetap dipakai agar pengguna menerima pesan
   * ramah — tetapi `detail` kini berisi `describeFailure()`, dan itulah
   * yang muncul di log server sebagai penyebab yang bisa ditindaklanjuti.
   */
  const detail = describeFailure(attempts);
  if (lastError instanceof AppError) {
    if (lastError.code === 'MODEL_NOT_FOUND' || lastError.code === 'TIMEOUT') {
      throw new AppError(lastError.code, detail);
    }
  }
  throw new AppError('UPSTREAM', detail);
}

/** Catat jejak provider ke log server. Ini yang membuat fallback terlihat. */
function logAttempts(
  purpose: LlmPurpose,
  attempts: ProviderAttempt[],
  finalProvider: ProviderName | null,
): void {
  const trail = attempts
    .map((a) =>
      a.ok
        ? `${a.provider}=ok`
        : a.skipped
          ? `${a.provider}=dilewati`
          : `${a.provider}=gagal`,
    )
    .join(' → ');
  const suffix = finalProvider ? `dilayani oleh ${finalProvider}` : 'SEMUA GAGAL';
  console.info(`[llm] ${purpose}: ${trail} — ${suffix}`);
}

/* ============================================================
 * API publik — ekstraksi dokumen
 * ============================================================ */

export interface ExtractDocumentOptions {
  bytes: Uint8Array;
  mimeType: string;
  kind?: DocumentKind;
  /** Batas jumlah bagian. 0 = tanpa batas. */
  maxChunks?: number;
  /** Dipanggil setiap satu bagian selesai, untuk progres aksesibel. */
  onChunk?: (info: { index: number; total: number; text: string }) => void;
}

/**
 * Ekstrak dokumen: 9router lebih dulu, Gemini sebagai jaring pengaman.
 *
 * KEPUTUSAN PENTING — PDF DIRENDER, BUKAN DIKIRIM MENTAH
 * -----------------------------------------------------
 * Endpoint `chat/completions` yang dipakai 9router hanya menerima GAMBAR
 * pada part `image_url`. Mengirim PDF sebagai `image_url` ditolak gateway
 * dengan `400 model_param_invalid`; sedangkan part `file`/`file_data`/
 * `input_file` diterima secara HTTP tetapi isinya tidak sampai ke model —
 * model lalu menjawab "berkas tidak dilampirkan" atau MENGARANG. Semua itu
 * sudah diuji langsung, buktinya di `scripts/probe-9router-pdf.py`.
 *
 * Karena itu PDF dirender lebih dulu menjadi PNG per halaman
 * (`lib/pdf-render.ts`) dan setiap halaman diekstrak terpisah. Gambar asli
 * (JPG/PNG/WEBP) dikirim langsung tanpa render — jalur itu memang bekerja.
 *
 * Bila PDF tidak dapat dirender — misalnya `pdftoppm` tidak terpasang —
 * kita TIDAK memaksakan jalur yang salah. Kita langsung menyerahkan ke
 * Gemini, yang memang menerima PDF secara native.
 */
export async function extractDocumentWithFallback(
  options: ExtractDocumentOptions,
): Promise<ExtractionResult> {
  const result = await extractDocumentDetailed(options);
  return result.value;
}

/**
 * Sama seperti `extractDocumentWithFallback`, tetapi mengembalikan metadata
 * provider. Dipakai oleh alat diagnostik agar dapat melaporkan SIAPA yang
 * melayani — tanpa itu, pertanyaan "apakah 9router benar-benar dipakai?"
 * hanya bisa dijawab dengan membaca log.
 */
export async function extractDocumentDetailed(
  options: ExtractDocumentOptions,
): Promise<LlmResult<ExtractionResult>> {
  const isPdf = options.mimeType === 'application/pdf';

  const result = await runProviderChain({
    purpose: 'extract',
    call9Router: async () => {
      if (!isPdf) {
        const prompt = buildExtractionPrompt(options.kind ?? 'naratif');
        const raw = await callRouter({
          prompt,
          attachment: { bytes: options.bytes, mimeType: options.mimeType },
          temperature: 0.2,
          maxTokens: 8192,
          jsonMode: true,
        });
        return toExtractionResult(raw, options);
      }

      return extractPdfViaRouter(options);
    },
    callGemini: () => extractDocumentWithGemini(options),
  });

  console.info(
    `[llm] extract selesai via ${result.meta.provider} ` +
      `(${result.value.chunks.length} bagian, ${result.value.pageCount} halaman)`,
  );
  return result;
}

/**
 * Ekstraksi PDF lewat 9router: render per halaman, lalu kirim tiap halaman
 * sebagai gambar.
 *
 * Keuntungan dibanding satu permintaan untuk seluruh berkas:
 *  - setiap halaman punya peluang berhasil sendiri, jadi satu halaman
 *    bermasalah tidak menjatuhkan seluruh modul;
 *  - progres dapat dilaporkan per halaman ke screen reader;
 *  - risiko keluaran terpotong di tengah bab hilang, karena batas keluaran
 *    berlaku per halaman, bukan per dokumen.
 */
async function extractPdfViaRouter(
  options: ExtractDocumentOptions,
): Promise<ExtractionResult> {
  const maxPages =
    typeof options.maxChunks === 'number' && options.maxChunks > 0
      ? options.maxChunks
      : undefined;

  const rendered = await renderPdfPages(options.bytes, { maxPages });

  const prompt = buildExtractionPrompt(options.kind ?? 'naratif');
  const chunks: ExtractedChunk[] = [];
  const warnings: string[] = [];
  let firstFailureNote: string | null = null;

  for (const page of rendered.pages) {
    const raw = await callRouter({
      prompt,
      attachment: { bytes: page.png, mimeType: 'image/png' },
      temperature: 0.2,
      maxTokens: 4096,
      jsonMode: true,
    });

    let parsed: { text: string; hadUnreadable: boolean; note: string };
    try {
      parsed = parsePageExtraction(raw);
    } catch (err) {
      /*
       * Satu halaman gagal diurai JANGAN membatalkan seluruh dokumen.
       * Halaman lain tetap berharga bagi pengguna; kita catat masalahnya
       * supaya diumumkan, lalu lanjut.
       */
      const detail = err instanceof Error ? err.message : String(err);
      firstFailureNote ??= `Halaman ${page.pageNumber} tidak terbaca: ${detail}`;
      continue;
    }

    chunks.push({
      index: chunks.length,
      text: parsed.text,
      pageCount: 1,
      hadUnreadable: parsed.hadUnreadable,
      note: parsed.note.length > 0 ? parsed.note : null,
    });

    options.onChunk?.({
      index: chunks.length - 1,
      total: rendered.pages.length,
      text: parsed.text,
    });
  }

  if (chunks.length === 0) {
    throw new AppError(
      'UPSTREAM',
      firstFailureNote ??
        'Tidak ada halaman PDF yang berhasil diekstrak oleh 9router.',
    );
  }

  if (firstFailureNote) {
    warnings.push(firstFailureNote);
  }
  if (rendered.truncated) {
    warnings.push(
      `Dokumen memiliki sekitar ${rendered.totalPages} halaman, tetapi hanya ` +
        `${rendered.pages.length} halaman pertama yang diproses. ` +
        `Untuk hasil lengkap, pisahkan modul menjadi beberapa berkas per bab.`,
    );
  }

  const withNotes = chunks.filter((c) => c.hadUnreadable);
  if (withNotes.length > 0) {
    warnings.push(
      `${withNotes.length} halaman ditandai tidak terbaca seluruhnya. ` +
        `Teks yang tersedia tetap dapat dibacakan.`,
    );
  }

  return {
    chunks,
    pageCount: chunks.length,
    truncated: rendered.truncated || firstFailureNote !== null,
    warnings,
  };
}

/* ============================================================
 * API publik — teks bebas (tanya-jawab)
 * ============================================================ */

export interface GenerateTextOptions {
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/**
 * Panggil model untuk prompt teks bebas, dengan fallback 9router → Gemini.
 *
 * Mengembalikan hanya teksnya. Untuk diagnostik yang butuh jejak provider,
 * gunakan `generateTextDetailed`.
 */
export async function generateTextWithFallback(
  options: GenerateTextOptions,
): Promise<string> {
  const result = await generateTextDetailed(options);
  return result.value;
}

/** Sama seperti `generateTextWithFallback`, tetapi mengembalikan metadata. */
export function generateTextDetailed(
  options: GenerateTextOptions,
): Promise<LlmResult<string>> {
  return runProviderChain({
    purpose: 'text',
    call9Router: () =>
      callRouter({
        prompt: options.prompt,
        temperature: options.temperature ?? 0.3,
        maxTokens: options.maxOutputTokens ?? 1024,
        jsonMode: false,
        parentSignal: options.signal,
      }),
    callGemini: () =>
      generateTextWithGemini({
        prompt: options.prompt,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
        signal: options.signal,
      }),
  });
}

/* ============================================================
 * Parsing keluaran 9router
 * ============================================================
 *
 * Model OpenAI-compatible tidak punya jaminan skema sekuat
 * `responseJsonSchema` milik Gemini. Karena itu kita membersihkan
 * setidaknya dua keanehan yang lazim: pagar markdown ```json, dan
 * pemikiran (reasoning) yang sudah tercampur ke dalam JSON.
 */
function parseLooseJson(raw: string): Record<string, unknown> {
  let cleaned = raw.trim();

  // 1. Buang pagar markdown bila ada.
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const attempts = [cleaned];

  // 2. Ambil objek pertama yang tampak JSON.
  const match = /\{[\s\S]*\}/.exec(cleaned);
  if (match) attempts.push(match[0]);

  // 3. Beberapa model menambahkan blok alasan sebelum JSON. Ambil objek
  //    terakhir agar bagian yang diinginkan lebih mungkin terambil.
  const lastBrace = cleaned.lastIndexOf('{');
  const lastClose = cleaned.lastIndexOf('}');
  if (lastBrace >= 0 && lastClose > lastBrace) {
    attempts.push(cleaned.slice(lastBrace, lastClose + 1));
  }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* coba kandidat berikutnya */
    }
  }

  throw new AppError('UPSTREAM', 'Respons 9router bukan JSON yang valid.');
}

/** Hitung kata seperti di process-document, untuk cek pemotongan kasar. */
function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

interface PageExtraction {
  text: string;
  hadUnreadable: boolean;
  note: string;
}

/**
 * Urai hasil ekstraksi SATU halaman dari 9router.
 *
 * Berbeda dari ekstraksi Gemini yang memakai `responseJsonSchema` (skema
 * dipaksakan oleh API), di sini bentuk JSON hanya dijelaskan lewat prompt.
 * Model karena itu kadang menambahkan pembungkus: pagar markdown, blok
 * alasan sebelum JSON, atau JSON di dalam string. `parseLooseJson` sudah
 * menangani ketiga bentuk itu.
 */
function parsePageExtraction(raw: string): PageExtraction {
  const record = parseLooseJson(raw);

  const text = typeof record.teks === 'string' ? record.teks.trim() : '';
  if (text.length === 0) {
    throw new AppError(
      'UPSTREAM',
      'Model tidak menghasilkan teks yang dapat dibacakan untuk halaman ini.',
    );
  }

  return {
    text,
    hadUnreadable: record.ada_bagian_gagal === true,
    note: typeof record.catatan === 'string' ? record.catatan.trim() : '',
  };
}

/**
 * Ubah keluaran mentah 9router menjadi bentuk `ExtractionResult` yang
 * sama persis dengan keluaran Gemini, supaya rute di atasnya tidak perlu
 * tahu provider mana yang menjawab.
 */
function toExtractionResult(
  raw: string,
  options: ExtractDocumentOptions,
): ExtractionResult {
  const record = parseLooseJson(raw);

  const text = typeof record.teks === 'string' ? record.teks.trim() : '';
  const pages =
    typeof record.jumlah_halaman === 'number' &&
    Number.isFinite(record.jumlah_halaman)
      ? Math.max(0, Math.round(record.jumlah_halaman))
      : 0;

  if (text.length === 0) {
    throw new AppError(
      'UPSTREAM',
      '9router tidak menghasilkan teks yang dapat dibacakan.',
    );
  }

  const warnings: string[] = [];
  const hadUnreadable = record.ada_bagian_gagal === true;
  const note = typeof record.catatan === 'string' ? record.catatan.trim() : '';

  if (hadUnreadable) {
    warnings.push(
      note.length > 0
        ? `Sebagian dokumen tidak terbaca seluruhnya. Catatan dari sistem: ${note}`
        : 'Sebagian dokumen tidak terbaca seluruhnya. Teks yang tersedia tetap dapat dibacakan.',
    );
  }

  /*
   * Sinyal pemotongan yang tidak diminta secara eksplisit.
   *
   * Jaring pengaman penting: tanpa `responseJsonSchema`, model bisa
   * mengembalikan JSON yang secara sintaks sah tetapi terpotong di tengah
   * dan menutup sendiri. Model sendiri tidak selalu menandainya lewat
   * `ada_bagian_gagal`. Deteksi paling murah yang dapat dipercaya adalah
   * rasio keluaran terhadap masukan — pola yang sama yang dipakai
   * `lib/gemini.ts` untuk dokumen panjang.
   */
  const isPdf = options.mimeType === 'application/pdf';
  if (isPdf) {
    // Rata-rata ~3000 byte teks PDF per halaman untuk modul pelajaran.
    const estimatedWords = options.bytes.length / 6;
    const producedWords = countWords(text);
    if (producedWords < estimatedWords * 0.45) {
      warnings.push(
        'Sebagian isi dokumen tampaknya tidak terbaca seluruhnya. ' +
          'Untuk hasil terbaik, pisahkan modul menjadi beberapa berkas per bab.',
      );
    }
  }

  const chunk: ExtractedChunk = {
    index: 0,
    text,
    pageCount: pages,
    hadUnreadable,
    note: note.length > 0 ? note : null,
  };

  options.onChunk?.({ index: 0, total: 1, text });

  return {
    chunks: [chunk],
    pageCount: pages,
    truncated: hadUnreadable || warnings.length > 0,
    warnings,
  };
}

/* ============================================================
 * Prompt ekstraksi (versi 9router)
 * ============================================================
 *
 * Diringkas dari `lib/gemini.ts`. Instruksi intinya harus tetap setia:
 * keluaran berupa kalimat mengalir siap-dengar, simbol matematika diubah
 * menjadi kalimat, dan larangan mengarang tetap eksplisit. Yang berubah
 * hanyalah cara meminta bentuk JSON — 9router tidak menerima skema, jadi
 * bentuknya dijelaskan di dalam prompt.
 */
function buildExtractionPrompt(kind: DocumentKind): string {
  const kindNote =
    kind === 'matematis'
      ? 'Dokumen ini materi eksakta. Bacakan setiap rumus, tabel, dan diagram sebagai kalimat utuh dan berurutan. Sebutkan satuan secara lengkap.'
      : kind === 'bergambar'
        ? 'Dokumen ini hasil pindai atau berisi banyak gambar. Bila ada bagian buram, jangan menebak; catat pada kolom catatan dan lanjutkan bagian yang jelas.'
        : 'Dokumen ini teks pelajaran umum. Pertahankan urutan alur bacaan dari awal sampai akhir, dan panjangkan singkatan yang tidak lazim.';

  return `
Kamu adalah mesin pra-proses untuk Text-to-Speech. Tugasmu mengekstrak teks
dari dokumen agar nyaman dibacakan kepada siswa penyandang disabilitas penglihatan.

ATURAN WAJIB:
1. Tulis ulang isi dokumen menjadi kalimat mengalir yang natural, seolah dibacakan narator profesional.
2. Abaikan sepenuhnya: nomor halaman, header, footer, watermark, nama berkas, dan pesan hak cipta yang berulang.
3. Jangan gunakan penomoran seperti "1." atau simbol bullet. Ubah semuanya menjadi rangkaian kalimat.
4. Terjemahkan simbol matematika, rumus, dan tabel menjadi kalimat yang mudah didengar. Contoh: "x^2" dibaca "x pangkat dua"; tanda "=" dibaca "sama dengan".
5. JANGAN menambahkan informasi yang tidak ada di dokumen. Jangan menyimpulkan, jangan mengomentari, jangan meringkas.
6. Jika ada bagian yang tidak terbaca atau tidak jelas, jangan mengarang. Tandai masalahnya pada kolom catatan.
7. Tulis dalam bahasa yang sama dengan dokumen.

${kindNote}

Balas HANYA dengan objek JSON, tanpa penjelasan tambahan dan tanpa pagar markdown,
dengan struktur tepat seperti ini:
{
  "teks": "seluruh isi dokumen sebagai kalimat mengalir yang siap dibacakan",
  "jumlah_halaman": <angka, perkiraan jumlah halaman yang benar-benar dibaca>,
  "ada_bagian_gagal": <true atau false>,
  "catatan": "<penjelasan singkat bila ada bagian gagal, atau string kosong>"
}
`.trim();
}
