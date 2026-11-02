export interface SanitizeOptions {
  systemPrompt: string;
  fallbackText: string;
  maxChars?: number;
}

export interface SanitizeResult {
  text: string;
  leaked: boolean;
  truncated: boolean;
}

const shingleCache = new Map<string, Set<string>>();
const SHINGLE_SIZE = 8;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) {
    out.add(tokens.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  return out;
}

function systemShingles(systemPrompt: string): Set<string> {
  const cached = shingleCache.get(systemPrompt);
  if (cached) return cached;
  const result = shingles(tokenize(systemPrompt));
  if (shingleCache.size > 4) shingleCache.clear();
  shingleCache.set(systemPrompt, result);
  return result;
}

/** Buang blok <think>...</think> (termasuk yang tidak tertutup). */
export function stripThink(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, ' ');
}

const INTERNAL_TAG = /<\/?(?:info_kaliber|pesan_user|system|assistant|think)\b[^>]*>/gi;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+\S+/i,
  /\bROUTER_KEY\b/,
  /\bADMIN_TOKEN\b/,
];

function leaksPrompt(output: string, systemPrompt: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(output))) return true;
  const known = systemShingles(systemPrompt);
  if (known.size === 0) return false;
  for (const shingle of shingles(tokenize(output))) {
    if (known.has(shingle)) return true;
  }
  return false;
}

function toWhatsAppMarkdown(text: string): string {
  let out = text;
  out = out.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  out = out.replace(/~~([^~\n]+)~~/g, '~$1~');
  out = out
    .split('\n')
    .filter((line) => (line.match(/\|/g) ?? []).length < 2)
    .join('\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Bersihkan jawaban model: buang tag internal, deteksi kebocoran prompt/rahasia,
 * ubah markdown, dan potong panjangnya.
 */
export function sanitizeOutput(raw: string, options: SanitizeOptions): SanitizeResult {
  const maxChars = options.maxChars ?? 1500;
  let text = stripThink(raw ?? '');
  text = text.replace(INTERNAL_TAG, ' ').trim();

  if (leaksPrompt(text, options.systemPrompt)) {
    return { text: options.fallbackText, leaked: true, truncated: false };
  }

  text = toWhatsAppMarkdown(text);
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    // Jangan potong di tengah surrogate pair.
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    truncated = true;
  }

  if (text.trim() === '') {
    return { text: options.fallbackText, leaked: false, truncated };
  }
  return { text, leaked: false, truncated };
}
