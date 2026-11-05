import pino from 'pino';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'authorization',
  'headers.authorization',
  'ADMIN_TOKEN',
  'ROUTER_KEY',
  'token',
  'apiKey',
];

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Logger tunggal untuk bot dan Baileys. Level awal `warn` (bisa di-seed dari
 * env LOG_LEVEL) lalu diubah dari pengaturan web tanpa restart.
 */
export const logger = pino({
  level: isLogLevel(process.env.LOG_LEVEL?.trim()) ? process.env.LOG_LEVEL!.trim() : 'warn',
  redact: {
    paths: redactPaths,
    censor: '[redacted]',
  },
});

/** Terapkan level log dari pengaturan; nilai tidak valid diabaikan. */
export function applyLogLevel(level: unknown): void {
  if (isLogLevel(level)) logger.level = level;
}
