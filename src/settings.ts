import { DEFAULT_SETTINGS, findKnowledgeTemplate, type Settings } from './config.js';
import { getDb } from './db.js';
import { applyLogLevel, isLogLevel, logger } from './logger.js';

const cache = new Map<string, unknown>();

function persist(key: string, value: unknown, updatedAt: number): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, JSON.stringify(value), updatedAt);
}

const SEEDED_MODEL_META_KEY = '_seeded_default_model';
const WEB_MODEL_MARKER = '__web__';

/**
 * Muat settings dari SQLite. Key yang belum ada diisi dari default (env hanya
 * dipakai untuk seed pertama), knowledge diisi template saat masih kosong.
 */
export function initSettings(defaultModel = '', defaultLogLevel = ''): void {
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

  // LOG_LEVEL dari env hanya seed awal; setelah tersimpan, web yang menang.
  if (!stored.has('log_level') && isLogLevel(defaultLogLevel)) {
    stored.set('log_level', defaultLogLevel);
  }

  cache.clear();
  const now = Date.now();
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) {
    if (!stored.has(key)) {
      cache.set(key, value);
      // `undefined` tidak bisa di-bind ke SQLite; cukup jadi nilai cache default.
      if (value !== undefined) persist(key, value, now);
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

  // Sinkronisasi DEFAULT_MODEL dari .env:
  // - Bila DEFAULT_MODEL di .env dikosongkan/dimatikan dan nilai model di DB
  //   bukan hasil simpan manual dari web, kosongkan kembali model di DB.
  // - Bila DEFAULT_MODEL diisi dan model masih kosong, gunakan sebagai seed awal.
  const trimmedDefaultModel = defaultModel.trim();
  const prevSeedMarker = stored.get(SEEDED_MODEL_META_KEY);
  const currentModel = typeof cache.get('model') === 'string' ? (cache.get('model') as string).trim() : '';

  if (trimmedDefaultModel === '') {
    if (prevSeedMarker !== WEB_MODEL_MARKER && currentModel !== '') {
      cache.set('model', '');
      persist('model', '', now);
    }
    if (prevSeedMarker !== WEB_MODEL_MARKER) {
      persist(SEEDED_MODEL_META_KEY, '', now);
    }
  } else if (currentModel === '') {
    cache.set('model', trimmedDefaultModel);
    persist('model', trimmedDefaultModel, now);
    persist(SEEDED_MODEL_META_KEY, trimmedDefaultModel, now);
  } else if (prevSeedMarker === undefined) {
    persist(SEEDED_MODEL_META_KEY, trimmedDefaultModel, now);
  }

  applyLogLevel(cache.get('log_level'));
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
export function updateSettings(patch: Partial<Settings>, options?: { internal?: boolean }): void {
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
      if (!options?.internal && key === 'model') {
        const strVal = typeof value === 'string' ? value.trim() : '';
        persist(SEEDED_MODEL_META_KEY, strVal ? WEB_MODEL_MARKER : '', now);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const [key, value] of entries) {
    cache.set(key, value);
  }
  if (entries.some(([key]) => key === 'log_level')) {
    applyLogLevel(cache.get('log_level'));
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
