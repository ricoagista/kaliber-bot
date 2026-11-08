import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import {
  DEFAULT_SETTINGS,
  loadEnv,
  type Settings,
  assertSecretKey,
} from './config.js';
import {
  countActiveMutes,
  countActiveStrikes,
  countLogsSince,
  countMessagesSince,
  getRecentAudit,
  getRecentLogs,
  getDb,
  insertAudit,
} from './db.js';
import { invalidPatterns } from './guard.js';
import { pingLlm, probeProvider } from './llm.js';
import { isLogLevel, logger } from './logger.js';
import { handleMessage } from './pipeline.js';
import { getSetting, getSettings, isKnownSettingKey, updateSettings } from './settings.js';
import {
  MAX_PROVIDERS,
  MAX_KEYS_PER_PROVIDER,
  LimitError,
  listProviders,
  getProvider,
  getKey,
  createProvider,
  updateProvider,
  deleteProvider,
  listKeys,
  addKey,
  recordKeyProbe,
  deleteKey,
  toggleKey,
  toggleProvider,
  createLlmContext,
  buildModelPlan,
  updateKey,
  type ProviderKeyRow,
  type ProviderRow,
  type ProviderWithKeys,
} from './providers.js';
import { encryptKey, decryptKeyCached, hasRevealPassword, verifyRevealPassword, keyLast4 } from './crypto.js';
import { endpointCandidates } from './endpoint.js';
import { getConnInfo } from '@hono/node-server/conninfo';

const env = loadEnv();
const here = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 64 * 1024;
const KNOWLEDGE_WARN_CHARS = 12_000;

export interface WaSnapshot {
  state: 'disconnected' | 'connecting' | 'open' | 'logged_out';
  qrDataUrl: string | null;
  pairingCode: string | null;
  me: string | null;
  lastError: string | null;
  reconnectAttempt: number;
}

export interface WaControl {
  snapshot(): Promise<WaSnapshot>;
  requestPairing(phone: string): Promise<string>;
  logout(): Promise<void>;
}

export interface ApiDeps {
  wa: WaControl;
  startedAt: number;
}

const STRING_LIMITS: Record<string, number> = {
  system_prompt: 20_000,
  contact: 200,
  fallback_text: 2_000,
  refusal_text: 2_000,
  info_text: 2_000,
  help_text: 2_000,
  knowledge: 50_000,
  model: 200,
  llm_strategy: 20,
  trigger_prefix: 32,
  log_level: 10,
};

const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PROVIDER_BASE_URL_RE = /^https?:\/\//;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

const BOOLEAN_KEYS = new Set<string>([
  'bot_enabled',
  'private_enabled',
  'group_enabled',
  'allowlist_enabled',
]);

const NUMBER_RANGES: Record<string, { min: number; max: number; int?: boolean }> = {
  temperature: { min: 0, max: 2 },
  max_tokens: { min: 1, max: 2_000, int: true },
  history_turns: { min: 0, max: 20, int: true },
  max_input_chars: { min: 20, max: 5_000, int: true },
  rate_limit_per_min: { min: 1, max: 120, int: true },
  group_cooldown_sec: { min: 0, max: 3_600, int: true },
  strike_limit: { min: 1, max: 20, int: true },
  strike_window_min: { min: 1, max: 1_440, int: true },
  mute_minutes: { min: 1, max: 10_080, int: true },
};

function validateProviderName(name: string): boolean {
  return PROVIDER_NAME_RE.test(name);
}

function validateProviderBaseUrl(baseUrl: string): boolean {
  return PROVIDER_BASE_URL_RE.test(baseUrl);
}

function validateProviderModel(raw: unknown): { ok: true; model: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'model harus teks' };
  const model = raw.trim();
  if (model.length > 120) return { ok: false, error: 'model maksimal 120 karakter' };
  if (CONTROL_CHAR_RE.test(model)) return { ok: false, error: 'model tidak boleh memuat karakter kontrol' };
  return { ok: true, model };
}

