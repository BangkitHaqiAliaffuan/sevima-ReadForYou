'use client';

/**
 * app/page.tsx — halaman utama
 * ============================
 *
 * Mengorkestrasi seluruh alur:
 *
 *   1. Unggah berkas ke Supabase Storage dengan progres yang diumumkan.
 *   2. Panggil /api/process-document untuk mengekstrak teks via Gemini.
 *   3. Tampilkan teks dan aktifkan pemutar suara (msedge-tts lewat /api/tts).
 *
 * FOKUS UTAMA HALAMAN INI ADALAH AKSESIBILITAS:
 *
 *  - Setiap perubahan tahap diumumkan lewat LiveStatus, bukan hanya
 *    ditunjukkan lewat pemintal (spinner) visual.
 *  - Fokus dipindahkan secara sengaja pada momen yang tepat: ke judul
 *    hasil ketika teks siap, dan kembali ke input berkas ketika gagal.
 *    Pemindahan fokus dilakukan di useEffect karena pada saat handler
 *    berjalan, elemen tujuan belum tentu sudah ada di DOM.
 *  - Galat selalu berupa kalimat lengkap dalam bahasa Indonesia yang
 *    menjelaskan langkah berikutnya, bukan kode kesalahan.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AudioPlayer } from '@/components/AudioPlayer';
import { VoiceQA } from '@/components/VoiceQA';
import { DocumentHistory } from '@/components/DocumentHistory';
import { LiveStatus, StatusBanner } from '@/components/LiveStatus';
import { ProgressBar, UploadModule } from '@/components/UploadModule';
import { useAnnouncer } from '@/hooks/useAnnouncer';
import { useServerAudio } from '@/hooks/useServerAudio';
import { useSession } from '@/hooks/useSession';
import { formatDuration, splitIntoSentences } from '@/lib/chunk-text';
import { SAMPLE_DOCUMENT } from '@/lib/sample-document';
import {
  buildStoragePath,
  getBrowserSupabase,
  humanizeFileName,
  STORAGE_BUCKET,
} from '@/lib/supabase';
import { formatMegabytes } from '@/lib/validate-file';
import type {
  ApiErrorBody,
  PipelineStage,
  ProcessDocumentResponse,
  SpeechState,
  VoiceOption,
} from '@/types';

/** Interval pengumuman progres: jangan lebih rapat dari ini. */
const PROGRESS_STEP_PERCENT = 10;

