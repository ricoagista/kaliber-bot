import type { Settings } from './config.js';
import { endpointCandidates, normalizeBaseUrl } from './endpoint.js';
import { logger } from './logger.js';
import {
  buildModelPlan,
  getProviderById,
  getProviderKeySecret,
  listProviders,
  markKeyFailed,
  markKeySucceeded,
  resolveModel,
  updateKeyProbeStatus,
  type KeyStatus,
} from './providers.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallResult {
  ok: boolean;
  reply: string;
  model: string | null;
  latencyMs: number;
  error?: string;
}

export interface ProbeResult {
  ok: boolean;
  status: KeyStatus;
  httpStatus: number;
  latencyMs: number;
  models: string[];
  testedModel: string;
  chatOk: boolean;
  message: string;
}

const TOTAL_BUDGET_MS = 75_000;
const PER_REQUEST_TIMEOUT_MS = 30_000;
const MIN_REMAINING_BUDGET_MS = 3_000;

function extractAssistantText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown>;
    const msg = first?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg?.content)) {
      return msg.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
            return (part as Record<string, unknown>).text as string;
          }
          return '';
        })
        .join('');
    }
    if (typeof first?.text === 'string') {
      return first.text;
    }
  }
  return '';
}

function extractModelsList(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  const rawList = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.models)
      ? obj.models
      : [];
  const models: string[] = [];
  for (const item of rawList) {
    if (typeof item === 'string' && item.trim()) {
      models.push(item.trim());
    } else if (item && typeof item === 'object') {
      const id = (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name;
      if (typeof id === 'string' && id.trim()) {
        models.push(id.trim());
      }
    }
    if (models.length >= 500) break;
  }
  return models;
}

export async function callLlm(
  messages: ChatMessage[],
  settings: Settings
): Promise<LlmCallResult> {
  const startTime = Date.now();
  const plan = buildModelPlan(settings, { advance: true });
  const candidates = [plan.model, ...plan.fallbackModels].filter((c) => c && c.trim().length > 0);

  if (candidates.length === 0) {
    return {
      ok: false,
      reply: '',
      model: null,
      latencyMs: Date.now() - startTime,
      error: 'Belum ada model atau provider aktif yang dikonfigurasi.',
    };
  }

  let lastError = 'Gagal menghubungi layanan LLM.';

  for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
    const candidate = candidates[cIdx];
    const isLastCandidate = cIdx === candidates.length - 1;
    const triedKeys = new Set<number>();

    for (let attempt = 0; attempt < 2; attempt++) {
      const elapsed = Date.now() - startTime;
      const remaining = TOTAL_BUDGET_MS - elapsed;
      if (remaining < MIN_REMAINING_BUDGET_MS) {
        return {
          ok: false,
          reply: '',
          model: null,
          latencyMs: Date.now() - startTime,
          error: 'Waktu tunggu LLM habis.',
        };
      }

      const resolved = resolveModel(candidate, {
        advance: true,
        excludeKeyIds: triedKeys.size > 0 ? triedKeys : undefined,
      });

      if (!resolved) {
        break;
      }

      if (resolved.keyId) {
        triedKeys.add(resolved.keyId);
      }

      const timeoutMs = Math.min(PER_REQUEST_TIMEOUT_MS, remaining);
      const urls = endpointCandidates(resolved.baseUrl, '/chat/completions');

      let succeeded = false;
      let httpStatus = 0;
      let retryAfterHeader: string | null = null;

      for (let uIdx = 0; uIdx < urls.length; uIdx++) {
        const url = urls[uIdx];
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (resolved.apiKey) {
          headers.Authorization = `Bearer ${resolved.apiKey}`;
        }

        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: resolved.modelName,
              messages,
              temperature: settings.temperature,
              max_tokens: settings.max_tokens,
              stream: false,
            }),
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
          });

          httpStatus = res.status;
          retryAfterHeader = res.headers.get('retry-after');

          if (res.status >= 300 && res.status < 400) {
            lastError = 'Provider mengembalikan redirect yang tidak diizinkan.';
            break;
          }

          if (res.status === 404 && uIdx === 0 && urls.length > 1) {
            // Coba kandidat URL ke-2 (/v1 vs non-/v1)
            continue;
          }

          if (res.ok) {
            const json = await res.json().catch(() => null);
            const content = extractAssistantText(json).trim();
            if (content) {
              markKeySucceeded(resolved.keyId);
              return {
                ok: true,
                reply: content,
                model: resolved.fullModelLabel,
                latencyMs: Date.now() - startTime,
              };
            }
            lastError = 'Respons LLM kosong.';
            httpStatus = 502;
          } else {
            lastError = `Provider merespons dengan status HTTP ${res.status}.`;
          }
          break;
        } catch (err) {
          httpStatus = 0;
          lastError = 'Koneksi ke provider gagal atau waktu habis.';
          logger.debug({ provider: resolved.providerName, err }, 'Request ke LLM gagal');
          break;
        }
      }

      if (!succeeded) {
        markKeyFailed(resolved.keyId, resolved.providerId, httpStatus, retryAfterHeader);
      }

      const canRetrySecondAttempt =
        attempt === 0 && (resolved.healthyKeyCount > 1 || isLastCandidate);
      if (!canRetrySecondAttempt) {
        break;
      }
    }
  }

  return {
    ok: false,
    reply: '',
    model: null,
    latencyMs: Date.now() - startTime,
    error: lastError,
  };
}

