/**
 * Error terpusat.
 *
 * Alasan file ini ada: tanpa satu bentuk error yang seragam, frontend akan
 * menebak-nebak isi respons dan akhirnya menampilkan "[object Object]" ke
 * screen reader — kegagalan aksesibilitas yang sering lolos review.
 */

import type { ApiErrorBody, ApiErrorCode } from '@/types';

interface ErrorSpec {
  status: number;
  message: string;
  retryable: boolean;
}

export const ERROR_SPECS: Record<ApiErrorCode, ErrorSpec> = {
  NO_FILE: {
    status: 400,
    message:
      'Berkas tidak ditemukan. Silakan unggah ulang berkas modul Anda.',
    retryable: false,
  },
  BAD_REQUEST: {
    status: 400,
    message:
      'Permintaan tidak lengkap. Silakan coba lagi dari awal.',
    retryable: false,
  },
  TOO_LARGE: {
    status: 413,
    message:
      'Ukuran berkas terlalu besar. Maksimal dua puluh megabita. Silakan pilih berkas yang lebih kecil, atau pecah menjadi beberapa bagian.',
    retryable: false,
  },
  UNSUPPORTED_TYPE: {
    status: 415,
    message:
      'Jenis berkas ini belum didukung. Gunakan berkas PDF, JPG, PNG, atau WEBP.',
    retryable: false,
  },
  UPSTREAM: {
    status: 502,
    message:
      'Layanan kecerdasan buatan sedang bermasalah. Silakan coba lagi beberapa saat lagi.',
    retryable: true,
  },
  MODEL_NOT_FOUND: {
    status: 502,
    message:
      'Model kecerdasan buatan tidak tersedia. Hubungi pengelola aplikasi untuk memperbarui konfigurasi model.',
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    message:
      'Terlalu banyak permintaan dalam waktu singkat. Mohon tunggu sebentar, lalu coba lagi.',
    retryable: true,
  },
  TIMEOUT: {
    status: 504,
    message:
      'Proses ekstraksi memakan waktu terlalu lama. Silakan coba lagi, atau gunakan dokumen yang lebih pendek.',
    retryable: true,
  },
  CONFIG: {
    status: 500,
    message:
      'Konfigurasi server belum lengkap. Hubungi pengelola aplikasi.',
    retryable: false,
  },
};

export class AppError extends Error {
  public readonly code: ApiErrorCode;
  public readonly retryable: boolean;
  public readonly httpStatus: number;
  /** Rincian teknis untuk log; hanya dipakai `debug` di luar produksi. */
  public readonly detail?: string;

  constructor(code: ApiErrorCode, detail?: string) {
    const spec = ERROR_SPECS[code];
    // `detail` tidak pernah sampai ke pengguna; hanya untuk log server.
    super(detail ? `${spec.message} (detail: ${detail})` : spec.message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = spec.retryable;
    this.httpStatus = spec.status;
    this.detail = detail;
  }

  /**
   * Bentuk aman untuk dikirim ke klien (tanpa detail internal).
   *
   * PENYIMPANGAN YANG DISENGAJA SAAT DEVELOPMENT
   * --------------------------------------------
   * Di produksi, `detail` (mis. "kuota habis", "kunci ditolak", nama
   * instance provider) HARUS disembunyikan — itu benar dan tetap berlaku.
   *
   * Tetapi perilaku yang sama membuat penelusuran saat development buta:
   * pengguna dan pengembang hanya melihat "Layanan kecerdasan buatan
   * sedang bermasalah" tanpa cara mengetahui penyebabnya. Karena itu, bila
   * `NODE_ENV` BUKAN 'production', `detail` ikut dikirim pada field
   * `debug` yang terpisah. Pemanggil dapat mengabaikannya; alat uji dan
   * konsol pengembang dapat membacanya.
   *
   * Jadikan produksi (NODE_ENV=production) untuk mematikan perilaku ini.
   */
  toBody(): ApiErrorBody {
    const body: ApiErrorBody = {
      error: {
        code: this.code,
        message: ERROR_SPECS[this.code].message,
        retryable: this.retryable,
      },
    };

    if (process.env.NODE_ENV !== 'production' && this.debugDetail) {
      body.debug = this.debugDetail;
    }

    return body;
  }

  /**
   * Rincian teknis untuk log server dan (saat development) untuk `debug`.
   *
   * Disimpan terpisah dari `message` supaya `message` yang dibacakan
   * screen reader tetap ringkas dan ramah dalam segala keadaan.
   */
  public get debugDetail(): string | undefined {
    return this.detail;
  }
}

/**
 * Ubah nilai apa pun yang dilempar (bisa string, bisa Error aneh) menjadi
 * AppError. Ini menjaga handler tidak pernah mengirim 500 kosong.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new AppError('TIMEOUT');
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new AppError('UPSTREAM', detail);
}

export function errorResponse(err: unknown): Response {
  const appErr = toAppError(err);
  return Response.json(appErr.toBody(), { status: appErr.httpStatus });
}
