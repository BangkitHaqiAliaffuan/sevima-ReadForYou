'use client';

/**
 * MasukClient — isi halaman `/masuk`.
 *
 * Merakit ulang potongan yang sudah ada (LiveStatus + useSession +
 * AuthPanel) tanpa menduplikasi logika auth. Dua keputusan penting:
 *
 * 1. Redirect HANYA untuk auth permanen. Tamu anonim sengaja tetap di
 *    halaman ini agar form upgrade terlihat — memantulkan mereka ke
 *    beranda (yang tanpa UI auth) akan menghilangkan jalur upgrade.
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
  const { user, isAnonymous, loading } = useSession();
  const router = useRouter();
  const redirectedRef = useRef(false);

  const redirect = safeRedirect(redirectParam);

  /* Pantulkan ke tujuan setelah masuk PERMANEN (upgrade/masuk email).
     Fokus-di-efek mengikuti kontrak repo; navigasi di sini (bukan di
     handler AuthPanel) agar pengumuman sukses sempat dikirim dulu. */
  useEffect(() => {
    if (loading || redirectedRef.current) return;
    if (!user || isAnonymous) return;
    if (!redirect) return;
    redirectedRef.current = true;
    announce('Berhasil masuk. Membawa Anda kembali ke halaman sebelumnya.', {
      key: 'auth',
    });
    router.replace(redirect);
  }, [user, isAnonymous, loading, redirect, announce, router]);

  return (
    <>
      <LiveStatus
        politeMessage={politeMessage}
        assertiveMessage={assertiveMessage}
      />

      <AuthPanel
        user={user}
        isAnonymous={isAnonymous}
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
