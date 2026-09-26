/**
 * msedge-tts — pembungkus sintesis suara
 * ======================================
 *
 * KENAPA MODUL INI HIDUP DI SERVER:
 * msedge-tts berkomunikasi lewat WebSocket ke API Read Aloud Microsoft
 * Edge dan memerlukan modul Node (`stream`, `http.Agent`). Dokumentasi
 * tipe-nya menyatakan opsi agen "NOT SUPPORTED IN BROWSER". Jadi seluruh
 * sintesis harus terjadi di Route Handler, bukan di komponen klien.
 *
 * KENAPA KITA MEMAKAI INI, BUKAN speechSynthesis:
 *  1. Suara neural Microsoft (id-ID-ArdiNeural, id-ID-GadisNeural) jauh
 *     lebih jelas dan tidak terdengar robotik.
 *  2. Suara tersedia konsisten lintas sistem operasi. speechSynthesis
 *     bergantung pada suara yang terpasang di perangkat pengguna, yang
 *     pada Linux sering tidak ada suara Indonesia sama sekali.
 *  3. Audio dapat diunduh dan diputar ulang, sesuatu yang tidak mungkin
 *     dengan speechSynthesis.
 *
 * RISIKO YANG HARUS DISADARI:
 * API Read Aloud Edge tidak berdokumen resmi dan dapat berubah tanpa
 * pemberitahuan. Karena itu setiap kegagalan di sini HARUS dapat
 * ditangani: lihat `hooks/useServerAudio.ts`, yang jatuh kembali ke
 * speechSynthesis bila endpoint ini gagal.
 */

import { MsEdgeTTS, OUTPUT_FORMAT, type Voice } from 'msedge-tts';

import type { VoiceOption } from '@/types';

/* ============================================================
 * Batasan
 * ============================================================ */

/**
 * Batas panjang teks per permintaan sintesis.
 *
 * Angka 1000 karakter dipilih dengan pertimbangan:
 *  - Lapisan klien memecah dokumen menjadi kalimat (rata-rata < 200
 *    karakter), jadi batas ini tidak akan tercapai pada pemakaian wajar.
 *  - Batas ini mencegah satu permintaan jahat menahan koneksi WebSocket
 *    ke Microsoft terlalu lama, yang bisa membuat akun kita dibatasi.
 */
export const MAX_TTS_CHARS = 1000;

/**
 * Batas waktu sintesis.
 *
 * Edge TTS biasanya menjawab dalam 1-3 detik untuk satu kalimat. Bila
 * melewati 20 detik, ada yang salah dan lebih baik gagal cepat daripada
 * menggantungkan permintaan sampai batas server.
 */
const SYNTHESIS_TIMEOUT_MS = 20_000;

/** Suara default. Ardi dipilih karena pelafalan Indonesia yang jelas. */
export const DEFAULT_VOICE = 'id-ID-ArdiNeural';

/** Hanya suara ini yang diizinkan — mencegah penyalahgunaan sebagai proxy. */
export const ALLOWED_LOCALES = ['id-ID'];

/* ============================================================
 * Kesalahan
 * ============================================================ */

export class TtsError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 502) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/* ============================================================
 * Daftar suara
 * ============================================================ */

/** Ubah nama suara Microsoft menjadi label yang enak dibacakan. */
function toLabel(voice: Voice): string {
  // "id-ID-ArdiNeural" -> "Ardi"
  const parts = voice.ShortName.split('-');
  const raw = parts[2] ?? voice.ShortName;
  const name = raw.replace(/Neural$/i, '');
  const genderWord =
    voice.Gender === 'Female' ? 'perempuan' : voice.Gender === 'Male' ? 'pria' : '';
  return genderWord ? `${name}, suara ${genderWord}` : name;
}

/**
 * Ambil daftar suara Indonesia.
 *
 * Hasil disaring ke locale Indonesia saja. Menyediakan 322 suara asing
 * hanya akan menyulitkan pengguna screen reader yang harus menelusuri
 * daftar panjang untuk menemukan suara bahasa Indonesia.
 */
