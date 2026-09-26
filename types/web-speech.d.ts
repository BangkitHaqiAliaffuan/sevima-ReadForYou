/**
 * Deklarasi Web Speech API — AI ReadForYou
 * ========================================
 *
 * KENAPA BERKAS INI ADA:
 * `lib.dom` pada TypeScript yang dipakai proyek ini belum mendeklarasikan
 * Web Speech API sama sekali, dan Chrome/Edge hanya mengekspos konstruktor
 * prefix `webkitSpeechRecognition`. Tanpa berkas ini, `tsc` menolak
 * seluruh akses pengenalan suara. Bila `tsc` suatu hari sudah mencakup
 * semuanya (duplikat deklarasi akan error), berkas ini dapat dihapus —
 * build akan tetap lolos.
 */

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface Window {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
}
