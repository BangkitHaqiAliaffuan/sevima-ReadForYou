'use client';

/**
 * AuthPanel — masuk dengan akun email.
 *
 * MODEL AUTH (disederhanakan — tanpa tamu):
 *  - Belum masuk  → form Masuk / Daftar akun email.
 *  - Sudah masuk  → identitas akun + tombol Keluar.
 *
 * Keputusan aksesibilitas (mengikuti kontrak repo):
 * - Tidak ada CAPTCHA visual, tidak ada redirect OAuth yang menghilangkan
 *   konteks screen reader.
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
  loading: boolean;
  announce: (
    message: string,
    options?: { priority?: 'polite' | 'assertive'; key?: string },
  ) => void;
  /**
   * Dipanggil saat pengguna memilih melanjutkan tanpa masuk. Bila
   * diisi, panel menampilkan tombol "Lanjut tanpa masuk".
   */
  onDismiss?: () => void;
}

type FormMode = 'signin' | 'signup';

export function AuthPanel({
  user,
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

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode>('signin');
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

  function handleEmailSubmit(event: FormEvent<HTMLFormElement>): void {
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
        if (mode === 'signin') {
          const { error } = await supabase.auth.signInWithPassword({
            email: cleanEmail,
            password,
          });
          if (error) throw error;
          focusAfterAuthRef.current = true;
          announce('Berhasil masuk. Riwayat bacaan Anda dimuat.', { key: 'auth' });
        } else {
          /*
           * Pendaftaran akun baru (uid baru, riwayat kosong). Bila
           * "Confirm email" aktif di dashboard, signUp sukses TANPA
           * sesi — pengguna harus klik tautan verifikasi dulu.
           */
          const { data, error } = await supabase.auth.signUp({
            email: cleanEmail,
            password,
          });
          if (error) throw error;
          focusAfterAuthRef.current = true;
          if (data.session) {
            announce(
              'Pendaftaran berhasil. Riwayat bacaan Anda mulai tersimpan.',
              { key: 'auth' },
            );
          } else {
            announce(
              'Pendaftaran diterima. Periksa email Anda dan klik tautan ' +
                'verifikasi, lalu masuk dengan kata sandi Anda.',
              { key: 'auth' },
            );
          }
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
        focusAfterAuthRef.current = true;
        setEmail('');
        setPassword('');
        announce('Anda telah keluar.', { key: 'auth' });
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
      ) : user ? (
        /* ---------- Sudah masuk ---------- */
        <div className="space-y-3">
          <p id={hintId} className="max-w-reading text-base text-muted">
            Masuk sebagai{' '}
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
      ) : (
        /* ---------- Belum masuk ---------- */
        <div className="space-y-3">
          <p id={hintId} className="max-w-reading text-base text-muted">
            Masuk untuk menyimpan riwayat bacaan Anda. Tanpa masuk, Anda
            tetap dapat mengunggah dan mendengarkan modul, tetapi riwayat
            tidak tersimpan.
          </p>

          <form
            onSubmit={handleEmailSubmit}
            className="max-w-reading space-y-3"
            aria-label={
              mode === 'signin' ? 'Formulir masuk akun' : 'Formulir daftar akun'
            }
          >
            <div className="space-y-1">
              <label
                htmlFor={emailId}
                className="block text-base font-semibold text-foreground"
              >
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
                className="min-h-11 w-full rounded-md border-2 border-border bg-surface px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor={passwordId}
                className="block text-base font-semibold text-foreground"
              >
                Kata sandi (minimal 6 karakter)
              </label>
              <input
                id={passwordId}
                type={showPassword ? 'text' : 'password'}
                autoComplete={
                  mode === 'signin' ? 'current-password' : 'new-password'
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={describedBy}
                className="min-h-11 w-full rounded-md border-2 border-border bg-surface px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-pressed={showPassword}
                className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-2 text-base font-medium text-accent underline"
              >
                <span>
                  {showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}
                </span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                aria-disabled={busy}
                aria-describedby={describedBy}
                className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-accent px-6 py-3 text-base font-semibold text-white hover:bg-accent-dark"
              >
                <span>
                  {busy
                    ? 'Memproses…'
                    : mode === 'signin'
                      ? 'Masuk'
                      : 'Daftar akun'}
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setMode((current) => (current === 'signin' ? 'signup' : 'signin'))
                }
                aria-disabled={busy}
                className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md px-2 text-base font-semibold text-accent underline"
              >
                <span>
                  {mode === 'signin'
                    ? 'Belum punya akun? Daftar'
                    : 'Sudah punya akun? Masuk'}
                </span>
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

          {onDismiss && (
            <p className="max-w-reading text-base text-muted">
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-2 text-base font-semibold text-accent underline"
              >
                <span>Lanjut tanpa masuk</span>
              </button>{' '}
              — Anda tetap dapat mengunggah, tetapi riwayat bacaan tidak akan
              tersimpan.
            </p>
          )}
        </div>
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

  if (message.includes('user already registered') || message.includes('already exists')) {
    return (
      'Email ini sudah terdaftar. Silakan masuk dengan kata sandi Anda ' +
      'alih-alih mendaftar.'
    );
  }
  if (message.includes('invalid login credentials')) {
    return 'Email atau kata sandi salah. Periksa kembali lalu coba lagi.';
  }
  if (message.includes('email not confirmed')) {
    return (
      'Email Anda belum diverifikasi. Periksa kotak masuk dan klik tautan ' +
      'verifikasi, lalu coba masuk lagi.'
    );
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
