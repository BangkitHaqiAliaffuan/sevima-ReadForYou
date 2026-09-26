# AI ReadForYou

Aplikasi web untuk membantu siswa penyandang disabilitas penglihatan membaca
modul pelajaran. Unggah berkas PDF atau gambar, sistem mengekstrak isinya
menjadi teks yang mengalir, lalu membacakannya dengan suara alami Microsoft
Edge.

Dirancang mengikuti **WCAG 2.1 tingkat AA** dan dapat dioperasikan
sepenuhnya dengan keyboard.

---

## Menjalankan proyek

### 1. Pasang dependensi

```bash
npm install
```

### 2. Siapkan Supabase

1. Buat proyek di <https://supabase.com>.
2. Buka **SQL Editor**, tempel seluruh isi `supabase/schema.sql`, lalu jalankan.
   Skrip ini membuat tabel `documents`, bucket penyimpanan `modules`, dan
   kebijakan keamanannya.
3. Buka **Project Settings → API**, catat `Project URL`, `anon public key`,
   dan `service_role key`.

### 3. Dapatkan kunci Gemini

Buat kunci di <https://aistudio.google.com/apikey>.

### 4. Isi berkas lingkungan

```bash
cp .env.local.example .env.local
```

Lalu isi:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3.8-flash
```

> **Keamanan:** `SUPABASE_SERVICE_ROLE_KEY` dan `GEMINI_API_KEY` **tidak boleh**
> memakai awalan `NEXT_PUBLIC_`. Keduanya hanya dipakai di server.
> Aplikasi akan melempar kesalahan bila kunci ini sampai dipanggil dari
> komponen klien.

> **Fitur suara tidak butuh kunci.** `msedge-tts` memakai API Read Aloud
> Microsoft Edge secara langsung, jadi tidak ada variabel lingkungan untuk TTS.

### 4b. (Opsional) Pakai 9router saat development

Selama pengembangan, aplikasi dapat memanggil sebuah gateway
OpenAI-compatible (9router) lebih dulu, dengan Gemini otomatis mengambil
alih bila gateway itu bermasalah. Tambahkan ke `.env.local`:

```bash
LLM_API_KEY=sk-...
LLM_BASE_URL=http://localhost:20128/v1
LLM_MODEL=cbai/deepseek-v4.1-flash
LLM_PROVIDER_ORDER=9router,gemini
```

Biarkan `LLM_API_KEY` kosong (atau hapus keempat barisnya) untuk memakai
Gemini saja — perilaku produksi. Urutan `LLM_PROVIDER_ORDER` dibaca
kiri-ke-kanan; provider yang kuncinya kosong akan dilewati, bukan
menggagalkan permintaan.

Model yang dipilih untuk `LLM_MODEL` **harus** menerima gambar (vision)
dan mematuhi `response_format: json_object`, karena ekstraksi dokumen
mengirim berkas biner dan mengharapkan balasan JSON.

Untuk memastikan jalurnya benar-benar hidup tanpa mengunggah dokumen:

```bash
curl -X POST http://localhost:3000/api/llm/test
curl -X POST 'http://localhost:3000/api/llm/test?mode=extract'
```

Rute itu hanya aktif saat bukan produksi, atau bila `ALLOW_LLM_TEST=1`.

**Penting soal PDF:** gateway hanya bisa membaca **gambar**, bukan PDF.
Karena itu aplikasi merender PDF menjadi gambar per halaman lebih dulu
(memakai `pdftoppm` dari paket Poppler). Pasang lebih dulu:

```bash
sudo apt install poppler-utils     # Debian/Ubuntu
brew install poppler              # macOS
```

Bila Poppler tidak terpasang, ekstraksi PDF otomatis dialihkan ke Gemini
(yang memang menerima PDF secara native) — aplikasi tetap jalan, tetapi
kuota Gemini terpakai.

**Bila muncul "Layanan kecerdasan buatan sedang bermasalah":** jalankan
`POST /api/llm/test` di atas. Responsnya memuat field `error.cause` yang
menyebutkan penyebab sebenarnya per provider (kuota habis, kunci ditolak,
jaringan mati, atau bentuk permintaan ditolak). Saat produksi
(`NODE_ENV=production`) rincian itu sengaja tidak dikirim.

### 5. Jalankan

```bash
npm run dev
```

Buka <http://localhost:3000>.

---

## Perintah verifikasi

```bash
npx tsc --noEmit   # pemeriksaan tipe
npm run lint       # eslint (Next 16, flat config)
npm run build      # build produksi
```

Uji kelayakan layanan suara (memastikan msedge-tts dan suara Indonesia
benar-benar tersedia):

```bash
node --experimental-strip-types scripts/probe-tts.mts
```

---

## Peringatan penting: model Gemini

`gemini-1.5-flash` yang disebut pada brief awal **sudah dinonaktifkan oleh
Google**. Permintaan ke model itu sekarang gagal. Hal yang sama berlaku untuk
`gemini-2.0-flash` (dinonaktifkan 1 Juni 2026).

Rujukan resmi: <https://ai.google.dev/gemini-api/docs/deprecations>

Aplikasi ini memakai `gemini-3.8-flash` sebagai default dan **berpindah
otomatis** ke model cadangan bila model utama tidak ditemukan. Model diatur
lewat variabel lingkungan, jadi Anda tidak perlu mengubah kode untuk
berganti model.

---

## Arsitektur suara

Aplikasi ini **tidak** memakai `window.speechSynthesis`. Audio disintesis di
server memakai `msedge-tts` karena modul itu memerlukan WebSocket dan modul
Node yang tidak ada di peramban.

| Aspek | speechSynthesis | msedge-tts (yang dipakai) |
|---|---|---|
| Kualitas | suara sistem, sering robotik | neural Microsoft, natural |
| Ketersediaan | bergantung suara terpasang di perangkat | konsisten di mana pun |
| Kontrol | Pause tidak andal | `<audio>`, presisi penuh |
| Biaya | gratis, lokal | satu permintaan per kalimat |

**Alur:** klien memecah teks menjadi kalimat → `POST /api/tts` per kalimat →
server menyintesis MP3 → klien memutar berurutan sambil **memuat kalimat
berikutnya lebih awal** sehingga jeda antar kalimat nyaris tidak terasa.

**Jaring pengaman:** bila endpoint suara gagal tiga kali berturut-turut,
pemutar otomatis beralih ke suara bawaan peramban dan memberi tahu pengguna.
Demo tidak akan mati total karena layanan pihak ketiga bermasalah.

---

## Struktur proyek

```
app/
  api/
    process-document/route.ts   Ekstraksi teks via Gemini (mengamankan kunci)
    tts/route.ts                Sintesis suara per kalimat (msedge-tts)
    voices/route.ts             Daftar suara Indonesia
  layout.tsx                    lang="id", tautan lewati navigasi
  page.tsx                      Halaman utama
  globals.css                   Token warna, sr-only, fokus, preferensi
