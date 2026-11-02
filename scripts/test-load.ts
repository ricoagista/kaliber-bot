/**
 * Uji beban ringan: 20 pesan paralel dari 5 nomor palsu.
 * Memakai DB in-memory dan model kosong, jadi tidak memanggil 9router.
 * Gagal bila RSS melewati 200 MB atau ada pesan yang tidak terproses.
 */
import { initDb } from '../src/db.js';
import { initSettings } from '../src/settings.js';
import { handleMessage } from '../src/pipeline.js';
import { defaultQueue } from '../src/queue.js';

const LIMIT_RSS_MB = 200;
const TOTAL = 20;
const SENDERS = Array.from({ length: 5 }, (_, i) => `62800000000${i + 1}@s.whatsapp.net`);

async function main(): Promise<void> {
  initDb(':memory:');
  initSettings('');

  let peakRssMb = 0;
  const sample = () => {
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rss > peakRssMb) peakRssMb = rss;
  };
  const timer = setInterval(sample, 10);
  sample();

  const now = Date.now();
  const started = performance.now();
  const tasks: Array<Promise<unknown>> = [];
  for (let i = 0; i < TOTAL; i++) {
    const sender = SENDERS[i % SENDERS.length]!;
    tasks.push(
      handleMessage({
        chatId: sender,
        senderId: sender,
        text: `pertanyaan beban nomor ${i + 1}`,
        messageId: `load-${i}-${now}`,
        now,
      }),
    );
  }

  const results = await Promise.all(tasks);
  const elapsed = Math.round(performance.now() - started);
  clearInterval(timer);
  sample();

  const replied = results.filter((result) => {
    const reply = (result as { reply: string | null }).reply;
    return typeof reply === 'string' && reply.length > 0;
  }).length;

  console.log('\nUji beban Kaliber Bot\n');
  console.log(`Pesan        : ${TOTAL} (5 nomor x 4)`);
  console.log(`Ada balasan  : ${replied}/${TOTAL}`);
  console.log(`Durasi       : ${elapsed} ms`);
  console.log(`Puncak RSS   : ${peakRssMb} MB (batas ${LIMIT_RSS_MB} MB)`);
  console.log(`Queue aktif  : ${defaultQueue.activeCount}, menunggu: ${defaultQueue.pendingCount}`);
  console.log(`Concurrency  : maksimum 2 (lihat unit test queue)\n`);

  const ok = replied === TOTAL && peakRssMb <= LIMIT_RSS_MB;
  console.log(ok ? 'LULUS\n' : 'GAGAL\n');
  process.exit(ok ? 0 : 1);
}

await main();
