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
} from './config.js';
import {
  countActiveMutes,
  countActiveStrikes,
  countLogsSince,
  countMessagesSince,
  getRecentLogs,
} from './db.js';
import { invalidPatterns } from './guard.js';
import { pingLlm } from './llm.js';
import { logger } from './logger.js';
import { handleMessage } from './pipeline.js';
import { getSetting, getSettings, isKnownSettingKey, updateSettings } from './settings.js';

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
  trigger_prefix: 32,
};

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

function clientIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'local'
  );
}

function tooManyFailures(ip: string, now: number): boolean {
  const list = (loginFailures.get(ip) ?? []).filter((ts) => now - ts < FAILURE_WINDOW_MS);
  loginFailures.set(ip, list);
  return list.length >= MAX_FAILURES;
}

function recordFailure(ip: string, now: number): void {
  const list = loginFailures.get(ip) ?? [];
  list.push(now);
  loginFailures.set(ip, list);
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

export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();

  // Header keamanan untuk semua respons.
  app.use('*', async (c, next) => {
    await next();
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.use('/api/*', bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'body terlalu besar' }, 413) }));

  // Auth: Bearer token wajib, dibandingkan constant-time.
  app.use('/api/*', async (c, next) => {
    const now = Date.now();
    const ip = clientIp(c.req.raw.headers);
    if (tooManyFailures(ip, now)) {
      return c.json({ error: 'terlalu banyak percobaan, coba lagi nanti' }, 429);
    }
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!tokenMatches(token, env.adminToken)) {
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
      model: settings.model,
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
    const result = await pingLlm({
      routerUrl: env.routerUrl,
      routerKey: env.routerKey,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: 5,
    });
    return c.json(result);
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    logger.error({ err }, 'error API');
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
