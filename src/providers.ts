import type { ModelRoutingMode, Settings } from './config.js';
import { decryptKeyRow, encryptApiKey, invalidateKeyCache, maskLast4 } from './crypto.js';
import { getDb } from './db.js';
import { normalizeBaseUrl } from './endpoint.js';
import { logger } from './logger.js';
import { getSettings, updateSettings } from './settings.js';

export const MAX_PROVIDERS = 5;
export const MAX_KEYS_PER_PROVIDER = 5;
export const PROVIDER_FORMATS = ['openai', 'anthropic'] as const;
export const PROVIDER_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type ProviderFormat = (typeof PROVIDER_FORMATS)[number];

export function parseProviderFormat(value: unknown): ProviderFormat | null {
  return typeof value === 'string' && (PROVIDER_FORMATS as readonly string[]).includes(value)
    ? (value as ProviderFormat)
    : null;
}

export type KeyStatus = '' | 'valid' | 'invalid' | 'rate_limited' | 'unreachable' | 'error';

export interface ProviderKeyPublic {
  id: number;
  providerId: number;
  label: string;
  keyLast4: string;
  enabled: boolean;
  cooldownUntil: number;
  failCount: number;
  lastStatus: KeyStatus;
  lastCheckedAt: number;
  createdAt: number;
}

export interface ProviderPublic {
  id: number;
  name: string;
  baseUrl: string;
  format: ProviderFormat;
  enabled: boolean;
  createdAt: number;
  keys: ProviderKeyPublic[];
}

interface ProviderRow {
  id: number;
  name: string;
  base_url: string;
  format: string;
  model: string;
  enabled: number;
  priority: number;
  created_at: number;
}

interface ProviderKeyRow {
  id: number;
  provider_id: number;
  label: string;
  key_encrypted: string;
  key_last4: string;
  enabled: number;
  cooldown_until: number;
  fail_count: number;
  last_status: string;
  last_checked_at: number;
  created_at: number;
}

const keyCounters = new Map<number, number>();

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function toKeyPublic(row: ProviderKeyRow): ProviderKeyPublic {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    keyLast4: row.key_last4,
    enabled: row.enabled === 1,
    cooldownUntil: row.cooldown_until,
    failCount: row.fail_count,
    lastStatus: (row.last_status || '') as KeyStatus,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  };
}

export function listProviders(): ProviderPublic[] {
  const db = getDb();
  const providers = db
    .prepare('SELECT * FROM providers ORDER BY id ASC')
    .all() as unknown as ProviderRow[];
  const keys = db
    .prepare('SELECT * FROM provider_keys ORDER BY id ASC')
    .all() as unknown as ProviderKeyRow[];

  const keysByProvider = new Map<number, ProviderKeyPublic[]>();
  for (const k of keys) {
    const list = keysByProvider.get(k.provider_id) ?? [];
    list.push(toKeyPublic(k));
    keysByProvider.set(k.provider_id, list);
  }

  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.base_url,
    format: parseProviderFormat(p.format) ?? 'openai',
    enabled: p.enabled === 1,
    createdAt: p.created_at,
    keys: keysByProvider.get(p.id) ?? [],
  }));
}

export function getProviderById(id: number): ProviderPublic | null {
  const all = listProviders();
  return all.find((p) => p.id === id) ?? null;
}

