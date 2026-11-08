import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from './logger.js';

let dbInstance: DatabaseSync | null = null;

// Satu statement SQL per entri agar migrasi PRAGMA user_version deterministik dan idempoten.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)`,
  `CREATE TABLE IF NOT EXISTS seen_messages (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_seen_messages_ts ON seen_messages(ts)`,
  `CREATE TABLE IF NOT EXISTS strikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strikes_jid_ts ON strikes(jid, ts)`,
  `CREATE TABLE IF NOT EXISTS mutes (
    jid TEXT PRIMARY KEY,
    until INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    message TEXT NOT NULL,
    reply TEXT,
    status TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    model TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts)`,
  `CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS provider_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    key_encrypted TEXT NOT NULL,
    key_last4 TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT '',
    last_checked_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_provider_keys_provider_id ON provider_keys(provider_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    key_id INTEGER NOT NULL REFERENCES provider_keys(id) ON DELETE CASCADE,
    success INTEGER NOT NULL,
    ip TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)`,
  `ALTER TABLE providers ADD COLUMN format TEXT NOT NULL DEFAULT 'openai'`,
];

export function initDb(dbPath: string): DatabaseSync {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const currentVersion = versionRow?.user_version ?? 0;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i];
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  db.exec('PRAGMA foreign_keys = ON;');
  dbInstance = db;
  logger.info({ dbPath, schemaVersion: MIGRATIONS.length }, 'Database initialized');
  return db;
}

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    throw new Error('Database belum diinisialisasi. Panggil initDb() terlebih dahulu.');
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (err) {
      logger.warn({ err }, 'Gagal menutup koneksi database');
    } finally {
      dbInstance = null;
    }
  }
}

export type LogStatus = 'ok' | 'blocked' | 'injection' | 'ratelimit' | 'error';

export interface LogEntry {
  id: number;
  ts: number;
  chat_id: string;
  message: string;
  reply: string | null;
  status: LogStatus;
  latency_ms: number;
  model: string | null;
}

export interface AuditEntry {
  id: number;
  ts: number;
  key_id: number;
  keyLabel: string | null;
  success: number;
  ip: string;
  result: string;
}

export function insertLog(entry: {
  ts?: number;
  chatId: string;
  message: string;
  reply: string | null;
  status: LogStatus;
  latencyMs: number;
  model?: string | null;
}): void {
  const db = getDb();
  const ts = entry.ts ?? Date.now();
  const msgBounded = entry.message.slice(0, 500);
  const replyBounded = entry.reply !== null && entry.reply !== undefined ? entry.reply.slice(0, 1500) : null;
  db.prepare(
    `INSERT INTO logs (ts, chat_id, message, reply, status, latency_ms, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(ts, entry.chatId, msgBounded, replyBounded, entry.status, Math.max(0, Math.round(entry.latencyMs)), entry.model ?? null);
}

export function getRecentLogs(limit = 100): LogEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, ts, chat_id, message, reply, status, latency_ms, model
       FROM logs
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    )
    .all(limit) as unknown as LogEntry[];
}

export function clearLogs(): number {
  const db = getDb();
  const info = db.prepare('DELETE FROM logs').run();
  return Number(info.changes);
}

export function insertAudit(entry: {
  ts?: number;
  keyId: number;
  success: boolean;
  ip: string;
  result: string;
}): void {
  const db = getDb();
  const ts = entry.ts ?? Date.now();
  db.prepare(
    `INSERT INTO audit_log (ts, key_id, success, ip, result)
     VALUES (?, ?, ?, ?, ?)`
  ).run(ts, entry.keyId, entry.success ? 1 : 0, entry.ip, entry.result);
}

export function getRecentAudit(limit = 50): AuditEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT a.id, a.ts, a.key_id, pk.label AS keyLabel, a.success, a.ip, a.result
       FROM audit_log a
       LEFT JOIN provider_keys pk ON pk.id = a.key_id
       ORDER BY a.ts DESC, a.id DESC
       LIMIT ?`
    )
    .all(limit) as unknown as AuditEntry[];
}

export function markMessageSeen(id: string, now = Date.now()): boolean {
  if (!id) return false;
  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM seen_messages WHERE id = ?').get(id);
  if (existing) {
    return true;
  }
  db.prepare('INSERT OR IGNORE INTO seen_messages (id, ts) VALUES (?, ?)').run(id, now);
  return false;
}

