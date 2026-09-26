'use client';

/**
 * useSpeechInput — masukan suara via Web Speech API
 * ==================================================
 *
 * KENAPA WEB SPEECH API (bukan rekam-kirim-server):
 *  - Gratis, instan, tanpa kunci API — cocok untuk MVP.
 *  - Browser yang didukung (Chrome/Edge) mencakup mayoritas pengguna.
 *  - Firefox/Safari yang belum mendukung tetap dapat memakai kolom
 *    ketikan — komponen wajib menyediakan jalur itu (lihat VoiceQA).
 *
 * KETERBATASAN YANG DISADARI:
 *  - Perlu koneksi internet (pengenalan di server vendor peramban).
 *  - Perlu konteks aman (https atau localhost) untuk izin mikrofon.
 *  - Hasil final dikirim sekali per sesi dengar; pengguna dapat
 *    menyuntingnya sebelum dikirim sebagai pertanyaan.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseSpeechInputOptions {
  /** Dipanggil sekali per sesi dengar dengan transkrip final. */
  onFinalText?: (text: string) => void;
}

export interface UseSpeechInputResult {
  /** False di browser tanpa dukungan (Firefox/Safari). */
  supported: boolean;
  listening: boolean;
  /** Transkrip sementara untuk umpan balik visual. */
  interimText: string;
  /** Pesan siap-dengar; null bila tidak ada galat. */
  errorMessage: string | null;
  start: () => void;
  stop: () => void;
}

export function useSpeechInput(
  options: UseSpeechInputOptions = {},
): UseSpeechInputResult {
  const { onFinalText } = options;

  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const onFinalTextRef = useRef(options.onFinalText);
  const finalTextRef = useRef('');

  useEffect(() => {
    onFinalTextRef.current = onFinalText;
  });

  const supported =
    typeof window !== 'undefined' &&
    (typeof window.SpeechRecognition === 'function' ||
      typeof window.webkitSpeechRecognition === 'function');

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  /* Bersihkan pengenalan saat komponen dilepas. */
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* abaikan */
      }
      recognitionRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    if (typeof window === 'undefined') return;
    const Recognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setErrorMessage(
        'Peramban ini belum mendukung masukan suara. Silakan ketik pertanyaan Anda pada kolom yang tersedia.',
      );
      return;
    }

    // Hentikan sesi lama bila ada (mis. tombol ditekan dua kali).
    try {
      recognitionRef.current?.abort();
    } catch {
      /* abaikan */
    }

    setErrorMessage(null);
    setInterimText('');
    finalTextRef.current = '';

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = 'id-ID';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          final += text;
        } else {
          interim += text;
        }
      }
      if (interim) setInterimText(interim);
      if (final) finalTextRef.current += final;
    };

    recognition.onerror = (event: Event) => {
      const code = (event as SpeechRecognitionErrorEvent).error ?? '';
      // 'aborted' berarti dihentikan sengaja (stop/unmount) — bukan galat.
      if (code === 'aborted') return;
      setListening(false);
      setErrorMessage(translateRecognitionError(code));
    };

    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      const text = finalTextRef.current.trim();
      if (text.length > 0) {
        onFinalTextRef.current?.(text);
      }
    };

    try {
      recognition.start();
      setListening(true);
    } catch {
      setErrorMessage(
        'Mikrofon tidak dapat dinyalakan. Silakan ketik pertanyaan Anda pada kolom yang tersedia.',
      );
    }
  }, []);

  return { supported, listening, interimText, errorMessage, start, stop };
}

/**
 * Ubah kode galat teknis menjadi kalimat yang dapat ditindaklanjuti.
 * Setiap kasus menunjuk ke jalan keluar (kolom ketikan) karena pengguna
 * tidak boleh buntu hanya karena mikrofon bermasalah.
 */
function translateRecognitionError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return (
        'Akses mikrofon ditolak. Izinkan akses mikrofon pada pengaturan ' +
        'peramban, atau ketik pertanyaan Anda pada kolom yang tersedia.'
      );
    case 'no-speech':
      return (
        'Tidak terdengar suara. Dekatkan mikrofon lalu coba lagi, ' +
        'atau ketik pertanyaan Anda.'
      );
    case 'network':
      return (
        'Pengenalan suara memerlukan internet. Periksa sambungan Anda, ' +
        'atau ketik pertanyaan Anda.'
      );
    case 'audio-capture':
      return (
        'Mikrofon tidak ditemukan. Periksa perangkat Anda, ' +
        'atau ketik pertanyaan Anda.'
      );
    default:
      return (
        'Masukan suara gagal. Silakan coba lagi, ' +
        'atau ketik pertanyaan Anda pada kolom yang tersedia.'
      );
  }
}
