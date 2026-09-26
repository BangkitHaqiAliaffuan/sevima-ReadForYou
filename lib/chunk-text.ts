/**
 * Pemecah teks menjadi kalimat — fondasi TTS yang andal.
 *
 * KENAPA INI PERLU (bukan sekadar satu panggilan speak()):
 *
 * `window.speechSynthesis` punya perilaku yang berbeda-beda antar browser
 * dan gagal pada teks panjang:
 *
 *  - Chrome: utterance yang lebih dari sekitar 15 detik dapat berhenti
 *    sendiri tanpa memanggil `onend`.
 *  - Safari: kadang `onend` tidak pernah dipanggil untuk teks sangat
 *    panjang, sehingga tombol Jeda/Hentikan tampak "tidak bekerja".
 *  - Firefox: pemotongan pada batas tertentu bisa memotong di tengah kata.
 *
 * Dengan memecah teks menjadi kalimat dan mengantre satu utterance per
 * kalimat, kita memperoleh: (a) jeda alami seperti pembaca manusia,
 * (b) posisi baca yang dapat dilacak untuk Pause/Lanjut, dan (c) titik
 * pemulihan ketika satu utterance gagal.
 */

import type { SentenceChunk } from '@/types';
import { estimateDurationMs } from '@/lib/tts/estimate';

/* ============================================================
 * Singkatan & pola yang TIDAK boleh dianggap akhir kalimat
 * ============================================================ */

/**
 * Daftar singkatan lazim dalam bahasa Indonesia beserta padanan yang lebih
 * enak didengar mesin TTS. Kunci berhuruf kecil; titik sudah termasuk.
 */
const ABBREVIATIONS: Record<string, string> = {
  'dll.': 'dan lain-lain',
  'dsb.': 'dan sebagainya',
  'dst.': 'dan seterusnya',
  'dsl.': 'dan sebagainya',
  'yg.': 'yang',
  'tsb.': 'tersebut',
  'hlm.': 'halaman',
  'hal.': 'halaman',
  'no.': 'nomor',
  'nol.': 'nomor',
  'vol.': 'volume',
  'bab.': 'bab',
  'a.n.': 'atas nama',
  'u.p.': 'untuk perhatian',
  's.d.': 'sampai dengan',
  'ybs.': 'yang bersangkutan',
  'ttd.': 'tertanda',
  'jl.': 'jalan',
  'gb.': 'gambar',
  'tgl.': 'tanggal',
  'th.': 'tahun',
  'sbb.': 'sebagai berikut',
  'sda.': 'sama dengan di atas',
  'k.a.': 'kepada',
  'spt.': 'seperti',
  'e.g.': 'contoh',
  'i.e.': 'yaitu',
  'vs.': 'versus',
  'bab i.': 'bab satu',
};

/** Gelar yang lazim muncul di modul pelajaran. */
const TITLES = [
  'dr.', 'drg.', 'prof.', 'ir.', 'drs.', 'dra.', 'mr.', 'mrs.', 'ms.',
];

/* ============================================================
 * Normalisasi teks untuk TTS
 * ============================================================ */

const NUMBER_WORDS: Record<string, string> = {
  '0': 'nol', '1': 'satu', '2': 'dua', '3': 'tiga', '4': 'empat',
  '5': 'lima', '6': 'enam', '7': 'tujuh', '8': 'delapan', '9': 'sembilan',
};

/**
 * Bersihkan teks supaya enak didengar. Ini pelengkap, bukan pengganti
 * prompt ke Gemini: model sudah diminta menulis kalimat mengalir, dan
 * fungsi ini merapikan sisa-sisa simbol yang lolos.
 */
