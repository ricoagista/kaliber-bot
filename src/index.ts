import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApi } from './api.js';
import { assertSecretKey, assertStartupConfig, loadEnv } from './config.js';
import { prepareKeyStore, setRevealPassword, setSecretKey } from './crypto.js';
import { closeDb, initDb, pruneStorage } from './db.js';
import { logger } from './logger.js';
import {
  backfillProviderModelsAndNormalizeSettings,
  seedDefaultProvider,
} from './providers.js';
import { initSettings } from './settings.js';
import { WaBot } from './wa.js';

async function main(): Promise<void> {
  const env = loadEnv();
  assertStartupConfig(env);
  assertSecretKey(env);
  setSecretKey(env.secretKey);
  setRevealPassword(env.revealPassword);

  const dbPath = path.resolve(env.dataDir, 'kaliber.db');
  initDb(dbPath);
  initSettings(env.defaultModel, env.logLevel);
  pruneStorage();
  seedDefaultProvider(env.routerUrl, env.routerKey, env.defaultModel);
  backfillProviderModelsAndNormalizeSettings();
  prepareKeyStore();

  const pruneTimer = setInterval(() => {
    try {
      pruneStorage();
    } catch (err) {
      logger.warn({ err }, 'Gagal menjalankan pruneStorage terjadwal');
    }
  }, 3600_000);
  pruneTimer.unref();

  const waAuthDir = path.resolve(env.dataDir, 'wa-auth');
  const bot = new WaBot(waAuthDir);

  const app = createApi({
    adminToken: env.adminToken,
    trustProxy: env.trustProxy,
    wa: bot,
  });

  const server = serve(
    {
      fetch: app.fetch,
      port: env.port,
      hostname: env.host,
    },
    (info) => {
      logger.info({ host: info.address, port: info.port }, 'Kaliber Bot HTTP server berjalan');
    }
  );

  void bot.start().catch((err) => {
    logger.error({ err }, 'Gagal memulai koneksi awal WhatsApp');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Memulai graceful shutdown');
    clearInterval(pruneTimer);

    void bot.stop().finally(() => {
      server.close(() => {
        closeDb();
        process.exit(0);
      });
    });

    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