export async function listIndonesianVoices(): Promise<VoiceOption[]> {
  const tts = new MsEdgeTTS();

  try {
    const voices = await tts.getVoices();

    return voices
      .filter((voice) =>
        ALLOWED_LOCALES.some((locale) =>
          voice.Locale?.toLowerCase().startsWith(locale.toLowerCase()),
        ),
      )
      .map<VoiceOption>((voice) => ({
        shortName: voice.ShortName,
        label: toLabel(voice),
        locale: voice.Locale,
        gender: voice.Gender,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'id'));
  } catch {
    throw new TtsError(
      'VOICES_UNAVAILABLE',
      'Tidak dapat mengambil daftar suara dari layanan Microsoft. ' +
        'Periksa sambungan internet server, lalu coba lagi.',
      502,
    );
  } finally {
    tts.close();
  }
}

/* ============================================================
 * Sintesis
 * ============================================================ */

export interface SynthesizeOptions {
  text: string;
  voice?: string;
  /**
   * Kecepatan relatif. 1 = normal.
   * Nilai dikonversi ke bentuk persentase yang dipahami SSML, mis.
   * 1.2 menjadi "+20%". Pengguna low vision sering memerlukan tempo
   * lebih lambat, jadi kontrol ini penting, bukan tambahan.
   */
  rate?: number;
  /** Nada suara, mis. "+0Hz". Biarkan kosong untuk default. */
  pitch?: string;
}

/**
 * Sintesis satu potong teks menjadi buffer MP3.
 *
 * Alasan mengembalikan Buffer, bukan langsung streaming ke respons:
 * kita perlu memverifikasi lebih dulu bahwa audio benar-benar dihasilkan.
 * Bila kita streaming langsung dan Edge TTS gagal di tengah jalan, klien
 * sudah menerima status 200 dengan isi rusak, dan pesan galat kita tidak
 * akan pernah sampai. Dengan menampung di memori, kita dapat mengirim
 * status HTTP yang benar.
 *
 * Untuk satu kalimat (di bawah 1000 karakter), ukuran MP3 yang dihasilkan
 * berkisar 20-80 KB, jadi ini aman.
 */
export async function synthesizeSpeech(
  options: SynthesizeOptions,
): Promise<Buffer> {
  const text = options.text.trim();

  if (text.length === 0) {
    throw new TtsError('EMPTY_TEXT', 'Tidak ada teks untuk dibacakan.', 400);
  }

  if (text.length > MAX_TTS_CHARS) {
    throw new TtsError(
      'TEXT_TOO_LONG',
      `Teks terlalu panjang (${text.length} karakter). ` +
        `Maksimal ${MAX_TTS_CHARS} karakter per permintaan.`,
      413,
    );
  }

  const voice = options.voice ?? DEFAULT_VOICE;

  // Validasi nama suara. Tanpa ini, klien dapat mengirim nama sembarangan
  // dan menjadikan endpoint kita sebagai jembatan ke suara apa pun yang
  // didukung Edge — termasuk suara yang tidak relevan dengan aplikasi.
  if (!isAllowedVoiceName(voice)) {
    throw new TtsError(
      'INVALID_VOICE',
      'Pilihan suara tidak dikenali. Silakan pilih suara dari daftar yang tersedia.',
      400,
    );
  }

  const tts = new MsEdgeTTS();
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new TtsError(
          'TIMEOUT',
          'Layanan suara tidak merespons dalam waktu yang wajar. Silakan coba lagi.',
          504,
        ),
      );
    }, SYNTHESIS_TIMEOUT_MS);
  });

  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const prosody = buildProsody(options);

    const collect = async (): Promise<Buffer> => {
      const { audioStream } = tts.toStream(text, prosody);

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        audioStream.on('end', () => resolve());
        audioStream.on('error', (error: Error) =>
          reject(
            new TtsError(
              'STREAM_ERROR',
              `Aliran audio terputus: ${error.message}`,
              502,
            ),
          ),
        );
      });

      return Buffer.concat(chunks);
    };

    const audio = await Promise.race([collect(), timeout]);

    if (audio.length === 0) {
      throw new TtsError(
        'EMPTY_AUDIO',
        'Layanan suara tidak menghasilkan audio. Silakan coba lagi.',
        502,
      );
    }

    return audio;
  } finally {
    // Selalu tutup WebSocket, termasuk ketika timeout. Tanpa ini,
    // koneksi menggantung dan memori server bocor sedikit demi sedikit.
    tts.close();
  }
}

/**
 * Terima hanya nama suara dengan locale yang diizinkan.
 * Format Microsoft: "id-ID-ArdiNeural".
 */
function isAllowedVoiceName(voice: string): boolean {
  return ALLOWED_LOCALES.some((locale) =>
    voice.toLowerCase().startsWith(`${locale.toLowerCase()}-`),
  );
}

/**
 * Susun opsi prosodi.
 *
 * KONVERSI YANG PERLU DIPERHATIKAN:
 * msedge-tts menerima `rate` sebagai angka relatif (0.8) ATAU string
 * persentase ("+20%"). Kita menormalkan ke string persentase karena
 * perilakunya lebih dapat diprediksi dan selaras dengan dokumentasi SSML
 * Microsoft.
 */
function buildProsody(options: SynthesizeOptions): {
  rate?: string;
  pitch?: string;
} {
  const prosody: { rate?: string; pitch?: string } = {};

  if (typeof options.rate === 'number' && Number.isFinite(options.rate)) {
    const clamped = Math.max(0.5, Math.min(2, options.rate));
    const percent = Math.round((clamped - 1) * 100);
    prosody.rate = percent >= 0 ? `+${percent}%` : `${percent}%`;
  }

  if (options.pitch && /^[+-]\d+(Hz|st|%)$/.test(options.pitch)) {
    prosody.pitch = options.pitch;
  }

  return prosody;
}

/* ============================================================
 * Utilitas
 * ============================================================
 *
 * Perhitungan durasi kini tinggal di `lib/tts/estimate.ts` untuk
 * menghindari impor melingkar dengan `chunk-text.ts`. Impor ulang di
 * sini supaya pemanggil lama (`hooks/useServerAudio.ts`) tetap dapat
 * mengambilnya dari satu tempat yang sama.
 */

export { estimateDurationMs } from '@/lib/tts/estimate';
