const THINK_CLOSED_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_UNCLOSED_RE = /<think\b[^>]*>[\s\S]*$/gi;
const INTERNAL_TAGS_RE = /<\/?\s*(?:info_kaliber|pesan_user|system|assistant|think)\b[^>]*>/gi;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/,
  /\bgsk_[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+\S+/i,
  /\bROUTER_KEY\b/,
  /\bADMIN_TOKEN\b/,
  /\bSECRET_KEY\b/,
  /\bREVEAL_PASSWORD\b/,
];

export function stripThink(text: string): string {
  return text.replace(THINK_CLOSED_RE, '').replace(THINK_UNCLOSED_RE, '');
}

function extractWords(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return matches ?? [];
}

export function leaksPrompt(output: string, systemPrompt: string): boolean {
  for (const re of SECRET_PATTERNS) {
    if (re.test(output)) {
      return true;
    }
  }

  // Ambil instruksi systemPrompt di luar blok <info_kaliber>...</info_kaliber>
  const promptOutsideKnowledge = systemPrompt.replace(
    /<info_kaliber\b[^>]*>[\s\S]*?<\/info_kaliber>/gi,
    ' '
  );

  const sysWords = extractWords(promptOutsideKnowledge);
  const outWords = extractWords(output);
  const SHINGLE_SIZE = 8;

  if (sysWords.length < SHINGLE_SIZE || outWords.length < SHINGLE_SIZE) {
    return false;
  }

  const shingles = new Set<string>();
  for (let i = 0; i <= sysWords.length - SHINGLE_SIZE; i++) {
    shingles.add(sysWords.slice(i, i + SHINGLE_SIZE).join(' '));
  }

  for (let i = 0; i <= outWords.length - SHINGLE_SIZE; i++) {
    const candidate = outWords.slice(i, i + SHINGLE_SIZE).join(' ');
    if (shingles.has(candidate)) {
      return true;
    }
  }

  return false;
}

export function toWhatsAppMarkdown(text: string): string {
  const lines = text.split(/\r?\n/);
  const keptLines: string[] = [];

  for (const rawLine of lines) {
    // Buang baris tabel Markdown (baris yang memiliki >= 2 karakter '|')
    const pipeCount = (rawLine.match(/\|/g) ?? []).length;
    if (pipeCount >= 2) {
      continue;
    }
    // Hapus heading '# ...' di awal baris
    const withoutHeading = rawLine.replace(/^\s*#{1,6}\s+/, '');
    keptLines.push(withoutHeading);
  }

  return keptLines
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncateSafeUtf16(text: string, maxChars = 1500): string {
  if (text.length <= maxChars) return text;
  let sliced = text.slice(0, maxChars);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  // Jangan memotong di tengah high surrogate (0xD800..0xDBFF)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    sliced = sliced.slice(0, -1);
  }
  return sliced.trimEnd();
}

export function sanitizeOutput(
  rawOutput: string,
  systemPrompt: string,
  fallbackText: string
): { text: string; leaked: boolean } {
  const withoutThink = stripThink(rawOutput);
  const withoutTags = withoutThink.replace(INTERNAL_TAGS_RE, '');

  if (leaksPrompt(withoutTags, systemPrompt)) {
    return {
      text: fallbackText,
      leaked: true,
    };
  }

  const formatted = toWhatsAppMarkdown(withoutTags);
  const bounded = truncateSafeUtf16(formatted, 1500);

  if (!bounded) {
    return {
      text: fallbackText,
      leaked: false,
    };
  }

  return {
    text: bounded,
    leaked: false,
  };
}
