import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage as NodeIncomingMessage } from 'node:http';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  DEFAULT_SETTINGS,
  VALID_LOG_LEVELS,
  VALID_MODEL_MODES,
  type LogLevel,
  type ModelRoutingMode,
  type Settings,
} from './config.js';
import { hasRevealPassword, verifyRevealPassword } from './crypto.js';
import { clearLogs, getRecentAudit, getRecentLogs, getStatusCounts, insertAudit } from './db.js';
import { invalidPatterns } from './guard.js';
import { clearConsoleLogs, getConsoleLogs } from './logger.js';
import {
  fetchAllProvidersModels,
  fetchProviderModels,
  pingLlm,
  probeProvider,
} from './llm.js';
import { handleMessage } from './pipeline.js';
import {
  MAX_KEYS_PER_PROVIDER,
  MAX_PROVIDERS,
  parseProviderFormat,
  ProviderError,
  addProviderKey,
  createProvider,
  deleteProvider,
  deleteProviderKey,
  getEffectivePlanAndRouterUrl,
  getProviderById,
  getProviderKeySecret,
  listProviders,
  toggleProvider,
  toggleProviderKey,
  updateProvider,
} from './providers.js';
import { getDefaultSettings, getSettings, updateSettings } from './settings.js';

export type WaConnectionState = 'connecting' | 'open' | 'disconnected' | 'logged_out';

export interface WaStatusSnapshot {
  state: WaConnectionState;
  qrDataUrl: string | null;
  pairingCode: string | null;
  me: string | null;
  lastError: string | null;
}

export interface WaController {
  getStatus(): WaStatusSnapshot;
  requestPairing(phone: string): Promise<string>;
  logout(): Promise<void>;
}

export interface ApiOptions {
  adminToken: string;
  trustProxy: boolean;
  wa: WaController;
}

const MAX_BODY_BYTES = 65_536;
const KNOWLEDGE_WARN_CHARS = 12_000;

const BOOLEAN_KEYS: ReadonlySet<keyof Settings> = new Set([
  'bot_enabled',
  'private_enabled',
  'group_enabled',
  'allowlist_enabled',
]);

const NUMBER_RANGES: Record<
  string,
  { min: number; max: number; integer: boolean }
> = {
  temperature: { min: 0, max: 2, integer: false },
  max_tokens: { min: 1, max: 2000, integer: true },
  history_turns: { min: 0, max: 20, integer: true },
  max_input_chars: { min: 20, max: 5000, integer: true },
  rate_limit_per_min: { min: 1, max: 120, integer: true },
  group_cooldown_sec: { min: 0, max: 3600, integer: true },
  strike_limit: { min: 1, max: 20, integer: true },
  strike_window_min: { min: 1, max: 1440, integer: true },
  mute_minutes: { min: 1, max: 10080, integer: true },
};

const STRING_LIMITS: Record<string, number> = {
  system_prompt: 20_000,
  knowledge: 50_000,
  fallback_text: 2_000,
  refusal_text: 2_000,
  info_text: 2_000,
  help_text: 2_000,
  contact: 200,
  model: 200,
  trigger_prefix: 32,
};

const LIST_KEYS: Record<string, { maxItems: number; maxItemLen: number }> = {
  allowed_groups: { maxItems: 200, maxItemLen: 300 },
  blocklist: { maxItems: 200, maxItemLen: 300 },
  allowlist: { maxItems: 200, maxItemLen: 300 },
  fallback_models: { maxItems: 200, maxItemLen: 300 },
  injection_patterns: { maxItems: 50, maxItemLen: 300 },
};

function constantTimeTokenMatch(given: string, expected: string): boolean {
  const givenHash = crypto.createHash('sha256').update(given, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(givenHash, expectedHash);
}

function getClientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const cfIp = c.req.header('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp;
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  const env = c.env as { incoming?: NodeIncomingMessage } | undefined;
  const remoteAddr = env?.incoming?.socket?.remoteAddress;
  return remoteAddr || '127.0.0.1';
}

function applySecurityHeaders(c: Context): void {
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
  );
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
}

