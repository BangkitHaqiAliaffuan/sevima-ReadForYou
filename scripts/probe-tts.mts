/**
 * Uji kelayakan msedge-tts SEBELUM dipakai di route.
 *
 * Membuktikan tiga hal:
 *  1. Modul dapat diimpor dan berfungsi di Node versi ini.
 *  2. Suara Indonesia benar-benar tersedia.
 *  3. Sintesis menghasilkan audio MP3 yang valid.
 *
 * Jalankan: node --experimental-strip-types scripts/probe-tts.mts
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

async function main(): Promise<void> {
  console.log('1. Mengimpor msedge-tts... ok');

  const tts = new MsEdgeTTS();
  console.log('2. Mengambil daftar suara...');

  const voices = await tts.getVoices();
  console.log(`   total suara: ${voices.length}`);

  const indonesian = voices.filter((v) =>
    v.Locale?.toLowerCase().startsWith('id'),
  );
  console.log('   suara Indonesia:');
  for (const v of indonesian) {
    console.log(`     - ${v.ShortName} | ${v.Gender} | ${v.FriendlyName}`);
  }

  if (indonesian.length === 0) {
    console.error('   GAGAL: tidak ada suara Indonesia.');
    process.exitCode = 1;
    tts.close();
    return;
  }

  const chosen = indonesian[0]!.ShortName;
  console.log(`3. Sintesis dengan ${chosen}...`);

  await tts.setMetadata(chosen, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const { audioStream } = tts.toStream(
    'Halo, ini uji coba pembacaan modul pelajaran.',
  );

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    audioStream.on('data', (c: Buffer) => chunks.push(c));
    audioStream.on('end', () => resolve());
    audioStream.on('error', (e: Error) => reject(e));
  });

  const audio = Buffer.concat(chunks);
  console.log(`   ukuran audio: ${audio.length} byte`);

  if (audio.length === 0) {
    console.error('   GAGAL: audio kosong.');
    process.exitCode = 1;
    tts.close();
    return;
  }

  // MP3 valid diawali "ID3" atau frame sync 0xFF 0xEx.
  const head = audio.subarray(0, 3).toString('latin1');
  const isId3 = head === 'ID3';
  const isFrameSync = audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0;
  console.log(`   header: ${JSON.stringify(head)}, ID3=${isId3}, frameSync=${isFrameSync}`);

  if (!isId3 && !isFrameSync) {
    console.error('   GAGAL: bukan MP3 yang valid.');
    process.exitCode = 1;
  } else {
    console.log('   BERHASIL: audio MP3 valid.');
  }

  tts.close();
}

main().catch((err: unknown) => {
  console.error('GAGAL dengan pengecualian:', err);
  process.exitCode = 1;
});
