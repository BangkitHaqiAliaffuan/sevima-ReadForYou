'use client';

/**
 * LiveStatus — satu-satunya jalur pengumuman ke screen reader.
 *
 * KENAPA DIPISAH DARI KOMPONEN LAIN:
 *
 * Kesalahan paling umum pada aplikasi "aksesibel" adalah memakai satu
 * <div aria-live="polite"> untuk segala hal: status unggah, progres,
 * pesan selesai, dan error. Akibatnya:
 *   - pesan saling menimpa sebelum sempat dibacakan,
 *   - error yang mendesak ikut mengantre di belakang progres yang
 *     sudah tidak relevan.
 *
 * Komponen ini menyediakan DUA region yang terpisah dan sejak awal ada di
 * DOM (penting: region live yang baru dibuat bersamaan dengan pengisiannya
 * sering tidak terbaca oleh pembaca layar).
 *
 *   - region "polite"    : status & progres. Menunggu giliran bicara.
 *   - region "assertive" : error. Menghentikan pengumuman berjalan.
 *
 * Setiap region hanya boleh ada satu di halaman. Bila ada dua pembungkus
 * LiveStatus, hapus salah satunya.
 */

import type { ReactNode } from 'react';

export interface LiveStatusProps {
  politeMessage: string;
  assertiveMessage: string;
}

export function LiveStatus({
  politeMessage,
  assertiveMessage,
}: LiveStatusProps) {
  return (
    <>
      {/*
        role="status" memiliki arti yang sama dengan aria-live="polite"
        sekaligus menambahkan aria-atomic="true", sehingga seluruh isi
        node dibacakan utuh — bukan hanya bagian yang berubah. Ini penting
        karena kita sering mengganti angka di tengah kalimat.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="live-region-polite"
      >
        {politeMessage}
      </div>

      {/*
        role="alert" setara dengan aria-live="assertive" +
        aria-atomic="true". Dipakai HANYA untuk kegagalan.
      */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        data-testid="live-region-assertive"
      >
        {assertiveMessage}
      </div>
    </>
  );
}

/* ============================================================
 * Util visual
 * ============================================================ */

/**
 * Teks yang hanya terbaca screen reader.
 *
 * CATATAN PENTING: kelas `sr-only` memakai teknik `clip: rect(0,0,0,0)`.
 * Ini disengaja — berbeda dengan `display:none` atau
 * `visibility:hidden` yang membuat elemen TIDAK terbaca sama sekali
 * dan juga tidak dapat difokus keyboard.
 */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

/* ============================================================
 * Indikator visual dengan padanan non-visual
 * ============================================================ */

export interface StatusBannerProps {
  tone: 'info' | 'success' | 'error' | 'warning';
  /** Teks yang tampak di layar. */
  children: ReactNode;
}

/**
 * Banner status visual.
 *
 * Di sini `aria-hidden="true"` dipakai dengan sengaja: isi banner sudah
 * diumumkan lewat region live di atas. Tanpa ini, screen reader akan
 * membacakan pesan yang sama dua kali.
 */
export function StatusBanner({ tone, children }: StatusBannerProps) {
  const toneClass = {
    info: 'border-accent bg-accent/5 text-accent-dark',
    success: 'border-success bg-success/5 text-success',
    error: 'border-danger bg-danger/5 text-danger',
    warning: 'border-warning bg-warning/5 text-warning-dark',
  }[tone];

  return (
    <p
      aria-hidden="true"
      className={`rounded-md border-2 px-4 py-3 text-base font-medium ${toneClass}`}
    >
      {children}
    </p>
  );
}
