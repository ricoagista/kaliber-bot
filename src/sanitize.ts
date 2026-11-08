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
 * Deteksi pola kredensial, rahasia, dan kebocoran 8 kata berurutan dari
 * instruksi system prompt (di luar blok <info_kaliber>).
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/,
  /\bgsk_[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+\S+/i,
  /\bROUTER_KEY\b/,
  /\bADMIN_TOKEN\b/,
  /\bSECRET_KEY\b/,
  /\bREVEAL_PASSWORD\b/,
];

const LEAK_WINDOW = 8;

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stripKnowledgeBlock(systemPrompt: string): string {
  return systemPrompt
    .replace(/<info_kaliber\b[^>]*>[\s\S]*?<\/info_kaliber>/gi, ' ')
    .replace(/\{\{KNOWLEDGE\}\}/g, ' ');
}

function leaksPrompt(output: string, systemPrompt: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(output))) return true;
  if (!systemPrompt || systemPrompt.trim() === '') return false;

  const promptWords = wordsOf(stripKnowledgeBlock(systemPrompt));
  const outWords = wordsOf(output);
  if (promptWords.length < LEAK_WINDOW || outWords.length < LEAK_WINDOW) return false;

  const shingles = new Set<string>();
  for (let i = 0; i + LEAK_WINDOW <= promptWords.length; i++) {
    shingles.add(promptWords.slice(i, i + LEAK_WINDOW).join(' '));
  }
  for (let i = 0; i + LEAK_WINDOW <= outWords.length; i++) {
    if (shingles.has(outWords.slice(i, i + LEAK_WINDOW).join(' '))) return true;
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
