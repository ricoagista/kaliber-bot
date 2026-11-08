import { insertLog, markMessageSeen, type LogStatus } from './db.js';
import { allowNonTextNotice, checkGuard } from './guard.js';
import { callLlm } from './llm.js';
import { addMessage, getHistory } from './memory.js';
import { buildMessages } from './prompt.js';
import { defaultQueue } from './queue.js';
import { sanitizeOutput } from './sanitize.js';
import { getSettings } from './settings.js';

export type PipelineStatus =
  | 'ok'
  | 'blocked'
  | 'injection'
  | 'ratelimit'
  | 'error'
  | 'ignored'
  | 'disabled';

export interface IncomingMessage {
  messageId?: string;
  chatId: string;
  senderId: string;
  altSenderIds?: string[];
  text: string;
  isGroup?: boolean;
  isMentioned?: boolean;
  hasMedia?: boolean;
  fromMe?: boolean;
  isStatus?: boolean;
  timestampMs?: number;
}

export interface PipelineResult {
  reply: string | null;
  meta: {
    status: PipelineStatus;
    flags: string[];
    model: string | null;
    latencyMs: number;
  };
}

const MAX_MESSAGE_AGE_MS = 60_000;

export async function handleMessage(msg: IncomingMessage): Promise<PipelineResult> {
  const startTime = Date.now();
  const isAdminTest = msg.chatId === 'admin-test';
  const isGroup = Boolean(msg.isGroup);

  // 1. Filter Kelayakan
  if (
    msg.fromMe ||
    msg.isStatus ||
    msg.chatId.endsWith('@broadcast') ||
    msg.chatId.endsWith('@newsletter')
  ) {
    return {
      reply: null,
      meta: { status: 'ignored', flags: ['ineligible'], model: null, latencyMs: 0 },
    };
  }

  if (msg.timestampMs && startTime - msg.timestampMs > MAX_MESSAGE_AGE_MS) {
    return {
      reply: null,
      meta: { status: 'ignored', flags: ['stale'], model: null, latencyMs: 0 },
    };
  }

  if (msg.messageId && markMessageSeen(msg.messageId, startTime)) {
    return {
      reply: null,
      meta: { status: 'ignored', flags: ['duplicate'], model: null, latencyMs: 0 },
    };
  }

  let workingText = (msg.text ?? '').trim();

  // 2. Apakah teks kosong?
  if (!workingText) {
    if (msg.hasMedia) {
      if (allowNonTextNotice(msg.senderId, startTime)) {
        const reply = 'Aku cuma bisa membaca teks ya 🙏';
        const latencyMs = Date.now() - startTime;
        insertLog({
          ts: startTime,
          chatId: msg.chatId,
          message: '[media]',
          reply,
          status: 'blocked',
          latencyMs,
          model: null,
        });
        return {
          reply,
          meta: { status: 'blocked', flags: ['non_text'], model: null, latencyMs },
        };
      }
    }
    return {
      reply: null,
      meta: { status: 'ignored', flags: ['empty'], model: null, latencyMs: 0 },
    };
  }

  const settings = getSettings();

  // 3. Cek Saklar Bot
  if (!isAdminTest) {
    if (!settings.bot_enabled) {
      return {
        reply: null,
        meta: { status: 'disabled', flags: ['bot_disabled'], model: null, latencyMs: 0 },
      };
    }
    if (isGroup && !settings.group_enabled) {
      return {
        reply: null,
        meta: { status: 'disabled', flags: ['group_disabled'], model: null, latencyMs: 0 },
      };
    }
    if (!isGroup && !settings.private_enabled) {
      return {
        reply: null,
        meta: { status: 'disabled', flags: ['private_disabled'], model: null, latencyMs: 0 },
      };
    }
  }

  // 4. Filter Grup
  if (isGroup && !isAdminTest) {
    const allowedGroups = settings.allowed_groups
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean);
    if (!allowedGroups.includes(msg.chatId.trim().toLowerCase())) {
      return {
        reply: null,
        meta: { status: 'ignored', flags: ['group_not_allowed'], model: null, latencyMs: 0 },
      };
    }

    const prefix = (settings.trigger_prefix ?? '!kaliber').trim();
    const lowerText = workingText.toLowerCase();
    const isStaticCmd = lowerText === '!info' || lowerText === '!help';
    const hasPrefix = prefix.length > 0 && lowerText.startsWith(prefix.toLowerCase());

    if (!msg.isMentioned && !hasPrefix && !isStaticCmd) {
      return {
        reply: null,
        meta: { status: 'ignored', flags: ['no_group_trigger'], model: null, latencyMs: 0 },
      };
    }

    if (hasPrefix && !isStaticCmd) {
      workingText = workingText.slice(prefix.length).trim();
    }
    // Hapus @mention (@angka) dari teks
    workingText = workingText.replace(/@\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!workingText) {
      return {
        reply: null,
        meta: { status: 'ignored', flags: ['empty_after_strip'], model: null, latencyMs: 0 },
      };
    }
  }

  // 5. Jalankan checkGuard()
  const guard = checkGuard({
    text: workingText,
    senderId: msg.senderId,
    altSenderIds: msg.altSenderIds,
    chatId: msg.chatId,
    isGroup,
    bypassLimits: isAdminTest,
    settings,
    now: startTime,
  });

  if (!guard.allowed) {
    const latencyMs = Date.now() - startTime;
    const logStatus: LogStatus = guard.status ?? 'blocked';
    insertLog({
      ts: startTime,
      chatId: msg.chatId,
      message: guard.normalized || workingText,
      reply: guard.reply ?? null,
      status: logStatus,
      latencyMs,
      model: null,
    });
    return {
      reply: guard.reply ?? null,
      meta: {
        status: logStatus,
        flags: guard.flags,
        model: null,
        latencyMs,
      },
    };
  }

  const normalized = guard.normalized;
  const lowerNorm = normalized.toLowerCase();

  // Perintah statis !info dan !help
  if (lowerNorm === '!info' || lowerNorm === '!help') {
    const reply = lowerNorm === '!info' ? settings.info_text : settings.help_text;
    const latencyMs = Date.now() - startTime;
    insertLog({
      ts: startTime,
      chatId: msg.chatId,
      message: normalized,
      reply,
      status: 'ok',
      latencyMs,
      model: 'static',
    });
    return {
      reply,
      meta: {
        status: 'ok',
        flags: ['static_command'],
        model: 'static',
        latencyMs,
      },
    };
  }

  // 6. Masuk Antrean (serial per pengirim, konkurensi global maks 2)
  return defaultQueue.run(msg.senderId, async () => {
    const currentSettings = getSettings();
    const now = Date.now();

    // 7. Susun Prompt
    const history = getHistory(msg.senderId, currentSettings.history_turns, now);
    const { systemPrompt, messages } = buildMessages(currentSettings, history, normalized, now);

    // 8. Panggil LLM
    const llm = await callLlm(messages, currentSettings);
    if (!llm.ok) {
      const latencyMs = Date.now() - startTime;
      const reply = currentSettings.fallback_text;
      insertLog({
        ts: startTime,
        chatId: msg.chatId,
        message: normalized,
        reply,
        status: 'error',
        latencyMs,
        model: llm.model,
      });
      return {
        reply,
        meta: {
          status: 'error',
          flags: ['llm_error'],
          model: llm.model,
          latencyMs,
        },
      };
    }

    // 9. Sanitasi Output
    const sanitized = sanitizeOutput(llm.reply, systemPrompt, currentSettings.fallback_text);
    const latencyMs = Date.now() - startTime;

    if (sanitized.leaked) {
      insertLog({
        ts: startTime,
        chatId: msg.chatId,
        message: normalized,
        reply: sanitized.text,
        status: 'blocked',
        latencyMs,
        model: llm.model,
      });
      return {
        reply: sanitized.text,
        meta: {
          status: 'blocked',
          flags: ['output_leak'],
          model: llm.model,
          latencyMs,
        },
      };
    }

    // 10. Simpan Memori & Log
    addMessage(msg.senderId, 'user', normalized, now);
    addMessage(msg.senderId, 'assistant', sanitized.text, Date.now());
    insertLog({
      ts: startTime,
      chatId: msg.chatId,
      message: normalized,
      reply: sanitized.text,
      status: 'ok',
      latencyMs,
      model: llm.model,
    });

    return {
      reply: sanitized.text,
      meta: {
        status: 'ok',
        flags: [],
        model: llm.model,
        latencyMs,
      },
    };
  });
}
