/**
 * Provider OpenAI-compatible tidak selalu konsisten soal prefix `/v1`.
 * Normalisasi base URL lalu coba satu-dua varian endpoint agar 404 path
 * tidak langsung dianggap provider mati.
 */
export function normalizeProviderBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/+$/, '');
}

export function endpointCandidates(baseUrl: string, path: string): string[] {
  const base = normalizeProviderBaseUrl(baseUrl);
  if (!base) return [];

  const candidates: string[] = [];
  const add = (value: string): void => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  if (/\/v1$/i.test(base)) {
    add(`${base}/${path}`);
    add(`${base.slice(0, -3)}/${path}`);
  } else {
    add(`${base}/${path}`);
    add(`${base}/v1/${path}`);
  }
  return candidates;
}
