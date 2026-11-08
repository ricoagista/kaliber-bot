import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  VALID_LOG_LEVELS,
  type LogLevel,
  type Settings,
} from './config.js';
import { getDb } from './db.js';
import { logger, setLogLevel } from './logger.js';

const settingsCache = new Map<keyof Settings, Settings[keyof Settings]>();
let initialDefaults: Settings = { ...DEFAULT_SETTINGS };

const MODEL_SEEDED_META_KEY = '__meta_model_seeded';

function loadKnowledgeTemplate(): string {
  try {
    const templatePath = path.resolve(process.cwd(), 'knowledge/kaliber.template.md');
    if (fs.existsSync(templatePath)) {
      return fs.readFileSync(templatePath, 'utf8');
    }
  } catch (err) {
    logger.warn({ err }, 'Gagal membaca template knowledge');
  }
  return '';
}

export function initSettings(defaultModel = '', defaultLogLevel: LogLevel = 'warn'): void {
  const db = getDb();
  const templateKnowledge = loadKnowledgeTemplate();

  initialDefaults = {
    ...DEFAULT_SETTINGS,
    model: defaultModel,
    log_level: (VALID_LOG_LEVELS as readonly string[]).includes(defaultLogLevel) ? defaultLogLevel : 'warn',
    knowledge: templateKnowledge,
  };

  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const existingMap = new Map<string, string>();
  for (const r of rows) {
    existingMap.set(r.key, r.value);
  }

  const now = Date.now();
  const upsertStmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  // Per PRD 3.1: DEFAULT_MODEL menjadi seed awal jika belum pernah disimpan manual dari Web Admin.
  // Jika dikosongkan kembali di .env dan model belum pernah disimpan manual, model otomatis dikosongkan.
  const modelWasSeeded = existingMap.get(MODEL_SEEDED_META_KEY) === 'true';
  const hasSavedModel = existingMap.has('model');

  for (const key of Object.keys(initialDefaults) as Array<keyof Settings>) {
    const raw = existingMap.get(key);
    if (raw === undefined) {
      const val = initialDefaults[key];
      upsertStmt.run(key, JSON.stringify(val), now);
      settingsCache.set(key, structuredClone(val));
      if (key === 'model') {
        upsertStmt.run(MODEL_SEEDED_META_KEY, 'true', now);
      }
    } else {
      try {
        const parsed = JSON.parse(raw);
        settingsCache.set(key, parsed);
      } catch {
        const val = initialDefaults[key];
        upsertStmt.run(key, JSON.stringify(val), now);
        settingsCache.set(key, structuredClone(val));
      }
    }
  }

  if (hasSavedModel && modelWasSeeded) {
    // Belum pernah diubah manual lewat Web Admin: sinkronkan dengan DEFAULT_MODEL dari .env
    const currentModel = settingsCache.get('model');
    if (currentModel !== defaultModel) {
      upsertStmt.run('model', JSON.stringify(defaultModel), now);
      settingsCache.set('model', defaultModel);
    }
  }

  const currentLogLevel = getSetting('log_level');
  setLogLevel(currentLogLevel);
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  if (settingsCache.has(key)) {
    const val = settingsCache.get(key) as Settings[K];
    return Array.isArray(val) ? ([...val] as Settings[K]) : val;
  }
  const fallback = initialDefaults[key];
  return Array.isArray(fallback) ? ([...fallback] as Settings[K]) : fallback;
}

export function getSettings(): Settings {
  const result = {} as Record<keyof Settings, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    result[key] = getSetting(key);
  }
  return result as unknown as Settings;
}

export function getDefaultSettings(): Settings {
  return structuredClone(initialDefaults);
}

export function updateSettings(partial: Partial<Settings>, options?: { fromAdmin?: boolean }): Settings {
  const db = getDb();
  const now = Date.now();
  const upsertStmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [k, v] of Object.entries(partial)) {
      if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
      const key = k as keyof Settings;
      upsertStmt.run(key, JSON.stringify(v), now);
      settingsCache.set(key, Array.isArray(v) ? [...v] : v);
      if (key === 'model' && options?.fromAdmin !== false) {
        upsertStmt.run(MODEL_SEEDED_META_KEY, 'false', now);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (partial.log_level && (VALID_LOG_LEVELS as readonly string[]).includes(partial.log_level)) {
    setLogLevel(partial.log_level);
  }

  return getSettings();
}

export function resetSettings(keys?: Array<keyof Settings>): Settings {
  const targetKeys = keys && keys.length > 0 ? keys : (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>);
  const patch: Partial<Settings> = {};
  for (const key of targetKeys) {
    if (key in initialDefaults) {
      (patch as Record<string, unknown>)[key] = structuredClone(initialDefaults[key]);
    }
  }
  return updateSettings(patch);
}

export { VALID_LOG_LEVELS };