export function validateSettingsPayload(
  payload: unknown
): { ok: true; patch: Partial<Settings> } | { ok: false; error: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Payload pengaturan harus berupa objek JSON.' };
  }

  const obj = payload as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (!(key in DEFAULT_SETTINGS)) {
      return { ok: false, error: `Key pengaturan tidak dikenal: ${key}` };
    }

    const typedKey = key as keyof Settings;

    if (BOOLEAN_KEYS.has(typedKey)) {
      if (typeof val !== 'boolean') {
        return { ok: false, error: `Pengaturan "${key}" wajib bertipe boolean.` };
      }
      patch[key] = val;
      continue;
    }

    if (key in NUMBER_RANGES) {
      const rule = NUMBER_RANGES[key];
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        return { ok: false, error: `Pengaturan "${key}" wajib berupa angka.` };
      }
      if (rule.integer && !Number.isInteger(val)) {
        return { ok: false, error: `Pengaturan "${key}" wajib berupa bilangan bulat.` };
      }
      if (val < rule.min || val > rule.max) {
        return {
          ok: false,
          error: `Pengaturan "${key}" wajib berada di rentang ${rule.min} sampai ${rule.max}.`,
        };
      }
      patch[key] = val;
      continue;
    }

    if (key === 'log_level') {
      if (typeof val !== 'string' || !(VALID_LOG_LEVELS as readonly string[]).includes(val)) {
        return {
          ok: false,
          error: 'Pengaturan "log_level" tidak valid.',
        };
      }
      patch[key] = val as LogLevel;
      continue;
    }

    if (key === 'model_mode') {
      if (typeof val !== 'string' || !(VALID_MODEL_MODES as readonly string[]).includes(val as ModelRoutingMode)) {
        return {
          ok: false,
          error: 'Pengaturan "model_mode" tidak valid. Pilihan: fallback, round_robin, fusion.',
        };
      }
      patch[key] = val as ModelRoutingMode;
      continue;
    }

    if (key in STRING_LIMITS) {
      const maxLen = STRING_LIMITS[key];
      if (typeof val !== 'string') {
        return { ok: false, error: `Pengaturan "${key}" wajib berupa teks string.` };
      }
      if (val.length > maxLen) {
        return {
          ok: false,
          error: `Pengaturan "${key}" melebihi batas maksimal ${maxLen} karakter.`,
        };
      }
      patch[key] = val;
      continue;
    }

    if (key in LIST_KEYS) {
      const rule = LIST_KEYS[key];
      if (!Array.isArray(val)) {
        return { ok: false, error: `Pengaturan "${key}" wajib berupa array string.` };
      }
      if (val.length > rule.maxItems) {
        return {
          ok: false,
          error: `Pengaturan "${key}" maksimal memuat ${rule.maxItems} item.`,
        };
      }
      const cleaned: string[] = [];
      for (const item of val) {
        if (typeof item !== 'string') {
          return { ok: false, error: `Setiap item pada "${key}" wajib berupa string.` };
        }
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (trimmed.length > rule.maxItemLen) {
          return {
            ok: false,
            error: `Item pada "${key}" melebihi batas ${rule.maxItemLen} karakter.`,
          };
        }
        cleaned.push(trimmed);
      }

      if (key === 'injection_patterns') {
        const bad = invalidPatterns(cleaned);
        if (bad.length > 0) {
          return {
            ok: false,
            error: `Pola regex injeksi tidak valid atau berisiko ReDoS: ${bad[0]}`,
          };
        }
      }

      patch[key] = cleaned;
      continue;
    }
  }

  return { ok: true, patch: patch as Partial<Settings> };
}

