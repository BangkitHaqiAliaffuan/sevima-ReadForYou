'use client';

/**
 * UploadModule — antarmuka unggah berkas yang dapat dioperasikan hanya
 * dengan keyboard dan sepenuhnya dapat dibaca screen reader.
 *
 * KEPUTUSAN AKSESIBILITAS YANG DIAMBIL DI SINI (beserta alasannya):
 *
 * 1. Kontrol sebenarnya adalah <input type="file">, bukan <div onClick>.
 *    Ini memberi kita gratis: fokus keyboard, pembacaan label, dan
 *    dialog pemilih berkas bawaan sistem operasi. Dropzone hanya
 *    memperluas area klik.
 *
 * 2. Input berkas disembunyikan dengan kelas `sr-only`, BUKAN `hidden`
 *    atau `display:none`. Elemen dengan display:none tidak dapat
 *    difokuskan, sehingga pengguna keyboard tidak akan bisa mencapai
 *    tombol "Pilih berkas" sama sekali.
 *
 * 3. Tombol tindakan TIDAK memakai atribut `disabled` saat memproses.
 *    Tombol yang disabled kehilangan fokus, dan pengguna keyboard akan
 *    terlempar ke awal dokumen tanpa tahu apa yang terjadi. Sebagai
 *    gantinya kita pakai `aria-disabled="true"` dan memblokir aksi di
 *    dalam handler — tombol tetap dapat difokus dan tetap terbaca.
 *
 * 4. Semua ikon bersifat `aria-hidden` DAN memiliki teks tersembunyi.
 *    Tidak ada satu pun kontrol yang hanya diwakili ikon.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';

import {
  ACCEPT_ATTRIBUTE,
  formatMegabytes,
  MAX_FILE_BYTES,
  validateFileOnClient,
} from '@/lib/validate-file';

export interface UploadModuleProps {
  /** Dipanggil setelah berkas lolos validasi klien. */
  onFileSelected: (file: File) => void;
  /** True saat unggah/ekstraksi berjalan. */
  busy?: boolean;
  /** Progres unggah 0-100. Null bila belum mulai. */
  uploadPercent?: number | null;
  /** Pesan kesalahan yang harus ditampilkan & diumumkan. */
  errorMessage?: string | null;
  /** Untuk mengarahkan fokus kembali ketika unggahan gagal. */
  focusInputSignal?: number;
}

