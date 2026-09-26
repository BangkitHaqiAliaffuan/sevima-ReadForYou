'use client';

/**
 * useSession — status masuk pengguna.
 *
 * Membaca sesi dari klien browser (persist otomatis via cookie, jadi
 * terbaca juga oleh middleware + Route Handler) dan mengikuti
 * perubahannya lewat onAuthStateChange. Satu-satunya sumber status
 * auth di seluruh UI — jangan panggil getSession langsung dari komponen.
 *
 * MODEL AUTH (disederhanakan):
 *  - `user === null`   → belum masuk. Aplikasi tetap dapat dipakai
 *    (unggah & baca), tetapi riwayat bacaan tidak tersimpan.
 *  - `user` berisi User → sudah masuk dengan akun email. Riwayat
 *    bacaan tersimpan dan dapat dibuka di perangkat lain.
 *
 * Tidak ada lagi konsep "tamu anonim": pengguna hanya punya dua
 * keadaan — belum masuk atau sudah masuk. Ini menghapus seluruh
 * rangkaian sesi anonim otomatis beserta kebingungannya.
 */

import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';

import { getBrowserSupabase } from '@/lib/supabase';

export interface SessionState {
  /** Null bila belum masuk. Berisi data akun bila sudah masuk. */
  user: User | null;
  /** True selama pemeriksaan awal berjalan. */
  loading: boolean;
}

export function useSession(): SessionState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const supabase = getBrowserSupabase();
      const { data } = await supabase.auth.getSession();
      setUser(data.session?.user ?? null);
    } catch {
      // Env belum lengkap atau jaringan putus: anggap belum masuk.
      // Pesan galat yang ramah ditangani komponen pemanggil.
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await refresh();
      if (cancelled) return;
    })();

    let subscription: { unsubscribe: () => void } | null = null;
    try {
      const supabase = getBrowserSupabase();
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!cancelled) {
          setUser(session?.user ?? null);
          setLoading(false);
        }
      });
      subscription = data.subscription;
    } catch {
      // getBrowserSupabase melempar bila env belum lengkap — biarkan
      // status belum masuk; refresh() di atas sudah menangani.
    }

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [refresh]);

  return { user, loading };
}
