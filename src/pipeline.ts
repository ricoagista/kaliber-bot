import { loadEnv } from './config.js';
import { getDb, insertLog } from './db.js';
import { allowNonTextNotice, checkGuard, digitsOf, normalizeText } from './guard.js';
import { callLlm } from './llm.js';
import { addMessage, getHistory } from './memory.js';
import { buildMessages, renderSystemPrompt } from './prompt.js';
import { defaultQueue } from './queue.js';
import { sanitizeOutput } from './sanitize.js';
import { getSettings } from './settings.js';
import { buildModelPlan, createLlmContext, type LlmContext } from './providers.js';

const runtimeEnv = loadEnv();
const NON_TEXT_REPLY = 'Aku cuma bisa membaca teks ya 🙏';
const LOGGABLE = new Set<PipelineStatus>(['ok', 'blocked', 'injection', 'ratelimit', 'error']);
const STALE_MESSAGE_MS = 60_000;

export type PipelineStatus =
  | 'ok'
  | 'ignored'
  | 'nontext'
  | 'disabled'
  | 'blocked'
  | 'injection'
  | 'ratelimit'
  | 'error';

export interface IncomingMessage {
  chatId: string;
  senderId: string;
  /** JID alternatif (PN/LID) untuk pencocokan blocklist/allowlist. */
  altSenderIds?: string[];
  isGroup?: boolean;
  fromMe?: boolean;
  isStatus?: boolean;
  text?: string | null;
  hasMedia?: boolean;
  messageId?: string;
  /** Waktu pesan dalam milidetik (epoch). */
  timestamp?: number;
  mentioned?: boolean;
  now?: number;
}

export interface PipelineMeta {
  status: PipelineStatus;
  flags: string[];
  model: string | null;
  latencyMs: number;
  usedFallback: boolean;
}

export interface PipelineResult {
  reply: string | null;
  meta: PipelineMeta;
}

function isAllowedGroup(allowed: string[], chatId: string): boolean {
  const chatDigits = digitsOf(chatId);
  return allowed.some((entry) => {
    const trimmed = String(entry).trim();
    if (!trimmed) return false;
    if (trimmed === chatId) return true;
    const digits = digitsOf(trimmed);
    return digits !== '' && digits === chatDigits;
  });
}

/**
 * Alur pesan masuk -> balasan. Tidak bergantung pada Baileys sehingga bisa
 * dipakai oleh WA maupun endpoint /api/test.
 */
