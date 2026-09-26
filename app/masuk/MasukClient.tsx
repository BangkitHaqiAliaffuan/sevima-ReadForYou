'use client';

/**
 * MasukClient — isi halaman `/masuk`.
 *
 * Merakit ulang potongan yang sudah ada (LiveStatus + useSession +
 * AuthPanel) tanpa menduplikasi logika auth. Dua keputusan penting:
 *
 * 1. Setelah berhasil masuk/daftar, pengguna SELALU dipantulkan keluar
 *    dari halaman ini — ke `?redirect=` bila ada, atau ke beranda (`/`).
 *    Tanpa jaminan ini, pengguna yang masuk otomatis akan terjebak di
 *    halaman masuk dan mengira prosesnya gagal.
 * 2. Tidak ada heading/fokus-on-mount tambahan: judul dokumen dari
 *    metadata ("Masuk — AI ReadForYou") sudah diumumkan screen reader
 *    saat navigasi, dan AuthPanel punya h2 + fokus-saat-berhasil sendiri.
 */

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { AuthPanel } from '@/components/AuthPanel';
import { LiveStatus } from '@/components/LiveStatus';
import { useAnnouncer } from '@/hooks/useAnnouncer';
import { useSession } from '@/hooks/useSession';

export interface MasukClientProps {
  /** Nilai mentah `?redirect=` dari server (belum divalidasi). */
  redirectParam: string | null;
}

/** Tujuan default setelah masuk bila tidak ada `?redirect=` yang sah. */
const DEFAULT_AFTER_LOGIN = '/';

/**
 * Terima hanya path internal (`/...`). Tolak protokol absolut,
 * protocol-relative (`//evil`), dan string kosong — anti open-redirect.
 */
export function safeRedirect(raw: string | null): string | null {
  if (!raw || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  if (raw.includes('..')) return null;
  return raw;
}

export function MasukClient({ redirectParam }: MasukClientProps) {
  const { politeMessage, assertiveMessage, announce } = useAnnouncer();
  const { user, loading } = useSession();
  const router = useRouter();
  const redirectedRef = useRef(false);

  /* Tujuan akhir: `?redirect=` bila sah, selain itu beranda. */
  const destination = safeRedirect(redirectParam) ?? DEFAULT_AFTER_LOGIN;

  /*
   * Pantulkan ke tujuan setelah masuk — SELALU, bukan hanya saat ada
   * `?redirect=`. Fokus-di-efek mengikuti kontrak repo; navigasi di sini
   * (bukan di handler AuthPanel) agar pengumuman sukses sempat dikirim.
   */
  useEffect(() => {
    if (loading || redirectedRef.current) return;
    if (!user) return;
    redirectedRef.current = true;
    announce(
      destination === DEFAULT_AFTER_LOGIN
        ? 'Berhasil masuk. Membawa Anda ke beranda.'
        : 'Berhasil masuk. Membawa Anda kembali ke halaman sebelumnya.',
      { key: 'auth' },
    );
    router.replace(destination);
  }, [user, loading, destination, announce, router]);

  return (
    <>
      <LiveStatus
        politeMessage={politeMessage}
        assertiveMessage={assertiveMessage}
      />

      <AuthPanel
        user={user}
        loading={loading}
        announce={announce}
        onDismiss={() => router.replace('/')}
      />

      <p className="max-w-reading text-base text-muted">
        <Link href="/" className="font-semibold text-accent underline">
          Kembali ke beranda
        </Link>{' '}
        tanpa masuk — Anda tetap dapat mengunggah, tetapi riwayat bacaan
        tidak akan tersimpan.
      </p>
    </>
  );
}
