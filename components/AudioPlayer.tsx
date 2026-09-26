'use client';

/**
 * AudioPlayer — pemutar suara dengan kontrol keyboard penuh.
 *
 * KEPUTUSAN AKSESIBILITAS (beserta alasan):
 *
 * 1. Setiap kontrol adalah <button> asli. Ini memberi fokus keyboard,
 *    aktivasi dengan Enter dan Spasi, serta peran yang benar bagi screen
 *    reader tanpa perlu `role`/`tabIndex`/`onKeyDown` buatan.
 *
 * 2. Setiap tombol ikon memiliki teks tersembunyi (`sr-only`) DAN
 *    `aria-label`. Kombinasi keduanya membuat tombol tetap dapat dikenali
 *    bila CSS gagal dimuat, dan memudahkan pengujian otomatis.
 *
 * 3. Tombol pembacaan TIDAK memakai atribut `disabled`, melainkan
 *    `aria-disabled`. Lihat penjelasan pada PlayerButton di bawah —
 *    ini perbedaan yang menentukan bagi pengguna keyboard.
 *
 * 4. Ada dua indikator berbeda yang sengaja dipisahkan:
 *      - "Tersedia" (buffered): berapa banyak yang audionya siap.
 *      - "Terbaca" (progress): posisi pemutaran saat ini.
 *    Menggabungkannya akan membuat pengguna mengira pemutaran tersendat,
 *    padahal sistem hanya sedang menyiapkan bagian berikutnya.
 */

import { useId, useState } from 'react';

import { formatDuration } from '@/lib/chunk-text';
import type { SpeechState, VoiceOption } from '@/types';

