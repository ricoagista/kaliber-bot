import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { assertStartupConfig, loadEnv } from './config.js';
import { countMessagesSince, initDb, pruneStorage } from './db.js';
import { logger } from './logger.js';
import { initSettings } from './settings.js';

const startedAt = Date.now();

export function createApp(): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => {
    return c.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      messagesToday: countMessagesSince(new Date().setHours(0, 0, 0, 0)),
    });
  });

  return app;
}

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

  const app = createApp();
  const server = serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
    logger.warn({ port: info.port }, 'kaliber-bot http siap');
  });

  const shutdown = (signal: string) => {
    logger.warn({ signal }, 'berhenti');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
