import assert from 'node:assert/strict';
import test from 'node:test';
import { callLlm, pingLlm, type LlmOptions } from '../src/llm.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseOptions(overrides: Partial<LlmOptions> = {}): LlmOptions {
  return {
    routerUrl: 'http://localhost:20128/v1',
    routerKey: 'rahasia-jangan-dilog',
    model: 'model-utama',
    fallbackModels: ['model-cadangan'],
    temperature: 0.3,
    maxTokens: 300,
    fallbackText: 'FALLBACK',
    sleep: async () => undefined,
    ...overrides,
  };
}

test('memanggil endpoint OpenAI-compatible dan mengembalikan jawaban', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return jsonResponse(200, { choices: [{ message: { content: '<think>x</think>Halo **Kaliber**' } }] });
  }) as unknown as typeof fetch;

  const result = await callLlm([{ role: 'user', content: 'halo' }], baseOptions({ fetchImpl }));
  assert.equal(result.ok, true);
  assert.equal(result.model, 'model-utama');
  assert.equal(result.content, 'Halo **Kaliber**');
  assert.equal(capturedUrl, 'http://localhost:20128/v1/chat/completions');
  const headers = capturedInit?.headers as Record<string, string>;
  assert.match(headers.authorization ?? '', /^Bearer /);
});

test('retry sekali untuk 500 lalu sukses', async () => {
  let calls = 0;
  let sleeps = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(500, { error: 'boom' });
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
  }) as unknown as typeof fetch;

  const result = await callLlm(
    [{ role: 'user', content: 'halo' }],
    baseOptions({
      fetchImpl,
      sleep: async () => {
        sleeps += 1;
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
});

test('pindah ke model fallback saat model utama menolak (400)', async () => {
  const models: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    models.push(body.model);
    if (body.model === 'model-utama') return jsonResponse(400, { error: 'bad model' });
    return jsonResponse(200, { choices: [{ message: { content: 'dari cadangan' } }] });
  }) as unknown as typeof fetch;

  const result = await callLlm([{ role: 'user', content: 'halo' }], baseOptions({ fetchImpl }));
  assert.equal(result.ok, true);
  assert.equal(result.model, 'model-cadangan');
  assert.deepEqual(models, ['model-utama', 'model-cadangan']);
});

test('semua model gagal -> fallback tanpa melempar error', async () => {
  const fetchImpl = (async () => jsonResponse(503, {})) as unknown as typeof fetch;
  const result = await callLlm([{ role: 'user', content: 'halo' }], baseOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.content, 'FALLBACK');
  assert.equal(result.attempts, 4); // 2 model x 2 percobaan
});

test('error jaringan tidak melempar ke pemanggil', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const result = await callLlm([{ role: 'user', content: 'halo' }], baseOptions({ fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.content, 'FALLBACK');
});

test('jawaban kosong dianggap gagal dan lanjut ke model berikutnya', async () => {
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === 'model-utama') return jsonResponse(200, { choices: [{ message: { content: '' } }] });
    return jsonResponse(200, { choices: [{ message: { content: 'cadangan' } }] });
  }) as unknown as typeof fetch;

  const result = await callLlm([{ role: 'user', content: 'halo' }], baseOptions({ fetchImpl }));
  assert.equal(result.ok, true);
  assert.equal(result.content, 'cadangan');
});

test('model belum diatur -> fallback langsung tanpa fetch', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
  const result = await callLlm(
    [{ role: 'user', content: 'halo' }],
    baseOptions({ fetchImpl, model: '', fallbackModels: [] }),
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.match(result.error ?? '', /model/);
});

test('ping melaporkan latensi dan status', async () => {
  const fetchImpl = (async () => jsonResponse(200, { choices: [{ message: { content: 'pong' } }] })) as unknown as typeof fetch;
  const result = await pingLlm({
    routerUrl: 'http://localhost:20128/v1',
    routerKey: 'k',
    model: 'm',
    temperature: 0,
    maxTokens: 5,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'm');
  assert.ok(result.latencyMs >= 0);
});
