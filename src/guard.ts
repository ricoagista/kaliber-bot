import type { Settings } from './config.js';
import { isJidMuted, recordStrikeAndMaybeMute, type LogStatus } from './db.js';

export const MAX_PATTERNS = 50;
export const MAX_PATTERN_LEN = 300;
export const MAX_INJECTION_SCAN_CHARS = 2_000;

const ZERO_WIDTH_RE = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const CONFUSABLES_MAP: Record<string, string> = {
  '\u0430': 'a', // Cyrillic а
  '\u0410': 'a',
  '\u0435': 'e', // Cyrillic е
  '\u0415': 'e',
  '\u0456': 'i', // Cyrillic і
  '\u0406': 'i',
  '\u043E': 'o', // Cyrillic о
  '\u041E': 'o',
  '\u0440': 'p', // Cyrillic р
  '\u0420': 'p',
  '\u0441': 'c', // Cyrillic с
  '\u0421': 'c',
  '\u0443': 'y', // Cyrillic у
  '\u0423': 'y',
  '\u0445': 'x', // Cyrillic х
  '\u0425': 'x',
  '\u0455': 's', // Cyrillic ѕ
  '\u0405': 's',
  '\u03B1': 'a', // Greek α
  '\u0391': 'a',
  '\u03B5': 'e', // Greek ε
  '\u0395': 'e',
  '\u03B9': 'i', // Greek ι
  '\u0399': 'i',
  '\u03BF': 'o', // Greek ο
  '\u039F': 'o',
};

const CONFUSABLES_RE = new RegExp(`[${Object.keys(CONFUSABLES_MAP).join('')}]`, 'g');

export function normalizeText(input: string): string {
  if (!input) return '';
  return input
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function foldConfusables(input: string): string {
  if (!input) return '';
  const mapped = input.replace(CONFUSABLES_RE, (ch) => CONFUSABLES_MAP[ch] ?? ch);
  return mapped
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC');
}

export function squashPattern(pattern: string): string {
  return pattern
    .replace(/\\s[*+?]?/g, '')
    .replace(/\\b/g, '')
    .replace(/\s+/g, '');
}

function hasNestedQuantifier(pattern: string): boolean {
  // Deteksi grup (...) yang di dalamnya memiliki +, *, atau {2,} lalu diikuti +, *, atau {...}
  const stack: Array<{ hasRepeat: boolean }> = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') {
      stack.push({ hasRepeat: false });
    } else if (ch === ')') {
      const group = stack.pop();
      if (!group) continue;
      const next = pattern.slice(i + 1);
      const followedByRepeat = /^(?:\+|\*|\{\d+)/.test(next);
      if (group.hasRepeat && followedByRepeat) {
        return true;
      }
      if (stack.length > 0 && (group.hasRepeat || followedByRepeat)) {
        stack[stack.length - 1].hasRepeat = true;
      }
    } else if (stack.length > 0) {
      if (ch === '+' || ch === '*') {
        stack[stack.length - 1].hasRepeat = true;
      } else if (ch === '{') {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
        if (m) {
          const minVal = Number(m[1]);
          const maxVal = m[2] === undefined ? minVal : m[2] === '' ? Infinity : Number(m[2]);
          if (maxVal >= 2) {
            stack[stack.length - 1].hasRepeat = true;
          }
        }
      }
    }
  }
  return false;
}

