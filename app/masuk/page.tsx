import type { Metadata } from 'next';

import { MasukClient } from './MasukClient';

export const metadata: Metadata = {
  title: 'Masuk — AI ReadForYou',
  description:
    'Masuk sebagai tamu dengan satu ketukan atau dengan akun email ' +
    'untuk menyimpan riwayat bacaan modul pelajaran Anda.',
};

interface MasukPageProps {
  /**
   * Next 15+: searchParams berupa Promise di Server Component.
   * `redirect` adalah path tujuan setelah masuk permanen
   * (mis. `/masuk?redirect=/`). Validasi dilakukan di klien.
   */
  searchParams: Promise<{ redirect?: string | string[] }>;
}

export default async function MasukPage({ searchParams }: MasukPageProps) {
  const params = await searchParams;
  const raw = params.redirect;
  const redirect = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);

  return <MasukClient redirectParam={redirect} />;
}
