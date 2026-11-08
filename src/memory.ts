import { getDb } from './db.js';

export const HISTORY_TTL_MS = 6 * 3600_000;

export interface MemoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export function getHistory(
  senderId: string,
  historyTurns: number,
  now = Date.now()
): MemoryEntry[] {
  if (!senderId || historyTurns <= 0) return [];
  const db = getDb();
  const maxMessages = historyTurns * 2;

  const rows = db
    .prepare(
      `SELECT role, content, ts
       FROM messages
       WHERE chat_id = ?
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    )
    .all(senderId, maxMessages) as Array<{ role: string; content: string; ts: number }>;

  if (rows.length === 0) return [];

  // Jika pesan paling akhir sudah berumur > 6 jam, riwayat dianggap kadaluarsa
  const latestTs = rows[0].ts;
  if (now - latestTs > HISTORY_TTL_MS) {
    return [];
  }

  return rows
    .reverse()
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({
      role: r.role as 'user' | 'assistant',
      content: r.content,
    }));
}

export function addMessage(
  senderId: string,
  role: 'user' | 'assistant',
  content: string,
  now = Date.now()
): void {
  if (!senderId || !content) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (chat_id, role, content, ts)
     VALUES (?, ?, ?, ?)`
  ).run(senderId, role, content, now);
}
