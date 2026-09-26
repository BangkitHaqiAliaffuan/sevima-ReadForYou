'use client';

/**
 * AuthPanel — masuk sebagai tamu (anonim) atau akun permanen.
 *
 * Keputusan aksesibilitas (mengikuti kontrak repo):
 * - Masuk 1 ketuk tanpa formulir sebagai jalur utama: tanpa CAPTCHA
 *   visual, tanpa pindah aplikasi email, tanpa redirect OAuth yang
 *   menghilangkan konteks screen reader.
 * - Upgrade ke email+password memakai `updateUser` (bukan `linkIdentity`:
 *   versi @supabase/auth-js terinstal hanya punya overload OAuth/IdToken
 *   untuk linkIdentity, sehingga email wajib lewat updateUser agar uid
 *   dan riwayat tetap sama).
 * - Galat inline berupa <p> biasa + pengumuman lewat region live milik
 *   halaman (jangan role="alert" ganda — LiveStatus sudah menyediakannya).
 * - Tombol memakai `aria-disabled` + penjaga di handler, bukan `disabled`.
 * - Fokus dipindah di useEffect setelah auth berhasil, bukan di handler.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';

import { getBrowserSupabase } from '@/lib/supabase';

export interface AuthPanelProps {
  user: User | null;
  isAnonymous: boolean;
  loading: boolean;
  announce: (
    message: string,
    options?: { priority?: 'polite' | 'assertive'; key?: string },
  ) => void;
  /** Dipanggil saat pengguna memilih "Lanjut tanpa masuk". */
  onDismiss?: () => void;
}

type FormMode = 'upgrade' | 'signup' | 'signin';

