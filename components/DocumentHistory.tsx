'use client';

/**
 * DocumentHistory — riwayat bacaan milik pengguna yang masuk.
 *
 * Hanya dirender bila ada sesi (tamu murni tanpa sesi tidak punya
 * riwayat — halaman menampilkan penjelasan jujur sebagai gantinya,
 * bukan galat). Baris diambil lewat RLS `owner_select`, jadi pengguna
 * hanya melihat miliknya sendiri. Teks lengkap dimuat on-demand per
 * dokumen agar daftar tetap ringan.
 */

import { useCallback, useEffect, useId, useState } from 'react';

import { getBrowserSupabase } from '@/lib/supabase';

export interface HistoryItem {
  id: string;
  file_name: string;
  status: string;
  page_count: number | null;
  created_at: string;
}

export interface DocumentHistoryProps {
  /** Null bila tamu murni — komponen mengembalikan penjelasan. */
  userId: string | null;
  /** Dipanggil saat pengguna memilih "Bacakan lagi". */
  onReplay: (item: { text: string; name: string; wordCount: number }) => void;
  announce: (
    message: string,
    options?: { priority?: 'polite' | 'assertive'; key?: string },
  ) => void;
}

export function DocumentHistory({ userId, onReplay, announce }: DocumentHistoryProps) {
  const headingId = useId();

  if (!userId) {
    return (
      <section aria-labelledby={headingId} className="space-y-4">
        <h2 id={headingId} className="text-2xl font-bold text-foreground">
          Riwayat bacaan
        </h2>
        <p className="max-w-reading text-base text-muted">
          Anda melanjutkan tanpa masuk, sehingga riwayat bacaan tidak
          tersimpan. Masuk sebagai tamu di bagian atas halaman bila ingin
          bacaan tersimpan otomatis.
        </p>
      </section>
    );
  }

  /* `key` me-reset state daftar saat akun berganti — tanpa setState di efek. */
  return (
    <HistoryList
      key={userId}
      userId={userId}
      onReplay={onReplay}
      announce={announce}
    />
  );
}

/**
 * Daftar riwayat untuk satu akun. `items === null` berarti sedang memuat
 * (state awal), sehingga efek hanya menulis state di kelanjutan async
 * setelah `await` — pola yang sama dipakai `app/page.tsx#fetchVoices`.
 */
function HistoryList({
  userId,
  onReplay,
  announce,
}: {
  userId: string;
  onReplay: DocumentHistoryProps['onReplay'];
  announce: DocumentHistoryProps['announce'];
}) {
  const headingId = useId();
  const errorId = useId();

  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchHistory() {
      try {
        const supabase = getBrowserSupabase();
        const { data, error: queryError } = await supabase
          .from('documents')
          .select('id, file_name, status, page_count, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(20);

        if (cancelled) return;
        if (queryError) throw queryError;

        const rows = (data ?? []) as HistoryItem[];
        setItems(rows);
        if (rows.length > 0) {
          announce(`Ditemukan ${rows.length} bacaan tersimpan.`, { key: 'history' });
        }
      } catch {
        if (cancelled) return;
        const message =
          'Riwayat bacaan tidak dapat dimuat. Periksa sambungan internet Anda lalu muat ulang halaman.';
        setError(message);
        announce(message, { priority: 'assertive', key: 'history-error' });
      }
    }

    void fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [userId, announce]);

  const handleReplay = useCallback(
    (item: HistoryItem) => {
      if (replayingId !== null) return;
      setReplayingId(item.id);
      announce(`Memuat bacaan ${item.file_name}.`, { key: 'history' });
      void (async () => {
        try {
          const supabase = getBrowserSupabase();
          const { data, error: queryError } = await supabase
            .from('documents')
            .select('extracted_text, file_name')
            .eq('id', item.id)
            .maybeSingle<{ extracted_text: string | null; file_name: string }>();

          if (queryError) throw queryError;
          const text = data?.extracted_text?.trim() ?? '';
          if (text.length === 0) {
            throw new Error('empty');
          }
          onReplay({
            text,
            name: data?.file_name ?? item.file_name,
            wordCount: countWords(text),
          });
        } catch {
          const message =
            `Bacaan ${item.file_name} tidak dapat dimuat. ` +
            'Dokumen mungkin belum selesai diproses saat itu.';
          setError(message);
          announce(message, { priority: 'assertive', key: 'history-error' });
        } finally {
          setReplayingId(null);
        }
      })();
    },
    [replayingId, announce, onReplay],
  );

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 id={headingId} className="text-2xl font-bold text-foreground">
        Riwayat bacaan
      </h2>

      {items === null && !error && (
        <p className="text-base text-muted">Sedang memuat riwayat bacaan.</p>
      )}

      {error && (
        <p
          id={errorId}
          className="max-w-reading rounded-md border-2 border-danger bg-danger/5 px-4 py-3 text-base font-medium text-danger"
        >
          {error}
        </p>
      )}

      {items !== null && !error && items.length === 0 && (
        <p className="max-w-reading text-base text-muted">
          Belum ada bacaan tersimpan. Unggah modul pertama Anda di bagian
          atas halaman ini.
        </p>
      )}

      {items !== null && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-foreground">
                  {item.file_name}
                </p>
                <p className="text-sm text-muted">
                  {formatHistoryDate(item.created_at)}
                  {typeof item.page_count === 'number' && item.page_count > 0
                    ? ` — ${item.page_count} halaman`
                    : ''}
                  {item.status !== 'ready' ? ` — status: ${item.status}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleReplay(item)}
                aria-disabled={replayingId !== null}
                aria-label={`Bacakan lagi ${item.file_name}`}
                className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border-2 border-accent px-5 py-2 text-base font-semibold text-accent hover:bg-accent/5"
              >
                <span>
                  {replayingId === item.id ? 'Memuat…' : 'Bacakan lagi'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "12 Sep 2026, 14.30" — format Indonesia yang enak dibacakan SR. */
function formatHistoryDate(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return '';
  }
}

/** Hitung kata — selaras dengan penghitung server (regex Unicode). */
function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}
