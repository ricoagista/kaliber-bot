import { DEFAULT_SETTINGS, findKnowledgeTemplate, type Settings } from './config.js';
import { getDb } from './db.js';
import { logger } from './logger.js';

const cache = new Map<string, unknown>();

function persist(key: string, value: unknown, updatedAt: number): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, JSON.stringify(value), updatedAt);
}

/**
 * Muat settings dari SQLite. Key yang belum ada diisi dari default (env hanya
 * dipakai untuk seed pertama), knowledge diisi template saat masih kosong.
 */
export function initSettings(defaultModel = ''): void {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const stored = new Map<string, unknown>();
  for (const row of rows) {
    try {
      stored.set(row.key, JSON.parse(row.value));
    } catch {
      logger.warn({ key: row.key }, 'settings: nilai JSON rusak, diabaikan');
    }
  }

  cache.clear();
  const now = Date.now();
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) {
    if (!stored.has(key)) {
      cache.set(key, value);
      persist(key, value, now);
    } else {
      cache.set(key, stored.get(key));
    }
  }

  // Knowledge awal dari template (hanya bila masih kosong).
  const knowledge = cache.get('knowledge');
  if (typeof knowledge !== 'string' || knowledge.trim() === '') {
    const template = findKnowledgeTemplate();
    if (template.trim() !== '') {
      cache.set('knowledge', template);
      persist('knowledge', template, now);
    }
  }

  // Model awal dari env bila belum diatur lewat web.
  const model = cache.get('model');
  if ((typeof model !== 'string' || model.trim() === '') && defaultModel.trim() !== '') {
    cache.set('model', defaultModel);
    persist('model', defaultModel, now);
  }
}

export function isKnownSettingKey(key: string): key is keyof Settings {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  if (!cache.has(key)) {
    return DEFAULT_SETTINGS[key];
  }
  return cache.get(key) as Settings[K];
}

export function getSettings(): Settings {
  const out = {} as Settings;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const value = getSetting(key);
    out[key] = (Array.isArray(value) ? [...value] : value) as never;
  }
  return out;
}

/** Simpan patch settings secara atomik; cache langsung diperbarui (tanpa restart). */
export function updateSettings(patch: Partial<Settings>): void {
  const entries = Object.entries(patch).filter(([key]) => isKnownSettingKey(key)) as Array<
    [keyof Settings, unknown]
  >;
  if (entries.length === 0) return;

  const db = getDb();
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const [key, value] of entries) {
      persist(key, value, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const [key, value] of entries) {
    cache.set(key, value);
  }
}

/** Kembalikan satu/lebih setting ke default pabrik. */
export function resetSettings(keys: Array<keyof Settings>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of keys) {
    (patch as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
  }
  updateSettings(patch);
  return patch;
}