export async function handleMessage(input: IncomingMessage): Promise<PipelineResult> {
  const started = Date.now();
  const now = input.now ?? started;
  const settings = getSettings();
  const isAdminTest = input.chatId === 'admin-test';
  const flags: string[] = [];
  let usedFallback = false;

  const finish = (status: PipelineStatus, reply: string | null, model: string | null = null): PipelineResult => {
    const latencyMs = Date.now() - started;
    if (LOGGABLE.has(status)) {
      try {
        insertLog({
          ts: now,
          chatId: input.chatId,
          message: (input.text ?? '').slice(0, 500),
          reply: reply === null ? null : reply.slice(0, 1500),
          status,
          latencyMs,
          model,
        });
      } catch {
        // Logging tidak boleh menggagalkan balasan.
      }
    }
    return { reply, meta: { status, flags, model, latencyMs, usedFallback } };
  };

  // 1. Abaikan pesan yang tidak layak diproses.
  if (input.fromMe || input.isStatus) return finish('ignored', null);
  if (
    input.chatId === 'status@broadcast' ||
    input.chatId.endsWith('@broadcast') ||
    input.chatId.endsWith('@newsletter')
  ) {
    return finish('ignored', null);
  }
  if (typeof input.timestamp === 'number' && input.timestamp > 0 && now - input.timestamp > STALE_MESSAGE_MS) {
    return finish('ignored', null);
  }
  if (input.messageId) {
    const inserted = getDb()
      .prepare('INSERT OR IGNORE INTO seen_messages (id, ts) VALUES (?, ?)')
      .run(input.messageId, now);
    if (Number(inserted.changes) === 0) return finish('ignored', null);
  }

  const rawText = typeof input.text === 'string' ? input.text : '';
  if (rawText.trim() === '') {
    // 2. Bukan teks: balas sekali per nomor per jam.
    if (input.hasMedia) {
      if (allowNonTextNotice(input.senderId, now)) {
        flags.push('non_text');
        return finish('blocked', NON_TEXT_REPLY);
      }
    }
    return finish('ignored', null);
  }

  // 3. Saklar bot.
  if (!settings.bot_enabled) return finish('disabled', null);
  if (input.isGroup && !settings.group_enabled) return finish('disabled', null);
  if (!input.isGroup && !settings.private_enabled) return finish('disabled', null);

  // 4. Trigger grup.
  let text = normalizeText(rawText);
  if (input.isGroup) {
    if (!isAllowedGroup(settings.allowed_groups, input.chatId)) return finish('ignored', null);
    const prefix = (settings.trigger_prefix || '').trim().toLowerCase();
    const lower = text.toLowerCase();
    let triggered = Boolean(input.mentioned);
    if (prefix && lower.startsWith(prefix)) {
      triggered = true;
      text = text.slice(prefix.length).trim();
    } else if (/^!(info|help)$/i.test(lower)) {
      triggered = true;
    }
    if (input.mentioned) {
      text = text.replace(/@\d{5,20}\b/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (!triggered || text === '') return finish('ignored', null);
  }

  const senderJids = [input.senderId, ...(input.altSenderIds ?? [])];
  if (!input.isGroup) senderJids.push(input.chatId);
  const senderIds = senderJids.filter(Boolean);

  // 5. Guard.
  const guard = checkGuard({
    senderJids: senderIds,
    chatJid: input.chatId,
    isGroup: Boolean(input.isGroup),
    text,
    now,
    settings,
    bypassLimits: isAdminTest,
  });
  flags.push(...guard.flags);
  if (!guard.ok) return finish(guard.status, guard.reply, null);

  // Perintah statis grup/chat: tidak memanggil LLM.
  if (/^!info$/i.test(guard.normalized)) return finish('ok', settings.info_text, null);
  if (/^!help$/i.test(guard.normalized)) return finish('ok', settings.help_text, null);

  // 6-8. Antrean -> prompt -> LLM -> sanitize.
  return defaultQueue.run(input.senderId, async () => {
    const systemPrompt = renderSystemPrompt(settings, new Date(now));
    const history = getHistory(input.senderId, settings.history_turns, now);
    const messages = buildMessages({
      userText: guard.normalized,
      history,
      settings,
      now: new Date(now),
    });

    let llm;
    try {
      const llmContext = createLlmContext();
      const plan = buildModelPlan(settings);
      llm = await callLlm(messages, {
        routerUrl: runtimeEnv.routerUrl,
        routerKey: runtimeEnv.routerKey,
        model: plan.model,
        fallbackModels: plan.fallbackModels,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        fallbackText: settings.fallback_text,
        llmContext,
      });
    } catch {
      llm = {
        ok: false,
        content: settings.fallback_text,
        model: null,
        attempts: 0,
        error: 'exception',
      };
    }

    let status: PipelineStatus = 'ok';
    let reply: string;
    if (!llm.ok) {
      status = 'error';
      usedFallback = true;
      reply = settings.fallback_text;
      flags.push('llm_fallback');
    } else {
      const sanitized = sanitizeOutput(llm.content, {
        systemPrompt,
        fallbackText: settings.fallback_text,
      });
      reply = sanitized.text;
      if (sanitized.leaked) {
        status = 'blocked';
        usedFallback = true;
        flags.push('output_leak');
      }
      if (sanitized.truncated) flags.push('truncated');
    }

    if (status === 'ok') {
      addMessage(input.senderId, 'user', guard.normalized, now);
      addMessage(input.senderId, 'assistant', reply, now);
    }
    return finish(status, reply, llm.model);
  });
}
