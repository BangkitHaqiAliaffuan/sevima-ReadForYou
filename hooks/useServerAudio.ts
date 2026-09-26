'use client';

/**
 * useServerAudio — pemutar audio dengan sintesis di server
 * =========================================================
 *
 * MENGGANTIKAN `useTextToSpeech` yang memakai window.speechSynthesis.
 *
 * APA YANG BERUBAH DAN MENGAPA:
 *
 *  | Aspek        | speechSynthesis         | msedge-tts (sekarang)      |
 *  |--------------|-------------------------|----------------------------|
 *  | Kualitas     | suara sistem, robotik   | neural Microsoft, natural  |
 *  | Ketersediaan | bergantung perangkat    | konsisten di mana pun      |
 *  | Kontrol      | Pause tidak andal       | <audio>, presisi penuh     |
 *  | Biaya        | gratis, lokal          | satu permintaan per kalimat|
 *
 * MASALAH YANG HARUS DIPECAHKAN:
 *
 *  1. Satu permintaan HTTP per kalimat berarti jeda antar kalimat. Solusi:
 *     PRELOAD. Selagi kalimat ke-N diputar, kalimat ke-N+1 sudah diminta.
 *
 *  2. Permintaan HTTP dapat gagal. Bila kita hanya diam, pengguna akan
 *     menunggu tanpa kabar. Solusi: state 'loading' yang diumumkan, plus
 *     percobaan ulang satu kali.
 *
 *  3. Bila endpoint suara mati total, aplikasi tidak boleh ikut mati.
 *     Solusi: setelah dua kegagalan beruntun, beralih ke suara bawaan
 *     peramban (speechSynthesis), sehingga demo tetap dapat berjalan.
 *     Inilah kegunaan kode `useTextToSpeech` yang sudah ada: sebagai
 *     jaring pengaman, bukan sebagai jalur utama.
 *
 *  4. Objek URL untuk blob audio harus dibebaskan. Tanpa revokeObjectURL,
 *     setiap kalimat yang dibacakan membocorkan memori dan pemutaran
 *     panjang akan membuat tab melambat.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { splitIntoSentences } from '@/lib/chunk-text';
/*
 * PENTING: impor dari `@/lib/tts/estimate`, BUKAN `@/lib/tts/synthesize`.
 *
 * `synthesize.ts` mengimpor `msedge-tts`, yang memerlukan `fs`, `stream`,
 * dan WebSocket — modul Node yang tidak ada di peramban. Karena berkas
 * ini adalah komponen klien, mengimpor dari `synthesize` akan menarik
 * seluruh rantai modul server ke dalam bundle browser dan build gagal
 * dengan "Module not found: Can't resolve 'fs'".
 *
 * Kesalahan ini tidak tertangkap oleh tsc maupun eslint karena keduanya
 * hanya memeriksa tipe, bukan grafik modul. Hanya `next build` yang
 * menangkapnya.
 */
import { estimateDurationMs } from '@/lib/tts/estimate';
import type { SentenceChunk, SpeechState, TtsErrorBody } from '@/types';

export interface UseServerAudioOptions {
  onStateChange?: (state: SpeechState) => void;
  onSentenceChange?: (index: number, text: string) => void;
  onComplete?: () => void;
  onError?: (message: string) => void;
  /** Dipanggil sekali bila beralih ke suara bawaan peramban. */
  onFallbackActivated?: () => void;
}

export interface UseServerAudioResult {
  state: SpeechState;
  isReady: boolean;
  usingFallback: boolean;
  currentIndex: number;
  totalSentences: number;
  currentSentence: string;
  elapsedMs: number;
  totalMs: number;
  progressPercent: number;
  /** Persentase bagian yang audionya sudah siap diputar. */
  bufferedPercent: number;
  voice: string;
  rate: number;
  setVoice: (voice: string) => void;
  setRate: (rate: number) => void;
  load: (text: string) => void;
  play: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  goToSentence: (index: number) => void;
  skipNext: () => void;
  skipPrevious: () => void;
}

/** Jeda sebelum beralih ke suara bawaan peramban. */
const FAILURES_BEFORE_FALLBACK = 3;

/**
 * Dilempar ketika server menjawab 429. Berbeda dari galat lain: kegagalan
 * ini TIDAK boleh di-retry seketika (hanya membakar kuota), melainkan
 * menunggu sesuai header Retry-After.
 *
 * Ditaruh di tingkat modul (bukan dalam komponen) supaya pemeriksaan
 * `instanceof` tetap sah walau closure fetch dibuat pada render berbeda.
 */
class TtsRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'TtsRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Tunggu sesuai Retry-After, dibatasi agar pemutaran tidak macet lama. */
function sleepCapped(ms: number): Promise<void> {
  const capped = Math.min(Math.max(0, ms), 10_000);
  return new Promise((resolve) => setTimeout(resolve, capped));
}

export function useServerAudio(
  options: UseServerAudioOptions = {},
): UseServerAudioResult {
  const {
    onStateChange,
    onSentenceChange,
    onComplete,
    onError,
    onFallbackActivated,
  } = options;

  const [state, setState] = useState<SpeechState>('idle');
  const [chunks, setChunks] = useState<SentenceChunk[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [usingFallback, setUsingFallback] = useState(false);
  const [voice, setVoiceState] = useState('id-ID-ArdiNeural');
  const [rate, setRateState] = useState(1);
  /** Berapa banyak kalimat yang audionya sudah dimuat. */
  const [readyCount, setReadyCount] = useState(0);

  /* ---------------- Refs ---------------- */
  const chunksRef = useRef<SentenceChunk[]>([]);
  const indexRef = useRef(0);
  const stateRef = useRef<SpeechState>('idle');
  const voiceRef = useRef(voice);
  const rateRef = useRef(rate);
  const usingFallbackRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const generationRef = useRef(0);

  /** Cache audio per indeks kalimat: objectURL + status siap. */
  const audioCacheRef = useRef<Map<number, string>>(new Map());
  const pendingFetchesRef = useRef<Map<number, AbortController>>(new Map());
  /**
   * Janji fetch yang sedang berjalan per indeks. Dipakai agar dua pemanggil
   * (antrean + preload) menunggu hasil yang SAMA, bukan saling mengalahkan.
   */
  const pendingAudioRef = useRef<Map<number, Promise<string | null>>>(new Map());
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  /** Ucapan speechSynthesis untuk mode cadangan. */
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const updateState = useCallback(
    (next: SpeechState) => {
      stateRef.current = next;
      setState(next);
      onStateChange?.(next);
    },
    [onStateChange],
  );

  /* ---------------- Pembebasan memori ---------------- */

  const releaseAllAudio = useCallback(() => {
    for (const url of audioCacheRef.current.values()) {
      URL.revokeObjectURL(url);
    }
    audioCacheRef.current.clear();
    setReadyCount(0);

    for (const controller of pendingFetchesRef.current.values()) {
      controller.abort();
    }
    pendingFetchesRef.current.clear();
  }, []);

  const clearProgressTimer = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  /* ---------------- Unmount ---------------- */

  useEffect(() => {
    return () => {
      clearProgressTimer();
      releaseAllAudio();
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current.src = '';
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [clearProgressTimer, releaseAllAudio]);

  /* ============================================================
   * Jaring pengaman: suara bawaan peramban
   * ============================================================ */

  const speakWithBrowserVoice = useCallback(
    (startIndex: number) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        updateState('idle');
        onError?.(
          'Layanan suara tidak tersedia, dan peramban ini tidak mendukung pembacaan suara. ' +
            'Teks tetap dapat dibaca menggunakan pembaca layar Anda.',
        );
        return;
      }

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      window.speechSynthesis.cancel();

      const speakOne = (index: number) => {
        if (generationRef.current !== generation) return;

        const chunk = chunksRef.current[index];
        if (!chunk) {
          updateState('ended');
          onComplete?.();
          return;
        }

        indexRef.current = index;
        setCurrentIndex(index);
        onSentenceChange?.(index, chunk.text);

        const utterance = new SpeechSynthesisUtterance(chunk.text);
        utterance.lang = 'id-ID';
        utterance.rate = rateRef.current;
        utteranceRef.current = utterance;

        const voices = window.speechSynthesis.getVoices();
        const indonesian = voices.find((v) => /^id[-_]ID/i.test(v.lang));
        if (indonesian) utterance.voice = indonesian;

        utterance.onend = () => {
          if (generationRef.current !== generation) return;
          speakOne(index + 1);
        };

        utterance.onerror = (event) => {
          if (generationRef.current !== generation) return;
          const reason = (event as SpeechSynthesisErrorEvent).error;
          if (reason === 'canceled' || reason === 'interrupted') return;
          updateState('idle');
          onError?.('Pembacaan suara terhenti. Tekan Putar untuk mencoba lagi.');
        };

        window.speechSynthesis.speak(utterance);
      };

      updateState('speaking');
      speakOne(startIndex);
    },
    [onComplete, onError, onSentenceChange, updateState],
  );

  const activateFallback = useCallback(
    (reason: string) => {
      if (usingFallbackRef.current) return;
      usingFallbackRef.current = true;
      setUsingFallback(true);

      onFallbackActivated?.();
      console.warn('[useServerAudio] beralih ke suara bawaan peramban:', reason);

      // Beri tahu pengguna dengan jujur apa yang terjadi. Menyembunyikan
      // penurunan kualitas akan membuat mereka mengira suara barunya
      // memang begitu — padahal ada masalah teknis.
      onError?.(
        'Layanan suara utama sedang bermasalah. Sistem beralih memakai suara ' +
          'bawaan peramban agar pembacaan tetap berjalan. Kualitas suara mungkin berbeda.',
      );
    },
    [onError, onFallbackActivated],
  );

  /* ============================================================
   * Pengambilan audio dari server
   * ============================================================ */

  const fetchSentenceAudio = useCallback(
    async (index: number, signal: AbortSignal): Promise<string | null> => {
      const cached = audioCacheRef.current.get(index);
      if (cached) return cached;

      const chunk = chunksRef.current[index];
      if (!chunk) return null;

      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: chunk.text,
          voice: voiceRef.current,
          rate: rateRef.current,
        }),
        signal,
      });

      if (!response.ok) {
        // 429 adalah sinyal "mundur sejenak", bukan "coba lagi sekarang".
        if (response.status === 429) {
          const retryAfterSec = Number.parseInt(
            response.headers.get('Retry-After') ?? '',
            10,
          );
          const retryAfterMs = Number.isFinite(retryAfterSec)
            ? retryAfterSec * 1000
            : 5000;
          throw new TtsRateLimitedError(
            'Batas laju suara tercapai. Menunggu sebentar sebelum mencoba lagi.',
            retryAfterMs,
          );
        }

        /*
         * PENTING: server mengembalikan JSON, bukan audio, ketika gagal.
         * Kita memeriksa content-type sebelum membaca body supaya tidak
         * mencoba memutar pesan galat JSON sebagai suara.
         */
        let message = 'Layanan suara gagal memproses kalimat ini.';
        const contentType = response.headers.get('content-type') ?? '';

        if (contentType.includes('application/json')) {
          try {
            const body = (await response.json()) as TtsErrorBody;
            if (body.error?.message) message = body.error.message;
          } catch {
            /* pakai pesan bawaan */
          }
        }

        throw new Error(message);
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error('Server mengembalikan audio kosong.');
      }

      const url = URL.createObjectURL(blob);
      audioCacheRef.current.set(index, url);
      setReadyCount(audioCacheRef.current.size);
      return url;
    },
    [],
  );

  /**
   * Muat audio untuk satu indeks, dengan satu percobaan ulang.
   *
   * Satu percobaan ulang dipilih (bukan tiga) karena kegagalan pertama
   * biasanya bersifat sementara (jaringan berkedip), sedangkan kegagalan
   * beruntun menandakan layanan benar-benar mati — dan dalam kasus itu
   * kita lebih baik segera beralih ke suara bawaan daripada membuat
   * pengguna menunggu.
   *
   * Dua aturan tambahan:
   *  - Bila fetch untuk indeks ini SUDAH berjalan (mis. dari preload),
   *    tunggu hasilnya alih-alih mengembalikan null. Mengembalikan null
   *    membuat kalimat dilewati padahal audionya sedetik lagi siap.
   *  - Kegagalan 429 tidak di-retry seketika; tunggu sesuai Retry-After
   *    (dibatasi 10 detik) agar tidak membakar kuota.
   */
  const ensureAudio = useCallback(
    async (index: number): Promise<string | null> => {
      const cached = audioCacheRef.current.get(index);
      if (cached) return cached;

      const inFlight = pendingAudioRef.current.get(index);
      if (inFlight) {
        try {
          return await inFlight;
        } catch {
          return null;
        }
      }

      const controller = new AbortController();
      pendingFetchesRef.current.set(index, controller);

      const task = (async (): Promise<string | null> => {
        try {
          try {
            const url = await fetchSentenceAudio(index, controller.signal);
            consecutiveFailuresRef.current = 0;
            return url;
          } catch (firstError) {
            if (controller.signal.aborted) return null;

            if (firstError instanceof TtsRateLimitedError) {
              await sleepCapped(firstError.retryAfterMs);
              if (controller.signal.aborted) return null;
            }

            // Coba sekali lagi untuk kegagalan transien.
            const url = await fetchSentenceAudio(index, controller.signal);
            consecutiveFailuresRef.current = 0;
            return url;
          }
        } catch (retryError) {
          if (controller.signal.aborted) return null;

          consecutiveFailuresRef.current += 1;

          /*
           * Setelah beberapa kegagalan beruntun, layanan suara server
           * kemungkinan besar memang mati — bukan sekadar jaringan
           * tersendat. Pada titik itu kita beralih ke suara bawaan
           * peramban supaya pembacaan tetap berjalan.
           */
          if (consecutiveFailuresRef.current >= FAILURES_BEFORE_FALLBACK) {
            activateFallback(
              retryError instanceof Error ? retryError.message : String(retryError),
            );
          } else {
            onError?.(
              'Satu bagian teks gagal diubah menjadi suara. ' +
                'Sistem akan mencoba bagian berikutnya.',
            );
          }
          return null;
        } finally {
          pendingFetchesRef.current.delete(index);
        }
      })();

      pendingAudioRef.current.set(index, task);
      try {
        return await task;
      } finally {
        pendingAudioRef.current.delete(index);
      }
    },
    [activateFallback, fetchSentenceAudio, onError],
  );

  /* ============================================================
   * Preload
   * ============================================================ */

  /** Berapa kalimat ke depan yang dimuat lebih awal. */
  const PRELOAD_AHEAD = 2;

  const preloadAhead = useCallback(
    (fromIndex: number) => {
      if (usingFallbackRef.current) return;
      for (let offset = 1; offset <= PRELOAD_AHEAD; offset += 1) {
        const target = fromIndex + offset;
        if (target >= chunksRef.current.length) break;
        void ensureAudio(target);
      }
    },
    [ensureAudio],
  );

  /* ============================================================
   * Pemutaran
   * ============================================================
   *
   * CATATAN PERBAIKAN (temuan eslint react-hooks):
   *
   * Versi pertama membuat `playFromIndex` memanggil dirinya sendiri
   * secara langsung untuk melanjutkan ke kalimat berikutnya. Itu memicu
   * dua keluhan yang sah:
   *
   *  1. "Cannot access variable before it is declared" — fungsi yang
   *     memanggil dirinya sendiri di dalam useCallback tidak dapat
   *     diselesaikan referensinya.
   *  2. "This value cannot be modified" — menulis `audioElementRef.current`
   *     di dalam callback yang sekaligus menjadi dependency effect
   *     melanggar aturan imutabilitas React 19.
   *
   * Perbaikannya: pemutaran SATU kalimat dipisahkan ke `playSingle`, dan
   * pengantrean ditangani oleh `advance` yang didefinisikan sesudahnya.
   * Elemen audio juga dipusatkan lewat satu helper `getAudioElement`.
   */

  /** Ambil (atau buat) elemen audio tunggal yang dipakai ulang. */
  const getAudioElement = useCallback((): HTMLAudioElement => {
    const existing = audioElementRef.current;
    if (existing) return existing;
    const created = new Audio();
    created.preload = 'auto';
    audioElementRef.current = created;
    return created;
  }, []);

  /**
   * Putar satu kalimat. Tidak pernah memanggil dirinya sendiri dan tidak
   * pernah menaikkan generasi — generasi dimiliki oleh `runQueue` (satu
   * generasi per invokasi antrean). Tugas fungsi ini hanya MEMVERIFIKASI
   * bahwa generasinya masih berlaku di setiap titik await.
   *
   * Mengembalikan 'played' bila audio mulai berbunyi, 'failed' bila
   * kalimat ini tidak dapat diputar sehingga pemanggil perlu melanjutkan,
   * atau 'superseded' bila antrean ini sudah digantikan antrean baru.
   */
  const playSingle = useCallback(
    async (
      index: number,
      generation: number,
    ): Promise<'played' | 'failed' | 'superseded'> => {
      const list = chunksRef.current;
      const chunk = list[index];
      if (!chunk) return 'failed';

      // Antrean ini sudah digantikan sebelum mulai (Stop/muat baru/lompat).
      if (generationRef.current !== generation) return 'superseded';

      indexRef.current = index;
      setCurrentIndex(index);
      onSentenceChange?.(index, chunk.text);
      updateState('loading');

      const url = await ensureAudio(index);

      // Pengguna mungkin menekan Hentikan selagi kita menunggu.
      if (generationRef.current !== generation) return 'superseded';

      if (!url) return 'failed';

      const audio = getAudioElement();
      audio.src = url;

      const finished = new Promise<'ended' | 'error'>((resolve) => {
        audio.onended = () => resolve('ended');
        audio.onerror = () => resolve('error');
      });

      try {
        await audio.play();
      } catch {
        /*
         * Kegagalan `play()` biasanya karena kebijakan autoplay. Karena
         * pemutaran selalu berawal dari tombol (interaksi pengguna),
         * kasus ini jarang — tetapi tetap harus ditangani dengan pesan
         * yang memberi tahu langkah berikutnya.
         */
        if (generationRef.current === generation) {
          updateState('idle');
          onError?.(
            'Peramban menahan pemutaran otomatis. Tekan tombol Putar sekali lagi.',
          );
        }
        return 'failed';
      }

      if (generationRef.current !== generation) {
        audio.pause();
        return 'superseded';
      }

      updateState('speaking');
      // Muat kalimat berikutnya selagi yang ini diputar. Inilah yang
      // menghilangkan jeda antar kalimat.
      preloadAhead(index);

      const outcome = await finished;

      if (generationRef.current !== generation) return 'superseded';

      if (outcome === 'error') {
        onError?.(
          'Audio kalimat ini tidak dapat diputar. Melanjutkan ke bagian berikutnya.',
        );
        return 'failed';
      }

      return 'played';
    },
    [ensureAudio, getAudioElement, onError, onSentenceChange, preloadAhead, updateState],
  );

  /**
   * Jalankan antrean dari indeks tertentu sampai selesai.
   *
   * Menggunakan `while` alih-alih rekursi: lebih jelas dibaca, tidak
   * menumpuk stack pada dokumen dengan ratusan kalimat, dan tidak
   * memicu keluhan "access before declaration" dari eslint.
   *
   * KEPEMILIKAN GENERASI: satu invokasi antrean = satu generasi, dinaikkan
   * di sini, di awal. `playSingle` hanya memverifikasi — ia tidak boleh
   * menaikkan sendiri, karena itu membuat pemeriksaan di bawah selalu
   * gagal dan antrean mati setelah satu kalimat (bug yang pernah terjadi).
   */
  const runQueue = useCallback(
    async (startIndex: number) => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;

      let index = startIndex;

      while (index < chunksRef.current.length) {
        if (usingFallbackRef.current) {
          speakWithBrowserVoice(index);
          return;
        }

        const outcome = await playSingle(index, generation);

        if (outcome === 'superseded') return;

        // Berhenti bila antrean lain (Stop/muat baru/lompat/putar ulang)
        // telah mengambil alih di tengah jalan.
        if (generationRef.current !== generation) return;

        if (outcome === 'failed') {
          // Beralih ke mode cadangan bila kegagalan sudah menumpuk.
          if (usingFallbackRef.current) {
            speakWithBrowserVoice(index);
            return;
          }
          // Satu kalimat gagal tidak boleh menghentikan seluruh bacaan.
          index += 1;
          continue;
        }

        index += 1;
      }

      updateState('ended');
      onComplete?.();
    },
    [
      onComplete,
      playSingle,
      speakWithBrowserVoice,
      updateState,
    ],
  );

  /* ============================================================
   * Penghitung progres
   * ============================================================ */

  useEffect(() => {
    if (state !== 'speaking' && state !== 'loading') {
      clearProgressTimer();
      return;
    }

    const startedAt = Date.now();
    const offsetMs = chunks
      .slice(0, currentIndex)
      .reduce((sum, chunk) => sum + chunk.estimatedMs, 0);

    progressTimerRef.current = setInterval(() => {
      const estimate = offsetMs + (Date.now() - startedAt) * 1.25;
      setElapsedMs(Math.min(estimate, totalMs));
    }, 500);

    return clearProgressTimer;
  }, [state, currentIndex, chunks, totalMs, clearProgressTimer]);

  /* ============================================================
   * Kontrol publik
   * ============================================================ */

  const load = useCallback(
    (text: string) => {
      clearProgressTimer();
      generationRef.current += 1;
      releaseAllAudio();

      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current.src = '';
      }

      const parsed = splitIntoSentences(text);
      chunksRef.current = parsed;
      indexRef.current = 0;
      consecutiveFailuresRef.current = 0;

      setChunks(parsed);
      setCurrentIndex(0);
      setElapsedMs(0);
      setTotalMs(
        parsed.reduce(
          (sum, chunk) => sum + (chunk.estimatedMs || estimateDurationMs(chunk.text)),
          0,
        ),
      );
      updateState('idle');
    },
    [clearProgressTimer, releaseAllAudio, updateState],
  );

  const play = useCallback(() => {
    if (chunksRef.current.length === 0) return;
    const current = stateRef.current;
    // Abaikan penekanan ganda: antrean sudah berjalan. Tanpa pengaman ini,
    // klik kedua melahirkan antrean tandingan yang saling membatalkan
    // dengan antrean pertama hingga tidak ada bunyi sama sekali.
    if (current === 'speaking' || current === 'loading') return;
    const startAt = current === 'paused' || current === 'ended' ? indexRef.current : 0;
    void runQueue(current === 'ended' ? 0 : startAt);
  }, [runQueue]);

  const pause = useCallback(() => {
    if (stateRef.current !== 'speaking' && stateRef.current !== 'loading') return;

    if (usingFallbackRef.current) {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        generationRef.current += 1;
        window.speechSynthesis.cancel();
      }
    } else {
      // Batalkan antrean yang mungkin sedang menunggu fetch: tanpa ini,
      // audio tetap mulai berbunyi setelah jeda bila tepat jeda ditekan
      // saat status masih 'loading'.
      generationRef.current += 1;
      audioElementRef.current?.pause();
    }

    clearProgressTimer();
    updateState('paused');
  }, [clearProgressTimer, updateState]);

  const resume = useCallback(() => {
    if (stateRef.current !== 'paused') return;

    if (usingFallbackRef.current) {
      speakWithBrowserVoice(indexRef.current);
      return;
    }

    // Melanjutkan dari awal kalimat terasa lebih natural daripada
    // menyambung di tengah kata, dan menghindari kesan terpotong.
    void runQueue(indexRef.current);
  }, [runQueue, speakWithBrowserVoice]);

  const stop = useCallback(() => {
    generationRef.current += 1;
    clearProgressTimer();

    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.currentTime = 0;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    indexRef.current = 0;
    setCurrentIndex(0);
    setElapsedMs(0);
    updateState('idle');
  }, [clearProgressTimer, updateState]);

  const goToSentence = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, chunksRef.current.length - 1));
      indexRef.current = clamped;
      setCurrentIndex(clamped);

      if (
        stateRef.current === 'speaking' ||
        stateRef.current === 'paused' ||
        stateRef.current === 'loading'
      ) {
        void runQueue(clamped);
      }
    },
    [runQueue],
  );

  const skipNext = useCallback(() => {
    goToSentence(indexRef.current + 1);
  }, [goToSentence]);

  const skipPrevious = useCallback(() => {
    goToSentence(indexRef.current - 1);
  }, [goToSentence]);

  const setVoice = useCallback(
    (next: string) => {
      voiceRef.current = next;
      setVoiceState(next);
      // Audio lama memakai suara berbeda; buang agar tidak diputar ulang
      // dengan suara yang salah.
      releaseAllAudio();
    },
    [releaseAllAudio],
  );

  const setRate = useCallback((next: number) => {
    const clamped = Math.max(0.5, Math.min(2, next));
    rateRef.current = clamped;
    setRateState(clamped);
  }, []);

  /* ============================================================
   * Nilai turunan
   * ============================================================ */

  const currentSentence = useMemo(
    () => chunks[currentIndex]?.text ?? '',
    [chunks, currentIndex],
  );

  const progressPercent = useMemo(() => {
    if (totalMs <= 0) return 0;
    return Math.min(100, Math.round((elapsedMs / totalMs) * 100));
  }, [elapsedMs, totalMs]);

  const bufferedPercent = useMemo(() => {
    if (chunks.length === 0) return 0;
    return Math.min(100, Math.round((readyCount / chunks.length) * 100));
  }, [readyCount, chunks.length]);

  return {
    state,
    isReady: chunks.length > 0,
    usingFallback,
    currentIndex,
    totalSentences: chunks.length,
    currentSentence,
    elapsedMs,
    totalMs,
    progressPercent,
    bufferedPercent,
    voice,
    rate,
    setVoice,
    setRate,
    load,
    play,
    pause,
    resume,
    stop,
    goToSentence,
    skipNext,
    skipPrevious,
  };
}