components/
  UploadModule.tsx              Antarmuka unggah yang aksesibel
  AudioPlayer.tsx               Pemutar suara (Putar/Jeda/Lanjut/Hentikan)
  LiveStatus.tsx                Dua region live terpisah
hooks/
  useServerAudio.ts             Antrean audio + preload + fallback
  useAnnouncer.ts               Antrean pengumuman yang dibatasi
lib/
  supabase.ts                   Klien browser & server
  gemini.ts                     Model, skema keluaran, cadangan, timeout
  chunk-text.ts                 Pemecah kalimat & normalisasi teks
  validate-file.ts              Validasi MIME + magic bytes
  rate-limit.ts                 Pembatas laju per jalur
  api-error.ts                  Bentuk galat terpusat
  tts/
    synthesize.ts               Pembungkus msedge-tts (khusus server)
    estimate.ts                 Estimasi durasi (aman untuk klien)
scripts/
  probe-tts.mts                 Uji kelayakan layanan suara
supabase/
  schema.sql                    Tabel, bucket, kebijakan
```

### Catatan penting soal impor

`lib/tts/estimate.ts` **dipisahkan** dari `lib/tts/synthesize.ts` dengan
sengaja. `synthesize.ts` mengimpor `msedge-tts` yang memerlukan `fs` dan
`stream` — modul Node. Bila komponen klien mengimpor dari `synthesize`,
seluruh rantai server ikut masuk ke bundle browser dan build gagal dengan
`Module not found: Can't resolve 'fs'`.

