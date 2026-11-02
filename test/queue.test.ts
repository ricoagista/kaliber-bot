import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageQueue } from '../src/queue.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('pesan dari nomor yang sama diproses serial', async () => {
  const queue = new MessageQueue(4);
  const order: string[] = [];
  const first = queue.run('nomor-a', async () => {
    order.push('a1-mulai');
    await delay(20);
    order.push('a1-selesai');
  });
  const second = queue.run('nomor-a', async () => {
    order.push('a2-mulai');
    order.push('a2-selesai');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a1-mulai', 'a1-selesai', 'a2-mulai', 'a2-selesai']);
});

test('konkurensi global dibatasi', async () => {
  const queue = new MessageQueue(2);
  let active = 0;
  let maxActive = 0;
  const gates: Array<() => void> = [];

  const tasks = Array.from({ length: 6 }, (_, i) =>
    queue.run(`nomor-${i}`, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
    }),
  );

  await delay(30);
  assert.equal(maxActive, 2);
  assert.equal(queue.activeCount, 2);

  while (gates.length > 0 || queue.activeCount > 0) {
    const gate = gates.shift();
    if (gate) gate();
    await delay(5);
    if (gates.length === 0 && queue.pendingCount === 0) break;
  }
  await Promise.all(tasks);
  assert.equal(maxActive, 2);
  assert.equal(active, 0);
});

test('error pada satu task tidak memutus antrean berikutnya', async () => {
  const queue = new MessageQueue(1);
  const failing = queue.run('sama', async () => {
    throw new Error('boom');
  });
  await assert.rejects(failing, /boom/);
  const next = await queue.run('sama', async () => 'lanjut');
  assert.equal(next, 'lanjut');
});