export function AuthPanel({
  user,
  isAnonymous,
  loading,
  announce,
  onDismiss,
}: AuthPanelProps) {
  const headingId = useId();
  const emailId = useId();
  const passwordId = useId();
  const hintId = useId();
  const errorId = useId();

  const headingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(false);
  const focusAfterAuthRef = useRef(false);

  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  /* Fokus ke judul status setelah auth berhasil. Dilakukan di useEffect
     karena saat handler berjalan React belum selesai merender ulang. */
  useEffect(() => {
    if (focusAfterAuthRef.current && user && headingRef.current) {
      focusAfterAuthRef.current = false;
      headingRef.current.focus();
    }
  }, [user]);

  async function runGuarded(task: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFormError(null);
    try {
      await task();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function handleGuestSignIn(): void {
    void runGuarded(async () => {
      try {
        const supabase = getBrowserSupabase();
        const { error } = await supabase.auth.signInAnonymously();
        if (error) throw error;
        focusAfterAuthRef.current = true;
        announce(
          'Anda masuk sebagai tamu. Berkas yang Anda unggah tersimpan dan memiliki riwayat. ' +
            'Untuk menyimpan permanen di perangkat lain, daftarkan email di bawah.',
          { key: 'auth' },
        );
      } catch (err) {
        const message = translateAuthError(err);
        setFormError(message);
        announce(message, { priority: 'assertive', key: 'auth-error' });
      }
    });
  }

  function handleEmailSubmit(event: FormEvent<HTMLFormElement>, mode: FormMode): void {
    event.preventDefault();
    if (busyRef.current) return;

    const cleanEmail = email.trim();
    if (cleanEmail.length === 0 || !cleanEmail.includes('@')) {
      const message = 'Masukkan alamat email yang valid, misalnya nama@contoh.id.';
      setFormError(message);
      announce(message, { priority: 'assertive', key: 'auth-error' });
      return;
    }
    if (password.length < 6) {
      const message = 'Kata sandi minimal 6 karakter. Silakan tambahkan lagi.';
      setFormError(message);
      announce(message, { priority: 'assertive', key: 'auth-error' });
      return;
    }

    void runGuarded(async () => {
      try {
        const supabase = getBrowserSupabase();
        if (mode === 'upgrade') {
          const { error } = await supabase.auth.updateUser({
            email: cleanEmail,
            password,
          });
          if (error) throw error;
          focusAfterAuthRef.current = true;
          announce(
            'Akun Anda tersimpan. Bila diminta verifikasi, periksa email Anda lalu kembali ke halaman ini. Riwayat bacaan Anda tetap sama.',
            { key: 'auth' },
          );
        } else if (mode === 'signup') {
          /*
           * Pendaftaran akun permanen BARU (uid baru, riwayat kosong).
           * Bila "Confirm email" aktif di dashboard, signUp sukses TANPA
           * sesi — pengguna harus klik tautan verifikasi dulu.
           */
          const { data, error } = await supabase.auth.signUp({
            email: cleanEmail,
            password,
          });
          if (error) throw error;
          focusAfterAuthRef.current = true;
          if (data.session) {
            announce('Pendaftaran berhasil. Riwayat bacaan Anda mulai tersimpan.', {
              key: 'auth',
            });
          } else {
            announce(
              'Pendaftaran diterima. Periksa email Anda dan klik tautan verifikasi, ' +
                'lalu masuk dengan kata sandi Anda.',
              { key: 'auth' },
            );
          }
        } else {
          const { error } = await supabase.auth.signInWithPassword({
            email: cleanEmail,
            password,
          });
          if (error) throw error;
          focusAfterAuthRef.current = true;
          announce('Berhasil masuk. Riwayat bacaan Anda dimuat.', { key: 'auth' });
        }
        setPassword('');
      } catch (err) {
        const message = translateAuthError(err);
        setFormError(message);
        announce(message, { priority: 'assertive', key: 'auth-error' });
      }
    });
  }

  function handleSignOut(): void {
    void runGuarded(async () => {
      try {
        const supabase = getBrowserSupabase();
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        /*
         * Model 2-sesi: semua orang selalu bersesi. Langsung buatkan anon
         * baru agar tidak ada jendela tanpa sesi (guard otomatis di
         * useSession sudah terpakai saat load, jadi buat manual di sini).
         */
        const { error: anonError } = await supabase.auth.signInAnonymously();
        if (anonError) throw anonError;
        focusAfterAuthRef.current = true;
        setEmail('');
        setPassword('');
        announce('Anda keluar. Sesi tamu baru dibuat otomatis untuk Anda.', {
          key: 'auth',
        });
      } catch (err) {
        const message = translateAuthError(err);
        setFormError(message);
        announce(message, { priority: 'assertive', key: 'auth-error' });
      }
    });
  }

  const describedBy = [hintId, formError ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl font-bold text-foreground focus-visible:outline-none"
      >
        Status masuk
      </h2>

      {loading ? (
        <p className="max-w-reading text-base text-muted">
          Sedang memeriksa status masuk Anda.
        </p>
      ) : !user ? (
        <div className="space-y-3">
          {/*
            Model 2-sesi: tanpa sesi = pembuatan sesi GAGAL (provider
            nonaktif/jaringan), bukan pilihan. Sesi tamu normalnya sudah
            dibuat otomatis oleh useSession — tombol ini hanya pemulihan.
          */}
          <p id={hintId} className="max-w-reading text-base text-muted">
            Sesi tamu tidak dapat dibuat otomatis. Periksa sambungan
            internet Anda, lalu coba lagi — atau masuk dengan akun email
            di bawah.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleGuestSignIn}
              aria-disabled={busy}
              aria-describedby={describedBy}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md bg-accent px-6 py-3 text-base font-semibold text-white hover:bg-accent-dark"
            >
              <UserIcon />
              <span>{busy ? 'Memproses…' : 'Coba lagi'}</span>
            </button>
            {onDismiss && (
              /*
               * Jalan keluar satu-ketuk ketika pembuatan sesi gagal.
               * Tanpa ini, pengguna hanya bisa menekan "Coba lagi" yang
               * jelas akan gagal lagi, lalu terjebak di halaman ini.
               * `dismissed` menyembunyikan form masuk akun lama di bawah
               * agar tidak menawarkan jalur yang juga tidak akan berhasil.
               */
              <button
                type="button"
                onClick={() => {
                  setDismissed(true);
                  onDismiss();
                }}
                aria-disabled={busy}
                className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border-2 border-border px-5 py-3 text-base font-semibold text-foreground hover:bg-subtle"
              >
                <span>Lanjut tanpa masuk</span>
              </button>
            )}
          </div>
          {formError && (
            <p
              id={errorId}
              className="max-w-reading rounded-md border-2 border-danger bg-danger/5 px-4 py-3 text-base font-medium text-danger"
            >
              {formError}
            </p>
          )}
        </div>
      ) : isAnonymous ? (
        <div className="space-y-3">
          <p id={hintId} className="max-w-reading text-base text-muted">
            Anda masuk sebagai tamu. Berkas dan riwayat tersimpan di akun
            tamu ini. Daftarkan email agar akun tersimpan permanen dan dapat
            dibuka di perangkat lain — riwayat Anda ikut terbawa.
          </p>
          <form onSubmit={(event) => handleEmailSubmit(event, 'upgrade')} className="max-w-reading space-y-3">
            <div className="space-y-1">
              <label htmlFor={emailId} className="block text-base font-semibold text-foreground">
                Alamat email
              </label>
              <input
                id={emailId}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-describedby={describedBy}
                placeholder="nama@contoh.id"
                className="min-h-11 w-full rounded-md border-2 border-border bg-surface px-3 py-2 text-base text-foreground"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={passwordId} className="block text-base font-semibold text-foreground">
                Kata sandi baru (minimal 6 karakter)
              </label>
              <input
                id={passwordId}
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={describedBy}
                className="min-h-11 w-full rounded-md border-2 border-border bg-surface px-3 py-2 text-base text-foreground"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-pressed={showPassword}
                className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-2 text-base font-medium text-accent underline"
              >
                <span>{showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}</span>
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                aria-disabled={busy}
                aria-describedby={describedBy}
                className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-accent px-6 py-3 text-base font-semibold text-white hover:bg-accent-dark"
              >
                <span>{busy ? 'Menyimpan…' : 'Simpan akun permanen'}</span>
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                aria-disabled={busy}
                className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border-2 border-border px-5 py-2 text-base font-semibold text-foreground hover:bg-subtle"
              >
                <span>Keluar</span>
              </button>
            </div>
            {formError && (
              <p
                id={errorId}
                className="max-w-reading rounded-md border-2 border-danger bg-danger/5 px-4 py-3 text-base font-medium text-danger"
              >
                {formError}
              </p>
            )}
          </form>
        </div>
      ) : (
        <div className="space-y-3">
          <p id={hintId} className="max-w-reading text-base text-muted">
            Anda masuk sebagai{' '}
            <span className="font-semibold text-foreground">{user.email}</span>.
            Riwayat bacaan tersimpan dan dapat dibuka di perangkat lain.
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            aria-disabled={busy}
            aria-describedby={describedBy}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border-2 border-border px-5 py-2 text-base font-semibold text-foreground hover:bg-subtle"
          >
            <span>{busy ? 'Memproses…' : 'Keluar'}</span>
          </button>
          {formError && (
            <p
              id={errorId}
              className="max-w-reading rounded-md border-2 border-danger bg-danger/5 px-4 py-3 text-base font-medium text-danger"
            >
              {formError}
            </p>
          )}
        </div>
      )}

      {/* Masuk akun lama (perangkat lain): hanya relevan bila belum masuk
          dan panel tidak ditutup. */}
      {!loading && !user && !dismissed && (
        <details className="max-w-reading rounded-md border border-border bg-surface p-4">
          <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold text-foreground">
            Sudah punya akun? Masuk dengan email
          </summary>
          <form onSubmit={(event) => handleEmailSubmit(event, 'signin')} className="mt-3 space-y-3">
            <div className="space-y-1">
              <label htmlFor={`${emailId}-masuk`} className="block text-base font-semibold text-foreground">
                Alamat email
              </label>
              <input
                id={`${emailId}-masuk`}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="nama@contoh.id"
                className="min-h-11 w-full rounded-md border-2 border-border bg-surface px-3 py-2 text-base text-foreground"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${passwordId}-masuk`} className="block text-base font-semibold text-foreground">
                Kata sandi
              </label>
              <input
                id={`${passwordId}-masuk`}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="min-h-11 w-full rounded-md border-2 border-border bg-surface px-3 py-2 text-base text-foreground"
              />
            </div>
            <button
              type="submit"
              aria-disabled={busy}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-accent px-6 py-3 text-base font-semibold text-white hover:bg-accent-dark"
            >
              <span>{busy ? 'Memproses…' : 'Masuk'}</span>
            </button>
          </form>
        </details>
      )}
    </section>
  );
}

/**
 * Ubah galat mentah Supabase/Auth menjadi kalimat Indonesia yang menjelaskan
 * langkah berikutnya. Pesan ini final — langsung ditampilkan + diumumkan.
 */
export function translateAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.toLowerCase();

  if (message.includes('anonymous sign-ins are disabled')) {
    return (
      'Masuk tamu belum diaktifkan oleh pengelola. ' +
      'Silakan lanjut tanpa masuk, atau hubungi pengelola aplikasi.'
    );
  }
  if (message.includes('user already registered') || message.includes('already exists')) {
    return (
      'Email ini sudah terdaftar. Buka bagian "Sudah punya akun? Masuk dengan email" ' +
      'lalu masuk dengan kata sandi Anda.'
    );
  }
  if (message.includes('invalid login credentials')) {
    return 'Email atau kata sandi salah. Periksa kembali lalu coba lagi.';
  }
  if (message.includes('password should be at least')) {
    return 'Kata sandi minimal 6 karakter. Silakan tambahkan lagi.';
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return 'Tidak dapat menghubungi server. Periksa sambungan internet Anda lalu coba lagi.';
  }
  if (raw.trim().length > 0 && raw.length < 300) return raw;
  return 'Terjadi kesalahan saat memproses masuk. Silakan coba lagi.';
}

function UserIcon() {
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
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