export function UploadModule({
  onFileSelected,
  busy = false,
  uploadPercent = null,
  errorMessage = null,
  focusInputSignal = 0,
}: UploadModuleProps) {
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  /* Fokus dikembalikan ke input ketika unggahan gagal. Dilakukan di
     useEffect, BUKAN langsung di dalam handler, karena pada saat handler
     berjalan React belum selesai menempelkan elemen ke DOM — memanggil
     .focus() di sana adalah sumber bug yang sering ditemui. */
  useEffect(() => {
    if (focusInputSignal > 0 && inputRef.current) {
      inputRef.current.focus();
    }
  }, [focusInputSignal]);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (busy) return;
      if (!files || files.length === 0) return;

      const file = files[0];
      if (!file) return;

      const result = validateFileOnClient(file);
      if (!result.ok) {
        setLocalError(result.message ?? 'Berkas tidak dapat diproses.');
        // Kosongkan nilai input supaya memilih berkas yang sama lagi tetap
        // memicu event `change`. Tanpa ini, memilih ulang berkas yang gagal
        // tidak akan melakukan apa pun dan terasa seperti aplikasi rusak.
        if (inputRef.current) inputRef.current.value = '';
        return;
      }

      setLocalError(null);
      onFileSelected(file);
    },
    [busy, onFileSelected],
  );

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      handleFiles(event.target.files);
    },
    [handleFiles],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      handleFiles(event.dataTransfer.files);
    },
    [handleFiles],
  );

  const shownError = localError ?? errorMessage;
  const describedBy = [helpId, shownError ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <section aria-labelledby="upload-heading" className="space-y-4">
      <h2 id="upload-heading" className="text-2xl font-bold text-foreground">
        Unggah modul pelajaran
      </h2>

      <p id={helpId} className="max-w-reading text-base text-muted">
        Pilih berkas modul dalam format PDF, JPG, PNG, atau WEBP.
        Ukuran maksimal {formatMegabytes(MAX_FILE_BYTES)}. Setelah diunggah,
        sistem akan mengubah isi berkas menjadi teks yang dapat dibacakan.
      </p>

      {/* ---------- Dropzone visual (bukan kontrol utama) ---------- */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={[
          'rounded-md border-2 border-dashed p-6 text-center transition-colors motion-reduce:transition-none',
          isDragging ? 'border-accent bg-accent/5' : 'border-border bg-surface',
        ].join(' ')}
      >
        {/*
          Label utama. Mengarah ke input melalui htmlFor sehingga
          menekan atau menekan Enter pada label akan membuka pemilih
          berkas. Ukuran minimal 44x44 piksel memenuhi WCAG 2.5.8.
        */}
        <label
          htmlFor={inputId}
          className={[
            'inline-flex min-h-11 cursor-pointer items-center justify-center',
            'gap-2 rounded-md bg-accent px-6 py-3 text-base font-semibold text-white',
            'hover:bg-accent-dark',
            busy ? 'cursor-not-allowed opacity-60' : '',
          ].join(' ')}
        >
          <UploadIcon />
          <span>Pilih berkas modul</span>
        </label>

        <p aria-hidden="true" className="mt-3 text-sm text-muted">
          atau seret dan lepaskan berkas ke area ini
        </p>

        {/*
          Input berkas yang sebenarnya. `sr-only` memakai clip-rect
          sehingga elemen tetap ada di pohon aksesibilitas dan tetap
          dapat difokus dengan Tab.
        */}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          onChange={onChange}
          aria-label="Pilih berkas modul pelajaran untuk diunggah"
          aria-describedby={describedBy}
          aria-disabled={busy}
          aria-invalid={shownError ? true : undefined}
          className="sr-only"
          data-testid="file-input"
        />
      </div>

      {/* ---------- Progres ---------- */}
      {busy && uploadPercent !== null && (
        <ProgressBar
          percent={uploadPercent}
          label="Progres mengunggah berkas"
        />
      )}

      {/* ---------- Kesalahan ---------- */}
      {shownError && (
        <p
          id={errorId}
          className="max-w-reading rounded-md border-2 border-danger bg-danger/5 px-4 py-3 text-base font-medium text-danger"
        >
          {shownError}
        </p>
      )}
    </section>
  );
}

/* ============================================================
 * ProgressBar
 * ============================================================ */

export interface ProgressBarProps {
  percent: number;
  label: string;
}

/**
 * Indikator progres yang bukan sekadar animasi.
 *
 * Kunci aksesibilitasnya:
 *  - `role="progressbar"` + `aria-valuenow/min/max` memberi tahu screen
 *    reader posisi saat ini.
 *  - `aria-valuetext` menggantikan angka mentah dengan frasa yang wajar
 *    didengar ("empat puluh lima persen"), sehingga NVDA tidak
 *    membacakan angka tanpa konteks.
 *  - Teks persen juga tampil secara visual, karena pengguna low vision
 *    tidak dapat menafsirkan batang warna saja.
 */
export function ProgressBar({ percent, label }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));

  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${clamped} persen`}
        className="h-4 w-full overflow-hidden rounded-full border border-border bg-subtle"
      >
        <div
          className="h-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p aria-hidden="true" className="text-sm font-medium text-muted">
        {clamped} persen
      </p>
    </div>
  );
}

/* ============================================================
 * Ikon
 * ============================================================ */

/**
 * Setiap ikon WAJIB `aria-hidden="true"` dan `focusable="false"`.
 *
 * `focusable="false"` diperlukan khusus untuk Internet Explorer dan Edge
 * versi lama, yang memasukkan SVG ke urutan tab. Tanpa itu, pengguna
 * keyboard akan berhenti pada elemen yang tidak melakukan apa pun.
 */
function UploadIcon() {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