export default function HomePage() {
  const { politeMessage, assertiveMessage, announce, clear } = useAnnouncer();
  const { user } = useSession();

  /* Id stabil untuk deps memo + scope storage (hindari optional-chain di deps). */
  const sessionUserId = user?.id ?? null;

  const [stage, setStage] = useState<PipelineStage>('idle');
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [documentText, setDocumentText] = useState('');
  const [documentName, setDocumentName] = useState('');
  /** ID baris `documents` untuk tanya-jawab; null bila tanpa id (riwayat). */
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  /** Posisi macet terakhir — menampilkan panel pemulihan. */
  const [stalledInfo, setStalledInfo] = useState<{
    index: number;
    total: number;
  } | null>(null);

  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesUnavailable, setVoicesUnavailable] = useState(false);

  /** Menaikkan nilai ini memicu fokus kembali ke input berkas. */
  const [focusInputSignal, setFocusInputSignal] = useState(0);

  /**
   * Menaikkan nilai ini memicu fokus ke judul hasil saat teks dimuat ulang
   * dari riwayat (stage sudah 'ready' sehingga efek stage saja tak cukup).
   */
  const [replaySignal, setReplaySignal] = useState(0);

  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const playButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeSentenceRef = useRef<HTMLSpanElement | null>(null);
  const lastAnnouncedPercent = useRef(0);
  /** Mencegah pemrosesan ganda ketika pengguna menekan tombol dua kali. */
  const busyRef = useRef(false);

  const busy = stage === 'uploading' || stage === 'extracting';

  /* ============================================================
   * Pemutar suara
   * ============================================================ */

  const handleStateChange = useCallback(
    (state: SpeechState) => {
      if (state === 'loading') {
        announce('Sedang menyiapkan suara untuk kalimat ini.', { key: 'tts' });
      } else if (state === 'speaking') {
        announce('Mulai membacakan teks.', { key: 'tts' });
      } else if (state === 'paused') {
        announce('Pembacaan dijeda.', { key: 'tts' });
      }
      // 'idle' sengaja tidak diumumkan: keadaan itu juga muncul saat
      // memuat teks baru, dan pengumuman di sana hanya menambah kebisingan.
    },
    [announce],
  );

  const handleComplete = useCallback(() => {
    announce('Pembacaan teks selesai.', { key: 'tts' });
  }, [announce]);

  const handleAudioError = useCallback(
    (message: string) => {
      setErrorMessage(message);
      announce(message, { priority: 'assertive', key: 'audio-error' });
    },
    [announce],
  );

  const handleFallbackActivated = useCallback(() => {
    announce(
      'Layanan suara utama tidak dapat dihubungi. Sistem beralih memakai ' +
        'suara bawaan peramban agar pembacaan tetap berjalan.',
      { priority: 'assertive', key: 'audio-fallback' },
    );
  }, [announce]);

  const handleAudioReady = useCallback(
    (info: { usingFallback: boolean }) => {
      announce(
        info.usingFallback
          ? 'Audio siap dengan suara bawaan peramban. Tekan Putar atau Alt+P untuk mulai mendengarkan.'
          : 'Audio siap. Tekan Putar atau Alt+P untuk mulai mendengarkan.',
        {
          key: 'audio-ready',
        },
      );
      // Pindahkan fokus langsung ke tombol Putar agar siswa tidak perlu mencari kontrol
      if (playButtonRef.current) {
        playButtonRef.current.focus();
      }
    },
    [announce],
  );

  const handleInterrupted = useCallback(
    (info: {
      index: number;
      total: number;
      playedCount: number;
      reason: 'stall' | 'failed';
    }) => {
      setStalledInfo({ index: info.index, total: info.total });
      const position = `kalimat ${info.index + 1} dari ${info.total}`;
      announce(
        info.reason === 'stall'
          ? `Pembacaan terhenti di ${position}. Posisi Anda tersimpan, tidak perlu mengulang dari awal. ` +
              `Tekan Ulangi kalimat ini untuk mencoba lagi, Lewati untuk lanjut ke kalimat berikutnya, ` +
              `atau Pakai suara peramban untuk melanjutkan.`
          : `Pembacaan tidak dapat dimulai. Layanan suara tidak merespons sama sekali. ` +
              `Tekan Ulangi untuk mencoba lagi, atau Pakai suara peramban untuk melanjutkan.`,
        { priority: 'assertive', key: 'audio-interrupted' },
      );
      // SENGAJA tidak memindahkan fokus: pengguna tetap di posisinya dan
      // dapat mencapai tombol pemulihan lewat Tab normal.
    },
    [announce],
  );

  const handleSentenceWaiting = useCallback(
    (index: number, total: number) => {
      announce(
        `Menyiapkan audio kalimat ${index + 1} dari ${total}. Mohon tunggu sebentar.`,
        { key: 'audio-waiting' },
      );
    },
    [announce],
  );

  const audio = useServerAudio({
    onStateChange: handleStateChange,
    onComplete: handleComplete,
    onError: handleAudioError,
    onFallbackActivated: handleFallbackActivated,
    onAudioReady: handleAudioReady,
    onInterrupted: handleInterrupted,
    onSentenceWaiting: handleSentenceWaiting,
  });

  const { load: loadAudio, pause: pauseDocument } = audio;

  /**
   * Jeda bacaan dokumen untuk sesi tanya (posisi tersimpan di hook,
   * pengguna melanjutkan dengan Putar setelah jawaban selesai).
   */
  const handlePauseDocument = useCallback(() => {
    pauseDocument();
  }, [pauseDocument]);
  const {
    useFallbackVoice,
    retryMainService,
    reloadCurrentAudio,
  } = audio;

  const handleRetryMainService = useCallback(() => {
    announce('Mencoba layanan suara utama.', { key: 'audio-service' });
    retryMainService();
  }, [announce, retryMainService]);

  const handleReloadAudio = useCallback(() => {
    announce('Memuat ulang audio kalimat ini.', { key: 'audio-reload' });
    reloadCurrentAudio();
  }, [announce, reloadCurrentAudio]);

  /* ============================================================
   * Muat teks ke pemutar
   * ============================================================ */

  useEffect(() => {
    if (documentText.length === 0) return;
    loadAudio(documentText);
  }, [documentText, loadAudio]);

  /* ============================================================
   * Ambil daftar suara sekali saat halaman dibuka
   * ============================================================ */

  useEffect(() => {
    let cancelled = false;

    async function fetchVoices() {
      try {
        const response = await fetch('/api/voices');
        if (!response.ok) throw new Error(`status ${response.status}`);

        const data = (await response.json()) as {
          voices: VoiceOption[];
          fallbackRecommended?: boolean;
        };

        if (cancelled) return;

        setVoices(data.voices ?? []);
        setVoicesUnavailable((data.voices?.length ?? 0) === 0);
      } catch {
        if (cancelled) return;
        /*
         * Kegagalan di sini TIDAK menghalangi pengguna. Daftar suara
         * hanyalah pelengkap; audio tetap dapat diputar dengan suara
         * bawaan. Jadi kita menandainya dan melanjutkan, bukan
         * menampilkan galat yang membuat panik.
         */
        setVoicesUnavailable(true);
      }
    }

    void fetchVoices();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ============================================================
   * Fokus hasil
   * ============================================================ */

  useEffect(() => {
    if (stage === 'ready' && resultHeadingRef.current) {
      /*
       * Pindahkan fokus ke judul hasil supaya pengguna screen reader
       * langsung berada di awal konten baru, bukan tertinggal di tombol
       * unggah yang sudah tidak relevan.
       *
       * tabIndex={-1} pada elemen tujuan membuatnya dapat difokus secara
       * program tanpa masuk ke urutan Tab. Ini pola yang benar untuk
       * pemindahan fokus; memakai autoFocus justru merampas kendali
       * pengguna, terutama ketika halaman dimuat ulang.
       */
      resultHeadingRef.current.focus();
    }
  }, [stage, replaySignal]);

  /* ============================================================
   * Pengumuman progres
   * ============================================================ */

  const announceProgress = useCallback(
    (percent: number, kind: 'unggah' | 'ekstraksi') => {
      const rounded = Math.floor(percent);
      if (rounded - lastAnnouncedPercent.current < PROGRESS_STEP_PERCENT) return;
      lastAnnouncedPercent.current = rounded;

      announce(
        kind === 'unggah'
          ? `Sedang mengunggah berkas, ${rounded} persen.`
          : `Sedang mengekstrak teks, ${rounded} persen.`,
        { key: kind },
      );
    },
    [announce],
  );

  /* ============================================================
   * Alur utama: unggah lalu ekstrak
   * ============================================================ */

  const handleFileSelected = useCallback(
    async (file: File) => {
      /*
       * Kunci untuk mencegah dua proses berjalan bersamaan. Tanpa ini,
       * pengguna yang menekan tombol cepat dua kali akan mengirim dua
       * unggahan, memakan kuota, dan membuat pengumuman tumpang tindih.
       */
      if (busyRef.current) return;
      busyRef.current = true;

      clear();
      setErrorMessage(null);
      setWarnings([]);
      setStalledInfo(null);
      setDocumentText('');
      setDocumentName(humanizeFileName(file.name));
      setWordCount(0);
      setDocumentId(null);
      lastAnnouncedPercent.current = 0;

      try {
        /* ---------- Tahap 1: unggah ---------- */
        setStage('uploading');
        setUploadPercent(0);

        announce(
          `Mulai mengunggah berkas ${humanizeFileName(file.name)}, ` +
            `berukuran ${formatMegabytes(file.size)}.`,
          { key: 'status' },
        );

        const supabase = getBrowserSupabase();
        /*
         * Berkas milik pengguna yang sudah masuk disimpan di bawah folder
         * uid-nya agar cocok dengan kebijakan storage `owner_*`. Pengguna
         * yang BELUM masuk memakai folder 'anonim' (kebijakan
         * `mvp_anon_upload`) dan tidak memperoleh riwayat.
         */
        const path = buildStoragePath({
          scope: sessionUserId ?? 'anonim',
          fileName: file.name,
        });

        const uploadResult = await uploadWithProgress(supabase, path, file, (percent) => {
          setUploadPercent(percent);
          announceProgress(percent, 'unggah');
        });

        if (!uploadResult.ok) {
          throw new Error(uploadResult.message);
        }

        /* ---------- Tahap 2: catat dokumen (opsional) ---------- */
        let documentId: string | null = null;

        const insertResult = await supabase
          .from('documents')
          .insert({
            user_id: sessionUserId,
            file_path: path,
            file_name: humanizeFileName(file.name),
            mime_type: file.type || 'application/octet-stream',
            size_bytes: file.size,
            status: 'uploaded',
          })
          .select('id')
          .maybeSingle<{ id: string }>();

        if (!insertResult.error && insertResult.data) {
          documentId = insertResult.data.id;
        }
        // Simpan id untuk tanya-jawab (null bila insert gagal → fallback teks).
        setDocumentId(documentId);
        // Bila tabel belum dibuat, kita lanjut memakai filePath langsung.
        // Ini disengaja agar aplikasi tetap berfungsi pada tahap MVP.

        announce(
          'Berkas berhasil diunggah. Sekarang sistem mulai memproses teks.',
          { key: 'status' },
        );

        /* ---------- Tahap 3: ekstraksi teks ---------- */
        setStage('extracting');
        setUploadPercent(null);

        /*
         * Progres sintetis. Sebagian permintaan tidak melaporkan progres
         * bertahap, jadi kita tampilkan kemajuan yang berhenti di 90
         * persen sampai jawaban server tiba. Ini lebih jujur daripada
         * batang yang melompat tiba-tiba dari 0 ke 100.
         */
        let synthetic = 0;
        const ticker = setInterval(() => {
          synthetic = Math.min(90, synthetic + 3);
          setUploadPercent(synthetic);
          announceProgress(synthetic, 'ekstraksi');
        }, 700);

        let payload: ProcessDocumentResponse;
        try {
          payload = await requestExtraction(documentId, path);
        } finally {
          clearInterval(ticker);
          setUploadPercent(null);
        }

        /* ---------- Tahap 4: tampilkan hasil ---------- */
        setDocumentText(payload.text);
        setWordCount(payload.wordCount);
        setWarnings(payload.warnings);
        setStage('ready');

        announce(
          `Proses selesai. Teks siap dibacakan, berisi ${payload.wordCount} kata, ` +
            `perkiraan waktu baca ${formatDuration(
              payload.text.length > 0
                ? (payload.text.length / 14) * 1000 * 1.25
                : 0,
            )}. ` +
            `Menyiapkan audio. Tombol Putar akan aktif setelah audio siap.` +
            (payload.warnings.length > 0
              ? ` Terdapat ${payload.warnings.length} catatan penting.`
              : ''),
          { key: 'audio-ready' },
        );
      } catch (err) {
        const message = toFriendlyMessage(err);
        setStage('error');
        setErrorMessage(message);
        setUploadPercent(null);
        announce(message, { priority: 'assertive', key: 'error' });
        // Kembalikan fokus ke input berkas agar pengguna dapat langsung
        // mencoba lagi tanpa menavigasi ulang dari awal.
        setFocusInputSignal((value) => value + 1);
      } finally {
        busyRef.current = false;
      }
    },
    [announce, announceProgress, clear, sessionUserId],
  );

  /**
   * Muat ulang bacaan tersimpan dari riwayat ke pemutar + tampilan teks.
   * Fokus ke judul hasil ditangani efek [stage, replaySignal].
   */
  const handleReplaySelected = useCallback(
    (item: { text: string; name: string; wordCount: number }) => {
      clear();
      setErrorMessage(null);
      setWarnings([]);
      setDocumentText(item.text);
      setDocumentName(item.name);
      setWordCount(item.wordCount);
      // Riwayat tak menyimpan id — tanya-jawab memakai fallback teks.
      setDocumentId(null);
      setStage('ready');
      setReplaySignal((value) => value + 1);
      announce(
        `Bacaan ${item.name} dimuat ulang, berisi ${item.wordCount} kata. Pemutar suara siap digunakan.`,
        { key: 'status' },
      );
    },
    [announce, clear],
  );

  /**
   * Muat modul contoh pra-ekstraksi langsung tanpa unggah berkas.
   */
  const handleSelectSample = useCallback(() => {
    if (busyRef.current) return;
    clear();
    setErrorMessage(null);
    setWarnings([]);
    setDocumentText(SAMPLE_DOCUMENT.text);
    setDocumentName(SAMPLE_DOCUMENT.name);
    setWordCount(SAMPLE_DOCUMENT.wordCount);
    setDocumentId(null);
    setStage('ready');
    setReplaySignal((v) => v + 1);
    announce(
      `Modul contoh Tata Surya dimuat, berisi ${SAMPLE_DOCUMENT.wordCount} kata. Menyiapkan audio.`,
      { key: 'status' },
    );
  }, [announce, clear]);

  /**
   * Reset kembali ke menu pemilihan / pengunggahan modul.
   */
  const handleResetToUpload = useCallback(() => {
    audio.stop();
    setStage('idle');
    setDocumentText('');
    setDocumentName('');
    setDocumentId(null);
    setWarnings([]);
    setStalledInfo(null);
    setFocusInputSignal((v) => v + 1);
    announce('Kembali ke menu pemilihan modul pelajaran.', { key: 'status' });
  }, [audio, announce]);

  /* ============================================================
   * Nilai turunan & sinkronisasi kalimat
   * ============================================================ */

  const totalEstimatedMs = useMemo(
    () => audio.totalMs,
    [audio.totalMs],
  );

  const sentences = useMemo(() => {
    if (!documentText) return [];
    return splitIntoSentences(documentText);
  }, [documentText]);

  // Gulir otomatis mengikuti kalimat yang sedang dibacakan
  useEffect(() => {
    if (stage === 'ready' && activeSentenceRef.current) {
      activeSentenceRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [audio.currentIndex, stage]);

  // Pintasan keyboard global aksesibel
  useEffect(() => {
    if (stage !== 'ready' || !documentText) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (!event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.preventDefault();
        if (audio.state === 'speaking') {
          audio.pause();
        } else if (audio.state === 'paused') {
          audio.resume();
        } else if (audio.isAudioReady) {
          audio.play();
        }
      } else if (key === 'k') {
        event.preventDefault();
        audio.skipNext();
      } else if (key === 'j') {
        event.preventDefault();
        audio.skipPrevious();
      } else if (key === 'r') {
        event.preventDefault();
        audio.goToSentence(audio.currentIndex);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [stage, documentText, audio]);

  /* ============================================================
   * Render
   * ============================================================ */

  const isReadingStage = stage === 'ready' && documentText.length > 0;

  return (
    <>
      {/* Dua region live, satu-satunya jalur pengumuman. */}
      <LiveStatus
        politeMessage={politeMessage}
        assertiveMessage={assertiveMessage}
      />

      {/* ================= TAHAP 1: Unggah & Pemilihan Modul (saat belum ada dokumen aktif) ================= */}
      {!isReadingStage && (
        <div className="space-y-8">
          <UploadModule
            onFileSelected={(file) => {
              void handleFileSelected(file);
            }}
            onSelectSample={handleSelectSample}
            busy={busy}
            uploadPercent={stage === 'uploading' ? uploadPercent : null}
            errorMessage={stage === 'error' ? errorMessage : null}
            focusInputSignal={focusInputSignal}
          />

          {/* Status visual pemrosesan */}
          {busy && (
            <div aria-hidden="true" className="space-y-3">
              <StatusBanner tone="info">
                {stage === 'uploading'
                  ? 'Sedang mengunggah berkas Anda ke sistem.'
                  : 'Kecerdasan buatan sedang mengekstrak teks menjadi narasi mengalir.'}
              </StatusBanner>
              <Spinner />
            </div>
          )}

          {stage === 'extracting' && uploadPercent !== null && (
            <ProgressBar percent={uploadPercent} label="Progres ekstraksi teks" />
          )}

          {/* Riwayat bacaan */}
          <DocumentHistory
            userId={sessionUserId}
            onReplay={handleReplaySelected}
            announce={announce}
          />
        </div>
      )}

      {/* ================= TAHAP 2: Ruang Baca & Dengar Terpadu (saat dokumen aktif) ================= */}
      {isReadingStage && (
        <div className="space-y-8">
          {/* Header modul aktif + tombol ganti modul */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/70 bg-surface p-5 shadow-xs">
            <div className="space-y-1">
              <p className="text-xs font-bold uppercase tracking-wider text-accent-dark">
                Modul Sedang Dibaca
              </p>
              <h2 className="text-xl font-bold text-foreground sm:text-2xl">
                {documentName}
              </h2>
              <p className="text-sm font-medium text-muted">
                {wordCount > 0 && <span>{wordCount} kata</span>}
                {wordCount > 0 && totalEstimatedMs > 0 && <span> • </span>}
                {totalEstimatedMs > 0 && (
                  <span>estimasi waktu dengar {formatDuration(totalEstimatedMs)}</span>
                )}
              </p>
            </div>

            <button
              type="button"
              onClick={handleResetToUpload}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border-2 border-border bg-surface px-5 py-2.5 text-base font-semibold text-foreground hover:bg-subtle focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent"
              aria-label="Kembali ke pemilihan modul untuk mengunggah berkas lain"
            >
              <span>Ganti Modul</span>
            </button>
          </div>

          <StatusBanner tone="success">
            Teks berhasil diekstrak dan siap dibacakan. Gunakan pemutar di bawah atau tekan Alt+P untuk memutar.
          </StatusBanner>

          {/* Peringatan server bila ada bagian terpotong */}
          {warnings.length > 0 && (
            <section
              aria-labelledby="peringatan-heading"
              className="rounded-md border-2 border-warning bg-warning/5 p-4"
            >
              <h2 id="peringatan-heading" className="text-lg font-bold text-warning-dark">
                Catatan penting tentang dokumen ini
              </h2>
              <ul className="mt-2 list-disc space-y-2 pl-6 text-base text-warning-dark">
                {warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          {/* Pemulihan pembacaan terhenti */}
          {audio.state === 'stalled' && stalledInfo && (
            <section
              aria-labelledby="terhenti-heading"
              className="rounded-md border-2 border-danger bg-danger/5 p-4"
            >
              <h2 id="terhenti-heading" className="text-lg font-bold text-danger">
                Pembacaan terhenti di kalimat {stalledInfo.index + 1} dari{' '}
                {stalledInfo.total}
              </h2>
              <p className="mt-2 max-w-reading text-base text-danger">
                Posisi Anda tersimpan — tidak perlu mengulang dari awal. Pilih
                cara melanjutkan:
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => audio.retryCurrent()}
                  className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-6 py-3 text-base font-semibold text-white hover:bg-accent-dark"
                >
                  Ulangi kalimat ini
                </button>
                <button
                  type="button"
                  onClick={() => audio.skipNext()}
                  className="inline-flex min-h-11 items-center justify-center rounded-md border-2 border-accent bg-surface px-6 py-3 text-base font-semibold text-accent-dark hover:bg-accent/5"
                >
                  Lewati kalimat ini
                </button>
                {!audio.usingFallback ? (
                  <button
                    type="button"
                    onClick={() => audio.useFallbackVoice()}
                    className="inline-flex min-h-11 items-center justify-center rounded-md border-2 border-accent bg-surface px-6 py-3 text-base font-semibold text-accent-dark hover:bg-accent/5"
                  >
                    Pakai suara peramban
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => audio.retryMainService()}
                    className="inline-flex min-h-11 items-center justify-center rounded-md border-2 border-accent bg-surface px-6 py-3 text-base font-semibold text-accent-dark hover:bg-accent/5"
                  >
                    Coba layanan utama
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Pemutar suara utama */}
          <AudioPlayer
            playButtonRef={playButtonRef}
            state={audio.state}
            isReady={audio.isReady}
            isAudioReady={audio.isAudioReady}
            prefetchReady={audio.prefetchReady}
            prefetchNeeded={audio.prefetchNeeded}
            usingFallback={audio.usingFallback}
            currentIndex={audio.currentIndex}
            totalSentences={audio.totalSentences}
            currentSentence={audio.currentSentence}
            progressPercent={audio.progressPercent}
            bufferedPercent={audio.bufferedPercent}
            totalMs={totalEstimatedMs}
            voices={voices}
            voicesUnavailable={voicesUnavailable}
            voice={audio.voice}
            rate={audio.rate}
            onSetVoice={audio.setVoice}
            onSetRate={audio.setRate}
            onPlay={audio.play}
            onPause={audio.pause}
            onResume={audio.resume}
            onStop={audio.stop}
            onSkipNext={audio.skipNext}
            onSkipPrevious={audio.skipPrevious}
            onGoToSentence={audio.goToSentence}
            onUseFallbackVoice={useFallbackVoice}
            onRetryMainService={handleRetryMainService}
            onReloadAudio={handleReloadAudio}
          />

          {/* Tanya Dokumen (Voice/Text QA) */}
          <VoiceQA
            documentId={documentId}
            docText={documentText}
            docName={documentName || 'dokumen'}
            voice={audio.voice}
            rate={audio.rate}
            voices={voices}
            voicesUnavailable={voicesUnavailable}
            announce={announce}
            onPauseDocument={handlePauseDocument}
          />

          {/* Teks Bacaan dengan Penyorotan Kalimat Interaktif */}
          <section aria-labelledby="hasil-heading" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2
                id="hasil-heading"
                ref={resultHeadingRef}
                tabIndex={-1}
                className="text-2xl font-bold text-foreground focus-visible:outline-none"
              >
                Teks Bacaan Modul
              </h2>
              <span className="text-xs text-muted">
                Klik atau tekan Enter pada kalimat mana pun untuk langsung mendengarkannya
              </span>
            </div>

            <article
              lang="id"
              aria-label={`Isi teks dokumen ${documentName}`}
              className="max-w-reading rounded-xl border border-border/80 bg-surface p-6 text-lg leading-relaxed text-foreground shadow-xs"
            >
              <div className="space-y-2">
                {sentences.map((chunk) => {
                  const isActive = chunk.index === audio.currentIndex;
                  return (
                    <span
                      key={chunk.index}
                      ref={isActive ? activeSentenceRef : null}
                      onClick={() => audio.goToSentence(chunk.index)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          audio.goToSentence(chunk.index);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-current={isActive ? 'true' : undefined}
                      aria-label={`Kalimat ${chunk.index + 1}: ${chunk.text}. Tekan Enter untuk membacakan.`}
                      className={[
                        'inline rounded-md px-1 py-0.5 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                        isActive
                          ? 'bg-amber-100 font-semibold text-foreground ring-2 ring-accent/60 shadow-xs'
                          : 'hover:bg-subtle text-foreground/90',
                      ].join(' ')}
                    >
                      {chunk.text}{' '}
                    </span>
                  );
                })}
              </div>
            </article>
          </section>

          {/* Riwayat bacaan di bagian bawah ruang baca */}
          <DocumentHistory
            userId={sessionUserId}
            onReplay={handleReplaySelected}
            announce={announce}
          />
        </div>
      )}
    </>
  );
}

/* ============================================================
 * Unggah dengan progres
 * ============================================================ */

interface UploadOutcome {
  ok: boolean;
  message: string;
}

/**
 * Unggah berkas ke Supabase Storage.
 *
 * Supabase JS tidak menyediakan callback progres yang seragam di semua
 * versi, jadi kita melaporkan 0 dan 100 persen. Bar progres tetap
 * bermakna karena tahap ekstraksi setelahnya punya progres sintetis.
 */
async function uploadWithProgress(
  supabase: ReturnType<typeof getBrowserSupabase>,
  path: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<UploadOutcome> {
  onProgress(0);

  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
  });

  if (error) {
    return { ok: false, message: translateStorageError(error.message) };
  }

  onProgress(100);
  return { ok: true, message: '' };
}

/**
 * Ubah pesan galat Supabase menjadi kalimat yang dapat dibacakan.
 *
 * Galat mentah seperti "The resource already exists" tidak bermakna bagi
 * siswa. Setiap kasus dipetakan ke kalimat yang menjelaskan penyebab DAN
 * langkah berikutnya.
 */
function translateStorageError(raw: string): string {
  const message = raw.toLowerCase();

  if (message.includes('bucket not found')) {
    return (
      `Tempat penyimpanan berkas "${STORAGE_BUCKET}" belum dibuat. ` +
      `Hubungi pengelola aplikasi untuk menjalankan berkas supabase/schema.sql.`
    );
  }
  if (message.includes('already exists') || message.includes('duplicate')) {
    return 'Berkas dengan nama ini sudah ada. Silakan ganti nama berkas atau unggah ulang.';
  }
  if (message.includes('exceeded the maximum allowed size')) {
    return 'Berkas melebihi batas ukuran yang diizinkan. Silakan pilih berkas yang lebih kecil.';
  }
  if (message.includes('row level security') || message.includes('policy')) {
    return (
      'Akses penyimpanan ditolak oleh kebijakan keamanan. ' +
      'Hubungi pengelola aplikasi untuk memeriksa kebijakan pada bucket penyimpanan.'
    );
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return 'Koneksi ke server terputus. Periksa sambungan internet Anda lalu coba lagi.';
  }

  return `Berkas gagal diunggah. Pesan dari server: ${raw}`;
}

/* ============================================================
 * Panggilan API ekstraksi
 * ============================================================ */

async function requestExtraction(
  documentId: string | null,
  filePath: string,
): Promise<ProcessDocumentResponse> {
  const response = await fetch('/api/process-document', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(documentId ? { documentId } : { filePath }),
  });

  if (!response.ok) {
    /*
     * Server selalu mengembalikan bentuk ApiErrorBody. Bila tidak
     * (misalnya halaman HTML dari proxy yang salah), kita menanganinya
     * tanpa membocorkan HTML ke pengguna.
     */
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }

    const message =
      body?.error.message ??
      `Permintaan gagal dengan status ${response.status}. Silakan coba lagi.`;
    throw new Error(message);
  }

  return (await response.json()) as ProcessDocumentResponse;
}

/* ============================================================
 * Utilitas pesan
 * ============================================================ */

/**
 * Pastikan pengguna SELALU menerima kalimat yang utuh dan dapat
 * ditindaklanjuti. Pesan JavaScript bawaan seperti "Failed to fetch"
 * tidak memenuhi syarat itu.
 */
function toFriendlyMessage(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message;

    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return 'Tidak dapat menghubungi server. Periksa sambungan internet Anda, lalu coba lagi.';
    }
    if (/aborted|timeout/i.test(message)) {
      return 'Proses memakan waktu terlalu lama dan dihentikan. Silakan coba lagi dengan dokumen yang lebih pendek.';
    }
    // Pesan dari AppError sudah dalam bentuk final yang ramah.
    if (message.length > 0) return message;
  }

  return 'Terjadi kesalahan yang tidak terduga. Silakan coba lagi.';
}

/* ============================================================
 * Pemintal
 * ============================================================ */

function Spinner() {
  return (
    <div
      /*
       * aria-hidden karena elemen ini murni dekoratif. Informasi yang
       * dibawakannya sudah disampaikan lewat StatusBanner dan region live.
       */
      aria-hidden="true"
      className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-subtle"
    >
      <div className="h-full w-1/3 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
    </div>
  );
}
