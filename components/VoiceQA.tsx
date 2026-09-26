'use client';

/**
 * VoiceQA — tanya-jawab suara atas dokumen yang sudah diekstrak
 * =============================================================
 *
 * ALUR (disepakati):
 *  1. Pengguna menekan mic (atau mengetik) → bacaan dokumen DIJEDA dulu
 *     (posisi tersimpan) + jawaban lama dihentikan.
 *  2. Ucapan diubah jadi teks (Web Speech API) atau diambil dari kolom
 *     ketikan → dikirim ke /api/ask.
 *  3. Jawaban ringkas dimuat ke pemutar KHUSUS jawaban (instans
 *     useServerAudio kedua) sehingga posisi bacaan dokumen utuh.
 *  4. Selesai menjawab: bacaan TETAP jeda — pengguna menekan Putar bila
 *     mau lanjut. Terprediksi bagi screen reader.
 *
 * AKSESIBILITAS:
 *  - Kolom ketikan SELALU ada (pengguna tuna rungu/wicara atau browser
 *    tanpa STT tidak terkunci).
 *  - Transkrip interim hanya visual (aria-hidden) agar tidak membanjiri
 *    screen reader; yang diumumkan hanya awal/akhir dengar + hasil.
 *  - Transkrip final masuk ke kolom yang bisa disunting sebelum dikirim.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { AudioPlayer } from '@/components/AudioPlayer';
import { StatusBanner } from '@/components/LiveStatus';
import { useServerAudio } from '@/hooks/useServerAudio';
import { useSpeechInput } from '@/hooks/useSpeechInput';
import type { UseAnnouncerResult } from '@/hooks/useAnnouncer';
import type {
  ApiErrorBody,
  AskResponse,
  SpeechState,
  VoiceOption,
} from '@/types';

export interface VoiceQaProps {
  /** ID dokumen untuk /api/ask; null bila bacaan dari riwayat. */
  documentId: string | null;
  /** Teks dokumen (fallback bila tanpa id). */
  docText: string;
  docName: string;
  /** Suara/tempo awal jawaban — disamakan dengan pemutar bacaan. */
  voice: string;
  rate: number;
  voices: VoiceOption[];
  voicesUnavailable: boolean;
  announce: UseAnnouncerResult['announce'];
  /** Dijalankan saat sesi tanya dimulai: jeda bacaan dokumen. */
  onPauseDocument: () => void;
}

