import pino from 'pino';
import { VALID_LOG_LEVELS, type LogLevel } from './config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL && (VALID_LOG_LEVELS as readonly string[]).includes(process.env.LOG_LEVEL)
    ? process.env.LOG_LEVEL
    : 'warn',
  redact: {
    paths: [
      'adminToken',
      'secretKey',
      'revealPassword',
      'apiKey',
      'plainKey',
      'keyEncrypted',
      'key_encrypted',
      'headers.authorization',
      'req.headers.authorization',
    ],
    censor: '[REDACTED]',
  },
});

export function setLogLevel(level: LogLevel): void {
  if ((VALID_LOG_LEVELS as readonly string[]).includes(level)) {
    logger.level = level;
  }
}
