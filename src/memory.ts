import { getDb } from './db.js';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;

/** Simpan satu giliran percakapan. */
export function addMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  ts: number = Date.now(),
): void {
  getDb()
    .prepare('INSERT INTO messages (chat_id, role, content, ts) VALUES (?, ?, ?, ?)')
    .run(chatId, role, content, ts);
}

/** Ambil N giliran terakhir; riwayat basi (> 6 jam) dianggap kosong. */
export function getHistory(
  chatId: string,
  turns: number,
  now: number = Date.now(),
): StoredMessage[] {
  const db = getDb();
  const latest = db
    .prepare('SELECT ts FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT 1')
    .get(chatId) as { ts: number } | undefined;
  if (!latest) return [];
  if (now - Number(latest.ts) > HISTORY_TTL_MS) return [];

  const limit = Math.max(0, Math.floor(turns)) * 2;
  if (limit === 0) return [];
  const rows = db
    .prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(chatId, limit) as Array<{ role: string; content: string }>;

  return rows
    .reverse()
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({ role: row.role as 'user' | 'assistant', content: row.content }));
}

export function clearHistory(chatId: string): void {
  getDb().prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
}
