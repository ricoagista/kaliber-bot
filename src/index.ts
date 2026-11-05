import { serve } from '@hono/node-server';
import { createApi } from './api.js';
import { assertSecretKey, assertStartupConfig, loadEnv } from './config.js';
import { initDb, pruneStorage, getDb } from './db.js';
import { logger } from './logger.js';
import { initSettings } from './settings.js';
import { WaBot } from './wa.js';
import { addKey, createProvider, prepareKeyStore } from './providers.js';
import { encryptKey, maskKey, setRevealPassword } from './crypto.js';

const startedAt = Date.now();

function main(): void {
  const env = loadEnv();
  assertStartupConfig(env);
  assertSecretKey();
  setRevealPassword(env.revealPassword);

  initDb(`${env.dataDir}/kaliber.db`);
  initSettings(env.defaultModel, env.logLevel);
  pruneStorage();

  // Seed default provider dari env jika tabel providers masih kosong
  const providerCount = getDb().prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number };
  if (providerCount.n === 0) {
    const routerUrl = env.routerUrl || 'http://host.containers.internal:20128/v1';
    const routerKey = env.routerKey || '';
    if (routerUrl) {
      createProvider('default', routerUrl, 0);
    }
    if (routerKey && routerKey.trim()) {
      const provider = getDb().prepare('SELECT * FROM providers WHERE name = ?').get('default') as
        | { id: number }
        | undefined;
      if (provider) {
        const encrypted = encryptKey(routerKey);
        addKey(provider.id, 'primary', encrypted, maskKey(routerKey));
      }
    }
  }

  // Migrasi format enkripsi lama + hangatkan cache key sekali saat start.
  const keyStore = prepareKeyStore();
  if (keyStore.failed > 0) {
    logger.warn({ ...keyStore }, 'sebagian key tidak bisa disiapkan (cek SECRET_KEY)');
  } else if (keyStore.migrated > 0) {
    logger.warn({ ...keyStore }, 'key lama dimigrasikan ke format enkripsi v2');
  }

  setInterval(() => {
    try {
      pruneStorage();
    } catch (err) {
      logger.error({ err }, 'prune gagal');
    }
  }, 60 * 60 * 1000).unref();

  const bot = new WaBot(`${env.dataDir}/wa-auth`);
  const app = createApi({ wa: bot, startedAt });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
    logger.warn({ port: info.port }, 'kaliber-bot http siap');
  });

  void bot.start().catch((err) => {
    logger.error({ err }, 'gagal memulai WhatsApp');
  });

  const shutdown = (signal: string) => {
    logger.warn({ signal }, 'berhenti');
    bot.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();