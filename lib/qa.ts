/**
 * Tanya-jawab berbasis dokumen — AI ReadForYou
 * ============================================
 *
 * Menyusun prompt terikat-dokumen dan memanggil Gemini untuk menjawab
 * pertanyaan pengguna. Prinsip yang sama dengan ekstraksi: jawaban yang
 * dikarang lebih berbahaya daripada jawaban yang menolak — bila dokumen
 * tidak memuat jawabannya, model WAJIB mengakuinya.
 */

import { AppError } from '@/lib/api-error';
import { generateTextWithFallback } from '@/lib/gemini';

/* ============================================================
 * Batasan
 * ============================================================ */

/** Pertanyaan dibatasi agar tak disalahgunakan sebagai injeksi panjang. */
export const MAX_QUESTION_CHARS = 500;

/**
 * Konteks dokumen yang dikirim ke model. Gemini Flash punya jendela
 * konteks ~1 juta token, jadi modul pelajaran utuh muat; batas ini hanya
 * pengaman biaya/kuota, bukan kebutuhan teknis.
 */
export const MAX_CONTEXT_CHARS = 200_000;

/** Jawaban dibatasi agar siap-dengar (2-4 kalimat) dan hemat TTS. */
const ANSWER_MAX_OUTPUT_TOKENS = 512;

/* ============================================================
 * Prompt
 * ============================================================ */

export function buildQaPrompt(
  question: string,
  docText: string,
  docName: string,
): string {
  return `
Kamu adalah asisten belajar untuk siswa penyandang disabilitas penglihatan.
Jawablah pertanyaan di bawah ini HANYA berdasarkan isi dokumen yang diberikan.

ATURAN WAJIB:
1. Jawaban maksimal 4 kalimat, dalam Bahasa Indonesia yang natural dan siap dibacakan Text-to-Speech.
2. Jangan memakai penomoran, bullet, simbol, atau format markdown.
3. JANGAN menambahkan informasi yang tidak ada di dokumen. Jangan menyimpulkan di luar isi dokumen.
4. Jika dokumen tidak memuat jawabannya, katakan dengan jujur: "Maaf, hal itu tidak dibahas dalam dokumen ${docName}." Jangan mengarang.

=== ISI DOKUMEN (${docName}) ===
${docText}
=== AKHIR DOKUMEN ===

Pertanyaan: ${question}

Jawaban:
`.trim();
}

/* ============================================================
 * API publik
 * ============================================================ */

export interface AnswerQuestionOptions {
  question: string;
  docText: string;
  docName?: string;
}

/**
 * Jawab satu pertanyaan berdasarkan teks dokumen. Melempar AppError
 * (BAD_REQUEST bila masukan tidak sah, UPSTREAM/MODEL_NOT_FOUND bila
 * model gagal) agar route dapat memetakan langsung ke respons.
 */
export async function answerQuestion(
  options: AnswerQuestionOptions,
): Promise<string> {
  const question = options.question.trim();
  if (question.length === 0) {
    throw new AppError('BAD_REQUEST', 'Pertanyaan kosong.');
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new AppError(
      'BAD_REQUEST',
      `Pertanyaan ${question.length} karakter melebihi batas ${MAX_QUESTION_CHARS}.`,
    );
  }

  const docText = options.docText.trim();
  if (docText.length === 0) {
    throw new AppError('BAD_REQUEST', 'Teks dokumen kosong.');
  }
  if (docText.length > MAX_CONTEXT_CHARS) {
    throw new AppError(
      'TOO_LARGE',
      `Konteks ${docText.length} karakter melebihi batas ${MAX_CONTEXT_CHARS}.`,
    );
  }

  const docName =
    options.docName && options.docName.trim().length > 0
      ? options.docName.trim()
      : 'dokumen';

  const prompt = buildQaPrompt(question, docText, docName);
  return generateTextWithFallback({
    prompt,
    temperature: 0.3,
    maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
  });
}
