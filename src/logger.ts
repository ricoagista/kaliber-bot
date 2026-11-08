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

export type ConsoleLogLevel = 'info' | 'warn' | 'error' | 'success';

export interface ConsoleLogEntry {
  id: number;
  ts: number;
  timeStr: string;
  level: ConsoleLogLevel;
  tag: string;
  message: string;
}

const MAX_CONSOLE_LOGS = 300;
let nextConsoleId = 1;
const consoleLogsBuffer: ConsoleLogEntry[] = [];

export function formatTimeHms(ts = Date.now()): string {
  const d = new Date(ts);
  const formatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return formatter.format(d).replace(/\./g, ':');
}

export function addConsoleLog(
  level: ConsoleLogLevel,
  tag: string,
  message: string
): ConsoleLogEntry {
  const ts = Date.now();
  const entry: ConsoleLogEntry = {
    id: nextConsoleId++,
    ts,
    timeStr: formatTimeHms(ts),
    level,
    tag: tag.toUpperCase(),
    message: String(message),
  };

  consoleLogsBuffer.push(entry);
  if (consoleLogsBuffer.length > MAX_CONSOLE_LOGS) {
    consoleLogsBuffer.shift();
  }

  const logMsg = `[${entry.timeStr}] [${entry.tag}] ${entry.message}`;
  if (level === 'error') {
    logger.error(logMsg);
  } else if (level === 'warn') {
    logger.warn(logMsg);
  } else {
    logger.info(logMsg);
  }

  return entry;
}

export function getConsoleLogs(sinceId = 0): ConsoleLogEntry[] {
  if (sinceId <= 0) {
    return [...consoleLogsBuffer];
  }
  return consoleLogsBuffer.filter((item) => item.id > sinceId);
}

export function clearConsoleLogs(): void {
  consoleLogsBuffer.length = 0;
}

// Inisialisasi awal log sistem
addConsoleLog('info', 'SYSTEM', 'Kaliber Bot core process initialized');