export function isUnsafeRegex(pattern: string): boolean {
  if (typeof pattern !== 'string') return true;
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.length > MAX_PATTERN_LEN) return true;

  // Tolak backreference \[1-9]
  if (/\\[1-9]/.test(trimmed)) return true;

  // Tolak quantifier {m,n} dengan batas > 100
  const braceMatches = trimmed.matchAll(/\{(\d+)(?:,(\d*))?\}/g);
  for (const m of braceMatches) {
    const min = Number(m[1]);
    const max = m[2] !== undefined && m[2] !== '' ? Number(m[2]) : min;
    if (min > 100 || max > 100) return true;
    if (m[2] !== undefined && m[2] !== '' && max < min) return true;
  }

  // Tolak nested quantifier
  if (hasNestedQuantifier(trimmed)) return true;

  const probeStr = 'a'.repeat(28) + '!';
  try {
    const re = new RegExp(trimmed, 'i');
    const t0 = performance.now();
    re.test(probeStr);
    if (performance.now() - t0 > 25) return true;

    const sq = squashPattern(trimmed);
    if (sq) {
      const reSq = new RegExp(sq, 'i');
      const t1 = performance.now();
      reSq.test(probeStr);
      if (performance.now() - t1 > 25) return true;
    }
  } catch {
    return true;
  }

  return false;
}

export function invalidPatterns(patterns: string[]): string[] {
  if (!Array.isArray(patterns)) return ['Format daftar pola tidak valid'];
  if (patterns.length > MAX_PATTERNS) {
    return [`Maksimal ${MAX_PATTERNS} pola diperbolehkan`];
  }
  const bad: string[] = [];
  for (const p of patterns) {
    if (isUnsafeRegex(p)) {
      bad.push(p);
    }
  }
  return bad;
}

export interface CompiledPattern {
  raw: string;
  normalRe: RegExp;
  squashedRe: RegExp | null;
}

let cachedPatternKey = '';
let cachedCompiled: CompiledPattern[] = [];

export function compilePatterns(patterns: string[]): CompiledPattern[] {
  const cacheKey = JSON.stringify(patterns);
  if (cacheKey === cachedPatternKey) {
    return cachedCompiled;
  }
  const compiled: CompiledPattern[] = [];
  for (const raw of patterns.slice(0, MAX_PATTERNS)) {
    if (isUnsafeRegex(raw)) continue;
    try {
      const normalRe = new RegExp(raw, 'i');
      const sq = squashPattern(raw);
      const squashedRe = sq ? new RegExp(sq, 'i') : null;
      compiled.push({ raw, normalRe, squashedRe });
    } catch {
      // Abaikan pola yang gagal dikompilasi
    }
  }
  cachedPatternKey = cacheKey;
  cachedCompiled = compiled;
  return compiled;
}

export function matchesInjection(text: string, patterns: string[]): boolean {
  const bounded = normalizeText(text).slice(0, MAX_INJECTION_SCAN_CHARS);
  if (!bounded) return false;
  const folded = foldConfusables(bounded);
  const flat = folded.replace(/[\s._-]+/g, '');

  const compiled = compilePatterns(patterns);
  for (const item of compiled) {
    if (item.normalRe.test(bounded)) return true;
    if (item.normalRe.test(folded)) return true;
    if (flat && item.squashedRe && item.squashedRe.test(flat)) return true;
  }
  return false;
}

function extractPhoneDigits(jidOrPhone: string): string {
  const beforeAt = jidOrPhone.split('@')[0] ?? '';
  const beforeColon = beforeAt.split(':')[0] ?? '';
  const digits = beforeColon.replace(/\D+/g, '');
  if (digits.startsWith('0')) {
    return '62' + digits.slice(1);
  }
  return digits;
}

function jidMatchesList(senderJids: string[], list: string[]): boolean {
  if (!list || list.length === 0) return false;
  const normalizedList = list.map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (normalizedList.length === 0) return false;

  const listDigits = new Set(
    normalizedList.map((item) => extractPhoneDigits(item)).filter((d) => d.length >= 6)
  );

  for (const jid of senderJids) {
    const cleanJid = jid.trim().toLowerCase();
    if (!cleanJid) continue;
    if (normalizedList.includes(cleanJid)) return true;
    const digits = extractPhoneDigits(cleanJid);
    if (digits.length >= 6 && listDigits.has(digits)) return true;
  }
  return false;
}

