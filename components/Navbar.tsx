'use client';

/**
 * Navbar — bilah navigasi utama + status masuk ringkas.
 *
 * Satu-satunya pintu auth di seluruh situs selain halaman `/masuk`:
 * tamu melihat tombol highlight "Masuk / daftar", pengguna yang masuk
 * melihat identitasnya + tombol "Keluar". Alur penuh (tamu 1-ketuk,
 * upgrade, masuk email) tetap tinggal di `/masuk` + `AuthPanel`.
 *
 * Aksesibilitas: <nav> berlabel (bukan sekadar <div>), tautan/tombol
 * asli, target ≥44px, `aria-disabled` + penjaga di handler (bukan
 * `disabled`), tanpa region live sendiri — konfirmasi logout adalah
 * navigasi ke `/masuk` yang judul + isinya eksplisit.
 */

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { translateAuthError } from '@/components/AuthPanel';
import { useSession } from '@/hooks/useSession';
import { getBrowserSupabase } from '@/lib/supabase';

export function Navbar() {
  const { user, isAnonymous, loading } = useSession();
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  function handleSignOut(): void {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      try {
        const supabase = getBrowserSupabase();
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        router.replace('/masuk');
      } catch (err) {
        // Tanpa region live sendiri: kegagalan logout yang jarang ini
        // dilaporkan lewat console + tombol kembali normal. Status sesi
        // tetap terlihat di navbar sehingga pengguna tidak terkecoh.
        console.error('[navbar] keluar gagal:', translateAuthError(err));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }

  return (
    <nav
      aria-label="Navigasi utama"
      className="flex flex-wrap items-center gap-3 border-b-2 border-border pb-4"
    >
      <Link
        href="/"
        className="inline-flex min-h-11 items-center text-lg font-bold text-foreground"
      >
        AI ReadForYou
      </Link>

      <div className="ml-auto flex flex-wrap items-center gap-3">
        {loading ? null : !user ? (
          <Link
            href="/masuk"
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-accent px-6 py-2 text-base font-semibold text-white hover:bg-accent-dark"
          >
            Masuk / daftar
          </Link>
        ) : (
          <>
            <p
              className="max-w-44 truncate text-base text-muted sm:max-w-64"
              title={isAnonymous ? 'Tamu' : (user.email ?? 'Akun')}
            >
              {isAnonymous ? (
                'Tamu'
              ) : (
                <>
                  <span className="sr-only">Masuk sebagai </span>
                  {user.email}
                </>
              )}
            </p>
            <button
              type="button"
              onClick={handleSignOut}
              aria-disabled={busy}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border-2 border-border px-5 py-2 text-base font-semibold text-foreground hover:bg-subtle"
            >
              <span>{busy ? 'Memproses…' : 'Keluar'}</span>
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
