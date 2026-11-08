export function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Base URL wajib diawali http:// atau https://');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Format Base URL tidak valid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL wajib menggunakan protokol http atau https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL tidak boleh memuat kredensial di dalam URL.');
  }

  let cleanPath = parsed.pathname.replace(/\/+$/, '');
  if (cleanPath.endsWith('/chat/completions')) {
    cleanPath = cleanPath.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  } else if (cleanPath.endsWith('/messages')) {
    cleanPath = cleanPath.slice(0, -'/messages'.length).replace(/\/+$/, '');
  } else if (cleanPath.endsWith('/models')) {
    cleanPath = cleanPath.slice(0, -'/models'.length).replace(/\/+$/, '');
  }

  return `${parsed.origin}${cleanPath}`;
}

export function endpointCandidates(baseUrl: string, suffix: '/chat/completions' | '/messages' | '/models'): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith('/v1')) {
    const withoutV1 = normalized.slice(0, -3).replace(/\/+$/, '');
    return [`${normalized}${suffix}`, `${withoutV1}${suffix}`];
  }
  return [`${normalized}${suffix}`, `${normalized}/v1${suffix}`];
}