const LIST_LIMITS: Record<string, { maxItems: number; maxLen: number }> = {
  allowed_groups: { maxItems: 100, maxLen: 100 },
  fallback_models: { maxItems: 10, maxLen: 200 },
  blocklist: { maxItems: 500, maxLen: 100 },
  allowlist: { maxItems: 500, maxLen: 100 },
  injection_patterns: { maxItems: 50, maxLen: 300 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ValidationResult =
  | { ok: true; patch: Partial<Settings> }
  | { ok: false; error: string };

export function validatePatch(input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, error: 'body harus berupa object JSON' };
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!isKnownSettingKey(key)) {
      return { ok: false, error: `setting tidak dikenal: ${key}` };
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') return { ok: false, error: `${key} harus boolean` };
      patch[key] = value;
      continue;
    }
    if (key in NUMBER_RANGES) {
      const range = NUMBER_RANGES[key]!;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `${key} harus angka` };
      }
      if (value < range.min || value > range.max) {
        return { ok: false, error: `${key} harus antara ${range.min} dan ${range.max}` };
      }
      if (range.int && !Number.isInteger(value)) return { ok: false, error: `${key} harus bilangan bulat` };
      patch[key] = value;
      continue;
    }
    if (key in STRING_LIMITS) {
      if (typeof value !== 'string') return { ok: false, error: `${key} harus teks` };
      if (value.length > STRING_LIMITS[key]!) {
        return { ok: false, error: `${key} maksimal ${STRING_LIMITS[key]} karakter` };
      }
      if (key === 'log_level' && !isLogLevel(value)) {
        return { ok: false, error: 'log_level harus salah satu: trace, debug, info, warn, error, fatal' };
      }
      if (key === 'llm_strategy' && value !== 'manual' && value !== 'round_robin' && value !== 'priority') {
        return { ok: false, error: 'llm_strategy harus salah satu: manual, round_robin, priority' };
      }
      patch[key] = value;
      continue;
    }
    if (key in LIST_LIMITS) {
      const limit = LIST_LIMITS[key]!;
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { ok: false, error: `${key} harus daftar teks` };
      }
      const list = (value as string[]).map((item) => item.trim()).filter(Boolean);
      if (list.length > limit.maxItems) {
        return { ok: false, error: `${key} maksimal ${limit.maxItems} baris` };
      }
      const tooLong = list.find((item) => item.length > limit.maxLen);
      if (tooLong) return { ok: false, error: `${key}: item terlalu panjang` };
      if (key === 'injection_patterns') {
        const invalid = invalidPatterns(list);
        if (invalid.length > 0) return { ok: false, error: `regex tidak valid: ${invalid.join(' | ')}` };
      }
      patch[key] = list;
      continue;
    }
    return { ok: false, error: `setting tidak dikenal: ${key}` };
  }
  return { ok: true, patch: patch as Partial<Settings> };
}

const loginFailures = new Map<string, number[]>();
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

// Rate limit untuk password reveal
const revealFailures = new Map<string, number[]>();
const REVEAL_FAILURE_WINDOW_MS = 60_000;
const MAX_REVEAL_FAILURES = 5;

// Rate limit global untuk endpoint tes provider/key (maks 20 per menit)
const probeBuckets = new Map<string, number[]>();
const PROBE_WINDOW_MS = 60_000;
const MAX_PROBE_PER_MIN = 20;

function allowProbeRequest(now: number): boolean {
  pruneFailureMap(probeBuckets, now, PROBE_WINDOW_MS);
  const key = 'global';
  const list = (probeBuckets.get(key) ?? []).filter((ts) => now - ts < PROBE_WINDOW_MS);
  if (list.length >= MAX_PROBE_PER_MIN) {
    probeBuckets.set(key, list);
    return false;
  }
  list.push(now);
  probeBuckets.set(key, list);
  if (probeBuckets.size > 5000) probeBuckets.delete(probeBuckets.keys().next().value as string);
  return true;
}

function clientIp(c: Parameters<typeof getConnInfo>[0], trustProxy = env.trustProxy): string {
  if (trustProxy) {
    return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  }
  const rawEnv = (c as { env?: { incoming?: unknown } }).env;
  if (rawEnv && typeof rawEnv === 'object' && 'incoming' in rawEnv && rawEnv.incoming) {
    try {
      return getConnInfo(c).remote.address || 'local';
    } catch {
      return 'local';
    }
  }
  // Fallback saat dijalankan in-memory (app.request di unit test tanpa socket HTTP).
  return c.req.header('cf-connecting-ip') || 'local';
}

function tooManyFailures(ip: string, now: number): boolean {
  pruneFailureMap(loginFailures, now, FAILURE_WINDOW_MS);
  const list = (loginFailures.get(ip) ?? []).filter((ts) => now - ts < FAILURE_WINDOW_MS);
  loginFailures.set(ip, list);
  if (loginFailures.size > 5000) loginFailures.delete(loginFailures.keys().next().value as string);
  return list.length >= MAX_FAILURES;
}

