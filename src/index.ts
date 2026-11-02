import { serve } from '@hono/node-server';
import { createApi, type WaControl } from './api.js';
import { assertStartupConfig, loadEnv } from './config.js';
import { initDb, pruneStorage } from './db.js';
import { logger } from './logger.js';
import { initSettings } from './settings.js';

const startedAt = Date.now();

const waPlaceholder: WaControl = {
  async snapshot() {
    return {
      state: 'disconnected',
      qrDataUrl: null,
      pairingCode: null,
      me: null,
      lastError: 'WhatsApp belum diinisialisasi',
      reconnectAttempt: 0,
    };
  },
  async requestPairing() {
    throw new Error('WhatsApp belum diinisialisasi');
  },
  async logout() {
    throw new Error('WhatsApp belum diinisialisasi');
  },
};

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

  const app = createApi({ wa: waPlaceholder, startedAt });
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
