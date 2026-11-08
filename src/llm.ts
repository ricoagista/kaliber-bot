import type { ChatMessage } from './prompt.js';
import type { KeyStatus } from './providers.js';
import { stripThink } from './sanitize.js';
import { endpointCandidates } from './endpoint.js';

export interface LlmOptions {
  // For backward compatibility with tests, allow routerUrl/routerKey
  routerUrl?: string;
  routerKey?: string;
  model: string;
  fallbackModels: string[];
  temperature: number;
  maxTokens: number;
  fallbackText: string;
  timeoutMs?: number;
  totalBudgetMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  // Optional: if provided, use this to resolve model to provider+key
  llmContext?: {
    resolveModel: (model: string) => Promise<{
      baseUrl: string;
      apiKey: string;
      providerId: number;
      keyId: number;
      model?: string;
      keysAvailable?: number;
    } | null>;
    markKeyFailed: (providerId: number, keyId: number, status: number, retryAfterMs?: number) => Promise<void>;
    markKeySucceeded?: (providerId: number, keyId: number) => Promise<void>;
  };
}

export interface LlmResult {
  ok: boolean;
  content: string;
  model: string | null;
  attempts: number;
  error?: string;
}

const RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Coba `/chat/completions`, lalu varian `/v1/chat/completions` bila 404. */
async function fetchWithEndpointFallback(
  fetchImpl: typeof fetch,
  baseUrl: string,
  init: RequestInit,
): Promise<Response> {
  const urls = endpointCandidates(baseUrl, 'chat/completions');
  if (urls.length === 0) throw new Error('base URL provider kosong');
  let lastResponse: Response | null = null;
  for (const url of urls) {
    const response = await fetchImpl(url, init);
    if (response.status !== 404) return response;
    lastResponse = response;
  }
  return lastResponse as Response;
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get('retry-after');
  if (!raw) return 30_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(60_000, Math.max(0, date - Date.now())) : 30_000;
}

function modelList(options: LlmOptions): string[] {
  const raw = [options.model, ...(options.fallbackModels ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function extractContent(payload: unknown): string {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Panggil LLM (OpenAI-compatible) dengan dukungan multi-provider/multi-key.
 * Retry 1x untuk 429/5xx/timeout, lalu pindah ke model fallback.
 * Tidak pernah melempar error ke pemanggil.
 */
export async function callLlm(messages: ChatMessage[], options: LlmOptions): Promise<LlmResult> {
  const fallbackText = options.fallbackText ?? '';
  const models = modelList(options);
  if (models.length === 0) {
    return { ok: false, content: fallbackText, model: null, attempts: 0, error: 'model belum diatur' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? sleepDefault;
  let attempts = 0;
  let lastError = '';

  // If llmContext is provided, use it for model resolution with key rotation
  if (options.llmContext) {
    const { resolveModel, markKeyFailed, markKeySucceeded } = options.llmContext;
    const totalBudgetMs = options.totalBudgetMs ?? 75_000;
    const startedAt = Date.now();
    for (let i = 0; i < models.length; i++) {
      const model = models[i]!;
      const isLastCandidate = i === models.length - 1;
      for (let attempt = 0; attempt < 2; attempt++) {
        const remainingBudget = totalBudgetMs - (Date.now() - startedAt);
        if (remainingBudget < 3_000) {
          return {
            ok: false,
            content: fallbackText,
            model: null,
            attempts,
            error: lastError || 'batas waktu total habis',
          };
        }
        attempts += 1;
        const resolved = await resolveModel(model);
        if (!resolved) {
          lastError = `provider/key tidak ditemukan untuk model ${model}`;
          break;
        }
        const { baseUrl, apiKey, providerId, keyId } = resolved;
        const allowSecondAttempt = (resolved.keysAvailable ?? 0) > 1 || isLastCandidate;
        const attemptTimeout = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, remainingBudget);
        try {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (apiKey) headers.authorization = `Bearer ${apiKey}`;

          const response = await fetchWithEndpointFallback(fetchImpl, baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: resolved.model || model,
              messages,
              temperature: options.temperature,
              max_tokens: options.maxTokens,
              stream: false,
            }),
            signal: AbortSignal.timeout(attemptTimeout),
          });

          if (!response.ok) {
            lastError = `http ${response.status}`;
            if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
              const retryDelay = response.status === 429 ? retryAfterMs(response) : undefined;
              await markKeyFailed(providerId, keyId, response.status, retryDelay);
              if (attempt === 0 && allowSecondAttempt) {
                await sleep(response.status === 429 ? Math.min(RETRY_DELAY_MS, retryAfterMs(response)) : RETRY_DELAY_MS);
                continue;
              }
            }
            break;
          }

          const payload: unknown = await response.json().catch(() => null);
          const content = stripThink(extractContent(payload)).trim();
          if (content !== '') {
            await markKeySucceeded?.(providerId, keyId);
            return { ok: true, content, model, attempts };
          }
          lastError = 'jawaban kosong';
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.name : 'error jaringan';
          await markKeyFailed(providerId, keyId, 0);
          if (attempt === 0 && allowSecondAttempt) {
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          break;
        }
      }
    }
    return { ok: false, content: fallbackText, model: null, attempts, error: lastError || 'gagal' };
  }

  // Backward compatibility: use routerUrl/routerKey directly (for tests)
  if (!options.routerUrl) {
    return { ok: false, content: fallbackText, model: null, attempts: 0, error: 'routerUrl tidak disediakan' };
  }
  const routerUrl = options.routerUrl;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts += 1;
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (options.routerKey) headers.authorization = `Bearer ${options.routerKey}`;

        const response = await fetchWithEndpointFallback(fetchImpl, routerUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            stream: false,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });

        if (!response.ok) {
          lastError = `http ${response.status}`;
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          break;
        }

        const payload: unknown = await response.json().catch(() => null);
        const content = stripThink(extractContent(payload)).trim();
        if (content !== '') {
          return { ok: true, content, model, attempts };
        }
        lastError = 'jawaban kosong';
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.name : 'error jaringan';
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        break;
      }
    }
  }

  return { ok: false, content: fallbackText, model: null, attempts, error: lastError || 'gagal' };
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  model: string | null;
  error?: string;
}

