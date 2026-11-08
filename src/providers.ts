import { getDb } from './db.js';
import {
  decryptKey,
  decryptKeyCached,
  encryptKey,
  getSecretKey,
  invalidateKeyCache,
  isLegacyEncrypted,
} from './crypto.js';
import { logger } from './logger.js';
import { getSettings, updateSettings } from './settings.js';

export interface ProviderRow {
  id: number;
  name: string;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  createdAt: number;
}

export interface ProviderKeyRow {
  id: number;
  providerId: number;
  label: string;
  keyEncrypted: string;
  keyLast4: string;
  enabled: boolean;
  cooldownUntil: number;
  failCount: number;
  createdAt: number;
}

export interface ProviderWithKeys extends ProviderRow {
  keys: ProviderKeyRow[];
}

interface RawProviderRow {
  id: number;
  name: string;
  base_url: string;
  enabled: number;
  priority: number;
  created_at: number;
}

interface RawProviderKeyRow {
  id: number;
  provider_id: number;
  label: string;
  key_encrypted: string;
  key_last4: string;
  enabled: number;
  cooldown_until: number;
  fail_count: number;
  created_at: number;
}

function mapProvider(row: RawProviderRow): ProviderRow {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    createdAt: row.created_at,
  };
}

function mapKey(row: RawProviderKeyRow): ProviderKeyRow {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    keyEncrypted: row.key_encrypted,
    keyLast4: row.key_last4,
    enabled: Boolean(row.enabled),
    cooldownUntil: row.cooldown_until,
    failCount: row.fail_count,
    createdAt: row.created_at,
  };
}

function selectProvider(id: number): RawProviderRow | undefined {
  return getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as unknown as RawProviderRow | undefined;
}

function selectKey(id: number): RawProviderKeyRow | undefined {
  return getDb().prepare('SELECT * FROM provider_keys WHERE id = ?').get(id) as unknown as RawProviderKeyRow | undefined;
}

function rowToProvider(row: RawProviderRow): ProviderWithKeys {
  const keys = getDb()
    .prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY id ASC')
    .all(row.id) as unknown as RawProviderKeyRow[];
  return { ...mapProvider(row), keys: keys.map(mapKey) };
}

export function listProviders(): ProviderWithKeys[] {
  const rows = getDb()
    .prepare('SELECT * FROM providers ORDER BY priority ASC, id ASC')
    .all() as unknown as RawProviderRow[];
  return rows.map(rowToProvider);
}

export function getProvider(id: number): ProviderWithKeys | null {
  const row = selectProvider(id);
  return row ? rowToProvider(row) : null;
}

export function getProviderByName(name: string): ProviderRow | null {
  const row = getDb().prepare('SELECT * FROM providers WHERE name = ?').get(name) as unknown as
    | RawProviderRow
    | undefined;
  return row ? mapProvider(row) : null;
}

export function createProvider(name: string, baseUrl: string, priority: number): ProviderRow {
  const db = getDb();
  const result = db
    .prepare('INSERT INTO providers (name, base_url, enabled, priority, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, baseUrl, 1, priority, Date.now());
  const row = selectProvider(Number(result.lastInsertRowid));
  if (!row) throw new Error('gagal membuat provider');
  return mapProvider(row);
}

export function updateProvider(
  id: number,
  patch: Partial<Omit<ProviderRow, 'id' | 'createdAt'>>,
): ProviderRow | null {
  const db = getDb();
  const existing = selectProvider(id);
  if (!existing) return null;
  db.prepare('UPDATE providers SET name = ?, base_url = ?, enabled = ?, priority = ? WHERE id = ?').run(
    patch.name !== undefined ? patch.name : existing.name,
    patch.baseUrl !== undefined ? patch.baseUrl : existing.base_url,
    patch.enabled === undefined ? existing.enabled : (patch.enabled ? 1 : 0),
    patch.priority !== undefined ? patch.priority : existing.priority,
    id,
  );
  const row = selectProvider(id);
  return row ? mapProvider(row) : null;
}

export function deleteProvider(id: number): boolean {
  const db = getDb();
  const provider = selectProvider(id);
  if (!provider) return false;
  for (const key of listKeys(id)) invalidateKeyCache(key.id);
  keyCounters.delete(id);
  db.prepare('DELETE FROM provider_keys WHERE provider_id = ?').run(id);
  db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  return true;
}

export function getKey(id: number): ProviderKeyRow | null {
  const row = selectKey(id);
  return row ? mapKey(row) : null;
}

export function listKeys(providerId: number): ProviderKeyRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY id ASC')
    .all(providerId) as unknown as RawProviderKeyRow[];
  return rows.map(mapKey);
}

