/**
 * Validasi berkas — lapisan pertama pertahanan.
 *
 * Prinsip penting: `File.type` berasal dari KLIEN dan bisa dipalsukan
 * dengan mudah (cukup ubah nama atau header). Karena itu validasi MIME
 * di sini diperkuat dengan pemeriksaan *magic bytes* — tanda tangan biner
 * asli di awal berkas.
 *
 * Validasi di klien gunanya untuk umpan balik cepat dan hemat kuota.
 * VALIDASI YANG SAMA diulang di server; jangan pernah mempercayai klien.
 */

import { AppError } from '@/lib/api-error';

/* ============================================================
 * Batasan
 * ============================================================ */

/**
 * Batas 20 MB diambil dari plafon request inline Gemini. Bila berkas
 * lebih besar dari ini, ia tidak akan pernah terkirim ke model, jadi lebih
 * baik ditolak di depan dengan pesan yang jelas.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AcceptedMime = (typeof ACCEPTED_MIME_TYPES)[number];

/** Nilai untuk atribut `accept` pada <input type="file">. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(',');

/* ============================================================
 * Magic bytes
 * ============================================================ */

interface Signature {
  mime: AcceptedMime;
  /** Byte pada offset tertentu yang harus cocok. */
  check: (bytes: Uint8Array) => boolean;
  label: string;
}

const SIGNATURES: Signature[] = [
  {
    mime: 'application/pdf',
    label: 'PDF',
    // "%PDF-"
    check: (b) =>
      b.length >= 5 &&
      b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d,
  },
  {
    mime: 'image/jpeg',
    label: 'JPG',
    // FF D8 FF
    check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    label: 'PNG',
    // 89 50 4E 47 0D 0A 1A 0A
    check: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    label: 'WEBP',
    // "RIFF" .... "WEBP"
    check: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

/** Tebak MIME dari magic bytes. Null bila tidak dikenali. */
export function detectMimeFromBytes(bytes: Uint8Array): AcceptedMime | null {
  for (const sig of SIGNATURES) {
    if (sig.check(bytes)) return sig.mime;
  }
  return null;
}

/* ============================================================
 * Helper format untuk pengumuman aksesibel
 * ============================================================ */

/** "3,4 MB" — koma sebagai pemisah desimal, sesuai kaidah Indonesia. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const rounded = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
  return `${String(rounded).replace('.', ',')} megabita`;
}

/* ============================================================
 * Validasi di klien (cepat, hemat kuota)
 * ============================================================ */

export interface ClientValidationResult {
  ok: boolean;
  /** Pesan siap dibacakan; ada hanya bila `ok === false`. */
  message?: string;
}

export function validateFileOnClient(file: File): ClientValidationResult {
  if (file.size === 0) {
    return {
      ok: false,
      message: `Berkas "${file.name}" kosong. Silakan pilih berkas lain.`,
    };
  }

  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      message:
        `Berkas "${file.name}" berukuran ${formatMegabytes(file.size)}, ` +
        `melebihi batas maksimal dua puluh megabita. ` +
        `Silakan pilih berkas yang lebih kecil, atau pecah menjadi beberapa bagian.`,
    };
  }

  // Tipe dari klien cukup untuk saringan cepat. Verifikasi sejati
  // dilakukan di server dengan magic bytes.
  if (
    file.type &&
    !(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)
  ) {
    return {
      ok: false,
      message:
        `Jenis berkas "${file.type}" belum didukung. ` +
        `Gunakan berkas PDF, JPG, PNG, atau WEBP.`,
    };
  }

  return { ok: true };
}

/* ============================================================
 * Validasi di server (otoritatif)
 * ============================================================ */

export interface ServerValidationInput {
  bytes: Uint8Array;
  declaredMime: string | null;
  fileName: string;
}

export interface ServerValidationOutput {
  mimeType: AcceptedMime;
  /** True bila tipe hasil deteksi berbeda dari yang diklaim klien. */
  mimeMismatch: boolean;
}

/**
 * Validasi otoritatif di server. Melempar AppError bila gagal.
 *
 * Ini yang menentukan boleh-tidaknya berkas diproses. Deteksi dilakukan
 * dari byte asli, bukan dari nama atau header.
 */
export function validateFileOnServer(
  input: ServerValidationInput,
): ServerValidationOutput {
  const { bytes, declaredMime } = input;

  if (bytes.length === 0) {
    throw new AppError('NO_FILE', `${input.fileName}: panjang nol`);
  }

  if (bytes.length > MAX_FILE_BYTES) {
    throw new AppError(
      'TOO_LARGE',
      `${input.fileName}: ${bytes.length} byte`,
    );
  }

  const detected = detectMimeFromBytes(bytes);

  if (!detected) {
    throw new AppError(
      'UNSUPPORTED_TYPE',
      `${input.fileName}: tanda tangan berkas tidak dikenali ` +
        `(klien mengklaim ${declaredMime ?? 'tidak ada'})`,
    );
  }

  return {
    mimeType: detected,
    mimeMismatch: Boolean(declaredMime) && declaredMime !== detected,
  };
}

/**
 * Perkiraan jumlah halaman untuk PDF, dibaca dari penghitung objek `/Type /Page`.
 * Hanya perkiraan kasar; dipakai untuk menentukan strategi chunking, bukan
 * untuk kebenaran yang presisi. Nilai 0 berarti tidak diketahui.
 */
export function estimatePdfPageCount(bytes: Uint8Array): number {
  try {
    // Batasi pemindaian agar tidak memakan CPU pada berkas besar.
    const limit = Math.min(bytes.length, 8 * 1024 * 1024);
    const slice = bytes.subarray(0, limit);
    const text = new TextDecoder('latin1').decode(slice);

    const countMarker = /\/Count\s+(\d+)/g;
    let max = 0;
    let m: RegExpExecArray | null;
    while ((m = countMarker.exec(text)) !== null) {
      const n = Number.parseInt(m[1] ?? '0', 10);
      if (Number.isFinite(n) && n > max) max = n;
    }

    if (max > 0) return max;

    const pageMarker = /\/Type\s*\/Page[^s]/g;
    const matches = text.match(pageMarker);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}