export function createProvider(input: {
  name: string;
  baseUrl: string;
  format?: unknown;
  apiKey: string;
  keyLabel?: string;
  enabled?: boolean;
}): ProviderPublic {
  const db = getDb();
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM providers').get() as { cnt: number };
  if (Number(countRow.cnt) >= MAX_PROVIDERS) {
    throw new ProviderError(`Maksimal ${MAX_PROVIDERS} provider diperbolehkan.`, 409);
  }

  const name = (input.name ?? '').trim().toLowerCase();
  if (!PROVIDER_NAME_REGEX.test(name)) {
    throw new ProviderError(
      'Nama provider wajib huruf kecil/angka/strip/garis bawah (1-32 karakter, diawali huruf/angka).',
      400
    );
  }

  const existing = db.prepare('SELECT id FROM providers WHERE name = ?').get(name);
  if (existing) {
    throw new ProviderError(`Provider dengan nama "${name}" sudah ada.`, 409);
  }

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(input.baseUrl ?? '');
  } catch (err) {
    throw new ProviderError(err instanceof Error ? err.message : 'Base URL tidak valid.', 400);
  }

  const format = input.format === undefined ? 'openai' : parseProviderFormat(input.format);
  if (!format) {
    throw new ProviderError('Format provider wajib openai atau anthropic.', 400);
  }

  // API key terikat pada provider: wajib ada sejak provider dibuat.
  if (!(input.apiKey ?? '').trim()) {
    throw new ProviderError('API key wajib diisi untuk menambah provider.', 400);
  }

  const enabled = input.enabled === false ? 0 : 1;
  const now = Date.now();

  // Provider dan key pertamanya disimpan atomik agar tidak ada provider tanpa key.
  let newId: number;
  db.exec('BEGIN IMMEDIATE');
  try {
    const res = db
      .prepare(
        `INSERT INTO providers (name, base_url, format, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(name, baseUrl, format, enabled, now);
    newId = Number(res.lastInsertRowid);
    addProviderKey(newId, { label: input.keyLabel?.trim() || 'key-1', apiKey: input.apiKey });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const created = getProviderById(newId);
  if (!created) {
    throw new ProviderError('Gagal membaca provider yang baru dibuat.', 500);
  }
  return created;
}

export function updateProvider(
  id: number,
  input: {
    name?: string;
    baseUrl?: string;
    format?: unknown;
    enabled?: boolean;
  }
): ProviderPublic {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM providers WHERE id = ?')
    .get(id) as unknown as ProviderRow | undefined;
  if (!row) {
    throw new ProviderError('Provider tidak ditemukan.', 404);
  }

  const oldName = row.name.toLowerCase();
  let name = row.name;
  if (input.name !== undefined) {
    name = input.name.trim().toLowerCase();
    if (!PROVIDER_NAME_REGEX.test(name)) {
      throw new ProviderError(
        'Nama provider wajib huruf kecil/angka/strip/garis bawah (1-32 karakter, diawali huruf/angka).',
        400
      );
    }
    const dup = db.prepare('SELECT id FROM providers WHERE name = ? AND id != ?').get(name, id);
    if (dup) {
      throw new ProviderError(`Provider dengan nama "${name}" sudah ada.`, 409);
    }
  }

  let baseUrl = row.base_url;
  if (input.baseUrl !== undefined) {
    try {
      baseUrl = normalizeBaseUrl(input.baseUrl);
    } catch (err) {
      throw new ProviderError(err instanceof Error ? err.message : 'Base URL tidak valid.', 400);
    }
    if (baseUrl !== row.base_url) {
      const keyCountRow = db
        .prepare('SELECT COUNT(*) AS cnt FROM provider_keys WHERE provider_id = ?')
        .get(id) as { cnt: number };
      if (Number(keyCountRow.cnt) > 0) {
        throw new ProviderError(
          'Hapus semua API key pada provider ini terlebih dahulu sebelum mengubah Base URL',
          400
        );
      }
    }
  }

  let format: ProviderFormat = parseProviderFormat(row.format) ?? 'openai';
  if (input.format !== undefined) {
    const parsed = parseProviderFormat(input.format);
    if (!parsed) {
      throw new ProviderError('Format provider wajib openai atau anthropic.', 400);
    }
    format = parsed;
  }

  let enabled = row.enabled;
  if (input.enabled !== undefined) {
    enabled = input.enabled ? 1 : 0;
  }

  db.prepare(
    `UPDATE providers
     SET name = ?, base_url = ?, format = ?, enabled = ?
     WHERE id = ?`
  ).run(name, baseUrl, format, enabled, id);

  if (name !== oldName) {
    const oldPrefix = `${oldName}/`;
    const newPrefix = `${name}/`;
    const settings = getSettings();
    let newModel = settings.model;
    if (newModel && newModel.toLowerCase().startsWith(oldPrefix)) {
      newModel = newPrefix + newModel.slice(oldPrefix.length);
    }
    const newFallbacks = (settings.fallback_models || []).map((m) => {
      return m.toLowerCase().startsWith(oldPrefix)
        ? newPrefix + m.slice(oldPrefix.length)
        : m;
    });
    updateSettings({ model: newModel, fallback_models: newFallbacks }, { fromAdmin: false });
  }

  const updated = getProviderById(id);
  if (!updated) {
    throw new ProviderError('Provider tidak ditemukan.', 404);
  }
  return updated;
}

function cleanSettingsAfterProviderDeleted(deletedProvName: string): void {
  const settings = getSettings();
  const prefix = `${deletedProvName.toLowerCase()}/`;

  const isBoundToDeleted = (m: string) => {
    const trimmed = m.trim().toLowerCase();
    return trimmed.startsWith(prefix) || trimmed === deletedProvName.toLowerCase();
  };

  const oldModel = settings.model || '';
  const oldFallbacks = Array.isArray(settings.fallback_models) ? settings.fallback_models : [];

  const remainingFallbacks = oldFallbacks.filter((m) => !isBoundToDeleted(m));
  let newModel = oldModel;

  if (isBoundToDeleted(oldModel)) {
    // Model utama berasal dari provider yang dihapus:
    // Promosikan model cadangan pertama yang tersisa (bila ada), atau kosongkan
    newModel = remainingFallbacks.shift() ?? '';
  }

  const db = getDb();
  const remainingProvCount = db.prepare('SELECT COUNT(*) AS cnt FROM providers').get() as { cnt: number };
  if (Number(remainingProvCount.cnt) === 0) {
    newModel = '';
    remainingFallbacks.length = 0;
  }

  if (newModel !== oldModel || remainingFallbacks.length !== oldFallbacks.length) {
    updateSettings(
      {
        model: newModel,
        fallback_models: remainingFallbacks,
      },
      { fromAdmin: false }
    );
  }
}

export function deleteProvider(id: number): void {
  const db = getDb();
  const provRow = db
    .prepare('SELECT id, name FROM providers WHERE id = ?')
    .get(id) as { id: number; name: string } | undefined;
  if (!provRow) {
    throw new ProviderError('Provider tidak ditemukan.', 404);
  }
  const provName = provRow.name;
  const keys = db
    .prepare('SELECT id FROM provider_keys WHERE provider_id = ?')
    .all(id) as Array<{ id: number }>;
  const res = db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  if (res.changes === 0) {
    throw new ProviderError('Provider tidak ditemukan.', 404);
  }
  for (const k of keys) {
    invalidateKeyCache(k.id);
  }
  keyCounters.delete(id);

  cleanSettingsAfterProviderDeleted(provName);
}

export function toggleProvider(id: number, enabled: boolean): ProviderPublic {
  return updateProvider(id, { enabled });
}

export function addProviderKey(
  providerId: number,
  input: { label: string; apiKey: string }
): ProviderKeyPublic {
  const db = getDb();
  const prov = db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId);
  if (!prov) {
    throw new ProviderError('Provider tidak ditemukan.', 404);
  }

  const countRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM provider_keys WHERE provider_id = ?')
    .get(providerId) as { cnt: number };
  if (Number(countRow.cnt) >= MAX_KEYS_PER_PROVIDER) {
    throw new ProviderError(
      `Maksimal ${MAX_KEYS_PER_PROVIDER} API key per provider diperbolehkan.`,
      409
    );
  }

  const label = (input.label ?? '').trim();
  if (!label || label.length > 64) {
    throw new ProviderError('Label key wajib diisi (maksimal 64 karakter).', 400);
  }

  const apiKey = (input.apiKey ?? '').trim();
  if (!apiKey || apiKey.length > 512) {
    throw new ProviderError('API key wajib diisi (maksimal 512 karakter).', 400);
  }

  const encrypted = encryptApiKey(apiKey);
  const last4 = maskLast4(apiKey);
  const now = Date.now();

  const res = db
    .prepare(
      `INSERT INTO provider_keys (provider_id, label, key_encrypted, key_last4, enabled, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    )
    .run(providerId, label, encrypted, last4, now);

  const keyId = Number(res.lastInsertRowid);
  const row = db
    .prepare('SELECT * FROM provider_keys WHERE id = ?')
    .get(keyId) as unknown as ProviderKeyRow | undefined;
  if (!row) {
    throw new ProviderError('Gagal membaca API key yang baru disimpan.', 500);
  }
  return toKeyPublic(row);
}

export function deleteProviderKey(providerId: number, keyId: number): void {
  const db = getDb();
  const res = db
    .prepare('DELETE FROM provider_keys WHERE id = ? AND provider_id = ?')
    .run(keyId, providerId);
  if (res.changes === 0) {
    throw new ProviderError('API key tidak ditemukan.', 404);
  }
  invalidateKeyCache(keyId);
}

export function toggleProviderKey(
  providerId: number,
  keyId: number,
  enabled: boolean
): ProviderKeyPublic {
  const db = getDb();
  const res = db
    .prepare('UPDATE provider_keys SET enabled = ? WHERE id = ? AND provider_id = ?')
    .run(enabled ? 1 : 0, keyId, providerId);
  if (res.changes === 0) {
    throw new ProviderError('API key tidak ditemukan.', 404);
  }
  const row = db
    .prepare('SELECT * FROM provider_keys WHERE id = ?')
    .get(keyId) as unknown as ProviderKeyRow;
  return toKeyPublic(row);
}

export function getProviderKeySecret(
  keyId: number,
  providerId?: number
): {
  id: number;
  providerId: number;
  label: string;
  plainKey: string;
  baseUrl: string;
  format: ProviderFormat;
} | null {
  const db = getDb();
  const sql =
    providerId !== undefined
      ? `SELECT pk.*, p.base_url, p.format AS provider_format
         FROM provider_keys pk
         JOIN providers p ON p.id = pk.provider_id
         WHERE pk.id = ? AND pk.provider_id = ?`
      : `SELECT pk.*, p.base_url, p.format AS provider_format
         FROM provider_keys pk
         JOIN providers p ON p.id = pk.provider_id
         WHERE pk.id = ?`;

  const row = (
    providerId !== undefined ? db.prepare(sql).get(keyId, providerId) : db.prepare(sql).get(keyId)
  ) as unknown as (ProviderKeyRow & { base_url: string; provider_format: string }) | undefined;

  if (!row) return null;
  const plainKey = decryptKeyRow(row.id, row.key_encrypted);
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    plainKey,
    baseUrl: row.base_url,
    format: parseProviderFormat(row.provider_format) ?? 'openai',
  };
}

