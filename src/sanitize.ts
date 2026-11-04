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

/** Buang blok <think>...</think> (termasuk yang tidak tertutup). */
export function stripThink(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, ' ');
}

const INTERNAL_TAG = /<\/?(?:info_kaliber|pesan_user|system|assistant|think)\b[^>]*>/gi;

/**
 * Deteksi pola kredensial dan rahasia yang jelas.
 * Jangan membandingkan jawaban dengan seluruh system prompt karena
 * system prompt juga memuat knowledge base yang memang boleh dijawab.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+\S+/i,
  /\bROUTER_KEY\b/,
  /\bADMIN_TOKEN\b/,
];

function leaksPrompt(output: string, _systemPrompt: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(output));
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
 * Bersihkan jawaban model:
 * - Buang tag internal dan blok think.
 * - Deteksi kredensial/rahasia.
 * - Ubah markdown WhatsApp.
 * - Batasi panjang jawaban.
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
    if (last >= 0xd800 && last <= 0xdbff) {
      text = text.slice(0, -1);
    }

    truncated = true;
  }

  if (text.trim() === '') {
    return { text: options.fallbackText, leaked: false, truncated };
  }

  return { text, leaked: false, truncated };
}
