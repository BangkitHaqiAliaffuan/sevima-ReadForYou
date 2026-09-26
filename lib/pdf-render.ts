/**
 * Render PDF menjadi gambar — AI ReadForYou
 * ==========================================
 *
 * KENAPA MODUL INI ADA
 * --------------------
 * Ini bukan optimasi, melainkan syarat agar AI-nya dapat dipakai.
 *
 * Gateway 9router (dan endpoint `chat/completions` pada umumnya) hanya
 * menerima GAMBAR di part `image_url`. Mengirim PDF di sana ditolak
 * gateway dengan `400 model_param_invalid`. Cara-cara lain — part `file`,
 * `file_data`, maupun `input_file` — diterima secara HTTP tetapi isinya
 * TIDAK sampai ke model: model menjawab "berkas tidak dilampirkan" atau,
 * lebih berbahaya, MENGARANG isi dokumen.
 *
 * Semua itu sudah diuji; buktinya ada di `scripts/probe-9router-pdf.py`.
 * Kesimpulannya satu: untuk memakai model vision lewat gateway ini, PDF
 * harus diubah lebih dulu menjadi gambar per halaman.
 *
 * HASIL SAMPINGAN YANG MENGUNTUNGKAN
 * ----------------------------------
 * Ekstraksi menjadi per-halaman, bukan satu permintaan besar. Ini juga
 * memperbaiki kelemahan lama: pada pendekatan "satu permintaan untuk
 * seluruh PDF", keluaran dapat terpotong diam-diam di tengah bab. Dengan
 * per-halaman, setiap halaman dilaporkan selesai secara terpisah melalui
 * `onPage`, sehingga UI dapat mengumumkan progres kepada screen reader
 * dan kegagalan satu halaman tidak menjatuhkan seluruh dokumen.
 *
 * KETERGANTUNGAN SISTEM
 * --------------------
 * Modul ini memanggil `pdftoppm` dari paket Poppler lewat `execFile` —
 * tanpa shell, sehingga nama berkas tidak dapat menjadi perintah. Poppler
 * dipilih karena sudah terpasang di mayoritas lingkungan Linux dan
 * menghasilkan PNG bersih pada DPI yang kita tentukan.
 *
 * Bila `pdftoppm` tidak ada, modul ini TIDAK diam-diam gagal: ia melempar
 * `AppError('CONFIG', ...)` dengan instruksi pemasangan yang spesifik.
 * Kegagalan yang tidak terlihat adalah masalah yang sedang kita berantas;
 * jangan menambah satu pun yang baru.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { AppError } from '@/lib/api-error';

const execFileAsync = promisify(execFile);

/**
 * Resolusi render.
 *
 * 150 DPI dipilih dari pengukuran, bukan tebakan: pada 96 DPI teks kecil
 * pada modul pelajaran mulai sulit dibaca model, sedangkan 200 DPI ke
 * atas memperbesar payload base64 tanpa menambah ketepatan yang berarti.
 * 150 DPI menyeimbangkan keduanya.
 */
const RENDER_DPI = 150;

/** Plafon halaman agar satu PDF raksasa tidak menghabiskan kuota. */
export const MAX_RENDERED_PAGES = 40;

/** Plafon waktu untuk satu proses render. */
const RENDER_TIMEOUT_MS = 120_000;

export interface RenderedPage {
  /** Nomor halaman, dimulai dari 1. */
  pageNumber: number;
  /** PNG siap dikirim sebagai `data:image/png;base64,...`. */
  png: Buffer;
}

export interface RenderPdfOptions {
  /** Batas halaman. Bila nol atau kosong, memakai `MAX_RENDERED_PAGES`. */
  maxPages?: number;
  /** Dipanggil setiap halaman selesai dirender, untuk progres aksesibel. */
  onPage?: (info: { pageNumber: number; total: number }) => void;
}

export interface RenderPdfResult {
  pages: RenderedPage[];
  /** Perkiraan jumlah halaman di dokumen (bisa lebih besar dari `pages`). */
  totalPages: number;
  /** true bila `pages` lebih sedikit dari `totalPages`. */
  truncated: boolean;
}

