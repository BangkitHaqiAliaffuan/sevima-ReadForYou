'use client';

/**
 * useSession — status masuk pengguna.
 *
 * Membaca sesi dari klien browser (persist otomatis via cookie, jadi
 * terbaca juga oleh middleware + Route Handler) dan mengikuti
 * perubahannya lewat onAuthStateChange. Satu-satunya sumber status
 * auth di seluruh UI — jangan panggil getSession langsung dari komponen.
 */

import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';

import { getBrowserSupabase } from '@/lib/supabase';

export interface SessionState {
  /** Null bila tamu murni (tanpa sesi apa pun). */
  user: User | null;
  /** True bila sesi anonim (is_anonymous dari Supabase Auth). */
  isAnonymous: boolean;
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
      // Env belum lengkap atau jaringan putus: anggap tamu murni.
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
      // status tamu murni; refresh() di atas sudah menangani.
    }

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [refresh]);

  return {
    user,
    isAnonymous: user?.is_anonymous === true,
    loading,
  };
}
