import type { Settings } from './config.js';
import type { ChatMessage } from './llm.js';

export function formatNowWib(now = Date.now()): string {
  const d = new Date(now);
  const formatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${formatter.format(d)} WIB`;
}

export function renderSystemPrompt(settings: Settings, now = Date.now()): string {
  let template = settings.system_prompt ?? '';
  if (!template.includes('{{KNOWLEDGE}}')) {
    template = `${template.trimEnd()}\n\n<info_kaliber>\n{{KNOWLEDGE}}\n</info_kaliber>`;
  }

  const nowStr = formatNowWib(now);
  const contactStr = settings.contact ?? '';
  const knowledgeStr = settings.knowledge ?? '';

  return template
    .replaceAll('{{NOW}}', nowStr)
    .replaceAll('{{CONTACT}}', contactStr)
    .replaceAll('{{KNOWLEDGE}}', knowledgeStr);
}

const INTERNAL_TAG_ESCAPE_RE = /<\/?\s*(?:pesan_user|info_kaliber)\b[^>]*>/gi;

export function escapeUserInput(text: string): string {
  return text.replace(INTERNAL_TAG_ESCAPE_RE, (match) =>
    match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  );
}

export function wrapUserMessage(text: string): string {
  return `<pesan_user>${escapeUserInput(text)}</pesan_user>`;
}

export function buildMessages(
  settings: Settings,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userText: string,
  now = Date.now()
): { systemPrompt: string; messages: ChatMessage[] } {
  const systemPrompt = renderSystemPrompt(settings, now);
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const item of history) {
    if (item.role === 'user') {
      messages.push({ role: 'user', content: wrapUserMessage(item.content) });
    } else {
      messages.push({ role: 'assistant', content: item.content });
    }
  }

  messages.push({ role: 'user', content: wrapUserMessage(userText) });
  return { systemPrompt, messages };
}