/** Apakah `pdftoppm` tersedia di lingkungan ini? */
export async function isPdfRendererAvailable(): Promise<boolean> {
  try {
    await execFileAsync('pdftoppm', ['-v'], { timeout: 10_000 });
    return true;
  } catch (err) {
    // `pdftoppm -v` menulis versi ke stderr lalu keluar dengan status
    // bukan-nol pada sebagian build, jadi ENOENT adalah satu-satunya tanda
    // yang benar-benar berarti "tidak terpasang".
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    return code !== 'ENOENT';
  }
}

/**
 * Hitung halaman PDF dengan `pdfinfo` bila ada.
 *
 * Bila `pdfinfo` tidak tersedia, kembalikan 0 dan biarkan pemanggil
 * menyimpulkan jumlah sebenarnya dari hasil render. Tidak ada gunanya
 * menggagalkan seluruh proses hanya karena hitungan awal tidak tersedia.
 */
async function countPdfPages(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [filePath], {
      timeout: 20_000,
    });
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    return match ? Number.parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Render setiap halaman PDF menjadi PNG.
 *
 * PDF ditulis dulu ke berkas sementara karena `pdftoppm` bekerja pada
 * berkas, bukan pada stdin. Direktori sementara selalu dibersihkan di
 * blok `finally`, termasuk saat terjadi galat.
 */
export async function renderPdfPages(
  pdf: Uint8Array,
  options: RenderPdfOptions = {},
): Promise<RenderPdfResult> {
  if (pdf.length === 0) {
    throw new AppError('BAD_REQUEST', 'PDF kosong, tidak ada yang dapat dirender.');
  }

  const workdir = await mkdtemp(join(tmpdir(), 'r4y-pdf-'));

  try {
    const pdfPath = join(workdir, 'input.pdf');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(pdfPath, pdf);

    const totalPages = await countPdfPages(pdfPath);
    const limit =
      options.maxPages && options.maxPages > 0
        ? Math.min(options.maxPages, MAX_RENDERED_PAGES)
        : MAX_RENDERED_PAGES;

    try {
      await execFileAsync(
        'pdftoppm',
        [
          '-png',
          '-r', String(RENDER_DPI),
          // Hentikan setelah `limit` halaman supaya PDF raksasa tidak
          // menghabiskan kuota model.
          '-f', '1',
          '-l', String(limit),
          pdfPath,
          join(workdir, 'page'),
        ],
        { timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;

      if (code === 'ENOENT') {
        throw new AppError(
          'CONFIG',
          'Pengubah PDF menjadi gambar (pdftoppm) tidak terpasang di server. ' +
            'Pasang paket Poppler lebih dulu — Debian/Ubuntu: `sudo apt install poppler-utils`; ' +
            'macOS: `brew install poppler`.',
        );
      }

      const detail = err instanceof Error ? err.message : String(err);
      throw new AppError(
        'UNSUPPORTED_TYPE',
        `PDF gagal diubah menjadi gambar. Kemungkinan berkas rusak atau ` +
          `dilindungi kata sandi. Rincian: ${detail}`,
      );
    }

    // `pdftoppm` memberi nama dengan jumlah digit yang menyesuaikan jumlah
    // halaman (page-1.png untuk <10, page-01.png untuk >=10), jadi urutan
    // TIDAK boleh mengandalkan `localeCompare`. Kita mengurutkan numerik
    // demi memastikan halaman tetap pada urutan bacaan yang benar.
    const entries = (await readdir(workdir)).filter((name) =>
      /^page-\d+\.png$/.test(name),
    );

    const numbered = entries
      .map((name) => ({
        name,
        pageNumber: Number.parseInt(/page-(\d+)\.png/.exec(name)?.[1] ?? '0', 10),
      }))
      .filter((entry) => entry.pageNumber > 0)
      .sort((a, b) => a.pageNumber - b.pageNumber);

    const pages: RenderedPage[] = [];
    for (const entry of numbered) {
      pages.push({
        pageNumber: entry.pageNumber,
        png: await readFile(join(workdir, entry.name)),
      });
      options.onPage?.({ pageNumber: entry.pageNumber, total: numbered.length });
    }

    if (pages.length === 0) {
      throw new AppError(
        'UNSUPPORTED_TYPE',
        'Tidak ada halaman yang berhasil dirender dari PDF ini.',
      );
    }

    const effectiveTotal = totalPages > 0 ? totalPages : pages.length;

    return {
      pages,
      totalPages: effectiveTotal,
      truncated: effectiveTotal > pages.length,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {
      // Pemadaman direktori sementara tidak boleh menutupi galat aslinya.
    });
  }
}