function recordFailure(ip: string, now: number): void {
  pruneFailureMap(loginFailures, now, FAILURE_WINDOW_MS);
  const list = loginFailures.get(ip) ?? [];
  list.push(now);
  loginFailures.set(ip, list);
  if (loginFailures.size > 5000) loginFailures.delete(loginFailures.keys().next().value as string);
}

function revealBlocked(ip: string, now: number): boolean {
  pruneFailureMap(revealFailures, now, REVEAL_FAILURE_WINDOW_MS);
  const list = (revealFailures.get(ip) ?? []).filter((ts) => now - ts < REVEAL_FAILURE_WINDOW_MS);
  revealFailures.set(ip, list);
  if (revealFailures.size > 5000) revealFailures.delete(revealFailures.keys().next().value as string);
  return list.length >= MAX_REVEAL_FAILURES;
}

function recordRevealFailure(ip: string, now: number): void {
  pruneFailureMap(revealFailures, now, REVEAL_FAILURE_WINDOW_MS);
  const list = revealFailures.get(ip) ?? [];
  list.push(now);
  revealFailures.set(ip, list);
  if (revealFailures.size > 5000) revealFailures.delete(revealFailures.keys().next().value as string);
}

function pruneFailureMap(map: Map<string, number[]>, now: number, windowMs: number): void {
  for (const [key, timestamps] of map) {
    const active = timestamps.filter((ts) => now - ts < windowMs);
    if (active.length === 0) map.delete(key);
    else map.set(key, active);
  }
  while (map.size > 5000) {
    const oldest = map.keys().next().value;
    if (typeof oldest !== 'string') break;
    map.delete(oldest);
  }
}

function tokenMatches(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  const givenHash = createHash('sha256').update(given).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(givenHash, expectedHash);
}

function findIndexHtml(): string | null {
  const candidates = [
    path.resolve('public', 'index.html'),
    path.resolve(here, '..', 'public', 'index.html'),
    path.resolve(here, '..', '..', 'public', 'index.html'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** Jangan pernah kirim ciphertext key ke browser; cukup metadata + mask. */
function publicKey(row: ProviderKeyRow): Omit<ProviderKeyRow, 'keyEncrypted'> {
  const { keyEncrypted: _encrypted, ...rest } = row;
  return rest;
}

const MODEL_FETCH_TIMEOUT_MS = 8_000;

interface ProviderModels {
  providerId: number;
  provider: string;
  models: string[];
  error?: string;
}

/**
 * Ambil daftar model dari endpoint /models provider memakai key aktif yang
 * tersimpan. Key tidak pernah dikirim ke klien.
 */
async function fetchProviderModels(provider: ProviderWithKeys): Promise<ProviderModels> {
  const key = provider.keys.find((item) => item.enabled);
  let apiKey = '';
  if (key) {
    try {
      apiKey = decryptKeyCached(key.id, key.keyEncrypted);
    } catch {
      return {
        providerId: provider.id,
        provider: provider.name,
        models: [],
        error: 'key tidak bisa didekripsi (SECRET_KEY mungkin berubah)',
      };
    }
  }

  const urls = endpointCandidates(provider.baseUrl, 'models');
  if (urls.length === 0) {
    return { providerId: provider.id, provider: provider.name, models: [], error: 'Base URL kosong' };
  }

  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
      });
      const text = await response.text().catch(() => '');
      let models: string[] = [];
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.data)) {
          models = parsed.data
            .map((item: { id?: unknown }) => (typeof item?.id === 'string' ? item.id : ''))
            .filter(Boolean);
        }
      } catch {
        // respons bukan JSON; status tetap dilaporkan
      }
      if (response.ok) {
        return { providerId: provider.id, provider: provider.name, models };
      }
      // 404 bisa berarti prefix /v1 berbeda; coba kandidat berikutnya.
      if (response.status !== 404) {
        return { providerId: provider.id, provider: provider.name, models, error: `HTTP ${response.status}` };
      }
    } catch {
      return {
        providerId: provider.id,
        provider: provider.name,
        models: [],
        error: 'Provider tidak terjangkau (timeout/jaringan).',
      };
    }
  }

  return {
    providerId: provider.id,
    provider: provider.name,
    models: [],
    error: 'HTTP 404 — endpoint /models tidak ditemukan. Coba tambahkan /v1 pada Base URL.',
  };
}

function applySecurityHeaders(c: { header: (name: string, value: string) => void }): void {
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  );
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
}

