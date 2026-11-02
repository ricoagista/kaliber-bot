import { serve } from '@hono/node-server';
import { createApi } from './api.js';
import { assertStartupConfig, loadEnv } from './config.js';
import { initDb, pruneStorage } from './db.js';
import { logger } from './logger.js';
import { initSettings } from './settings.js';
import { WaBot } from './wa.js';

const startedAt = Date.now();

function main(): void {
  const env = loadEnv();
  assertStartupConfig(env);

  initDb(`${env.dataDir}/kaliber.db`);
  initSettings(env.defaultModel);
  pruneStorage();
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