export function isJidMuted(jids: string[], now = Date.now()): boolean {
  if (jids.length === 0) return false;
  const db = getDb();
  const stmt = db.prepare('SELECT until FROM mutes WHERE jid = ? AND until > ?');
  for (const jid of jids) {
    if (!jid) continue;
    const row = stmt.get(jid, now) as { until: number } | undefined;
    if (row) return true;
  }
  return false;
}

export function recordStrikeAndMaybeMute(
  jid: string,
  now: number,
  strikeWindowMin: number,
  strikeLimit: number,
  muteMinutes: number
): { count: number; muted: boolean } {
  const db = getDb();
  const cutoff = now - strikeWindowMin * 60_000;
  db.prepare('DELETE FROM strikes WHERE jid = ? AND ts < ?').run(jid, cutoff);
  db.prepare('INSERT INTO strikes (jid, ts) VALUES (?, ?)').run(jid, now);

  const row = db
    .prepare('SELECT COUNT(*) AS cnt FROM strikes WHERE jid = ? AND ts >= ?')
    .get(jid, cutoff) as { cnt: number } | undefined;
  const count = Number(row?.cnt ?? 1);

  if (count >= strikeLimit) {
    const until = now + muteMinutes * 60_000;
    db.prepare(
      `INSERT INTO mutes (jid, until) VALUES (?, ?)
       ON CONFLICT(jid) DO UPDATE SET until = excluded.until`
    ).run(jid, until);
    db.prepare('DELETE FROM strikes WHERE jid = ?').run(jid);
    return { count, muted: true };
  }

  return { count, muted: false };
}

export function getStatusCounts(now = Date.now()): {
  messagesToday: number;
  blockedToday: number;
  strikes: number;
  mutes: number;
} {
  const db = getDb();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const dayStartMs = startOfDay.getTime();

  const totalRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM logs WHERE ts >= ?')
    .get(dayStartMs) as { cnt: number } | undefined;
  const blockedRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM logs WHERE ts >= ? AND status IN ('blocked', 'injection', 'ratelimit')")
    .get(dayStartMs) as { cnt: number } | undefined;
  const strikesRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM strikes WHERE ts >= ?')
    .get(now - 24 * 3600_000) as { cnt: number } | undefined;
  const mutesRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM mutes WHERE until > ?')
    .get(now) as { cnt: number } | undefined;

  return {
    messagesToday: Number(totalRow?.cnt ?? 0),
    blockedToday: Number(blockedRow?.cnt ?? 0),
    strikes: Number(strikesRow?.cnt ?? 0),
    mutes: Number(mutesRow?.cnt ?? 0),
  };
}

export function pruneStorage(now = Date.now()): void {
  const db = getDb();
  const sixHoursAgo = now - 6 * 3600_000;
  const twentyFourHoursAgo = now - 24 * 3600_000;
  const sevenDaysAgo = now - 7 * 24 * 3600_000;
  const ninetyDaysAgo = now - 90 * 24 * 3600_000;

  db.prepare('DELETE FROM messages WHERE ts < ?').run(sixHoursAgo);
  db.prepare('DELETE FROM logs WHERE ts < ?').run(sevenDaysAgo);
  db.prepare('DELETE FROM seen_messages WHERE ts < ?').run(twentyFourHoursAgo);
  db.prepare('DELETE FROM strikes WHERE ts < ?').run(twentyFourHoursAgo);
  db.prepare('DELETE FROM mutes WHERE until < ?').run(now);
  db.prepare('DELETE FROM audit_log WHERE ts < ?').run(ninetyDaysAgo);

  // Pangkas masing-masing tabel agar menyisakan maksimal 2000 baris terbaru.
  db.exec(`
    DELETE FROM messages WHERE id NOT IN (
      SELECT id FROM messages ORDER BY ts DESC, id DESC LIMIT 2000
    );
    DELETE FROM logs WHERE id NOT IN (
      SELECT id FROM logs ORDER BY ts DESC, id DESC LIMIT 2000
    );
    DELETE FROM seen_messages WHERE id NOT IN (
      SELECT id FROM seen_messages ORDER BY ts DESC LIMIT 2000
    );
    DELETE FROM audit_log WHERE id NOT IN (
      SELECT id FROM audit_log ORDER BY ts DESC, id DESC LIMIT 2000
    );
  `);
}