export function createApi(deps: ApiDeps): Hono {
  const runtimeEnv = loadEnv();
  const app = new Hono();

  // Header keamanan untuk semua respons (termasuk error dan 404).
  app.use('*', async (c, next) => {
    applySecurityHeaders(c);
    await next();
    applySecurityHeaders(c);
  });

  app.use('/api/*', bodyLimit({
    maxSize: BODY_LIMIT,
    onError: (c) => {
      applySecurityHeaders(c);
      return c.json({ error: 'body terlalu besar' }, 413);
    },
  }));

  // Auth: Bearer token wajib, dibandingkan constant-time.
  app.use('/api/*', async (c, next) => {
    const now = Date.now();
    const ip = clientIp(c, runtimeEnv.trustProxy);
    if (tooManyFailures(ip, now)) {
      return c.json({ error: 'terlalu banyak percobaan, coba lagi nanti' }, 429);
    }
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!tokenMatches(token, runtimeEnv.adminToken)) {
      recordFailure(ip, now);
      logger.warn({ ip }, 'login admin gagal');
      return c.json({ error: 'unauthorized' }, 401);
    }
    loginFailures.delete(ip);
    await next();
  });

  app.get('/healthz', (c) => {
    return c.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  });

  app.get('/', (c) => {
    const file = findIndexHtml();
    if (!file) return c.text('public/index.html tidak ditemukan', 500);
    c.header('content-type', 'text/html; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(readFileSync(file, 'utf8'));
  });

  app.get('/index.html', (c) => c.redirect('/'));

  app.get('/api/settings', (c) => {
    return c.json({
      settings: getSettings(),
      defaults: DEFAULT_SETTINGS,
      limits: { knowledge_warn_chars: KNOWLEDGE_WARN_CHARS, body_bytes: BODY_LIMIT },
      has_reveal_password: hasRevealPassword(),
    });
  });

  app.put('/api/settings', async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: 'body JSON tidak valid' }, 400);
    const result = validatePatch(body);
    if (!result.ok) return c.json({ error: result.error }, 400);
    updateSettings(result.patch);
    logger.warn({ keys: Object.keys(result.patch) }, 'settings diperbarui');
    return c.json({ ok: true, settings: getSettings() });
  });

  app.get('/api/status', async (c) => {
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const wa = await deps.wa.snapshot();
    const settings = getSettings();
    return c.json({
      wa,
      bot: { enabled: settings.bot_enabled },
      uptimeSec: Math.round((now - deps.startedAt) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      messagesToday: countMessagesSince(startOfDay.getTime()),
      blockedToday: countLogsSince(startOfDay.getTime(), ['blocked', 'injection', 'ratelimit']),
      strikes: countActiveStrikes(now - settings.strike_window_min * 60_000),
      mutes: countActiveMutes(now),
      model: buildModelPlan(settings, { advance: false }).model || settings.model,
      routerUrl: env.routerUrl,
    });
  });

  app.post('/api/wa/pairing', async (c) => {
    const body = await readJson(c);
    if (body === null || !isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    let phone = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
    if (phone.startsWith('0')) phone = `62${phone.slice(1)}`;
    if (phone.length < 8 || phone.length > 15) {
      return c.json({ error: 'nomor tidak valid' }, 400);
    }
    try {
      const code = await deps.wa.requestPairing(phone);
      return c.json({ ok: true, code });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'gagal meminta pairing code';
      return c.json({ error: message }, 409);
    }
  });

  app.post('/api/wa/logout', async (c) => {
    try {
      await deps.wa.logout();
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'gagal logout' }, 500);
    }
  });

  app.post('/api/bot/toggle', async (c) => {
    const body = await readJson(c);
    if (body !== null && !isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const requested = isRecord(body) ? body.enabled : undefined;
    if (requested !== undefined && typeof requested !== 'boolean') {
      return c.json({ error: 'enabled harus boolean' }, 400);
    }
    const enabled = typeof requested === 'boolean' ? requested : !getSetting('bot_enabled');
    updateSettings({ bot_enabled: enabled });
    return c.json({ ok: true, enabled });
  });

  app.post('/api/test', async (c) => {
    const body = await readJson(c);
    if (body === null || !isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.trim() === '') return c.json({ error: 'text wajib diisi' }, 400);
    if (text.length > 5_000) return c.json({ error: 'text maksimal 5000 karakter' }, 400);

    const result = await handleMessage({
      chatId: 'admin-test',
      senderId: 'admin-test',
      text,
    });
    return c.json(result);
  });

  app.get('/api/logs', (c) => {
    const logs = getRecentLogs(100).map((row) => ({
      id: row.id,
      ts: row.ts,
      chatId: row.chat_id,
      message: row.message,
      reply: row.reply,
      status: row.status,
      latencyMs: row.latency_ms,
      model: row.model,
    }));
    return c.json({ logs });
  });

  app.post('/api/llm/ping', async (c) => {
    const settings = getSettings();
    const plan = buildModelPlan(settings, { advance: false });
    const llmContext = createLlmContext();
    const result = await pingLlm({
      model: plan.model,
      temperature: settings.temperature,
      maxTokens: 5,
      llmContext,
    });
    return c.json(result);
  });

  // ---- Daftar model dari provider (untuk pilihan di web) ----
  app.get('/api/models', async (c) => {
    const providers = listProviders().filter((provider) => provider.enabled);
    const results = await Promise.all(providers.map((provider) => fetchProviderModels(provider)));
    const models = results.flatMap((result) =>
      result.models.map((model) => ({
        providerId: result.providerId,
        provider: result.provider,
        model,
        value: `${result.provider}/${model}`,
      })),
    );
    const errors = results
      .filter((result) => result.error)
      .map((result) => ({
        providerId: result.providerId,
        provider: result.provider,
        error: result.error,
      }));
    return c.json({ models, errors });
  });

  // ---- Provider management ----
  app.get('/api/providers', (c) => {
    const providers = listProviders().map((provider) => ({
      ...provider,
      keys: provider.keys.map(publicKey),
    }));
    return c.json({
      providers,
      maxProviders: MAX_PROVIDERS,
      maxKeysPerProvider: MAX_KEYS_PER_PROVIDER,
      serverNow: Date.now(),
    });
  });

  app.post('/api/providers', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? body.priority : 0;
    let model = '';
    if (body.model !== undefined) {
      const checked = validateProviderModel(body.model);
      if (!checked.ok) return c.json({ error: checked.error }, 400);
      model = checked.model;
    }
    if (!name) return c.json({ error: 'nama provider wajib diisi' }, 400);
    if (!baseUrl) return c.json({ error: 'base URL wajib diisi' }, 400);
    if (!validateProviderName(name)) {
      return c.json({ error: 'nama provider tidak valid. Hanya huruf kecil, angka, garis bawah dan tanda hubung diperbolehkan, maksimal 32 karakter' }, 400);
    }
    if (!validateProviderBaseUrl(baseUrl)) {
      return c.json({ error: 'base URL harus http:// atau https://' }, 400);
    }
    try {
      const provider = createProvider(name, baseUrl, priority, model);
      logger.warn({ id: provider.id, name: provider.name }, 'provider ditambahkan');
      return c.json({ ok: true, provider }, 201);
    } catch (err) {
      if (err instanceof LimitError) {
        return c.json({ error: err.message }, 409);
      }
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        return c.json({ error: 'Nama provider sudah dipakai.' }, 409);
      }
      return c.json({ error: 'Gagal menambahkan provider.' }, 400);
    }
  });

  app.put('/api/providers/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'ID tidak valid' }, 400);
    const body = await readJson(c);
    if (!isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const patch: Partial<{ name: string; baseUrl: string; model: string; enabled: boolean; priority: number }> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return c.json({ error: 'nama provider wajib diisi' }, 400);
      if (!validateProviderName(name)) {
        return c.json({ error: 'nama provider tidak valid. Hanya huruf kecil, angka, garis bawah dan tanda hubung diperbolehkan, maksimal 32 karakter' }, 400);
      }
      patch.name = name;
    }
    if (body.baseUrl !== undefined) {
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      if (!baseUrl) return c.json({ error: 'base URL wajib diisi' }, 400);
      if (!validateProviderBaseUrl(baseUrl)) {
        return c.json({ error: 'base URL harus http:// atau https://' }, 400);
      }
      patch.baseUrl = baseUrl;
    }
    if (body.model !== undefined) {
      const checked = validateProviderModel(body.model);
      if (!checked.ok) return c.json({ error: checked.error }, 400);
      patch.model = checked.model;
    }
    if (body.enabled !== undefined) {
      patch.enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
    }
    if (body.priority !== undefined) {
      patch.priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? body.priority : 0;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'tidak ada field yang diubah' }, 400);
    }
    try {
      const before = getProvider(id);
      if (!before) return c.json({ error: 'provider tidak ditemukan' }, 404);
      const provider = updateProvider(id, patch as Partial<Omit<ProviderRow, 'id' | 'createdAt'>>);
      if (!provider) return c.json({ error: 'provider tidak ditemukan' }, 404);
      if (patch.name && patch.name !== before.name) {
        const settings = getSettings();
        const newPrefix = patch.name;
        const oldPrefix = before.name;
        const update: Partial<Settings> = {};
        if (settings.model.startsWith(oldPrefix + '/') || settings.model === oldPrefix) {
          update.model = settings.model.replace(new RegExp('^' + oldPrefix + '(/?)'), newPrefix + '$1');
        }
        if (Array.isArray(settings.fallback_models) && settings.fallback_models.length > 0) {
          update.fallback_models = settings.fallback_models.map((fbModel) =>
            fbModel.startsWith(oldPrefix + '/') ? fbModel.replace(new RegExp('^' + oldPrefix + '(/?)'), newPrefix + '$1') : fbModel,
          );
        }
        if (Object.keys(update).length > 0) updateSettings(update);
      }
      logger.warn({ id }, 'provider diperbarui');
      return c.json({ ok: true, provider });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        return c.json({ error: 'Nama provider sudah dipakai.' }, 409);
      }
      return c.json({ error: 'Gagal memperbarui provider.' }, 400);
    }
  });

  app.delete('/api/providers/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'ID tidak valid' }, 400);
    const ok = deleteProvider(id);
    if (!ok) return c.json({ error: 'provider tidak ditemukan' }, 404);
    logger.warn({ id }, 'provider dihapus');
    return c.json({ ok: true });
  });

  app.post('/api/providers/:id/toggle', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'ID tidak valid' }, 400);
    const body = await readJson(c);
    if (!isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : true;
    const ok = toggleProvider(id, enabled);
    if (!ok) return c.json({ error: 'provider tidak ditemukan' }, 404);
    return c.json({ ok: true, enabled });
  });

  // Tes koneksi memakai key aktif pertama (atau tanpa key) dan provider.model.
  app.post('/api/providers/:id/test', async (c) => {
    if (!allowProbeRequest(Date.now())) {
      return c.json({ error: 'Terlalu banyak tes koneksi, coba lagi sebentar.' }, 429);
    }
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'ID tidak valid' }, 400);
    const provider = getProvider(id);
    if (!provider) return c.json({ error: 'provider tidak ditemukan' }, 404);

    const activeKey = provider.keys.find((item) => item.enabled);
    if (provider.keys.length > 0 && !activeKey) {
      return c.json({
        ok: false,
        status: 'error',
        provider: provider.name,
        models: [],
        latencyMs: 0,
        error: 'Tidak ada key aktif pada provider ini.',
        note: 'Tidak ada key aktif pada provider ini.',
      });
    }

    let apiKey = '';
    if (activeKey) {
      try {
        apiKey = decryptKeyCached(activeKey.id, activeKey.keyEncrypted);
      } catch {
        recordKeyProbe(activeKey.id, 'error');
        return c.json({
          ok: false,
          status: 'error',
          provider: provider.name,
          models: [],
          latencyMs: 0,
          error: 'Key tidak bisa didekripsi (SECRET_KEY mungkin berubah).',
          note: 'Key tidak bisa didekripsi (SECRET_KEY mungkin berubah).',
        });
      }
    }

    const probe = await probeProvider({
      baseUrl: provider.baseUrl,
      apiKey,
      model: provider.model || undefined,
    });
    if (activeKey) {
      recordKeyProbe(activeKey.id, probe.status);
    }

    return c.json({
      ...probe,
      ok: probe.ok,
      provider: provider.name,
      models: probe.models,
      latencyMs: probe.latencyMs,
      ...(probe.ok ? {} : { error: probe.note || (probe.httpStatus ? `HTTP ${probe.httpStatus}` : 'gagal') }),
    });
  });

  app.get('/api/providers/:id/keys', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'ID tidak valid' }, 400);
    return c.json({ keys: listKeys(id).map(publicKey) });
  });

  app.get('/api/providers/:id/models', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'ID tidak valid' }, 400);
    const provider = getProvider(id);
    if (!provider) return c.json({ error: 'provider tidak ditemukan' }, 404);
    return c.json(await fetchProviderModels(provider));
  });

  app.post('/api/providers/:id/keys', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'ID tidak valid' }, 400);
    const body = await readJson(c);
    if (!isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    if (!label) return c.json({ error: 'label wajib diisi' }, 400);
    if (!apiKey) return c.json({ error: 'API key wajib diisi' }, 400);
    const provider = getProvider(id);
    if (!provider) return c.json({ error: 'provider tidak ditemukan' }, 400);
    try {
      const encrypted = encryptKey(apiKey);
      const key = addKey(provider.id, label, encrypted, keyLast4(apiKey));
      if (!key) return c.json({ error: 'gagal menambahkan key' }, 500);
      logger.warn({ keyId: key.id, providerId: provider.id }, 'key ditambahkan');
      return c.json({ ok: true, key: publicKey(key) }, 201);
    } catch (err) {
      if (err instanceof LimitError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: 'Gagal menambahkan key.' }, 400);
    }
  });

  app.post('/api/providers/:providerId/keys/:keyId/test', async (c) => {
    if (!allowProbeRequest(Date.now())) {
      return c.json({ error: 'Terlalu banyak tes koneksi, coba lagi sebentar.' }, 429);
    }
    const providerId = Number.parseInt(c.req.param('providerId'), 10);
    const keyId = Number.parseInt(c.req.param('keyId'), 10);
    if (!Number.isFinite(providerId) || !Number.isFinite(keyId)) return c.json({ error: 'ID tidak valid' }, 400);
    const provider = getProvider(providerId);
    if (!provider) return c.json({ error: 'provider tidak ditemukan' }, 404);
    const existing = getKey(keyId);
    if (!existing || existing.providerId !== providerId) return c.json({ error: 'key tidak ditemukan' }, 404);

    const body = await readJson(c);
    let requestedModel = '';
    if (isRecord(body) && body.model !== undefined) {
      const checked = validateProviderModel(body.model);
      if (!checked.ok) return c.json({ error: checked.error }, 400);
      requestedModel = checked.model;
    }

    let apiKey: string;
    try {
      apiKey = decryptKeyCached(existing.id, existing.keyEncrypted);
    } catch {
      recordKeyProbe(existing.id, 'error');
      return c.json({
        ok: false,
        status: 'error',
        latencyMs: 0,
        models: [],
        note: 'Key tidak bisa didekripsi (SECRET_KEY mungkin berubah).',
      });
    }

    const probe = await probeProvider({
      baseUrl: provider.baseUrl,
      apiKey,
      model: requestedModel || provider.model || undefined,
    });
    recordKeyProbe(existing.id, probe.status);
    return c.json(probe);
  });

  app.put('/api/providers/:providerId/keys/:keyId', async (c) => {
    const providerId = Number.parseInt(c.req.param('providerId'), 10);
    const keyId = Number.parseInt(c.req.param('keyId'), 10);
    if (!Number.isFinite(providerId) || !Number.isFinite(keyId)) return c.json({ error: 'ID tidak valid' }, 400);
    const existing = getKey(keyId);
    if (!existing || existing.providerId !== providerId) return c.json({ error: 'key tidak ditemukan' }, 404);
    const body = await readJson(c);
    if (!isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const patch: Partial<{ label: string; enabled: boolean }> = {};
    if (body.label !== undefined) {
      if (typeof body.label !== 'string' || !body.label.trim()) return c.json({ error: 'label harus teks tidak kosong' }, 400);
      patch.label = body.label.trim();
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled harus boolean' }, 400);
      patch.enabled = body.enabled;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'tidak ada field yang diubah' }, 400);
    }
    const key = updateKey(keyId, patch);
    if (!key) return c.json({ error: 'key tidak ditemukan' }, 404);
    return c.json({ ok: true, key: publicKey(key) });
  });

  app.delete('/api/providers/:providerId/keys/:keyId', async (c) => {
    const providerId = Number.parseInt(c.req.param('providerId'), 10);
    const keyId = Number.parseInt(c.req.param('keyId'), 10);
    if (!Number.isFinite(providerId) || !Number.isFinite(keyId)) return c.json({ error: 'ID tidak valid' }, 400);
    const existing = getKey(keyId);
    if (!existing || existing.providerId !== providerId) return c.json({ error: 'key tidak ditemukan' }, 404);
    const ok = deleteKey(keyId);
    if (!ok) return c.json({ error: 'key tidak ditemukan' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/providers/:id/keys/:keyId/toggle', async (c) => {
    const providerId = Number.parseInt(c.req.param('id'), 10);
    const keyId = Number.parseInt(c.req.param('keyId'), 10);
    if (!Number.isFinite(providerId) || !Number.isFinite(keyId)) return c.json({ error: 'ID tidak valid' }, 400);
    const existing = getKey(keyId);
    if (!existing || existing.providerId !== providerId) return c.json({ error: 'key tidak ditemukan' }, 404);
    const body = await readJson(c);
    if (!isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : true;
    const ok = toggleKey(keyId, enabled);
    if (!ok) return c.json({ error: 'key tidak ditemukan' }, 404);
    return c.json({ ok: true, enabled });
  });

  app.post('/api/llm/test', async (c) => {
    if (!allowProbeRequest(Date.now())) {
      return c.json({ error: 'Terlalu banyak tes koneksi, coba lagi sebentar.' }, 429);
    }
    const body = await readJson(c);
    if (!isRecord(body)) return c.json({ error: 'body JSON tidak valid' }, 400);
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    if (!baseUrl) return c.json({ error: 'base URL wajib diisi' }, 400);
    let apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    if (!apiKey && typeof body.providerId === 'number' && Number.isFinite(body.providerId)) {
      const existing = getProvider(body.providerId);
      if (existing && existing.baseUrl.trim().replace(/\/+$/, '') === baseUrl.trim().replace(/\/+$/, '')) {
        const activeKey = existing.keys.find((item) => item.enabled);
        if (activeKey) {
          try {
            apiKey = decryptKeyCached(activeKey.id, activeKey.keyEncrypted);
          } catch {
            // abaikan; probe akan jalan tanpa key atau gagal auth
          }
        }
      }
    }
    let model = '';
    if (body.model !== undefined) {
      const checked = validateProviderModel(body.model);
      if (!checked.ok) {
        return c.json({
          ok: false,
          status: 'error',
          latencyMs: 0,
          models: [],
          note: checked.error,
        });
      }
      model = checked.model;
    }
    if (!validateProviderBaseUrl(baseUrl)) {
      return c.json({
        ok: false,
        status: 'error',
        latencyMs: 0,
        models: [],
        note: 'Base URL harus menggunakan http:// atau https://.',
      });
    }
    const probe = await probeProvider({
      baseUrl,
      apiKey,
      model: model || undefined,
    });
    return c.json(probe);
  });

  // ---- Password reveal (verifikasi ulang untuk lihat key asli) ----
  app.get('/api/audit', (c) => {
    const entries = getRecentAudit(50).map((row) => ({
      id: row.id,
      ts: row.ts,
      keyId: row.key_id,
      success: Boolean(row.success),
      ip: row.ip,
      result: row.result,
    }));
    return c.json({ entries });
  });

  app.post('/api/keys/:keyId/reveal', async (c) => {
    const keyId = Number.parseInt(c.req.param('keyId'), 10);
    if (!Number.isFinite(keyId)) return c.json({ error: 'ID tidak valid' }, 400);

    const now = Date.now();
    const ip = clientIp(c, runtimeEnv.trustProxy);
    const audit = (success: boolean, result: string): void => {
      try {
        insertAudit({ ts: now, keyId, success, ip, result });
      } catch {
        // audit tidak boleh menggagalkan reveal
      }
    };

    if (revealBlocked(ip, now)) {
      audit(false, 'rate_limited');
      return c.json({ error: 'terlalu banyak percobaan reveal, coba lagi nanti' }, 429);
    }

    const body = await readJson(c);
    if (!isRecord(body)) {
      audit(false, 'bad_request');
      return c.json({ error: 'body JSON tidak valid' }, 400);
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      recordRevealFailure(ip, now);
      audit(false, 'no_password');
      return c.json({ error: 'password wajib diisi' }, 400);
    }
    if (password.length > 256) {
      recordRevealFailure(ip, now);
      audit(false, 'bad_request');
      return c.json({ error: 'password terlalu panjang' }, 400);
    }

    if (!hasRevealPassword()) {
      recordRevealFailure(ip, now);
      audit(false, 'not_configured');
      return c.json({ error: 'password reveal belum diatur di .env' }, 403);
    }

    if (!verifyRevealPassword(password)) {
      recordRevealFailure(ip, now);
      audit(false, 'wrong_password');
      logger.warn({ keyId, ip }, 'reveal key gagal: password salah');
      return c.json({ error: 'password salah' }, 403);
    }

    const keyRow = getDb()
      .prepare('SELECT id, label, key_encrypted FROM provider_keys WHERE id = ?')
      .get(keyId) as { id: number; label: string; key_encrypted: string } | undefined;
    if (!keyRow) {
      audit(false, 'key_not_found');
      return c.json({ error: 'key tidak ditemukan' }, 404);
    }

    let plainKey: string;
    try {
      plainKey = decryptKeyCached(keyRow.id, keyRow.key_encrypted);
    } catch {
      audit(false, 'decrypt_failed');
      return c.json({ error: 'key tidak bisa didekripsi (SECRET_KEY mungkin berubah)' }, 400);
    }

    audit(true, 'ok');
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true, keyId: keyRow.id, label: keyRow.label, plainKey });
  });
  app.notFound((c) => {
    applySecurityHeaders(c);
    return c.json({ error: 'not found' }, 404);
  });

  app.onError((err, c) => {
    logger.error({ err }, 'error API');
    applySecurityHeaders(c);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