export async function probeProvider(opts: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  providerId?: number;
  keyId?: number;
}): Promise<ProbeResult> {
  const startTime = Date.now();
  let baseUrl = (opts.baseUrl ?? '').trim();
  let apiKey = (opts.apiKey ?? '').trim();
  let defaultModel = (opts.model ?? '').trim();
  let savedKeyId = opts.keyId;

  if (opts.keyId !== undefined) {
    const keySecret = getProviderKeySecret(opts.keyId, opts.providerId);
    if (!keySecret) {
      return {
        ok: false,
        status: 'error',
        httpStatus: 404,
        latencyMs: 0,
        models: [],
        testedModel: '',
        chatOk: false,
        message: 'API key tidak ditemukan.',
      };
    }
    if (!baseUrl) baseUrl = keySecret.baseUrl;
    if (!apiKey) apiKey = keySecret.plainKey;
    if (!defaultModel) defaultModel = keySecret.providerModel;
    savedKeyId = keySecret.id;
  } else if (opts.providerId !== undefined) {
    const prov = getProviderById(opts.providerId);
    if (!prov) {
      return {
        ok: false,
        status: 'error',
        httpStatus: 404,
        latencyMs: 0,
        models: [],
        testedModel: '',
        chatOk: false,
        message: 'Provider tidak ditemukan.',
      };
    }
    if (!baseUrl) baseUrl = prov.baseUrl;
    if (!defaultModel) defaultModel = prov.model;
    if (!apiKey && prov.keys.length > 0) {
      const now = Date.now();
      const enabledKeys = prov.keys.filter((k) => k.enabled);
      const targetKey =
        enabledKeys.find((k) => k.cooldownUntil <= now) ?? enabledKeys[0] ?? prov.keys[0];
      if (targetKey) {
        const secret = getProviderKeySecret(targetKey.id, prov.id);
        if (secret) {
          apiKey = secret.plainKey;
          savedKeyId = secret.id;
        }
      }
    }
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeBaseUrl(baseUrl);
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      httpStatus: 400,
      latencyMs: 0,
      models: [],
      testedModel: '',
      chatOk: false,
      message: err instanceof Error ? err.message : 'Base URL tidak valid.',
    };
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // Tahap 1: GET /models (timeout 8 detik)
  const modelUrls = endpointCandidates(normalizedUrl, '/models');
  let models: string[] = [];
  let stage1Ok = false;
  let lastHttpStatus = 0;

  for (let i = 0; i < modelUrls.length; i++) {
    try {
      const res = await fetch(modelUrls[i], {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
      });
      lastHttpStatus = res.status;

      if (res.status >= 300 && res.status < 400) {
        const result: ProbeResult = {
          ok: false,
          status: 'error',
          httpStatus: res.status,
          latencyMs: Date.now() - startTime,
          models: [],
          testedModel: '',
          chatOk: false,
          message: 'Provider mengembalikan redirect (3xx) yang ditolak.',
        };
        if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'error');
        return result;
      }

      if (res.status === 401 || res.status === 403) {
        const result: ProbeResult = {
          ok: false,
          status: 'invalid',
          httpStatus: res.status,
          latencyMs: Date.now() - startTime,
          models: [],
          testedModel: '',
          chatOk: false,
          message: 'API key ditolak oleh provider (401/403).',
        };
        if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'invalid');
        return result;
      }

      if (res.status === 429) {
        const result: ProbeResult = {
          ok: true,
          status: 'rate_limited',
          httpStatus: 429,
          latencyMs: Date.now() - startTime,
          models: [],
          testedModel: '',
          chatOk: false,
          message: 'API key valid tetapi sedang terkena batas rate limit (429).',
        };
        if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'rate_limited');
        return result;
      }

      if (res.ok) {
        const json = await res.json().catch(() => null);
        models = extractModelsList(json);
        stage1Ok = true;
        break;
      }

      if ((res.status === 404 || res.status === 405) && i === 0 && modelUrls.length > 1) {
        continue;
      }
      break;
    } catch {
      lastHttpStatus = 0;
      break;
    }
  }

  // Tahap 2: POST /chat/completions (timeout 15 detik)
  let modelToTest = defaultModel || models[0] || '';
  if (modelToTest.includes('/')) {
    const slashIdx = modelToTest.indexOf('/');
    const maybeProv = modelToTest.slice(0, slashIdx).toLowerCase();
    const knownProv = listProviders().some((p) => p.name === maybeProv);
    if (knownProv) {
      modelToTest = modelToTest.slice(slashIdx + 1);
    }
  }

  if (!modelToTest) {
    if (stage1Ok) {
      if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'valid', true);
      return {
        ok: true,
        status: 'valid',
        httpStatus: 200,
        latencyMs: Date.now() - startTime,
        models,
        testedModel: '',
        chatOk: false,
        message: `Endpoint model merespons (${models.length} model), belum dites chat karena model belum dipilih.`,
      };
    }
    const status: KeyStatus = lastHttpStatus === 0 ? 'unreachable' : 'error';
    if (savedKeyId) updateKeyProbeStatus(savedKeyId, status);
    return {
      ok: false,
      status,
      httpStatus: lastHttpStatus,
      latencyMs: Date.now() - startTime,
      models: [],
      testedModel: '',
      chatOk: false,
      message:
        lastHttpStatus === 0
          ? 'Provider tidak dapat dijangkau.'
          : 'Gagal mengambil daftar model dan tidak ada nama model untuk diuji.',
    };
  }

  const chatUrls = endpointCandidates(normalizedUrl, '/chat/completions');
  for (let i = 0; i < chatUrls.length; i++) {
    try {
      const res = await fetch(chatUrls[i], {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelToTest,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
          temperature: 0,
          stream: false,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });

      lastHttpStatus = res.status;

      if (res.status >= 300 && res.status < 400) {
        if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'error');
        return {
          ok: false,
          status: 'error',
          httpStatus: res.status,
          latencyMs: Date.now() - startTime,
          models,
          testedModel: modelToTest,
          chatOk: false,
          message: 'Provider mengembalikan redirect (3xx) yang ditolak.',
        };
      }

      if (res.status === 404 && i === 0 && chatUrls.length > 1) {
        continue;
      }

      if (res.ok) {
        if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'valid', true);
        return {
          ok: true,
          status: 'valid',
          httpStatus: res.status,
          latencyMs: Date.now() - startTime,
          models,
          testedModel: modelToTest,
          chatOk: true,
          message: `Koneksi dan chat berhasil diuji pada model ${modelToTest}.`,
        };
      }

      if (res.status === 401 || res.status === 403) {
        if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'invalid');
        return {
          ok: false,
          status: 'invalid',
          httpStatus: res.status,
          latencyMs: Date.now() - startTime,
          models,
          testedModel: modelToTest,
          chatOk: false,
          message: 'API key ditolak saat uji chat (401/403).',
        };
      }

      if (res.status === 429) {
        if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'rate_limited');
        return {
          ok: true,
          status: 'rate_limited',
          httpStatus: 429,
          latencyMs: Date.now() - startTime,
          models,
          testedModel: modelToTest,
          chatOk: false,
          message: 'API key valid namun sedang terkena rate limit (429).',
        };
      }

      if (savedKeyId) updateKeyProbeStatus(savedKeyId, 'error');
      return {
        ok: false,
        status: 'error',
        httpStatus: res.status,
        latencyMs: Date.now() - startTime,
        models,
        testedModel: modelToTest,
        chatOk: false,
        message: `Model "${modelToTest}" ditolak atau gagal dijalankan (HTTP ${res.status}).`,
      };
    } catch {
      lastHttpStatus = 0;
      break;
    }
  }

  const finalStatus: KeyStatus = lastHttpStatus === 0 ? 'unreachable' : 'error';
  if (savedKeyId) updateKeyProbeStatus(savedKeyId, finalStatus);
  return {
    ok: false,
    status: finalStatus,
    httpStatus: lastHttpStatus,
    latencyMs: Date.now() - startTime,
    models,
    testedModel: modelToTest,
    chatOk: false,
    message:
      lastHttpStatus === 0
        ? 'Provider tidak terjangkau atau waktu tunggu habis.'
        : `Pengujian koneksi gagal (HTTP ${lastHttpStatus}).`,
  };
}