export function createApi(opts: ApiOptions): Hono {
  const app = new Hono();

  const loginFailures = new Map<string, number[]>();
  const revealFailures = new Map<string, number[]>();
  const testBuckets = new Map<string, number[]>();

  function checkTestRateLimit(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const list = (testBuckets.get(ip) ?? []).filter((ts) => ts > cutoff);
    if (list.length >= 20) {
      testBuckets.set(ip, list);
      return false;
    }
    list.push(now);
    testBuckets.set(ip, list);
    return true;
  }

  // Middleware global: pasang security headers pada setiap respons
  app.use('*', async (c, next) => {
    applySecurityHeaders(c);
    await next();
    applySecurityHeaders(c);
  });

  // Batas ukuran body 64 KB untuk seluruh /api/*
  app.use('/api/*', async (c, next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength) {
      const len = Number.parseInt(contentLength, 10);
      if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
        applySecurityHeaders(c);
        return c.json({ error: 'body terlalu besar' }, 413);
      }
    }
    const limiter = bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (ctx) => {
        applySecurityHeaders(ctx);
        return ctx.json({ error: 'body terlalu besar' }, 413);
      },
    });
    return limiter(c, next);
  });

  // Autentikasi Bearer + Rate Limit Login Brute-Force untuk seluruh /api/*
  app.use('/api/*', async (c, next) => {
    const ip = getClientIp(c, opts.trustProxy);
    const now = Date.now();
    const cutoff = now - 60_000;
    const fails = (loginFailures.get(ip) ?? []).filter((ts) => ts > cutoff);

    if (fails.length >= 5) {
      loginFailures.set(ip, fails);
      return c.json({ error: 'terlalu banyak percobaan, coba lagi nanti' }, 429);
    }

    const authHeader = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const givenToken = match ? match[1].trim() : '';

    if (!givenToken || !constantTimeTokenMatch(givenToken, opts.adminToken)) {
      fails.push(now);
      loginFailures.set(ip, fails);
      return c.json({ error: 'token tidak valid' }, 401);
    }

    if (fails.length > 0) {
      loginFailures.delete(ip);
    }
    await next();
  });

  // Publik: GET /healthz
  app.get('/healthz', (c) => {
    const rssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
    return c.json({
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      rssMb,
    });
  });

  // Publik: GET /
  app.get('/', (c) => {
    const htmlPath = path.resolve(process.cwd(), 'public/index.html');
    c.header('Cache-Control', 'no-store');
    if (!fs.existsSync(htmlPath)) {
      return c.html('<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Kaliber Bot</title></head><body><p>Web Admin sedang disiapkan.</p></body></html>');
    }
    const content = fs.readFileSync(htmlPath, 'utf8');
    return c.html(content);
  });

  // Publik: GET /kaliber.avif
  app.get('/kaliber.avif', (c) => {
    const logoPath = path.resolve(process.cwd(), 'public/kaliber.avif');
    if (!fs.existsSync(logoPath)) {
      return c.json({ error: 'aset tidak ditemukan' }, 404);
    }
    const buf = fs.readFileSync(logoPath);
    c.header('Content-Type', 'image/avif');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(buf);
  });

  // GET /api/settings
  app.get('/api/settings', (c) => {
    return c.json({
      settings: getSettings(),
      defaults: getDefaultSettings(),
      limits: {
        knowledge_warn_chars: KNOWLEDGE_WARN_CHARS,
        body_bytes: MAX_BODY_BYTES,
      },
      has_reveal_password: hasRevealPassword(),
    });
  });

  // PUT /api/settings
  app.put('/api/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const validated = validateSettingsPayload(body);
    if (!validated.ok) {
      return c.json({ error: validated.error }, 400);
    }
    const updated = updateSettings(validated.patch, { fromAdmin: true });
    return c.json({ ok: true, settings: updated });
  });

  // GET /api/status
  app.get('/api/status', (c) => {
    const settings = getSettings();
    const wa = opts.wa.getStatus();
    const counts = getStatusCounts();
    const rssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
    const uptimeSec = Math.floor(process.uptime());
    const { model, routerUrl } = getEffectivePlanAndRouterUrl(settings);

    return c.json({
      wa,
      botEnabled: settings.bot_enabled,
      bot_enabled: settings.bot_enabled,
      uptimeSec,
      rssMb,
      messagesToday: counts.messagesToday,
      blockedToday: counts.blockedToday,
      strikes: counts.strikes,
      mutes: counts.mutes,
      model,
      routerUrl,
    });
  });

  // POST /api/wa/pairing
  app.post('/api/wa/pairing', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { phone?: unknown } | null;
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      return c.json({ error: 'Nomor telepon wajib diisi.' }, 400);
    }
    try {
      const code = await opts.wa.requestPairing(phone);
      return c.json({ ok: true, code });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Gagal meminta kode pairing.' },
        400
      );
    }
  });

  // POST /api/wa/logout
  app.post('/api/wa/logout', async (c) => {
    try {
      await opts.wa.logout();
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Gagal memutuskan sesi WhatsApp.' },
        500
      );
    }
  });

  // POST /api/bot/toggle
  app.post('/api/bot/toggle', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    const current = getSettings().bot_enabled;
    const nextEnabled = typeof body?.enabled === 'boolean' ? body.enabled : !current;
    const updated = updateSettings({ bot_enabled: nextEnabled }, { fromAdmin: true });
    return c.json({
      ok: true,
      botEnabled: updated.bot_enabled,
      bot_enabled: updated.bot_enabled,
    });
  });

  // POST /api/test
  app.post('/api/test', async (c) => {
    const ip = getClientIp(c, opts.trustProxy);
    if (!checkTestRateLimit(ip)) {
      return c.json({ error: 'Terlalu banyak permintaan uji coba, coba lagi nanti.' }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) {
      return c.json({ error: 'Teks pesan uji coba tidak boleh kosong.' }, 400);
    }
    const res = await handleMessage({
      chatId: 'admin-test',
      senderId: 'admin-test',
      text,
      isGroup: false,
    });
    return c.json({
      reply: res.reply,
      status: res.meta.status,
      flags: res.meta.flags,
      model: res.meta.model,
      latencyMs: res.meta.latencyMs,
      meta: res.meta,
    });
  });

  // GET /api/logs
  app.get('/api/logs', (c) => {
    const logs = getRecentLogs(100);
    return c.json({ logs });
  });

  // DELETE /api/logs
  app.delete('/api/logs', (c) => {
    const deletedCount = clearLogs();
    return c.json({ ok: true, deletedCount });
  });

  // GET /api/console
  app.get('/api/console', (c) => {
    const since = Number.parseInt(c.req.query('since') || '0', 10);
    const logs = getConsoleLogs(Number.isFinite(since) ? since : 0);
    return c.json({ logs });
  });

  // DELETE /api/console
  app.delete('/api/console', (c) => {
    clearConsoleLogs();
    return c.json({ ok: true });
  });

  // GET /api/audit
  app.get('/api/audit', (c) => {
    const audit = getRecentAudit(50);
    return c.json({ audit });
  });

  // POST /api/llm/ping
  app.post('/api/llm/ping', async (c) => {
    const ip = getClientIp(c, opts.trustProxy);
    if (!checkTestRateLimit(ip)) {
      return c.json({ error: 'Terlalu banyak permintaan uji coba, coba lagi nanti.' }, 429);
    }
    const res = await pingLlm(getSettings());
    return c.json(res);
  });

  // POST /api/llm/test
  app.post('/api/llm/test', async (c) => {
    const ip = getClientIp(c, opts.trustProxy);
    if (!checkTestRateLimit(ip)) {
      return c.json({ error: 'Terlalu banyak permintaan uji coba, coba lagi nanti.' }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      baseUrl?: unknown;
      apiKey?: unknown;
      model?: unknown;
      format?: unknown;
      providerId?: unknown;
      keyId?: unknown;
    };

    const probe = await probeProvider({
      format: parseProviderFormat(body?.format) ?? undefined,
      baseUrl: typeof body?.baseUrl === 'string' ? body.baseUrl : undefined,
      apiKey: typeof body?.apiKey === 'string' ? body.apiKey : undefined,
      model: typeof body?.model === 'string' ? body.model : undefined,
      providerId: typeof body?.providerId === 'number' ? body.providerId : undefined,
      keyId: typeof body?.keyId === 'number' ? body.keyId : undefined,
    });
    return c.json(probe, 200);
  });

  // GET /api/models
  app.get('/api/models', async (c) => {
    const models = await fetchAllProvidersModels();
    return c.json(models);
  });

  // GET /api/providers
  app.get('/api/providers', (c) => {
    return c.json({
      providers: listProviders(),
      maxProviders: MAX_PROVIDERS,
      maxKeysPerProvider: MAX_KEYS_PER_PROVIDER,
      serverNow: Date.now(),
    });
  });

  // POST /api/providers
  app.post('/api/providers', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      baseUrl?: unknown;
      format?: unknown;
      apiKey?: unknown;
      keyLabel?: unknown;
      enabled?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Payload tidak valid.' }, 400);
    }

    try {
      const created = createProvider({
        name: typeof body.name === 'string' ? body.name : '',
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
        format: body.format,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
        keyLabel: typeof body.keyLabel === 'string' ? body.keyLabel : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      });
      return c.json({ ok: true, provider: created }, 201);
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
      }
      return c.json({ error: 'Gagal membuat provider.' }, 500);
    }
  });

  // PUT /api/providers/:id
  app.put('/api/providers/:id', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'ID provider tidak valid.' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      baseUrl?: unknown;
      format?: unknown;
      enabled?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Payload tidak valid.' }, 400);
    }

    try {
      const updated = updateProvider(id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
        format: body.format,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      });
      return c.json({ ok: true, provider: updated });
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
      }
      return c.json({ error: 'Gagal memperbarui provider.' }, 500);
    }
  });

  // DELETE /api/providers/:id
  app.delete('/api/providers/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'ID provider tidak valid.' }, 400);
    }
    try {
      deleteProvider(id);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
      }
      return c.json({ error: 'Gagal menghapus provider.' }, 500);
    }
  });

  // POST /api/providers/:id/toggle
  app.post('/api/providers/:id/toggle', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'ID provider tidak valid.' }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    const prov = getProviderById(id);
    if (!prov) {
      return c.json({ error: 'Provider tidak ditemukan.' }, 404);
    }
    const nextEnabled = typeof body?.enabled === 'boolean' ? body.enabled : !prov.enabled;
    try {
      const updated = toggleProvider(id, nextEnabled);
      return c.json({ ok: true, provider: updated });
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
      }
      return c.json({ error: 'Gagal mengubah status provider.' }, 500);
    }
  });

  // POST /api/providers/:id/test
  app.post('/api/providers/:id/test', async (c) => {
    const ip = getClientIp(c, opts.trustProxy);
    if (!checkTestRateLimit(ip)) {
      return c.json({ error: 'Terlalu banyak permintaan uji coba, coba lagi nanti.' }, 429);
    }
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'ID provider tidak valid.' }, 400);
    }
    const prov = getProviderById(id);
    if (!prov) {
      return c.json({ error: 'Provider tidak ditemukan.' }, 404);
    }
    const probe = await probeProvider({ providerId: id });
    return c.json(probe);
  });

  // GET /api/providers/:id/models
  app.get('/api/providers/:id/models', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'ID provider tidak valid.' }, 400);
    }
    const prov = getProviderById(id);
    if (!prov) {
      return c.json({ error: 'Provider tidak ditemukan.' }, 404);
    }
    const res = await fetchProviderModels(id);
    return c.json(res);
  });

  // POST /api/providers/:id/keys
  app.post('/api/providers/:id/keys', async (c) => {
    const providerId = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return c.json({ error: 'ID provider tidak valid.' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as {
      label?: unknown;
      apiKey?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Payload tidak valid.' }, 400);
    }

    try {
      const created = addProviderKey(providerId, {
        label: typeof body.label === 'string' ? body.label : '',
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
      });
      return c.json({ ok: true, key: created }, 201);
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
      }
      return c.json({ error: 'Gagal menambahkan API key.' }, 500);
    }
  });

  // DELETE /api/providers/:id/keys/:keyId
  app.delete('/api/providers/:id/keys/:keyId', (c) => {
    const providerId = Number.parseInt(c.req.param('id'), 10);
    const keyId = Number.parseInt(c.req.param('keyId'), 10);
    if (!Number.isInteger(providerId) || !Number.isInteger(keyId)) {
      return c.json({ error: 'ID tidak valid.' }, 400);
    }
    try {
      deleteProviderKey(providerId, keyId);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
      }
      return c.json({ error: 'Gagal menghapus API key.' }, 500);
    }
  });

  // POST /api/providers/:id/keys/:keyId/toggle
  app.post('/api/providers/:id/keys/:keyId/toggle', async (c) => {
    const providerId = Number.parseInt(c.req.param('id'), 10);
    const keyId = Number.parseInt(c.req.param('keyId'), 10);
    if (!Number.isInteger(providerId) || !Number.isInteger(keyId)) {
      return c.json({ error: 'ID tidak valid.' }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    const prov = getProviderById(providerId);
    const existingKey = prov?.keys.find((k) => k.id === keyId);
    if (!existingKey) {
      return c.json({ error: 'API key tidak ditemukan.' }, 404);
    }
    const nextEnabled =
      typeof body?.enabled === 'boolean' ? body.enabled : !existingKey.enabled;

    try {
      const updated = toggleProviderKey(providerId, keyId, nextEnabled);
      return c.json({ ok: true, key: updated });
    } catch (err) {
      if (err instanceof ProviderError) {
        return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
      }
      return c.json({ error: 'Gagal mengubah status API key.' }, 500);
    }
  });

  // POST /api/providers/:providerId/keys/:keyId/test
  app.post('/api/providers/:providerId/keys/:keyId/test', async (c) => {
    const ip = getClientIp(c, opts.trustProxy);
    if (!checkTestRateLimit(ip)) {
      return c.json({ error: 'Terlalu banyak permintaan uji coba, coba lagi nanti.' }, 429);
    }
    const providerId = Number.parseInt(c.req.param('providerId'), 10);
    const keyId = Number.parseInt(c.req.param('keyId'), 10);
    if (!Number.isInteger(providerId) || !Number.isInteger(keyId)) {
      return c.json({ error: 'ID tidak valid.' }, 400);
    }
    const secret = getProviderKeySecret(keyId, providerId);
    if (!secret) {
      return c.json({ error: 'API key tidak ditemukan.' }, 404);
    }
    const probe = await probeProvider({
      providerId,
      keyId,
    });
    return c.json(probe);
  });

  // POST /api/keys/:id/reveal
  app.post('/api/keys/:id/reveal', async (c) => {
    const ip = getClientIp(c, opts.trustProxy);
    const keyId = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(keyId) || keyId <= 0) {
      return c.json({ error: 'ID key tidak valid.' }, 400);
    }

    const secret = getProviderKeySecret(keyId);
    if (!secret) {
      return c.json({ error: 'API key tidak ditemukan.' }, 404);
    }

    const now = Date.now();
    const cutoff = now - 15 * 60_000;
    const fails = (revealFailures.get(ip) ?? []).filter((ts) => ts > cutoff);
    if (fails.length >= 5) {
      revealFailures.set(ip, fails);
      insertAudit({
        ts: now,
        keyId,
        success: false,
        ip,
        result: 'rate_limited',
      });
      return c.json({ error: 'Terlalu banyak percobaan gagal, coba lagi dalam 15 menit.' }, 429);
    }

    if (!hasRevealPassword()) {
      insertAudit({
        ts: now,
        keyId,
        success: false,
        ip,
        result: 'not_configured',
      });
      return c.json({ error: 'Fitur lihat key belum diaktifkan di server (REVEAL_PASSWORD kosong).' }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) {
      insertAudit({
        ts: now,
        keyId,
        success: false,
        ip,
        result: 'no_password',
      });
      return c.json({ error: 'Password wajib diisi.' }, 400);
    }

    if (!verifyRevealPassword(password)) {
      fails.push(now);
      revealFailures.set(ip, fails);
      insertAudit({
        ts: now,
        keyId,
        success: false,
        ip,
        result: 'wrong_password',
      });
      return c.json({ error: 'Password salah.' }, 403);
    }

    revealFailures.delete(ip);
    insertAudit({
      ts: now,
      keyId,
      success: true,
      ip,
      result: 'ok',
    });

    return c.json({
      ok: true,
      keyId: secret.id,
      label: secret.label,
      plainKey: secret.plainKey,
    });
  });

  app.notFound((c) => {
    applySecurityHeaders(c);
    return c.json({ error: 'Endpoint tidak ditemukan' }, 404);
  });

  app.onError((err, c) => {
    applySecurityHeaders(c);
    return c.json({ error: err.message || 'Terjadi kesalahan internal server' }, 500);
  });

  return app;
}
