'use client';

/**
 * useAnnouncer — antrean pengumuman untuk screen reader.
 *
 * KENAPA PERLU ANTREAN DAN THROTTLE:
 *
 * `aria-live` bukan saluran yang bisa dilewati begitu saja. Bila kita
 * menulis ke region live terlalu sering (misalnya "12 persen", "13 persen",
 * "14 persen" dalam rentang satu detik), pembaca layar akan mengantre
 * puluhan pengumuman. Akibatnya pengguna mendengar kabar yang sudah usang,
 * dan informasi penting seperti "selesai" tertunda berdetik-detik.
 *
 * Beberapa aturan yang diterapkan:
 *  - Pesan penting (`priority: 'assertive'`) selalu diteruskan segera dan
 *    membatalkan antrean progres yang menunggu.
 *  - Pesan progres di-throttle berdasarkan kunci, sehingga "progres unggah"
 *    dan "progres ekstraksi" tidak saling menggeser.
 *  - Pesan identik berulang diabaikan agar tidak diulang dua kali.
 *
 * Komponen yang menampilkannya ada di `components/LiveStatus.tsx`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type AnnouncementPriority = 'polite' | 'assertive';

export interface Announcement {
  id: number;
  message: string;
  priority: AnnouncementPriority;
  /** Kunci penggabungan; pesan dengan kunci sama akan menimpa yang lama. */
  key?: string;
}

export interface UseAnnouncerResult {
  /** Pesan yang sedang ada di region polite. */
  politeMessage: string;
  /** Pesan yang sedang ada di region assertive. */
  assertiveMessage: string;
  /** Kirim pengumuman baru. */
  announce: (
    message: string,
    options?: { priority?: AnnouncementPriority; key?: string },
  ) => void;
  /** Bersihkan region (dipakai saat mengulang alur dari awal). */
  clear: () => void;
}

/** Jeda minimum antar pengumuman dengan kunci yang sama. */
const THROTTLE_MS = 1200;

export function useAnnouncer(): UseAnnouncerResult {
  const [politeMessage, setPoliteMessage] = useState('');
  const [assertiveMessage, setAssertiveMessage] = useState('');

  const counterRef = useRef(0);
  const lastByKey = useRef<Map<string, { at: number; message: string }>>(
    new Map(),
  );
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /**
   * Screen reader hanya mengumumkan saat isi node *berubah*. Bila kita
   * mengirim pesan yang sama persis dua kali, tidak ada pengumuman kedua.
   * Karena itu kita membersihkan node lebih dulu, lalu mengisinya lagi
   * pada frame berikutnya.
   */
  const commit = useCallback(
    (message: string, priority: AnnouncementPriority) => {
      const setter = priority === 'assertive' ? setAssertiveMessage : setPoliteMessage;

      setter('');
      const timer = setTimeout(() => {
        timersRef.current.delete(timer);
        setter(message);
      }, 80);
      timersRef.current.add(timer);
    },
    [],
  );

  const announce = useCallback<UseAnnouncerResult['announce']>(
    (message, options) => {
      const trimmed = message.trim();
      if (trimmed.length === 0) return;

      const priority = options?.priority ?? 'polite';
      const key = options?.key;
      const now = Date.now();

      if (key) {
        const previous = lastByKey.current.get(key);

        // Pesan sama persis dalam rentang throttle: abaikan.
        if (previous && previous.message === trimmed && now - previous.at < THROTTLE_MS) {
          return;
        }

        // Pesan berbeda dengan kunci sama masih di-throttle supaya tidak
        // membanjiri pengguna dengan kabar progres yang terlalu rinci.
        if (
          previous &&
          priority === 'polite' &&
          now - previous.at < THROTTLE_MS &&
          isSameProgressKind(previous.message, trimmed)
        ) {
          return;
        }

        lastByKey.current.set(key, { at: now, message: trimmed });
      }

      counterRef.current += 1;
      commit(trimmed, priority);
    },
    [commit],
  );

  const clear = useCallback(() => {
    setPoliteMessage('');
    setAssertiveMessage('');
    lastByKey.current.clear();
  }, []);

  return { politeMessage, assertiveMessage, announce, clear };
}

/**
 * Deteksi apakah dua pesan merupakan jenis progres yang sama, misalnya
 * "Sedang mengunggah, 20 persen" dan "Sedang mengunggah, 25 persen".
 * Dipakai agar throttle progres tidak memblokir pesan penting yang
 * kebetulan punya kunci sama.
 */
function isSameProgressKind(a: string, b: string): boolean {
  const stripNumbers = (value: string) => value.replace(/\d+/g, '#');
  return stripNumbers(a) === stripNumbers(b);
}
