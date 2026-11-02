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

/** Hapus data lama agar storage STB tidak membengkak. */
export function pruneStorage(now: number = Date.now()): void {
  const db = getDb();
  const day = 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM messages WHERE ts < ?').run(now - 7 * day);
  db.prepare('DELETE FROM logs WHERE ts < ?').run(now - 7 * day);
  db.prepare('DELETE FROM seen_messages WHERE ts < ?').run(now - day);
  db.prepare('DELETE FROM strikes WHERE ts < ?').run(now - day);
  db.prepare('DELETE FROM mutes WHERE until < ?').run(now);
  // Batasi jumlah baris: sisakan 2000 terbaru.
  db.exec(
    'DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY ts DESC LIMIT 2000)',
  );
  db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY ts DESC LIMIT 2000)');
}
