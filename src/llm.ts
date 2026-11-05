import type { ChatMessage } from './prompt.js';
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
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  // Optional: if provided, use this to resolve model to provider+key
  llmContext?: {
    resolveModel: (model: string) => Promise<{ baseUrl: string; apiKey: string; providerId: number; keyId: number } | null>;
    markKeyFailed: (providerId: number, keyId: number, status: number) => Promise<void>;
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
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
    const { resolveModel, markKeyFailed } = options.llmContext;
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        attempts += 1;
        const resolved = await resolveModel(model);
        if (!resolved) {
          lastError = `provider/key tidak ditemukan untuk model ${model}`;
          break;
        }
        const { baseUrl, apiKey, providerId, keyId } = resolved;
        try {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (apiKey) headers.authorization = `Bearer ${apiKey}`;

          const response = await fetchWithEndpointFallback(fetchImpl, baseUrl, {
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
            if (isRetryableStatus(response.status)) {
              await markKeyFailed(providerId, keyId, response.status);
              if (attempt === 0) {
                await sleep(RETRY_DELAY_MS);
                continue;
              }
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
          if (isRetryableStatus(response.status) && attempt === 0) {
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
