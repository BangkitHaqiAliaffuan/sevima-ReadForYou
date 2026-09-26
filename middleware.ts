import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Middleware — menjaga sesi Supabase tetap segar di cookie.
 *
 * CATATAN DEPRESIASI (Next 16.3): build menyarankan konvensi `proxy.ts`
 * sebagai pengganti `middleware.ts`, tetapi berkas ini masih terdeteksi
 * dan berjalan ("Proxy (Middleware)" pada output build). Jangan migrasi
 * sebelum konvensi `proxy` terverifikasi di versi Next yang dipakai —
 * migrasi yang gagal membuat refresh sesi berhenti diam-diam.
 *
 * Tanpa ini, sesi yang dibuat di browser (masuk akun email) tidak
 * terbaca oleh Route Handler, sehingga cek kepemilikan dokumen di
 * /api/process-document selalu melihat pengguna sebagai "tanpa sesi".
 *
 * Hanya me-refresh token; tidak memblokir rute apa pun (pengguna yang
 * belum masuk tetap boleh mengunggah — itu keputusan produk, bukan tugas
 * middleware).
 */
export async function middleware(request: NextRequest): Promise<Response> {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Env belum diisi (mis. CI tanpa .env): lewatkan tanpa menyentuh sesi
  // agar build/lint tidak gagal karena middleware.
  if (!url || !anonKey) return supabaseResponse;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // getUser memicu refresh token bila kedaluwarsa; hasilnya sengaja tidak
  // dipakai di sini — otorisasi terjadi di masing-masing Route Handler.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