export interface AudioPlayerProps {
  state: SpeechState;
  isReady: boolean;
  usingFallback: boolean;
  currentIndex: number;
  totalSentences: number;
  currentSentence: string;
  progressPercent: number;
  bufferedPercent: number;
  /** False saat audio awal masih disiapkan — tombol Putar diblokir. */
  isAudioReady: boolean;
  prefetchReady: number;
  prefetchNeeded: number;
  totalMs: number;
  voices: VoiceOption[];
  voicesUnavailable: boolean;
  voice: string;
  rate: number;
  onSetVoice: (voice: string) => void;
  onSetRate: (rate: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSkipNext: () => void;
  onSkipPrevious: () => void;
  onGoToSentence: (index: number) => void;
}

export function AudioPlayer(props: AudioPlayerProps) {
  const {
    state,
    isReady,
    usingFallback,
    currentIndex,
    totalSentences,
    currentSentence,
    progressPercent,
    bufferedPercent,
    isAudioReady,
    prefetchReady,
    prefetchNeeded,
    totalMs,
    voices,
    voicesUnavailable,
    voice,
    rate,
    onSetVoice,
    onSetRate,
    onPlay,
    onPause,
    onResume,
    onStop,
    onSkipNext,
    onSkipPrevious,
    onGoToSentence,
  } = props;

  const headingId = useId();
  const positionId = useId();

  /*
   * Pratinjau posisi slider saat diseret. Nilai hanya di-commit ke pemutar
   * saat seretan dilepas (pointer up / key up), bukan pada setiap tick —
   * setiap commit memicu antrean + fetch TTS baru, dan drag 3 detik tanpa
   * komit-on-release dapat membakar puluhan request dari kuota 120/menit.
   */
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const displayPosition = seekPreview ?? currentIndex + 1;
  const commitSeek = () => {
    if (seekPreview !== null) {
      onGoToSentence(seekPreview - 1);
      setSeekPreview(null);
    }
  };

  const isSpeaking = state === 'speaking';
  const isPaused = state === 'paused';
  const isLoading = state === 'loading';
  /** Teks ada tapi audio awal belum cukup — Putar diblokir sementara. */
  const preparingAudio = isReady && !isAudioReady;

  const notReady = !isReady;

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <h2 id={headingId} className="text-2xl font-bold text-foreground">
        Pemutar suara
      </h2>

      {/*
        Bila layanan suara utama gagal, beri tahu pengguna secara terus
        terang. Menyembunyikan penurunan kualitas akan membuat mereka
        mengira suara yang berbeda itu memang disengaja.
      */}
      {usingFallback && (
        <p className="max-w-reading rounded-md border-2 border-warning bg-warning/5 px-4 py-3 text-base font-medium text-warning-dark">
          Layanan suara utama sedang bermasalah. Sistem memakai suara bawaan
          peramban agar pembacaan tetap dapat berjalan.
        </p>
      )}

      {/* ---------- Informasi posisi ---------- */}
      <p id={positionId} className="text-base text-muted">
        {isReady ? (
          <>
            <span className="font-semibold text-foreground">
              Kalimat {currentIndex + 1} dari {totalSentences}
            </span>
            {' — '}
            perkiraan total waktu {formatDuration(totalMs)}.
          </>
        ) : (
          'Belum ada teks yang dimuat.'
        )}
      </p>

      {/* ---------- Kontrol utama ---------- */}
      <div
        role="group"
        aria-label="Kontrol pembacaan"
        aria-describedby={positionId}
        className="flex flex-wrap items-center gap-3"
      >
        <PlayerButton
          onClick={onPlay}
          ariaDisabled={notReady || !isAudioReady || isSpeaking || isLoading}
          label={
            preparingAudio
              ? `Menyiapkan audio, ${prefetchReady} dari ${prefetchNeeded} kalimat siap`
              : 'Putar pembacaan dari awal'
          }
        >
          <PlayIcon />
          <span className="sr-only">Putar</span>
        </PlayerButton>

        <PlayerButton
          onClick={isPaused ? onResume : onPause}
          ariaDisabled={notReady || (!isSpeaking && !isPaused && !isLoading)}
          label={
            isPaused
              ? 'Lanjutkan pembacaan dari kalimat terakhir'
              : 'Jeda pembacaan'
          }
        >
          {isPaused ? <PlayIcon /> : <PauseIcon />}
          <span className="sr-only">{isPaused ? 'Lanjutkan' : 'Jeda'}</span>
        </PlayerButton>

        <PlayerButton
          onClick={onSkipPrevious}
          ariaDisabled={notReady || currentIndex <= 0}
          label="Baca kalimat sebelumnya"
        >
          <SkipBackIcon />
          <span className="sr-only">Kalimat sebelumnya</span>
        </PlayerButton>

        <PlayerButton
          onClick={onSkipNext}
          ariaDisabled={notReady || currentIndex >= totalSentences - 1}
          label="Baca kalimat berikutnya"
        >
          <SkipForwardIcon />
          <span className="sr-only">Kalimat berikutnya</span>
        </PlayerButton>

        <PlayerButton
          onClick={onStop}
          ariaDisabled={notReady || state === 'idle' || state === 'ended'}
          label="Hentikan pembacaan dan kembali ke awal"
          variant="danger"
        >
          <StopIcon />
          <span className="sr-only">Hentikan</span>
        </PlayerButton>
      </div>

      {/* ---------- Status penyiapan audio ---------- */}
      {preparingAudio && (
        <p className="max-w-reading rounded-md border-2 border-border bg-surface px-4 py-3 text-base font-medium text-muted">
          Menyiapkan audio: {prefetchReady} dari {prefetchNeeded} kalimat
          siap. Tombol Putar akan aktif setelah audio siap.
        </p>
      )}

      {/* ---------- Indikator ---------- */}
      {isReady && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div
              role="progressbar"
              aria-label="Progres pembacaan teks"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={`${progressPercent} persen`}
              className="h-4 w-full overflow-hidden rounded-full border border-border bg-subtle"
            >
              <div
                className="h-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p aria-hidden="true" className="text-sm font-medium text-muted">
              {progressPercent} persen terbaca
            </p>
          </div>

          {/*
            Indikator kesiapan audio. Ditampilkan terpisah dari progres
            pembacaan supaya pengguna paham bahwa bagian berikutnya
            sedang disiapkan, bukan macet.
          */}
          {!usingFallback && (
            <div className="space-y-2">
              <div
                role="progressbar"
                aria-label="Kesiapan audio yang sudah dihasilkan"
                aria-valuenow={bufferedPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={`${bufferedPercent} persen audio siap`}
                className="h-2 w-full overflow-hidden rounded-full border border-border bg-subtle"
              >
                <div
                  className="h-full bg-accent transition-[width] duration-500 ease-out motion-reduce:transition-none"
                  style={{ width: `${bufferedPercent}%` }}
                />
              </div>
              <p aria-hidden="true" className="text-sm text-muted">
                {bufferedPercent} persen audio sudah dihasilkan
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---------- Pengaturan ---------- */}
      <SettingsPanel
        voices={voices}
        voicesUnavailable={voicesUnavailable}
        selectedVoice={voice}
        rate={rate}
        usingFallback={usingFallback}
        disabled={notReady}
        onSetVoice={onSetVoice}
        onSetRate={onSetRate}
      />

      {/* ---------- Kalimat aktif ---------- */}
      <details className="rounded-md border border-border bg-surface p-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold text-foreground">
          Tampilkan kalimat yang sedang dibacakan
        </summary>
        <p className="mt-3 max-w-reading text-lg leading-relaxed text-foreground" lang="id">
          {currentSentence || 'Belum ada kalimat yang dibacakan.'}
        </p>
        {isReady && (
          <div className="mt-4">
            <label
              htmlFor={`${headingId}-seek`}
              className="block text-base font-medium text-foreground"
            >
              Lompat ke kalimat tertentu
            </label>
            <input
              id={`${headingId}-seek`}
              type="range"
              min={1}
              max={Math.max(1, totalSentences)}
              value={displayPosition}
              onChange={(event) =>
                setSeekPreview(Number.parseInt(event.target.value, 10))
              }
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              onBlur={commitSeek}
              aria-valuetext={`Kalimat ${displayPosition} dari ${totalSentences}`}
              className="mt-2 h-11 w-full max-w-md cursor-pointer accent-accent"
            />
          </div>
        )}
      </details>
    </section>
  );
}

/* ============================================================
 * Tombol pemutar
 * ============================================================ */

interface PlayerButtonProps {
  onClick: () => void;
  /** Sudah final; jangan pakai `disabled` agar fokus tidak hilang. */
  ariaDisabled: boolean;
  label: string;
  children: React.ReactNode;
  variant?: 'default' | 'danger';
}

/**
 * KENAPA `aria-disabled` DAN BUKAN `disabled`:
 *
 * Tombol dengan atribut `disabled` tidak dapat difokus dengan Tab.
 * Akibatnya pengguna keyboard kehilangan jejak posisinya, dan tombol
 * tidak lagi dibacakan screen reader — sehingga pengguna tidak tahu
 * bahwa tombol itu ada maupun mengapa tidak berfungsi.
 *
 * Dengan `aria-disabled`, tombol tetap dapat difokus dan tetap dibacakan
 * ("tombol tidak tersedia"), sementara klik DITOLAK di dalam (lihat
 * `guardedClick`) — bukan dibiarkan lolos ke handler. Tanpa penolakan
 * ini, menekan Putar saat audio sedang diputar akan melahirkan antrean
 * tandingan yang saling membatalkan hingga tidak ada bunyi sama sekali.
 */
function PlayerButton({
  onClick,
  ariaDisabled,
  label,
  children,
  variant = 'default',
}: PlayerButtonProps) {
  const base =
    'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 ' +
    'rounded-md border-2 px-4 py-3 text-base font-semibold transition-colors ' +
    'motion-reduce:transition-none focus-visible:outline-none ' +
    'focus-visible:ring-4 focus-visible:ring-accent focus-visible:ring-offset-2';

  const palette =
    variant === 'danger'
      ? 'border-danger bg-surface text-danger hover:bg-danger/5'
      : 'border-accent bg-accent text-white hover:bg-accent-dark';

  const disabledLook =
    'cursor-not-allowed border-border bg-subtle text-muted hover:bg-subtle';

  return (
    <button
      type="button"
      onClick={() => {
        if (!ariaDisabled) onClick();
      }}
      aria-disabled={ariaDisabled}
      aria-label={label}
      className={`${base} ${ariaDisabled ? disabledLook : palette}`}
    >
      {children}
    </button>
  );
}

/* ============================================================
 * Panel pengaturan
 * ============================================================ */

interface SettingsPanelProps {
  voices: VoiceOption[];
  voicesUnavailable: boolean;
  selectedVoice: string;
  rate: number;
  usingFallback: boolean;
  disabled: boolean;
  onSetVoice: (voice: string) => void;
  onSetRate: (rate: number) => void;
}

function SettingsPanel(props: SettingsPanelProps) {
  const {
    voices,
    voicesUnavailable,
    selectedVoice,
    rate,
    usingFallback,
    disabled,
    onSetVoice,
    onSetRate,
  } = props;

  const ids = {
    voice: useId(),
    rate: useId(),
  };

  return (
    <details className="rounded-md border border-border bg-surface p-4">
      {/*
        min-h-11 pada <summary> memenuhi WCAG 2.5.8 (Target Size).
        Tanpa ini elemen hanya setinggi sekitar 27px, terlalu kecil untuk
        pengguna dengan keterbatasan motorik.
      */}
      <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold text-foreground">
        Pengaturan suara
      </summary>

      <div className="mt-4 grid gap-6 md:grid-cols-2">
        {/* ----- Pilihan suara ----- */}
        <div>
          <label htmlFor={ids.voice} className="block text-base font-medium text-foreground">
            Pilih suara
          </label>

          <select
            id={ids.voice}
            value={selectedVoice}
            onChange={(event) => onSetVoice(event.target.value)}
            disabled={disabled || usingFallback || voices.length === 0}
            aria-describedby={`${ids.voice}-help`}
            className="mt-2 min-h-11 w-full rounded-md border-2 border-border bg-surface px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent disabled:cursor-not-allowed disabled:bg-subtle"
          >
            {voices.length === 0 && (
              <option value={selectedVoice}>
                {usingFallback ? 'Suara bawaan peramban' : 'Memuat daftar suara...'}
              </option>
            )}
            {voices.map((option) => (
              <option key={option.shortName} value={option.shortName}>
                {option.label}
              </option>
            ))}
          </select>

          {/*
            Keterangan berubah sesuai keadaan. Setiap keadaan dijelaskan
            dengan kalimat utuh, bukan sekadar "tidak tersedia", agar
            pengguna tahu apa yang harus dilakukan.
          */}
          <p id={`${ids.voice}-help`} className="mt-2 text-sm text-muted">
            {usingFallback
              ? 'Sedang memakai suara bawaan peramban. Pilihan suara tidak berlaku.'
              : voicesUnavailable
                ? 'Daftar suara sedang tidak dapat diambil. Pembacaan tetap berjalan dengan suara bawaan.'
                : 'Suara dihasilkan oleh layanan Microsoft Edge, tersedia dalam pilihan pria dan perempuan.'}
          </p>
        </div>

        {/* ----- Kecepatan ----- */}
        <div>
          <label htmlFor={ids.rate} className="block text-base font-medium text-foreground">
            Kecepatan bicara
          </label>
          <input
            id={ids.rate}
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={rate}
            onChange={(event) => onSetRate(Number.parseFloat(event.target.value))}
            aria-valuetext={`${rate.toFixed(1).replace('.', ',')} kali kecepatan normal`}
            className="mt-2 h-11 w-full cursor-pointer accent-accent focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent"
          />
          <p aria-hidden="true" className="mt-1 text-sm text-muted">
            {rate.toFixed(1).replace('.', ',')} kali kecepatan normal
          </p>
        </div>
      </div>

      {/*
        Catatan penting bagi pengguna: kecepatan diterapkan oleh server
        saat audio dibuat. Mengubah kecepatan berarti audio baru perlu
        dihasilkan, jadi pemutaran yang sedang berjalan akan mulai ulang.
        Menyembunyikan fakta ini akan membuat perubahan terasa seperti
        pemutaran yang rusak.
      */}
      <p className="mt-4 text-sm text-muted">
        Mengubah kecepatan atau suara akan membuat bagian yang sedang
        dibacakan dihasilkan ulang. Tekan Putar untuk memulai kembali.
      </p>
    </details>
  );
}

/* ============================================================
 * Ikon — semua dekoratif
 * ============================================================ */

function PlayIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function SkipBackIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6zM20 6v12l-9-6z" />
    </svg>
  );
}

function SkipForwardIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 6h2v12h-2zM4 6v12l9-6z" />
    </svg>
  );
}
