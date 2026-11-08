import type { Settings } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptInput {
  userText: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  settings: Settings;
  now?: Date;
}

/** Netralkan tag yang bisa dipakai untuk menutup/membuka blok prompt (termasuk variasi spasi/atribut). */
export function escapeUserText(text: string): string {
  return text.replace(/<\s*(\/?)\s*(pesan_user|info_kaliber)\b[^>]*>/gi, (_match, slash: string, tag: string) => {
    return `&lt;${slash}${tag.toLowerCase()}&gt;`;
  });
}

export function wrapUserText(text: string): string {
  return `<pesan_user>${escapeUserText(text)}</pesan_user>`;
}

/** Format waktu sekarang dalam zona Asia/Jakarta. */
export function formatNowWib(now: Date, timeZone = 'Asia/Jakarta'): string {
  const formatter = new Intl.DateTimeFormat('id-ID', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${formatter.format(now)} WIB`;
}

/** Isi placeholder system prompt; {{KNOWLEDGE}} ditambahkan otomatis bila tidak ada. */
export function renderSystemPrompt(settings: Settings, now: Date): string {
  let template = settings.system_prompt;
  if (!template.includes('{{KNOWLEDGE}}')) {
    template += '\n\n<info_kaliber>\n{{KNOWLEDGE}}\n</info_kaliber>';
  }
  const replacements: Record<string, string> = {
    '{{NOW}}': formatNowWib(now),
    '{{CONTACT}}': settings.contact,
    '{{KNOWLEDGE}}': settings.knowledge,
  };
  return template.replace(/\{\{(?:NOW|CONTACT|KNOWLEDGE)\}\}/g, (token) => replacements[token] ?? token);
}

/**
 * Susun messages untuk LLM: [system] + riwayat + [user].
 * Teks pengguna TIDAK pernah masuk ke system prompt.
 */
export function buildMessages(input: PromptInput): ChatMessage[] {
  const now = input.now ?? new Date();
  const messages: ChatMessage[] = [
    { role: 'system', content: renderSystemPrompt(input.settings, now) },
  ];

  const maxTurns = Math.max(0, Math.floor(input.settings.history_turns)) * 2;
  const history = input.history.slice(-maxTurns);
  for (const turn of history) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: wrapUserText(turn.content) });
    } else {
      messages.push({ role: 'assistant', content: turn.content });
    }
  }

  messages.push({ role: 'user', content: wrapUserText(input.userText) });
  return messages;
}