Kesalahan ini **tidak tertangkap** oleh `tsc` maupun `eslint`, karena
keduanya hanya memeriksa tipe, bukan grafik modul. Hanya `npm run build`
yang menangkapnya. Jadi selalu jalankan build sebelum menganggap perubahan
selesai.

---

## Hasil verifikasi

| Pemeriksaan | Perintah | Hasil |
|---|---|---|
| Pemeriksaan tipe | `npx tsc --noEmit` | ✅ lulus |
| Lint | `npm run lint` | ✅ 0 error, 0 warning |
| Build produksi | `npm run build` | ✅ 5 rute terbentuk |
| Endpoint suara | uji manual | ✅ MP3 valid 24 kHz mono |
| DOM aksesibilitas | uji di peramban | ✅ lihat tabel di bawah |

### Verifikasi aksesibilitas di peramban

| Pemeriksaan | Hasil |
|---|---|
| Region live | 1 `status` + 1 `alert`, keduanya `aria-atomic="true"` |
| Tombol tanpa nama aksesibel | 0 dari 5 |
| Tombol memakai `disabled` | **0** — semuanya `aria-disabled` agar tetap fokusable |
| SVG bocor ke aksesibilitas | 0 dari 6 |
| Input berkas dapat difokus | ya (`clip: rect(0,0,0,0)`, bukan `display:none`) |
| `lang` dokumen | `id` |
| Rasio kontras terukur | 7,28 – 18,88 (minimum WCAG 4,5) |
| Target sentuh < 44px | 0 |

### Bug yang ditemukan dan diperbaiki selama pengerjaan

1. **Pemecah kalimat melumat kalimat pendek.** "Satu. Dua. Tiga." menjadi satu
   blok, sehingga pemutar kehilangan kemampuan melompat antar kalimat.
2. **Target sentuh `<summary>` hanya 27px.** Dinaikkan ke 44px (WCAG 2.5.8).
3. **Modul server bocor ke bundle klien.** Ditemukan hanya oleh `next build`.
4. **`kind` tidak diteruskan ke prompt.** Dokumen tanpa jenis eksplisit
   kehilangan instruksi prompt khusus.
5. **Rekursi tanpa batas pada antrean audio.** Ditemukan oleh aturan
   `react-hooks` baru di Next 16.

---

## Cara menguji aksesibilitas sendiri

### Uji keyboard saja (tanpa mouse)

1. Tekan `Tab` dari awal halaman. Muncul tautan **"Lewati ke konten utama"**.
2. Tekan `Tab` lagi sampai tiba di **"Pilih berkas modul"**.
3. Tekan `Enter`. Dialog pemilih berkas sistem operasi terbuka.
4. Setelah teks siap, fokus berpindah otomatis ke judul **"Teks hasil ekstraksi"**.
5. `Tab` masuk ke kontrol pemutar. `Enter` mengaktifkan tombol.

Semua elemen harus terlihat jelas fokusnya. Tidak ada kontrol yang boleh
hanya berupa ikon tanpa nama.

### Uji dengan pembaca layar

| Pembaca layar | Sistem | Cara |
|---|---|---|
| NVDA | Windows | Unduh gratis di nvaccess.org |
| VoiceOver | macOS | `Cmd + F5` |
| Orca | Linux | `orca --setup` |

Saat mengunggah berkas, Anda harus mendengar pengumuman berurutan:

1. "Mulai mengunggah berkas ... berukuran ... megabita."
2. "Berkas berhasil diunggah. Sekarang sistem mulai memproses teks."
3. "Sedang mengekstrak teks, 30 persen." dan seterusnya.
4. "Proses selesai. Teks siap dibacakan, berisi ... kata, ..."

### Uji visual

- Setiap kotak dan teks harus memiliki kontras minimal 4,5:1.
- Perbesar halaman sampai 200%. Tata letak tidak boleh rusak.
- Aktifkan "reduce motion" di sistem operasi. Animasi harus berhenti.

---

## Keputusan yang memerlukan perhatian Anda

### 1. Aplikasi berjalan tanpa autentikasi

Tahap MVP ini belum memakai Supabase Auth. Artinya:

- Siapa pun yang memiliki anon key dapat mengunggah berkas.
- Server tidak dapat memverifikasi bahwa dokumen yang diminta milik pengguna
  yang memintanya (risiko IDOR).