export async function pingLlm(settings: Settings): Promise<{
  ok: boolean;
  model: string | null;
  latencyMs: number;
  message: string;
}> {
  const plan = buildModelPlan(settings, { advance: false });
  const candidate = plan.model || plan.fallbackModels[0] || '';
  if (!candidate) {
    return {
      ok: false,
      model: null,
      latencyMs: 0,
      message: 'Belum ada model aktif yang dikonfigurasi.',
    };
  }

  const resolved = resolveModel(candidate, { advance: false });
  if (!resolved) {
    return {
      ok: false,
      model: candidate,
      latencyMs: 0,
      message: 'Provider atau API key untuk model aktif tidak tersedia.',
    };
  }

  const probe = await probeProvider({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.modelName,
    providerId: resolved.providerId,
    keyId: resolved.keyId || undefined,
  });

  return {
    ok: probe.ok,
    model: resolved.fullModelLabel,
    latencyMs: probe.latencyMs,
    message: probe.message,
  };
}

export async function fetchProviderModels(providerId: number): Promise<{
  provider: string;
  models: string[];
  error?: string;
}> {
  const prov = getProviderById(providerId);
  if (!prov) {
    return { provider: '', models: [], error: 'Provider tidak ditemukan.' };
  }

  let apiKey = '';
  const enabledKeys = prov.keys.filter((k) => k.enabled);
  const now = Date.now();
  const chosenKey = enabledKeys.find((k) => k.cooldownUntil <= now) ?? enabledKeys[0];
  if (chosenKey) {
    const secret = getProviderKeySecret(chosenKey.id, prov.id);
    if (secret) apiKey = secret.plainKey;
  } else if (prov.keys.length > 0) {
    return {
      provider: prov.name,
      models: prov.model ? [prov.model] : [],
      error: 'Tidak ada API key aktif pada provider ini.',
    };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const urls = endpointCandidates(prov.baseUrl, '/models');
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i], {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 404 && i === 0 && urls.length > 1) {
        continue;
      }
      if (res.ok) {
        const json = await res.json().catch(() => null);
        const list = extractModelsList(json);
        if (prov.model && !list.includes(prov.model)) {
          list.unshift(prov.model);
        }
        return { provider: prov.name, models: list };
      }
      return {
        provider: prov.name,
        models: prov.model ? [prov.model] : [],
        error: `HTTP ${res.status}`,
      };
    } catch {
      return {
        provider: prov.name,
        models: prov.model ? [prov.model] : [],
        error: 'Tidak terjangkau',
      };
    }
  }

  return {
    provider: prov.name,
    models: prov.model ? [prov.model] : [],
    error: 'Gagal memuat model',
  };
}

export async function fetchAllProvidersModels(): Promise<
  Array<{ provider: string; models: string[]; error?: string }>
> {
  const activeProviders = listProviders().filter((p) => p.enabled);
  return Promise.all(activeProviders.map((p) => fetchProviderModels(p.id)));
}