export function addKey(
  providerId: number,
  label: string,
  keyEncrypted: string,
  keyLast4: string,
): ProviderKeyRow | null {
  const db = getDb();
  const result = db
    .prepare(
      'INSERT INTO provider_keys (provider_id, label, key_encrypted, key_last4, enabled, cooldown_until, fail_count, created_at) VALUES (?, ?, ?, ?, 1, 0, 0, ?)',
    )
    .run(providerId, label, keyEncrypted, keyLast4, Date.now());
  const row = selectKey(Number(result.lastInsertRowid));
  return row ? mapKey(row) : null;
}

export function updateKey(
  id: number,
  patch: Partial<Omit<ProviderKeyRow, 'id' | 'providerId' | 'createdAt'>>,
): ProviderKeyRow | null {
  const db = getDb();
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.label !== undefined) {
    sets.push('label = ?');
    values.push(patch.label);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.cooldownUntil !== undefined) {
    sets.push('cooldown_until = ?');
    values.push(patch.cooldownUntil);
  }
  if (patch.failCount !== undefined) {
    sets.push('fail_count = ?');
    values.push(patch.failCount);
  }
  if (sets.length === 0) return selectKey(id) ? mapKey(selectKey(id)!) : null;
  values.push(id);
  db.prepare(`UPDATE provider_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  invalidateKeyCache(id);
  const row = selectKey(id);
  return row ? mapKey(row) : null;
}

export function deleteKey(id: number): boolean {
  const db = getDb();
  const key = selectKey(id);
  if (!key) return false;
  db.prepare('DELETE FROM provider_keys WHERE id = ?').run(id);
  invalidateKeyCache(id);
  return true;
}

export function toggleKey(id: number, enabled: boolean): boolean {
  const db = getDb();
  db.prepare('UPDATE provider_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  invalidateKeyCache(id);
  return Boolean(selectKey(id));
}

export function toggleProvider(id: number, enabled: boolean): boolean {
  const db = getDb();
  db.prepare('UPDATE providers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return Boolean(selectProvider(id));
}

export interface ResolvedLlmKey {
  baseUrl: string;
  apiKey: string;
  providerId: number;
  keyId: number;
  model: string;
}

export interface LlmContext {
  resolveModel(modelName: string): Promise<ResolvedLlmKey | null>;
  markKeyFailed(providerId: number, keyId: number, status: number, retryAfterMs?: number): Promise<void>;
  markKeySucceeded(providerId: number, keyId: number): Promise<void>;
}

const keyCounters = new Map<number, number>();

export function createLlmContext(): LlmContext {
  return {
    async resolveModel(modelName: string): Promise<ResolvedLlmKey | null> {
      const slash = modelName.indexOf('/');
      const requestedProvider = slash >= 0 ? modelName.slice(0, slash) : '';
      const requested = requestedProvider ? getProviderByName(requestedProvider) : null;
      const namedProvider = requested?.enabled ? requestedProvider : '';
      const providerName = namedProvider || (await defaultProviderName());
      const actualModel = namedProvider ? modelName.slice(slash + 1) : modelName;
      if (!providerName) return null;
      const rawProvider = getDb()
        .prepare('SELECT * FROM providers WHERE name = ?')
        .get(providerName) as unknown as RawProviderRow | undefined;
      if (!rawProvider || !Boolean(rawProvider.enabled)) return null;

      const now = Date.now();
      const allKeys = getDb()
        .prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY id ASC')
        .all(rawProvider.id) as unknown as RawProviderKeyRow[];
      // Provider tanpa key sama sekali (mis. 9router lokal tanpa auth) tetap boleh dipakai.
      if (allKeys.length === 0) {
        return {
          baseUrl: mapProvider(rawProvider).baseUrl,
          apiKey: '',
          providerId: rawProvider.id,
          keyId: 0,
          model: actualModel,
        };
      }
      const rawKeys = allKeys.filter((key) => Boolean(key.enabled));
      if (rawKeys.length === 0) return null;
      const available = rawKeys.filter((key) => key.cooldown_until <= now);
      const candidates = available.length > 0
        ? available
        : [rawKeys.reduce((nearest, key) => key.cooldown_until < nearest.cooldown_until ? key : nearest)];

      const counter = keyCounters.get(rawProvider.id) ?? 0;
      const rawKey = candidates[counter % candidates.length]!;
      keyCounters.set(rawProvider.id, (counter + 1) % 1_000_000);

      const secret = getSecretKey();
      if (!secret) return null;
      try {
        const key = mapKey(rawKey);
        const apiKey = decryptKeyCached(key.id, key.keyEncrypted);
        return {
          baseUrl: mapProvider(rawProvider).baseUrl,
          apiKey,
          providerId: rawProvider.id,
          keyId: key.id,
          model: actualModel,
        };
      } catch (err) {
        logger.error({ keyId: rawKey.id, err }, 'gagal dekript key, dilewati');
        return null;
      }
    },
    async markKeyFailed(
      _providerId: number,
      keyId: number,
      status: number,
      retryAfterMs?: number,
    ): Promise<void> {
      if (keyId <= 0) return;
      const db = getDb();
      const now = Date.now();
      db.prepare('UPDATE provider_keys SET fail_count = fail_count + 1 WHERE id = ?').run(keyId);
      const key = selectKey(keyId);
      if (!key) return;
      const otherKey = db
        .prepare(
          'SELECT 1 FROM provider_keys WHERE provider_id = ? AND enabled = 1 AND id != ? LIMIT 1',
        )
        .get(key.provider_id, keyId);
      if (!otherKey) {
        db.prepare('UPDATE provider_keys SET cooldown_until = 0 WHERE id = ?').run(keyId);
        return;
      }
      let cooldownMs = 5_000;
      if (status === 429) cooldownMs = Math.min(60_000, Math.max(0, retryAfterMs ?? 30_000));
      else if (status === 401 || status === 403) cooldownMs = 30 * 60_000;
      else if (status >= 500 || status === 0) cooldownMs = 5_000;
      db.prepare('UPDATE provider_keys SET cooldown_until = ? WHERE id = ?').run(now + cooldownMs, keyId);
    },
    async markKeySucceeded(_providerId: number, keyId: number): Promise<void> {
      if (keyId <= 0) return;
      getDb().prepare('UPDATE provider_keys SET fail_count = 0, cooldown_until = 0 WHERE id = ?').run(keyId);
    },
  };
}

export function normalizeModelSettings(): void {
  const providers = listProviders();
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const defaultProvider = enabledProviders[0]?.name;
  if (!defaultProvider) return;
  const validNames = new Set(enabledProviders.map((provider) => provider.name));
  const addPrefix = (model: string): string => {
    const trimmed = model.trim();
    const slash = trimmed.indexOf('/');
    if (slash > 0 && validNames.has(trimmed.slice(0, slash))) return trimmed;
    return trimmed ? `${defaultProvider}/${trimmed}` : trimmed;
  };
  const settings = getSettings();
  const model = addPrefix(settings.model);
  const fallbackModels = settings.fallback_models.map(addPrefix);
  if (model !== settings.model || fallbackModels.some((value, index) => value !== settings.fallback_models[index])) {
    updateSettings({ model, fallback_models: fallbackModels });
  }
}

async function defaultProviderName(): Promise<string> {
  const db = getDb();
  const row = db
    .prepare('SELECT name FROM providers WHERE enabled = 1 ORDER BY priority ASC, id ASC LIMIT 1')
    .get() as { name: string } | undefined;
  return row?.name ?? '';
}

export interface KeyStoreReport {
  total: number;
  migrated: number;
  failed: number;
}

/**
 * Sekali saat start: migrasikan key format lama (scrypt per record) ke format
 * v2, lalu hangatkan cache dekripsi agar pesan tidak menjalankan scrypt.
 */
export function prepareKeyStore(): KeyStoreReport {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, key_encrypted FROM provider_keys')
    .all() as Array<{ id: number; key_encrypted: string }>;
  let migrated = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      let encrypted = row.key_encrypted;
      const plaintext = decryptKey(encrypted);
      if (isLegacyEncrypted(encrypted)) {
        encrypted = encryptKey(plaintext);
        db.prepare('UPDATE provider_keys SET key_encrypted = ? WHERE id = ?').run(encrypted, row.id);
        migrated += 1;
      }
      decryptKeyCached(row.id, encrypted);
    } catch (err) {
      failed += 1;
      invalidateKeyCache(row.id);
      logger.warn({ keyId: row.id, reason: err instanceof Error ? err.name : 'unknown' }, 'key tidak bisa disiapkan');
    }
  }

  return { total: rows.length, migrated, failed };
}