export function normalizeForSpeech(raw: string): string {
  let text = raw;

  // 1. Satukan baris yang terpotong tanpa tanda baca (hyphenation).
  text = text.replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2');

  // 2. Baris baru tunggal -> spasi; baris kosong -> jeda kalimat.
  text = text.replace(/\n{2,}/g, '. ');
  text = text.replace(/\n/g, ' ');

  // 3. Ganti singkatan dengan padanannya.
  for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
    // \b tidak bekerja baik dengan titik, jadi pakai batas kiri kata.
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(abbr)}(\\s|$)`, 'gi');
    text = text.replace(pattern, `$1${full}$2`);
  }

  // 4. Hapus gelar (tidak enak didengar bila dieja).
  for (const title of TITLES) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(title)}`, 'gi');
    text = text.replace(pattern, ' ');
  }

  // 5. Rentang angka: "5-10" -> "5 sampai 10" (jangan sampai mesin
  //    membacanya sebagai "lima negatif sepuluh").
  text = text.replace(/(\d)\s*[-–—]\s*(\d)/g, '$1 sampai $2');

  // 6. Simbol yang punya bunyi berbeda dari yang diharapkan.
  const symbolMap: [RegExp, string][] = [
    [/\s*&\s*/g, ' dan '],
    [/\s*%\s*/g, ' persen '],
    [/\s*≈\s*/g, ' sekitar '],
    [/\s*±\s*/g, ' kurang lebih '],
    [/\s*http\S+/gi, ' tautan '],
    [/\s*www\.\S+/gi, ' tautan '],
    [/\s*([x×])\s*/gi, ' kali '],
    [/\s*÷\s*/g, ' dibagi '],
    [/\s*=\s*/g, ' sama dengan '],
    [/\s*\+\s*/g, ' ditambah '],
    [/\s*≤\s*/g, ' kurang dari atau sama dengan '],
    [/\s*≥\s*/g, ' lebih dari atau sama dengan '],
    [/\s*→\s*/g, ' menjadi '],
  ];
  for (const [pattern, replacement] of symbolMap) {
    text = text.replace(pattern, replacement);
  }

  // 7. Pecahan sederhana: "1/2" -> "satu per dua".
  text = text.replace(
    /(^|\s)(\d)\s*\/\s*(\d)(\s|$)/g,
    (_m, pre: string, a: string, b: string, post: string) =>
      `${pre}${NUMBER_WORDS[a] ?? a} per ${NUMBER_WORDS[b] ?? b}${post}`,
  );

  // 8. Bullet & penomoran yang lolos dari prompt.
  text = text.replace(/^\s*[•▪◦‣·*]\s+/gm, '');
  text = text.replace(/\s*[•▪◦‣·]\s*/g, ', ');

  // 9. Rapikan spasi berlebih.
  text = text.replace(/\s{2,}/g, ' ');
  text = text.replace(/\s+([,.;:!?])/g, '$1');

  return text.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ============================================================
 * Pemecahan kalimat
 * ============================================================ */

/**
 * Kata-kata yang muncul sebelum titik tetapi TIDAK mengakhiri kalimat
 * pada konteks tertentu (mis. "Rp." atau angka desimal).
 */
const TRAILING_SAFE = /(?:\b(?:Rp|No|Vol|Bab|Hlm|Hal))$/i;

/**
 * Pecah teks menjadi kalimat. Strategi dua tahap:
 *
 *  1. Coba pecah pada tanda akhir kalimat yang jelas.
 *  2. Gabungkan kembali potongan yang terlalu pendek, dan pecah potongan
 *     yang terlalu panjang pada tanda baca lemah (,;) supaya tidak ada
 *     utterance raksasa.
 *
 * Panjang target 180 karakter dipilih karena mesin TTS paling stabil di
 * bawah ~200 karakter dan pembaca masih merasakan kalimat sebagai satu
 * kesatuan.
 */
export function splitIntoSentences(
  rawText: string,
  options?: { targetLength?: number },
): SentenceChunk[] {
  const targetLength = options?.targetLength ?? 180;
  const text = normalizeForSpeech(rawText);

  if (text.length === 0) return [];

  const segments = splitOnTerminators(text);

  /*
   * Tahap penggabungan — DIPERBAIKI SETELAH PENGUJIAN MENEMUKAN BUG.
   *
   * Riwayat: versi pertama menggabungkan segmen bila SALAH SATU pihak
   * pendek. Versi kedua masih salah: segmen yang SUDAH diakhiri tanda
   * baca akhir kalimat tidak boleh digabung sama sekali, karena itu
   * berarti kita dengan sengaja menghapus batas kalimat yang sudah
   * dideteksi dengan benar.
   *
   * Yang benar:
   *  - Segmen yang berakhir dengan . ! ? … adalah kalimat utuh.
   *    Biarkan berdiri sendiri.
   *  - Hanya pecahan yang TIDAK berakhir dengan tanda akhir kalimat
   *    (mis. hasil pemotongan pada koma) yang perlu digabungkan.
   *
   * Setiap penggabungan yang salah berdampak nyata: TTS kehilangan jeda
   * antar kalimat, tombol "kalimat berikutnya" melompat satu paragraf,
   * dan estimasi durasi untuk watchdog menjadi tidak akurat.
   */
  const merged: string[] = [];
  for (const segment of segments) {
    const prev = merged[merged.length - 1];

    const prevIsCompleteSentence = prev !== undefined && endsWithTerminator(prev);
    const segmentIsCompleteSentence = endsWithTerminator(segment);

    const shouldMerge =
      prev !== undefined &&
      !prevIsCompleteSentence &&
      !segmentIsCompleteSentence &&
      prev.length + segment.length + 1 <= targetLength * 1.2;

    if (shouldMerge) {
      merged[merged.length - 1] = `${prev} ${segment}`;
    } else {
      merged.push(segment);
    }
  }

  const final: string[] = [];
  for (const segment of merged) {
    if (segment.length <= targetLength * 1.6) {
      final.push(segment);
    } else {
      final.push(...splitOnWeakPunctuation(segment, targetLength));
    }
  }

  return final
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s, index) => ({
      index,
      text: s,
      estimatedMs: estimateDurationMs(s),
    }));
}

/**
 * Pecah pada tanda akhir kalimat (. ! ? …) sambil melindungi singkatan,
 * gelar, angka desimal, dan inisial.
 */
