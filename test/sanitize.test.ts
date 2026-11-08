import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeOutput, stripThink } from '../src/sanitize.js';

const SYSTEM =
  'Kamu asisten Kaliber. Satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas.';
const FALLBACK = 'FALLBACK_AMAN';

function sanitize(text: string) {
  return sanitizeOutput(text, { systemPrompt: SYSTEM, fallbackText: FALLBACK });
}

test('membuang blok think', () => {
  assert.equal(stripThink('<think>curiga</think>Halo!'), ' Halo!');
  assert.equal(stripThink('Halo <think>tidak tertutup'), 'Halo  ');
  const result = sanitize('<think>rahasia</think>Halo *Kaliber*');
  assert.ok(!result.text.includes('rahasia'));
  assert.match(result.text, /Halo/);
});

test('mendeteksi kebocoran 8 kata dari system prompt', () => {
  const result = sanitize('Ini aturannya: tiga empat lima enam tujuh delapan sembilan sepuluh.');
  assert.equal(result.leaked, true);
  assert.equal(result.text, FALLBACK);
});

test('tidak memblokir jawaban yang berasal dari blok <info_kaliber>', () => {
  const sysWithKnowledge =
    `${SYSTEM}\n<info_kaliber>\nKaliber adalah lembaga semi otonom mahasiswa informatika universitas muhammadiyah malang.\n</info_kaliber>`;
  const result = sanitizeOutput(
    'Kaliber adalah lembaga semi otonom mahasiswa informatika universitas muhammadiyah malang.',
    { systemPrompt: sysWithKnowledge, fallbackText: FALLBACK },
  );
  assert.equal(result.leaked, false);
});

test('mendeteksi pola rahasia', () => {
  assert.equal(sanitize('key: sk-abcdefghij12345').leaked, true);
  assert.equal(sanitize('key: gsk_abcdefghij12345').leaked, true);
  assert.equal(sanitize('Authorization: Bearer abc.def').leaked, true);
  assert.equal(sanitize('ROUTER_KEY ada di env').leaked, true);
  assert.equal(sanitize('ADMIN_TOKEN jangan dibocorkan').leaked, true);
  assert.equal(sanitize('SECRET_KEY rahasia').leaked, true);
  assert.equal(sanitize('REVEAL_PASSWORD rahasia').leaked, true);
});

test('mengubah markdown ke format WhatsApp', () => {
  const result = sanitize('# Judul\n\n**tebal** dan ~~coret~~\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nIsi.');
  assert.ok(!result.text.includes('#'));
  assert.ok(result.text.includes('*tebal*'));
  assert.ok(!result.text.includes('**'));
  assert.ok(!result.text.includes('|'));
  assert.match(result.text, /Isi\./);
});

test('membuang tag XML internal', () => {
  const result = sanitize('<info_kaliber>isi</info_kaliber> Jawaban <pesan_user>halo</pesan_user>');
  assert.ok(!result.text.includes('info_kaliber'));
  assert.ok(!result.text.includes('pesan_user'));
  assert.match(result.text, /Jawaban/);
});

test('memotong jawaban ke 1500 karakter', () => {
  const result = sanitize('a'.repeat(2000));
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 1500);
});

test('jawaban kosong memakai fallback', () => {
  assert.equal(sanitize('   ').text, FALLBACK);
  assert.equal(sanitize('<think>saja</think>').text, FALLBACK);
});