/** Tes koneksi singkat ke LLM (provider aktif) untuk dashboard. */
export async function pingLlm(
  options: {
    routerUrl?: string;
    routerKey?: string;
    model: string;
    temperature: number;
    maxTokens: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    llmContext?: LlmOptions['llmContext'];
  },
): Promise<PingResult> {
  const started = Date.now();
  const result = await callLlm([{ role: 'user', content: 'ping' }], {
    routerUrl: options.routerUrl,
    routerKey: options.routerKey,
    model: options.model,
    fallbackModels: [],
    fallbackText: '',
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs ?? 15_000,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    llmContext: options.llmContext,
  });
  return {
    ok: result.ok,
    latencyMs: Date.now() - started,
    model: result.model,
    error: result.error,
  };
}

export interface ProbeResult {
  ok: boolean;
  status: KeyStatus;
  httpStatus?: number;
  latencyMs: number;
  models: string[];
  modelTested?: string;
  chatOk?: boolean;
  note?: string;
}

/**
 * Uji key/provider dua tahap: GET /models (ambil daftar model + cek auth) lalu
 * POST /chat/completions sungguhan memakai model uji. Tidak pernah mengembalikan
 * body upstream, key, header, atau URL internal.
 */
export async function probeProvider(opts: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const trimmedBase = (opts.baseUrl ?? '').trim();
  if (!trimmedBase) {
    return {
      ok: false,
      status: 'error',
      latencyMs: 0,
      models: [],
      note: 'Base URL provider kosong.',
    };
  }
  let parsedBase: URL;
  try {
    parsedBase = new URL(trimmedBase);
  } catch {
    return {
      ok: false,
      status: 'error',
      latencyMs: 0,
      models: [],
      note: 'Base URL tidak valid (gunakan http:// atau https://).',
    };
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    return {
      ok: false,
      status: 'error',
      latencyMs: 0,
      models: [],
      note: 'Base URL harus menggunakan http:// atau https://.',
    };
  }
  const modelUrls = endpointCandidates(trimmedBase, 'models');
  if (modelUrls.length === 0) {
    return {
      ok: false,
      status: 'error',
      latencyMs: 0,
      models: [],
      note: 'Base URL provider kosong.',
    };
  }

  const headers: Record<string, string> = {};
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const modelsTimeout = Math.min(opts.timeoutMs ?? 8_000, 8_000);

  let models: string[] = [];
  let modelsHttpStatus: number | undefined;
  let modelsStepOk = false;

  for (const url of modelUrls) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(modelsTimeout),
      });
    } catch {
      return {
        ok: false,
        status: 'unreachable',
        latencyMs: Date.now() - started,
        models: [],
        note: 'Provider tidak terjangkau (timeout/jaringan).',
      };
    }

    modelsHttpStatus = response.status;
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: 'error',
        httpStatus: response.status,
        latencyMs: Date.now() - started,
        models: [],
        note: `Provider mengalihkan request (HTTP ${response.status}). Periksa Base URL.`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 'invalid',
        httpStatus: response.status,
        latencyMs: Date.now() - started,
        models: [],
        note: `Key ditolak provider (HTTP ${response.status}).`,
      };
    }
    if (response.status === 429) {
      return {
        ok: true,
        status: 'rate_limited',
        httpStatus: 429,
        latencyMs: Date.now() - started,
        models: [],
        note: 'Kena rate limit (HTTP 429); key kemungkinan valid.',
      };
    }
    if (response.status === 404 || response.status === 405) {
      continue;
    }
    if (response.ok) {
      modelsStepOk = true;
      const parsed: unknown = await response.json().catch(() => null);
      const data = (parsed as { data?: Array<{ id?: unknown }> } | null)?.data;
      if (Array.isArray(data)) {
        models = data
          .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
          .filter(Boolean)
          .slice(0, 500);
      }
      break;
    }
    return {
      ok: false,
      status: 'error',
      httpStatus: response.status,
      latencyMs: Date.now() - started,
      models: [],
      note: `Endpoint /models mengembalikan HTTP ${response.status}.`,
    };
  }

  const modelToTest = (opts.model ?? '').trim() || models[0] || '';
  if (!modelToTest) {
    if (modelsStepOk) {
      return {
        ok: true,
        status: 'valid',
        httpStatus: modelsHttpStatus,
        latencyMs: Date.now() - started,
        models,
        note: 'Belum dicek lewat chat (tidak ada model).',
      };
    }
    return {
      ok: false,
      status: 'error',
      httpStatus: modelsHttpStatus,
      latencyMs: Date.now() - started,
      models: [],
      note: 'Endpoint /models tidak tersedia dan model belum diisi.',
    };
  }

  const chatTimeout = opts.timeoutMs ?? 15_000;
  const chatHeaders: Record<string, string> = { 'content-type': 'application/json', ...headers };
  let chatRes: Response;
  try {
    chatRes = await fetchWithEndpointFallback(fetchImpl, opts.baseUrl, {
      method: 'POST',
      headers: chatHeaders,
      redirect: 'manual',
      body: JSON.stringify({
        model: modelToTest,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(chatTimeout),
    });
  } catch {
    return {
      ok: false,
      status: 'unreachable',
      latencyMs: Date.now() - started,
      models,
      modelTested: modelToTest,
      chatOk: false,
      note: 'Provider tidak terjangkau (timeout/jaringan).',
    };
  }

  const latencyMs = Date.now() - started;
  if (chatRes.status >= 300 && chatRes.status < 400) {
    return {
      ok: false,
      status: 'error',
      httpStatus: chatRes.status,
      latencyMs,
      models,
      modelTested: modelToTest,
      chatOk: false,
      note: `Provider mengalihkan request (HTTP ${chatRes.status}). Periksa Base URL.`,
    };
  }
  if (chatRes.ok) {
    return {
      ok: true,
      status: 'valid',
      httpStatus: chatRes.status,
      latencyMs,
      models,
      modelTested: modelToTest,
      chatOk: true,
      note: 'Key & model valid (tes chat berhasil).',
    };
  }
  if (chatRes.status === 401 || chatRes.status === 403) {
    return {
      ok: false,
      status: 'invalid',
      httpStatus: chatRes.status,
      latencyMs,
      models,
      modelTested: modelToTest,
      chatOk: false,
      note: `Key ditolak provider (HTTP ${chatRes.status}).`,
    };
  }
  if (chatRes.status === 429) {
    return {
      ok: true,
      status: 'rate_limited',
      httpStatus: 429,
      latencyMs,
      models,
      modelTested: modelToTest,
      chatOk: false,
      note: 'Kena rate limit (HTTP 429); key kemungkinan valid.',
    };
  }
  if (chatRes.status === 400 || chatRes.status === 404) {
    return {
      ok: false,
      status: 'error',
      httpStatus: chatRes.status,
      latencyMs,
      models,
      modelTested: modelToTest,
      chatOk: false,
      note: `Model "${modelToTest}" ditolak provider (HTTP ${chatRes.status}). Pilih model lain.`,
    };
  }
  return {
    ok: false,
    status: 'error',
    httpStatus: chatRes.status,
    latencyMs,
    models,
    modelTested: modelToTest,
    chatOk: false,
    note: `Provider mengembalikan error (HTTP ${chatRes.status}).`,
  };
}