const rateBuckets = new Map<string, number[]>();
const groupLast = new Map<string, number>();
const nonTextNotices = new Map<string, number>();

export function allowNonTextNotice(senderId: string, now = Date.now()): boolean {
  const last = nonTextNotices.get(senderId) ?? 0;
  if (now - last < 3600_000) {
    return false;
  }
  nonTextNotices.set(senderId, now);
  return true;
}

export interface GuardInput {
  text: string;
  senderId: string;
  altSenderIds?: string[];
  chatId: string;
  isGroup: boolean;
  bypassLimits?: boolean;
  settings: Settings;
  now?: number;
}

export interface GuardResult {
  allowed: boolean;
  normalized: string;
  status?: LogStatus;
  reply?: string | null;
  flags: string[];
}

export function checkGuard(input: GuardInput): GuardResult {
  const now = input.now ?? Date.now();
  const { settings, bypassLimits, isGroup, chatId } = input;
  const primary = input.senderId;
  const allSenderJids = Array.from(
    new Set([primary, ...(input.altSenderIds ?? [])].filter(Boolean))
  );

  const normalized = normalizeText(input.text);

  // 1. Blocklist
  if (!bypassLimits && jidMatchesList(allSenderJids, settings.blocklist)) {
    return {
      allowed: false,
      normalized,
      status: 'blocked',
      reply: null,
      flags: ['blocklist'],
    };
  }

  // 2. Mute
  if (!bypassLimits && isJidMuted(allSenderJids, now)) {
    return {
      allowed: false,
      normalized,
      status: 'blocked',
      reply: null,
      flags: ['muted'],
    };
  }

  // 3. Allowlist
  if (!bypassLimits && settings.allowlist_enabled) {
    if (!jidMatchesList(allSenderJids, settings.allowlist)) {
      return {
        allowed: false,
        normalized,
        status: 'blocked',
        reply: null,
        flags: ['allowlist'],
      };
    }
  }

  // 4. Batas Panjang Karakter
  if (normalized.length > settings.max_input_chars) {
    return {
      allowed: false,
      normalized,
      status: 'blocked',
      reply: `Pesannya kepanjangan, maksimal ${settings.max_input_chars} karakter ya 🙏`,
      flags: ['too_long'],
    };
  }

  // 5. Rate Limit Per Nomor (sliding window 60 detik)
  if (!bypassLimits) {
    const cutoff = now - 60_000;
    const prev = (rateBuckets.get(primary) ?? []).filter((ts) => ts > cutoff);
    if (prev.length >= settings.rate_limit_per_min) {
      rateBuckets.set(primary, prev);
      return {
        allowed: false,
        normalized,
        status: 'ratelimit',
        reply: null,
        flags: ['rate_limit'],
      };
    }
    prev.push(now);
    rateBuckets.set(primary, prev);
  }

  // 6. Group Cooldown
  if (isGroup && !bypassLimits && settings.group_cooldown_sec > 0) {
    const last = groupLast.get(chatId) ?? 0;
    if (now - last < settings.group_cooldown_sec * 1000) {
      return {
        allowed: false,
        normalized,
        status: 'ratelimit',
        reply: null,
        flags: ['group_cooldown'],
      };
    }
    groupLast.set(chatId, now);
  }

  // 7. Deteksi Prompt Injection
  if (matchesInjection(normalized, settings.injection_patterns)) {
    const flags: string[] = ['injection'];
    if (!bypassLimits) {
      const strikeRes = recordStrikeAndMaybeMute(
        primary,
        now,
        settings.strike_window_min,
        settings.strike_limit,
        settings.mute_minutes
      );
      flags.push(`strike:${strikeRes.count}`);
      if (strikeRes.muted) {
        flags.push('muted_after_strikes');
      }
    }
    return {
      allowed: false,
      normalized,
      status: 'injection',
      reply: settings.refusal_text,
      flags,
    };
  }

  return {
    allowed: true,
    normalized,
    flags: [],
  };
}
