/**
 * Kontrak data terpusat untuk AI ReadForYou.
 *
 * Prinsip: frontend dan backend berbagi SATU definisi tipe. Tidak ada
 * `any` di jalur data, sehingga perubahan bentuk API akan langsung
 * terdeteksi compiler.
 */

/* ============================================================
 * Dokumen & status
 * ============================================================ */

export type DocumentStatus =
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'error';

/** Baris tabel `documents` di Supabase. */
export interface DocumentRow {
  id: string;
  /** Nullable: MVP belum memakai Auth. */
  user_id: string | null;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  status: DocumentStatus;
  extracted_text: string | null;
  error_message: string | null;
  page_count: number | null;
  created_at: string;
}

/* ============================================================
 * API: /api/process-document
 * ============================================================ */

export interface ProcessDocumentRequest {
  /** ID baris `documents`. DIUTAMAKAN. */
  documentId?: string;
  /** Fallback MVP ketika tabel belum dipakai: path langsung di Storage. */
  filePath?: string;
  /** Untuk pengumuman aksesibel di klien ("bagian 3 dari 8"). */
  totalChunks?: number;
}

/** Satu bagian hasil ekstraksi (hasil chunked extraction). */
export interface ExtractedChunk {
  index: number;
  text: string;
  /** Jumlah halaman asal, bila model dapat mengetahuinya. */
  pageCount: number;
  /** True bila model melaporkan ada bagian yang tidak terbaca. */
  hadUnreadable: boolean;
  note: string | null;
}

export interface ProcessDocumentResponse {
  /** Teks akhir yang sudah dirangkai & siap dibacakan TTS. */
  text: string;
  /** Rincian per bagian; memungkinkan UI menampilkan progres granular. */
  chunks: ExtractedChunk[];
  pageCount: number;
  charCount: number;
  wordCount: number;
  /**
   * True bila dokumen melebihi `MAX_CHUNKS_PER_DOCUMENT` sehingga hanya
   * sebagian yang diekstrak.
   */
  truncated: boolean;
  /**
   * Pesan yang WAJIB diumumkan ke screen reader, misalnya bagian gagal
   * terbaca. Bukan untuk console.
   */
  warnings: string[];
}

/* ============================================================
 * Error taxonomy
 * ============================================================ */

export type ApiErrorCode =
  | 'NO_FILE'
  | 'BAD_REQUEST'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'UPSTREAM'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CONFIG';

/**
 * Bentuk error tunggal. Setiap kegagalan — apa pun sebabnya — harus bisa
 * dipetakan ke bentuk ini agar klien tidak perlu menebak.
 *
 * `message` sudah dalam bahasa Indonesia, siap dibacakan screen reader,
 * tanpa jargon teknis.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** True bila mencoba ulang berpotensi berhasil. */
    retryable: boolean;
  };
  /**
   * Rincian teknis penyebab kegagalan. HANYA diisi saat bukan produksi
   * (`NODE_ENV !== 'production'`) — lihat `AppError.toBody`.
   *
   * Ada karena pesan `error.message` sengaja generik dan ramah untuk
   * dibacakan screen reader, sehingga tanpa field ini penelusuran masalah
   * menjadi buta: "AI bermasalah" dapat berarti kunci salah, kuota habis,
   * atau jaringan mati, dan ketiganya butuh tindakan yang sangat berbeda.
   *
   * JANGAN pernah menampilkan ini sebagai pesan utama kepada pengguna.
   */
  debug?: string;
}

/* ============================================================
 * TTS (server-side, msedge-tts)
 * ============================================================
 *
 * CATATAN ARSITEKTUR:
 * Berbeda dari draf awal yang memakai `window.speechSynthesis`, audio
 * sekarang disintesis di server memakai msedge-tts karena modul itu
 * memerlukan WebSocket dan tidak berjalan di peramban.
 *
 * Keuntungannya nyata: suara neural Microsoft (id-ID-ArdiNeural /
 * id-ID-GadisNeural) jauh lebih jelas daripada suara sistem, dan
 * metadata batas kalimat memberi kita posisi baca yang presisi alih-alih
 * perkiraan.
 *
 * Kedua tipe di bawah tetap dipertahankan karena `useServerAudio`
 * memakai `SpeechSynthesis` sebagai JARING PENGAMAN bila endpoint audio
 * gagal — sehingga demo tidak bisa mati total di depan juri.
 */

export type SpeechState = 'idle' | 'loading' | 'speaking' | 'paused' | 'stalled' | 'ended';

export interface SentenceChunk {
  index: number;
  text: string;
  /** Perkiraan durasi (ms). Dipakai untuk indikator sebelum audio siap. */
  estimatedMs: number;
}

/** Suara yang tersedia dari endpoint /api/voices. */
export interface VoiceOption {
  /** Nilai yang dikirim ke server, mis. "id-ID-GadisNeural". */
  shortName: string;
  /** Nama yang dibacakan ke pengguna. */
  label: string;
  locale: string;
  gender: 'Male' | 'Female' | string;
}

export interface TtsRequest {
  /** Satu kalimat untuk disintesis. Batas 1000 karakter. */
  text: string;
  voice?: string;
  /** Kecepatan relatif, mis. "+20%" atau 0.8. */
  rate?: number;
  pitch?: string;
}

export interface TtsErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/* ============================================================
 * API: /api/ask (tanya-jawab berbasis dokumen)
 * ============================================================ */

export interface AskRequest {
  /** ID baris `documents`. DIUTAMAKAN — teks diambil server dari tabel. */
  documentId?: string;
  /** Fallback bila tanpa id (mis. bacaan dari riwayat): teks langsung. */
  text?: string;
  /** Nama dokumen untuk prompt (opsional, untuk penolakan jujur). */
  docName?: string;
  /** Pertanyaan pengguna, maks 500 karakter. */
  question?: string;
}

export interface AskResponse {
  /** Jawaban ringkas siap-dengar dalam Bahasa Indonesia. */
  answer: string;
}

/* ============================================================
 * Status alur di UI
 * ============================================================ */

export type PipelineStage =
  | 'idle'
  | 'validating'
  | 'uploading'
  | 'extracting'
  | 'ready'
  | 'error';
