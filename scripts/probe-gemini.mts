/**
 * Uji apakah kunci Gemini di .env benar-benar berfungsi.
 *
 * TIDAK menampilkan nilai kunci. Hanya melaporkan status.
 * Jalankan: node --experimental-strip-types scripts/probe-gemini.mts
 */

import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
const FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS?.trim() || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

async function testModel(ai: GoogleGenAI, model: string): Promise<string> {
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: 'Balas dengan satu kata: berhasil' }] }],
    config: { temperature: 0, maxOutputTokens: 32 },
  });
  return response.text ?? '(kosong)';
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  console.log('--- Pemeriksaan kunci ---');
  console.log(`GEMINI_API_KEY ada      : ${apiKey ? 'ya' : 'TIDAK'}`);
  console.log(`panjang                 : ${apiKey?.length ?? 0} karakter`);
  console.log(`awalan                  : ${apiKey?.slice(0, 5) ?? '-'}…`);
  console.log(`GEMINI_MODEL            : ${MODEL}`);
  console.log(`model cadangan          : ${FALLBACKS.join(', ') || '(tidak ada)'}`);
  console.log('');

  if (!apiKey) {
    console.error('GAGAL: GEMINI_API_KEY tidak ada di lingkungan.');
    process.exitCode = 1;
    return;
  }

  const ai = new GoogleGenAI({ apiKey });

  console.log('--- Menguji model ---');
  for (const model of [MODEL, ...FALLBACKS]) {
    try {
      const text = await testModel(ai, model);
      console.log(`  ${model}: BERHASIL -> ${JSON.stringify(text.slice(0, 60))}`);
      console.log('');
      console.log('Kesimpulan: kunci Gemini berfungsi.');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ${model}: GAGAL -> ${message.slice(0, 160)}`);
    }
  }

  console.log('');
  console.error('GAGAL: semua model di rantai tidak dapat dipakai.');
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('Pengecualian:', err);
  process.exitCode = 1;
});
