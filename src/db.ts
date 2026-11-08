import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let database: DatabaseSync | null = null;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);
  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

  CREATE TABLE IF NOT EXISTS seen_messages (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_seen_messages_ts ON seen_messages(ts);

  CREATE TABLE IF NOT EXISTS strikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_strikes_jid_ts ON strikes(jid, ts);

  CREATE TABLE IF NOT EXISTS mutes (
    jid TEXT PRIMARY KEY,
    until INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    message TEXT NOT NULL,
    reply TEXT,
    status TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    model TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
  `,
  `
  CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS provider_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    key_encrypted TEXT NOT NULL,
    key_last4 TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(provider_id) REFERENCES providers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    key_id INTEGER NOT NULL,
    success INTEGER NOT NULL,
    ip TEXT NOT NULL,
    FOREIGN KEY(key_id) REFERENCES provider_keys(id) ON DELETE CASCADE
  );
  `,
  `
  ALTER TABLE audit_log ADD COLUMN result TEXT NOT NULL DEFAULT '';
  `,
  `
  UPDATE provider_keys SET key_last4 = substr(key_last4, -4) WHERE length(key_last4) > 4;
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
  `,
  `
  ALTER TABLE providers ADD COLUMN model TEXT NOT NULL DEFAULT '';
  `,
  `
  ALTER TABLE provider_keys ADD COLUMN last_status TEXT NOT NULL DEFAULT '';
  `,
  `
  ALTER TABLE provider_keys ADD COLUMN last_checked_at INTEGER NOT NULL DEFAULT 0;
  `,
];

export function initDb(file: string): DatabaseSync {
  if (database) {
    database.close();
    database = null;
  }
  if (file !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  database = db;
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  let version = Number(row?.user_version ?? 0);
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  // Aktifkan foreign key constraints setelah migrasi
  db.exec('PRAGMA foreign_keys = ON');
}

export function getDb(): DatabaseSync {
  if (!database) {
    throw new Error('Database belum diinisialisasi. Panggil initDb() lebih dulu.');
  }
  return database;
}

export function closeDb(): void {
  if (database) {
    database.close();
    database = null;
  }
}

export interface LogRow {
  id: number;
  ts: number;
  chat_id: string;
  message: string;
  reply: string | null;
  status: string;
  latency_ms: number;
  model: string | null;
}

export function insertLog(entry: {
  ts: number;
  chatId: string;
  message: string;
  reply: string | null;
  status: string;
  latencyMs: number;
  model: string | null;
}): void {
  getDb()
    .prepare(
      'INSERT INTO logs (ts, chat_id, message, reply, status, latency_ms, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(entry.ts, entry.chatId, entry.message, entry.reply, entry.status, entry.latencyMs, entry.model);
}

export function countMessagesSince(since: number): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM logs WHERE ts >= ?').get(since) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function countLogsSince(since: number, statuses: string[]): number {
  if (statuses.length === 0) return 0;
  const placeholders = statuses.map(() => '?').join(', ');
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM logs WHERE ts >= ? AND status IN (${placeholders})`)
    .get(since, ...statuses) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function getRecentLogs(limit = 100): LogRow[] {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  return getDb()
    .prepare(
      'SELECT id, ts, chat_id, message, reply, status, latency_ms, model FROM logs ORDER BY ts DESC, id DESC LIMIT ?',
    )
    .all(safeLimit) as unknown as LogRow[];
}

export function countActiveStrikes(since: number): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM strikes WHERE ts >= ?').get(since) as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

export function countActiveMutes(now: number): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM mutes WHERE until > ?').get(now) as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

export interface AuditRow {
  id: number;
  ts: number;
  key_id: number;
  success: number;
  ip: string;
  result: string;
}

/** Catat percobaan reveal (berhasil/gagal) tanpa isi key. */
export function insertAudit(entry: {
  ts: number;
  keyId: number;
  success: boolean;
  ip: string;
  result: string;
}): void {
  getDb()
    .prepare('INSERT INTO audit_log (ts, key_id, success, ip, result) VALUES (?, ?, ?, ?, ?)')
    .run(entry.ts, entry.keyId, entry.success ? 1 : 0, entry.ip, entry.result);
}

export function getRecentAudit(limit = 50): AuditRow[] {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  return getDb()
    .prepare('SELECT id, ts, key_id, success, ip, result FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?')
    .all(safeLimit) as unknown as AuditRow[];
}


/** Hapus data lama agar storage STB tidak membengkak. */
export function pruneStorage(now: number = Date.now()): void {
  const db = getDb();
  const sixHours = 6 * 60 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM messages WHERE ts < ?').run(now - sixHours);
  db.prepare('DELETE FROM logs WHERE ts < ?').run(now - 7 * day);
  db.prepare('DELETE FROM seen_messages WHERE ts < ?').run(now - day);
  db.prepare('DELETE FROM strikes WHERE ts < ?').run(now - day);
  db.prepare('DELETE FROM mutes WHERE until < ?').run(now);
  // Hapus audit_log lebih tua dari 90 hari
  db.prepare('DELETE FROM audit_log WHERE ts < ?').run(now - ninetyDays);
  // Batasi jumlah baris: sisakan 2000 terbaru sesuai spesifikasi
  db.exec(
    'DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY ts DESC LIMIT 2000)',
  );
  db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY ts DESC LIMIT 2000)');
  db.exec(
    'DELETE FROM seen_messages WHERE id NOT IN (SELECT id FROM seen_messages ORDER BY ts DESC LIMIT 2000)',
  );
  db.exec('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY ts DESC LIMIT 2000)');
}
