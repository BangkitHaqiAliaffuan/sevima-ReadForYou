import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { Navbar } from "@/components/Navbar";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * `lang="id"` pada elemen <html> BUKAN sekadar hiasan.
 *
 * Screen reader memilih aturan pelafalan dan kamus berdasarkan nilai ini.
 * Tanpa `lang`, VoiceOver dapat membacakan teks Indonesia dengan logat
 * Inggris, dan pengguna harus menebak-nebak kata yang terdengar aneh.
 * Ini termasuk kriteria WCAG 3.1.1 (Language of Page) tingkat A.
 */
export const metadata: Metadata = {
  title: "AI ReadForYou — Pembaca Modul untuk Semua",
  description:
    "Unggah modul pelajaran dalam format PDF atau gambar, lalu dengarkan " +
    "isinya dibacakan dengan suara alami. Dirancang untuk siswa " +
    "penyandang disabilitas penglihatan, sepenuhnya dapat dioperasikan " +
    "dengan keyboard.",
  applicationName: "AI ReadForYou",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /*
   * Jangan pernah set maximumScale menjadi 1. Itu mematikan zoom dan
   * melanggar WCAG 1.4.4 (Resize Text). Pengguna low vision berhak
   * memperbesar halaman.
   */
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/*
          Tautan lewati navigasi WAJIB menjadi elemen pertama yang dapat
          difokus di halaman. Kelasnya menempatkannya di luar layar
          sampai ia menerima fokus (WCAG 2.4.1 Bypass Blocks).
        */}
        <a href="#konten-utama" className="skip-link">
          Lewati ke konten utama
        </a>

        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
          {/* Navbar (brand + status masuk) tepat setelah skip-link agar
              tetap menjadi landmark pertama setelah lompatan. */}
          <Navbar />

          <header className="mt-6 mb-8 border-b-2 border-border pb-6">
            <h1 className="mt-1 text-3xl leading-tight font-bold text-foreground sm:text-4xl">
              Pembaca modul pelajaran untuk semua siswa
            </h1>
            <p className="mt-3 max-w-reading text-base text-muted">
              Unggah modul dalam format PDF atau gambar. Sistem akan mengubah
              isinya menjadi teks yang mengalir, lalu membacakannya dengan suara
              alami. Seluruh fitur dapat digunakan dengan keyboard saja.
            </p>
          </header>

          <main id="konten-utama" className="flex-1 space-y-10 pb-16">
            {children}
          </main>

          <footer className="border-t-2 border-border pt-6">
            <p className="text-sm text-muted">
              Aplikasi ini dirancang mengikuti pedoman WCAG 2.1 tingkat AA.
              Bila Anda menemukan hambatan aksesibilitas, laporkan kepada
              pengelola agar dapat segera diperbaiki.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