function splitOnTerminators(text: string): string[] {
  const terminators = new Set(['.', '!', '?', '…', '。', '！', '？']);
  const result: string[] = [];
  let buffer = '';

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    buffer += char;

    if (!terminators.has(char)) continue;

    // Rangkai tanda berulang: "?!", "...", "!!!".
    while (i + 1 < text.length && terminators.has(text[i + 1] as string)) {
      i += 1;
      buffer += text[i] as string;
    }

    if (char === '.') {
      if (bufferEndsWithProtectedDot(buffer)) continue;
      // Angka desimal: "3.14" -> titik diikuti digit bukan akhir kalimat.
      const next = text[i + 1];
      const prev = buffer[buffer.length - 2];
      if (
        next !== undefined &&
        /\d/.test(next) &&
        prev !== undefined &&
        /\d/.test(prev)
      ) {
        continue;
      }
    }

    // Akhir kalimat jika diikuti spasi, tanda kutip, atau akhir teks.
    const next = text[i + 1];
    if (next === undefined || /\s/.test(next) || /["'”’»)]/.test(next)) {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) result.push(trimmed);
      buffer = '';
    }
  }

  const tail = buffer.trim();
  if (tail.length > 0) result.push(tail);

  return result;
}

/**
 * Apakah akumulasi buffer diakhiri titik yang TIDAK mengakhiri kalimat?
 * Contoh: "Harga Rp. 5000" — titik setelah "Rp" bukan akhir kalimat.
 */
function bufferEndsWithProtectedDot(buffer: string): boolean {
  const trimmed = buffer.slice(0, -1); // buang titik
  const lastToken = trimmed.split(/\s+/).pop() ?? '';

  if (lastToken.length === 0) return false;

  // Inisial: satu huruf besar, mis. "A." pada "A. Rahman".
  if (/^[A-Z]$/.test(lastToken)) return true;

  // Gelar satu-dua huruf besar berurutan: "M.", "S.", "Ir.".
  if (/^(?:[A-Z]\.)+[A-Z]?$/i.test(`${lastToken}.`)) {
    if (lastToken.length <= 3) return true;
  }

  // Singkatan yang sudah diketahui.
  if (/^(?:Rp|No|Vol|Bab|Hlm|Hal)$/i.test(lastToken)) return true;

  // Singkatan bertitik dari daftar.
  const withDot = `${lastToken.toLowerCase()}.`;
  if (withDot in ABBREVIATIONS) return true;
  for (const title of TITLES) {
    if (withDot === title.toLowerCase()) return true;
  }

  return TRAILING_SAFE.test(lastToken);
}

/**
 * Apakah teks berakhir dengan tanda akhir kalimat?
 *
 * Tanda kutip dan tanda kurung penutup diizinkan berada setelah tanda
 * akhir, karena dalam penulisan Indonesia keduanya lazim muncul di sana,
 * misalnya: Ia berkata, "Belajar itu penting." Tanda kutip penutup tidak
 * mengubah fakta bahwa kalimatnya sudah selesai.
 */
function endsWithTerminator(text: string): boolean {
  return /[.!?…。！？][""''»)\]]*\s*$/.test(text.trim());
}

/**
 * Pecah pada koma/titik koma/titik dua saat satu segmen terlalu panjang.
 */
function splitOnWeakPunctuation(text: string, targetLength: number): string[] {
  const pieces = text.split(/(?<=[,;:])\s+/);
  const result: string[] = [];
  let buffer = '';

  for (const piece of pieces) {
    if (buffer.length + piece.length > targetLength * 1.3 && buffer.length > 0) {
      result.push(buffer.trim());
      buffer = piece;
    } else {
      buffer = buffer.length === 0 ? piece : `${buffer} ${piece}`;
    }
  }

  if (buffer.trim().length > 0) result.push(buffer.trim());

  // Upaya terakhir: potong pada batas kata agar tidak ada utterance
  // yang sangat panjang bila tanda baca tidak ada sama sekali.
  const safe: string[] = [];
  for (const piece of result) {
    if (piece.length <= targetLength * 2) {
      safe.push(piece);
      continue;
    }
    let current = '';
    for (const word of piece.split(/\s+/)) {
      if (current.length + word.length + 1 > targetLength * 1.5 && current.length > 0) {
        safe.push(current.trim());
        current = word;
      } else {
        current = current.length === 0 ? word : `${current} ${word}`;
      }
    }
    if (current.trim().length > 0) safe.push(current.trim());
  }

  return safe;
}

/* ============================================================
 * Estimasi waktu
 * ============================================================
 *
 * CATATAN: `estimateDurationMs` dan `formatDuration` semula tinggal di
 * berkas ini. Setelah TTS pindah ke server (msedge-tts), `estimateDuration`
 * dipindahkan ke `lib/tts/synthesize.ts` agar logika estimasi hanya ada
 * di satu tempat. `formatDuration` tetap di sini karena murni urusan
 * tampilan dan dipakai juga untuk ringkasan dokumen.
 */

/** "sekitar 4 menit 30 detik" — untuk diumumkan ke pengguna. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000 / 1.25);
  if (totalSeconds < 60) {
    return `sekitar ${totalSeconds} detik`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `sekitar ${minutes} menit`;
  return `sekitar ${minutes} menit ${seconds} detik`;
}
