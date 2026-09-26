/**
 * Modul contoh pra-ekstraksi untuk onboarding instan.
 *
 * Memungkinkan pengguna (terutama siswa disabilitas penglihatan) mencoba
 * fitur pembacaan suara natural Edge TTS, navigasi kalimat, dan tanya-jawab
 * dokumen secara instan tanpa perlu menyiapkan atau mengunggah berkas PDF sendiri.
 */

export interface SampleDocument {
  name: string;
  topic: string;
  description: string;
  text: string;
  wordCount: number;
  pageCount: number;
}

export const SAMPLE_DOCUMENT: SampleDocument = {
  name: 'Modul Contoh: Mengenal Tata Surya dan Planet Kita',
  topic: 'Ilmu Pengetahuan Alam',
  description: 'Materi pengantar tentang matahari, delapan planet, dan keunikan bumi.',
  pageCount: 2,
  wordCount: 218,
  text: `Tata Surya adalah kumpulan benda langit yang terdiri atas Matahari sebagai bintang pusat dan semua objek yang terikat oleh gaya gravitasinya.

Matahari adalah bola gas raksasa yang sangat panas dan menjadi sumber energi utama bagi seluruh kehidupan di Bumi. Gravitasi Matahari menjaga planet-planet tetap mengorbit pada jalurnya masing-masing.

Ada delapan planet utama dalam Tata Surya kita. Planet-planet tersebut berurutan mulai dari yang paling dekat dengan Matahari, yaitu Merkurius, Venus, Bumi, Mars, Jupiter, Saturnus, Uranus, dan Neptunus.

Merkurius adalah planet terkecil dan paling dekat dengan Matahari, sehingga memiliki suhu siang yang sangat panas dan malam yang amat dingin.

Venus adalah planet terpanas dalam sistem kita karena diselimuti atmosfer tebal yang memerangkap panas Matahari.

Bumi adalah satu-satunya tempat yang diketahui memiliki kehidupan, dengan lautan air cair dan atmosfer yang kaya oksigen.

Mars sering dijuluki Planet Merah karena permukaannya yang kaya zat besi berkarat. Di planet ini terdapat gunung berapi tertinggi di Tata Surya.

Jupiter adalah planet terbesar, ukurannya lebih dari seribu kali volume Bumi dan memiliki badai raksasa yang terkenal.

Saturnus dikenal dengan keindahan cincinnya yang tersusun dari miliaran bongkahan es dan batuan.

Uranus dan Neptunus adalah raksasa es yang berada di tepi terluar Tata Surya, memiliki angin kencang dan suhu yang membeku.

Dengan mempelajari Tata Surya, kita dapat lebih memahami posisi Bumi dan menjaga kelestarian lingkungan tempat kita tinggal.`
};
