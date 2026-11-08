import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApi } from './api.js';
import { assertSecretKey, assertStartupConfig, loadEnv } from './config.js';
import { closeDb, initDb, pruneStorage, getDb } from './db.js';
import { logger } from './logger.js';
import { initSettings } from './settings.js';
import { WaBot } from './wa.js';
import {
  addKey,
  backfillProviderModels,
  createProvider,
  prepareKeyStore,
  normalizeModelSettings,
} from './providers.js';
import { encryptKey, setRevealPassword, keyLast4 } from './crypto.js';

const startedAt = Date.now();

function main(): void {
  const env = loadEnv();
  assertStartupConfig(env);
  assertSecretKey();
  setRevealPassword(env.revealPassword);

  initDb(path.join(env.dataDir, 'kaliber.db'));
  initSettings(env.defaultModel, env.logLevel);
  pruneStorage();

  // Seed default provider dari env jika tabel providers masih kosong
  const providerCount = getDb().prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number };
  const routerUrl = env.routerUrl || 'http://host.containers.internal:20128/v1';
  const routerKey = env.routerKey || '';
  if (providerCount.n === 0) {
    if (routerUrl) {
      const provider = createProvider('default', routerUrl, 0);
      if (routerKey && routerKey.trim()) {
        const encrypted = encryptKey(routerKey);
        addKey(provider.id, 'primary', encrypted, keyLast4(routerKey));
      }
    }
  }
  backfillProviderModels();
  normalizeModelSettings();

  // Migrasi format enkripsi lama + hangatkan cache key sekali saat start.
  const keyStore = prepareKeyStore();
  if (keyStore.failed > 0) {
    logger.warn({ ...keyStore }, 'sebagian key tidak bisa disiapkan (cek SECRET_KEY)');
  } else if (keyStore.migrated > 0) {
    logger.warn({ ...keyStore }, 'key lama dimigrasikan ke format enkripsi v2');
  }

  const pruneTimer = setInterval(() => {
    try {
      pruneStorage();
    } catch (err) {
      logger.error({ err }, 'prune gagal');
    }
  }, 60 * 60 * 1000);
  pruneTimer.unref();

  const bot = new WaBot(path.join(env.dataDir, 'wa-auth'));
  const app = createApi({ wa: bot, startedAt });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    logger.warn({ port: info.port }, 'kaliber-bot http siap');
  });

  void bot.start().catch((err) => {
    logger.error({ err }, 'gagal memulai WhatsApp');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, 'berhenti');
    clearInterval(pruneTimer);
    bot.stop();
    const finishExit = () => {
      try {
        closeDb();
      } catch (err) {
        logger.error({ err }, 'gagal menutup database');
      }
      process.exit(0);
    };
    server.close(() => finishExit());
    setTimeout(() => finishExit(), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
