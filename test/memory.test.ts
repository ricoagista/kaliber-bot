import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { addMessage, clearHistory, getHistory, HISTORY_TTL_MS } from '../src/memory.js';
import { freshDb } from './helpers.js';

beforeEach(() => {
  freshDb();
});

test('menyimpan dan mengambil riwayat berurutan', () => {
  const base = 1_700_000_000_000;
  addMessage('chat-1', 'user', 'halo', base);
  addMessage('chat-1', 'assistant', 'hai', base + 1000);
  addMessage('chat-1', 'user', 'apa itu kaliber?', base + 2000);
  const history = getHistory('chat-1', 4, base + 3000);
  assert.deepEqual(history, [
    { role: 'user', content: 'halo' },
    { role: 'assistant', content: 'hai' },
    { role: 'user', content: 'apa itu kaliber?' },
  ]);
});

test('membatasi jumlah giliran', () => {
  const base = 1_700_000_000_000;
  for (let i = 0; i < 10; i++) {
    addMessage('chat-2', i % 2 === 0 ? 'user' : 'assistant', `pesan-${i}`, base + i * 1000);
  }
  const history = getHistory('chat-2', 2, base + 20_000);
  assert.equal(history.length, 4);
  assert.equal(history[0]?.content, 'pesan-6');
  assert.equal(history[3]?.content, 'pesan-9');
});

test('riwayat kedaluwarsa setelah 6 jam tidak aktif', () => {
  const base = 1_700_000_000_000;
  addMessage('chat-3', 'user', 'lama', base);
  assert.equal(getHistory('chat-3', 4, base + HISTORY_TTL_MS - 1).length, 1);
  assert.equal(getHistory('chat-3', 4, base + HISTORY_TTL_MS + 1).length, 0);
});

test('clearHistory menghapus riwayat chat', () => {
  addMessage('chat-4', 'user', 'halo');
  clearHistory('chat-4');
  assert.deepEqual(getHistory('chat-4', 4), []);
});
