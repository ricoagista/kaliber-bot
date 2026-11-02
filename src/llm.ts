import type { ChatMessage } from './prompt.js';
import { stripThink } from './sanitize.js';

export interface LlmOptions {
  routerUrl: string;
  routerKey: string;
  model: string;
  fallbackModels: string[];
  temperature: number;
  maxTokens: number;
  fallbackText: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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
 * Panggil 9router (OpenAI-compatible). Retry 1x untuk 429/5xx/timeout,
 * lalu pindah ke model fallback. Tidak pernah melempar error ke pemanggil.
 */
export async function callLlm(messages: ChatMessage[], options: LlmOptions): Promise<LlmResult> {
  const fallbackText = options.fallbackText ?? '';
  const models = modelList(options);
  if (models.length === 0) {
    return { ok: false, content: fallbackText, model: null, attempts: 0, error: 'model belum diatur' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? sleepDefault;
  const url = `${options.routerUrl.replace(/\/+$/, '')}/chat/completions`;
  let attempts = 0;
  let lastError = '';

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts += 1;
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (options.routerKey) headers.authorization = `Bearer ${options.routerKey}`;

        const response = await fetchImpl(url, {
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

/** Tes koneksi singkat ke 9router untuk dashboard. */
export async function pingLlm(
  options: Omit<LlmOptions, 'fallbackText' | 'fallbackModels'>,
): Promise<PingResult> {
  const started = Date.now();
  const result = await callLlm([{ role: 'user', content: 'ping' }], {
    ...options,
    fallbackModels: [],
    fallbackText: '',
    maxTokens: 5,
    timeoutMs: options.timeoutMs ?? 15_000,
  });
  return {
    ok: result.ok,
    latencyMs: Date.now() - started,
    model: result.model,
    error: result.error,
  };
}