export function VoiceQA(props: VoiceQaProps) {
  const {
    documentId,
    docText,
    docName,
    voice,
    rate,
    voices,
    voicesUnavailable,
    announce,
    onPauseDocument,
  } = props;

  const headingId = useId();
  const inputId = useId();
  const errorId = useId();

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState('');
  const [qaError, setQaError] = useState<string | null>(null);
  /** Mencegah kirim ganda (klik cepat / final ganda). */
  const askingRef = useRef(false);

  /* ============================================================
   * Pemutar khusus jawaban (instans kedua — posisi bacaan aman)
   * ============================================================ */

  const handleAnswerState = useCallback(
    (state: SpeechState) => {
      if (state === 'speaking') {
        announce('Membacakan jawaban.', { key: 'qa-audio' });
      } else if (state === 'paused') {
        announce('Jawaban dijeda.', { key: 'qa-audio' });
      }
    },
    [announce],
  );

  const handleAnswerComplete = useCallback(() => {
    announce(
      'Jawaban selesai. Tekan Putar pada bacaan untuk melanjutkan.',
      { key: 'qa' },
    );
  }, [announce]);

  const handleAnswerError = useCallback(
    (message: string) => {
      setQaError(message);
      announce(message, { priority: 'assertive', key: 'qa-error' });
    },
    [announce],
  );

  const handleAnswerFallback = useCallback(() => {
    announce(
      'Layanan suara utama bermasalah. Jawaban dibacakan dengan suara bawaan peramban.',
      { priority: 'assertive', key: 'qa-fallback' },
    );
  }, [announce]);

  const answerAudio = useServerAudio({
    initialVoice: voice,
    initialRate: rate,
    onStateChange: handleAnswerState,
    onComplete: handleAnswerComplete,
    onError: handleAnswerError,
    onFallbackActivated: handleAnswerFallback,
  });

  const {
    load: loadAnswer,
    play: playAnswer,
    stop: stopAnswer,
    retryMainService: retryAnswerMain,
  } = answerAudio;

  const handleRetryAnswerMain = useCallback(() => {
    announce('Mencoba layanan suara utama untuk jawaban.', {
      key: 'qa-service',
    });
    retryAnswerMain();
  }, [announce, retryAnswerMain]);

  /* ============================================================
   * Kirim pertanyaan
   * ============================================================ */

  const submitQuestion = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (q.length === 0 || askingRef.current) return;
      askingRef.current = true;

      setAsking(true);
      setQaError(null);
      onPauseDocument();
      stopAnswer();

      announce('Mencari jawaban dalam dokumen.', { key: 'qa' });

      try {
        const response = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            documentId
              ? { documentId, question: q }
              : { text: docText, docName, question: q },
          ),
        });

        if (!response.ok) {
          let body: ApiErrorBody | null = null;
          try {
            body = (await response.json()) as ApiErrorBody;
          } catch {
            body = null;
          }
          throw new Error(
            body?.error.message ??
              `Permintaan gagal dengan status ${response.status}. Silakan coba lagi.`,
          );
        }

        const data = (await response.json()) as AskResponse;
        setAnswer(data.answer);
        loadAnswer(data.answer);
        // Langsung putar: antrean mengambil audio saat siap (prefetch
        // gate hanya memblokir tombol di UI, bukan pemutaran terprogram).
        playAnswer();
        announce('Jawaban diterima, membacakan.', { key: 'qa' });
      } catch (err) {
        const message =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Terjadi kesalahan yang tidak terduga. Silakan coba lagi.';
        // Kegagalan jaringan mentah diterjemahkan agar bisa ditindaklanjuti.
        const friendly = /failed to fetch|networkerror|load failed/i.test(message)
          ? 'Tidak dapat menghubungi server. Periksa sambungan internet Anda, lalu coba lagi.'
          : message;
        setQaError(friendly);
        announce(friendly, { priority: 'assertive', key: 'qa-error' });
      } finally {
        askingRef.current = false;
        setAsking(false);
      }
    },
    [
      announce,
      docName,
      docText,
      documentId,
      loadAnswer,
      onPauseDocument,
      playAnswer,
      stopAnswer,
    ],
  );

  const submitRef = useRef(submitQuestion);
  useEffect(() => {
    submitRef.current = submitQuestion;
  });

  /* ============================================================
   * Masukan suara
   * ============================================================ */

  const speech = useSpeechInput({
    onFinalText: useCallback((text: string) => {
      setQuestion(text);
      void submitRef.current(text);
    }, []),
  });

  /* Umumkan awal sesi dengar (akhir ditangani saat hasil tiba). */
  const wasListening = useRef(false);
  useEffect(() => {
    if (speech.listening && !wasListening.current) {
      announce('Mendengarkan. Silakan bicara sekarang.', { key: 'qa-listen' });
    }
    wasListening.current = speech.listening;
  }, [speech.listening, announce]);

  const handleMicClick = useCallback(() => {
    if (askingRef.current) return;
    onPauseDocument();
    stopAnswer();
    if (speech.listening) {
      speech.stop();
      return;
    }
    speech.start();
  }, [onPauseDocument, speech, stopAnswer]);

  const micBusy = asking;
  const shownError = qaError ?? speech.errorMessage;

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 id={headingId} className="text-2xl font-bold text-foreground">
        Tanya dokumen ini
      </h2>

      <p className="max-w-reading text-base text-muted">
        Ajukan pertanyaan dengan suara atau ketikan. Bacaan akan dijeda
        otomatis, dan kecerdasan buatan menjawab berdasarkan isi dokumen
        ini saja.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        {speech.supported && (
          <button
            type="button"
            onClick={handleMicClick}
            aria-disabled={micBusy}
            aria-label={
              speech.listening
                ? 'Berhenti mendengarkan'
                : 'Tanya dengan suara (menjeda bacaan)'
            }
            className={[
              'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md px-6 py-3 text-base font-semibold',
              'bg-accent text-white hover:bg-accent-dark',
              micBusy ? 'cursor-not-allowed opacity-60' : '',
            ].join(' ')}
          >
            <MicIcon />
            <span>{speech.listening ? 'Berhenti' : 'Tanya dengan suara'}</span>
          </button>
        )}

        <div className="min-w-0 flex-1 basis-64">
          <label
            htmlFor={inputId}
            className="block text-base font-medium text-foreground"
          >
            Pertanyaan Anda
          </label>
          <input
            id={inputId}
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitQuestion(question);
            }}
            placeholder="Contoh: apa inti bab ini?"
            aria-describedby={shownError ? errorId : undefined}
            aria-invalid={shownError ? true : undefined}
            className="mt-2 min-h-11 w-full rounded-md border-2 border-border bg-surface px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent"
          />
        </div>

        <button
          type="button"
          onClick={() => {
            if (!micBusy) void submitQuestion(question);
          }}
          aria-disabled={micBusy || question.trim().length === 0}
          aria-label="Kirim pertanyaan"
          className={[
            'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border-2 border-accent bg-surface px-6 py-3 text-base font-semibold text-accent-dark hover:bg-accent/5',
            micBusy || question.trim().length === 0
              ? 'cursor-not-allowed opacity-60'
              : '',
          ].join(' ')}
        >
          Kirim
        </button>
      </div>

      {speech.listening && (
        <p aria-hidden="true" className="text-base font-medium text-accent-dark">
          Mendengarkan…{speech.interimText ? ` "${speech.interimText}"` : ''}
        </p>
      )}

      {asking && (
        <div aria-hidden="true" className="space-y-3">
          <StatusBanner tone="info">
            Mencari jawaban dalam dokumen.
          </StatusBanner>
        </div>
      )}

      {shownError && (
        <p
          id={errorId}
          className="max-w-reading rounded-md border-2 border-danger bg-danger/5 px-4 py-3 text-base font-medium text-danger"
        >
          {shownError}
        </p>
      )}

      {answer && (
        <div className="space-y-4">
          <article
            lang="id"
            aria-label="Jawaban atas pertanyaan Anda"
            className="max-w-reading rounded-md border border-border bg-surface p-5 text-lg leading-relaxed whitespace-pre-wrap text-foreground"
          >
            {answer}
          </article>
          <AudioPlayer
            title="Suara jawaban"
            state={answerAudio.state}
            isReady={answerAudio.isReady}
            isAudioReady={answerAudio.isAudioReady}
            prefetchReady={answerAudio.prefetchReady}
            prefetchNeeded={answerAudio.prefetchNeeded}
            usingFallback={answerAudio.usingFallback}
            currentIndex={answerAudio.currentIndex}
            totalSentences={answerAudio.totalSentences}
            currentSentence={answerAudio.currentSentence}
            progressPercent={answerAudio.progressPercent}
            bufferedPercent={answerAudio.bufferedPercent}
            totalMs={answerAudio.totalMs}
            voices={voices}
            voicesUnavailable={voicesUnavailable}
            voice={answerAudio.voice}
            rate={answerAudio.rate}
            onSetVoice={answerAudio.setVoice}
            onSetRate={answerAudio.setRate}
            onPlay={answerAudio.play}
            onPause={answerAudio.pause}
            onResume={answerAudio.resume}
            onStop={answerAudio.stop}
            onSkipNext={answerAudio.skipNext}
            onSkipPrevious={answerAudio.skipPrevious}
            onGoToSentence={answerAudio.goToSentence}
            onUseFallbackVoice={answerAudio.useFallbackVoice}
            onRetryMainService={handleRetryAnswerMain}
            onReloadAudio={answerAudio.reloadCurrentAudio}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Ikon mikrofon dekoratif — disembunyikan dari aksesibilitas, nama
 * tombol berasal dari aria-label.
 */
function MicIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}