Pertahanan yang sudah terpasang: pembatas laju terpisah per jalur (20 per
menit untuk ekstraksi, 120 per menit untuk suara), batas ukuran 20 MB, dan
validasi jenis berkas dari magic bytes.

**Jangan menjalankan mode ini di produksi tanpa lebih dulu mengaktifkan
autentikasi.**

### 2. Layanan suara pihak ketiga

`msedge-tts` memakai API Read Aloud Microsoft Edge yang **tidak berdokumen
resmi** dan dapat berubah tanpa pemberitahuan. Jaring pengaman ke
`speechSynthesis` sudah terpasang, tetapi kualitas suaranya akan berbeda.

### 3. Ekstraksi dokumen panjang

Model Flash memiliki batas keluaran sekitar 65.000 token. Bila dokumen
melebihi batas itu, bagian akhir akan hilang. Aplikasi ini **mendeteksi dan
mengumumkan** kondisi tersebut, serta menyarankan pemisahan berkas per bab.

### 4. Pembatas laju disimpan di memori

Pada penerapan serverless (mis. Vercel), setiap instansi memiliki penghitung
sendiri, sehingga batas efektif berlipat. Cukup untuk MVP, tidak cukup untuk
produksi. Ganti dengan Upstash Redis bila diperlukan — antarmuka fungsinya
sudah dibuat kecil agar penggantian hanya menyentuh satu berkas.

---

## Autentikasi (anonim + email, tamu tetap boleh)

Aplikasi memakai tiga mode dalam satu alur:

1. **Tamu tanpa masuk** — langsung unggah; riwayat tidak tersimpan.
2. **Tamu anonim** — satu ketukan "Masuk sebagai tamu"
   (`signInAnonymously`, tanpa formulir agar ramah screen reader);
   berkas terikat uid anonim dan memiliki riwayat.
3. **Akun permanen** — upgrade dari tamu via `updateUser({ email,
   password })` sehingga uid dan riwayat tetap sama; perangkat lain
   memakai "Masuk dengan email" (`signInWithPassword`).

Prasyarat dasbor Supabase (sekali saja):

1. **Authentication → Providers** → aktifkan **Anonymous Sign-Ins**
   dan **Email**.
2. **SQL Editor** → jalankan `supabase/schema.sql` (bila belum),
   lalu `supabase/migration_auth_anon.sql`. Migrasi ini mempersempit
   `mvp_anon_select` ke baris tanpa pemilik (`user_id IS NULL`) dan
   mengunci unggahan anon ke folder `anonim/` — tanpa ini, tamu tanpa
   sesi dapat membaca dokumen milik akun lain.

Penegakan di kode: `middleware.ts` menyegarkan sesi cookie,
`app/api/process-document/route.ts` memverifikasi `user_id` pemilik
(milik akun lain ditolak sebagai "tidak ditemukan") dan memvalidasi
prefix folder path fallback. Rate limit per akun (`user:<id>`) untuk
yang masuk, per IP untuk tamu.

---

## Pemecahan masalah

| Gejala | Penyebab | Tindakan |
|---|---|---|
| "Konfigurasi Supabase publik belum lengkap" | `.env.local` belum dibuat atau kosong | Salin `.env.local.example`, isi nilainya, jalankan ulang `npm run dev` |
| "Tempat penyimpanan berkas modules belum dibuat" | `supabase/schema.sql` belum dijalankan | Jalankan skrip itu di SQL Editor |
| "Model kecerdasan buatan tidak tersedia" | Semua model di rantai gagal | Periksa `GEMINI_MODEL` dan `GEMINI_FALLBACK_MODELS` |
| Suara tidak keluar, pesan fallback muncul | Endpoint suara gagal 3 kali | Sistem otomatis beralih ke suara peramban; periksa sambungan internet server |
| "Layanan suara tidak merespons" | WebSocket ke Microsoft tersendat | Coba lagi; bila berulang, periksa firewall server |
| Build gagal: `Can't resolve 'fs'` | Komponen klien mengimpor modul server | Impor dari `lib/tts/estimate`, bukan `lib/tts/synthesize` |

---

## Lisensi & penghargaan

Dibangun dengan Next.js 16, Supabase, Tailwind CSS v4, Google Gemini, dan
msedge-tts. Dirancang mengikuti WCAG 2.1 tingkat AA.