export function updateKeyProbeStatus(
  keyId: number,
  status: KeyStatus,
  resetCooldown = false
): void {
  const db = getDb();
  const now = Date.now();
  if (resetCooldown) {
    db.prepare(
      `UPDATE provider_keys
       SET last_status = ?, last_checked_at = ?, cooldown_until = 0, fail_count = 0
       WHERE id = ?`
    ).run(status, now, keyId);
  } else {
    db.prepare(
      `UPDATE provider_keys
       SET last_status = ?, last_checked_at = ?
       WHERE id = ?`
    ).run(status, now, keyId);
  }
}

export function markKeySucceeded(keyId: number): void {
  if (!keyId) return;
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE provider_keys
     SET fail_count = 0, cooldown_until = 0, last_status = 'valid', last_checked_at = ?
     WHERE id = ?`
  ).run(now, keyId);
}

export function markKeyFailed(
  keyId: number,
  providerId: number,
  httpStatus: number,
  retryAfterHeader?: string | null
): void {
  if (!keyId) return;
  const db = getDb();
  const now = Date.now();

  const activeCountRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM provider_keys WHERE provider_id = ? AND enabled = 1')
    .get(providerId) as { cnt: number };
  const hasOtherKey = Number(activeCountRow.cnt) > 1;

  let status: KeyStatus = 'error';
  let cooldownMs = 5_000;

  if (httpStatus === 401 || httpStatus === 403) {
    status = 'invalid';
    cooldownMs = 30 * 60_000;
  } else if (httpStatus === 429) {
    status = 'rate_limited';
    let retrySec = 30;
    if (retryAfterHeader) {
      const parsed = Number.parseInt(retryAfterHeader.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        retrySec = Math.min(60, parsed);
      }
    }
    cooldownMs = retrySec * 1000;
  } else if (httpStatus === 0) {
    status = 'unreachable';
    cooldownMs = 5_000;
  } else {
    status = 'error';
    cooldownMs = 5_000;
  }

  const cooldownUntil = hasOtherKey ? now + cooldownMs : 0;

  db.prepare(
    `UPDATE provider_keys
     SET fail_count = fail_count + 1,
         cooldown_until = ?,
         last_status = ?,
         last_checked_at = ?
     WHERE id = ?`
  ).run(cooldownUntil, status, now, keyId);
}

export function normalizeModelSettings(): void {
  const settings = getSettings();

  if (settings.model) {
    const trimmed = settings.model.trim();
    if (trimmed !== settings.model) {
      updateSettings({ model: trimmed }, { fromAdmin: false });
    }
  }
}

let modelRoundRobinIndex = 0;

/**
 * Model utama dan cadangan dipilih sepenuhnya admin di tab Model; provider hanya
 * menyediakan endpoint dan API key, sehingga tidak ada model default per provider.
 * Mendukung mode fallback (urut), round_robin (rotasi bergiliran), dan fusion.
 */
export function buildModelPlan(
  settings: Settings,
  opts?: { advance?: boolean }
): { model: string; fallbackModels: string[]; mode: ModelRoutingMode } {
  const mode: ModelRoutingMode = settings.model_mode || 'fallback';
  const model = (settings.model ?? '').trim();
  const fallbackModels = (settings.fallback_models ?? [])
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && m !== model);

  const allModels = model ? [model, ...fallbackModels] : [...fallbackModels];
  if (allModels.length === 0) {
    return { model: '', fallbackModels: [], mode };
  }

  if (mode === 'round_robin' && allModels.length > 1) {
    const startIdx = modelRoundRobinIndex % allModels.length;
    if (opts?.advance) {
      modelRoundRobinIndex = (modelRoundRobinIndex + 1) % 1_000_000;
    }
    const rotated = allModels.slice(startIdx).concat(allModels.slice(0, startIdx));
    return {
      model: rotated[0],
      fallbackModels: rotated.slice(1),
      mode,
    };
  }

  return {
    model: allModels[0] || '',
    fallbackModels: allModels.slice(1),
    mode,
  };
}

export interface ResolvedTarget {
  providerId: number;
  providerName: string;
  baseUrl: string;
  format: ProviderFormat;
  modelName: string;
  fullModelLabel: string;
  keyId: number;
  apiKey: string;
  healthyKeyCount: number;
}

export function resolveModel(
  candidate: string,
  opts?: { advance?: boolean; excludeKeyIds?: Set<number> }
): ResolvedTarget | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const db = getDb();
  let providerRow: ProviderRow | undefined;
  let modelName = trimmed;

  const slashIdx = trimmed.indexOf('/');
  if (slashIdx > 0) {
    const prefix = trimmed.slice(0, slashIdx).toLowerCase();
    const rest = trimmed.slice(slashIdx + 1).trim();
    const byName = db
      .prepare('SELECT * FROM providers WHERE name = ?')
      .get(prefix) as unknown as ProviderRow | undefined;
    if (byName) {
      if (byName.enabled !== 1) {
        return null;
      }
      providerRow = byName;
      modelName = rest;
    }
  }

  if (!providerRow) {
    providerRow = db
      .prepare('SELECT * FROM providers WHERE enabled = 1 ORDER BY id ASC LIMIT 1')
      .get() as unknown as ProviderRow | undefined;
  }

  if (!providerRow || !modelName) {
    return null;
  }

  const allKeys = db
    .prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY id ASC')
    .all(providerRow.id) as unknown as ProviderKeyRow[];

  if (allKeys.length === 0) {
    return {
      providerId: providerRow.id,
      providerName: providerRow.name,
      baseUrl: providerRow.base_url,
      format: parseProviderFormat(providerRow.format) ?? 'openai',
      modelName,
      fullModelLabel: `${providerRow.name}/${modelName}`,
      keyId: 0,
      apiKey: '',
      healthyKeyCount: 1,
    };
  }

  const enabledKeys = allKeys.filter((k) => k.enabled === 1);
  if (enabledKeys.length === 0) {
    return null;
  }

  const now = Date.now();
  const exclude = opts?.excludeKeyIds;
  const availableKeys = enabledKeys.filter((k) => !exclude || !exclude.has(k.id));
  const pool = availableKeys.length > 0 ? availableKeys : enabledKeys;

  const nonCooldown = pool.filter((k) => k.cooldown_until <= now);
  let chosen: ProviderKeyRow;

  if (nonCooldown.length > 0) {
    const counter = keyCounters.get(providerRow.id) ?? 0;
    chosen = nonCooldown[counter % nonCooldown.length];
    if (opts?.advance !== false) {
      keyCounters.set(providerRow.id, (counter + 1) % 1_000_000);
    }
  } else {
    // Upaya terakhir: pilih key aktif dengan cooldown_until paling dekat/kecil
    chosen = [...pool].sort((a, b) => a.cooldown_until - b.cooldown_until)[0];
  }

  let plainKey = '';
  try {
    plainKey = decryptKeyRow(chosen.id, chosen.key_encrypted);
  } catch (err) {
    logger.error({ keyId: chosen.id, providerId: providerRow.id, err }, 'Gagal mendekripsi API key');
    return null;
  }

  const healthyKeyCount = enabledKeys.filter((k) => k.cooldown_until <= now).length;

  return {
    providerId: providerRow.id,
    providerName: providerRow.name,
    baseUrl: providerRow.base_url,
    format: parseProviderFormat(providerRow.format) ?? 'openai',
    modelName,
    fullModelLabel: `${providerRow.name}/${modelName}`,
    keyId: chosen.id,
    apiKey: plainKey,
    healthyKeyCount,
  };
}

export function getEffectivePlanAndRouterUrl(settings: Settings): {
  model: string;
  routerUrl: string;
} {
  const plan = buildModelPlan(settings);
  const firstCandidate = plan.model || plan.fallbackModels[0] || '';
  if (firstCandidate) {
    const resolved = resolveModel(firstCandidate, { advance: false });
    if (resolved) {
      return {
        model: plan.model || resolved.fullModelLabel,
        routerUrl: resolved.baseUrl,
      };
    }
  }

  const db = getDb();
  const topProv = db
    .prepare('SELECT base_url FROM providers WHERE enabled = 1 ORDER BY id ASC LIMIT 1')
    .get() as { base_url: string } | undefined;

  return {
    model: plan.model,
    routerUrl: topProv?.base_url ?? '',
  };
}
