import type { Settings } from './config.js';
import { getDb } from './db.js';

export type GuardStatus = 'ok' | 'blocked' | 'injection' | 'ratelimit';

export interface GuardInput {
  /** Identitas pengirim (JID utama, LID, dan nomor PN bila ada). */
  senderJids: string[];
  chatJid: string;
  isGroup: boolean;
  text: string;
  now: number;
  settings: Settings;
  /** Untuk /api/test: lewati rate limit, mute, allowlist, dan strike. */
  bypassLimits?: boolean;
}

export interface GuardResult {
  ok: boolean;
  status: GuardStatus;
  reply: string | null;
  flags: string[];
  normalized: string;
}

const rateBuckets = new Map<string, number[]>();
const groupLast = new Map<string, number>();
const nonTextNotices = new Map<string, number>();
const patternCache = new Map<string, CompileResult>();

const RATE_WINDOW_MS = 60_000;
const NON_TEXT_WINDOW_MS = 60 * 60 * 1000;
const MAX_PATTERN_LEN = 300;
const MAX_PATTERNS = 50;
const MAX_INJECTION_SCAN_CHARS = 2_000;

const HOMOGLYPH_MAP: Record<string, string> = {
  '\u0430': 'a', '\u0410': 'a', // Cyrillic a
  '\u0435': 'e', '\u0415': 'e', // Cyrillic e
  '\u0456': 'i', '\u0406': 'i', // Cyrillic i
  '\u043E': 'o', '\u041E': 'o', // Cyrillic o
  '\u0440': 'p', '\u0420': 'p', // Cyrillic r/p
  '\u0441': 'c', '\u0421': 'c', // Cyrillic s/c
  '\u0443': 'y', '\u0423': 'y', // Cyrillic u/y
  '\u0445': 'x', '\u0425': 'x', // Cyrillic kh/x
  '\u0455': 's', '\u0405': 's', // Cyrillic dze/s
  '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BF': 'o', // Greek
};

/** Normalisasi Unicode dan buang karakter tak terlihat/kontrol. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function foldConfusables(input: string): string {
  return input
    .replace(/[\u0410-\u045F\u0391-\u03C9]/g, (ch) => HOMOGLYPH_MAP[ch] ?? ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC');
}

export function digitsOf(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Deteksi pola regex yang berisiko ReDoS (nested quantifier, backreference,
 * batas quantifier berlebih, atau terlalu panjang).
 */
export function isUnsafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LEN) return true;
  // Backreference seperti \1 berisiko eksponensial di engine NFA.
  if (/\\[1-9]/.test(pattern)) return true;
  // Batas quantifier terlalu besar (> 100).
  const bounds = pattern.matchAll(/\{\s*(\d+)(?:\s*,\s*(\d*))?\s*\}/g);
  for (const match of bounds) {
    const low = Number(match[1] ?? 0);
    const high = match[2] ? Number(match[2]) : low;
    if (low > 100 || high > 100) return true;
  }
  // Deteksi grup yang memuat quantifier tak terbatas/berulang lalu diikuti quantifier lagi: (a+)+, (.*a){2,}, dll.
  let depth = 0;
  const groupHasRepetition: boolean[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      while (i + 1 < pattern.length && pattern[i + 1] !== ']') {
        if (pattern[i + 1] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(') {
      depth += 1;
      groupHasRepetition[depth] = false;
      continue;
    }
    if (ch === ')' && depth > 0) {
      const hadRep = Boolean(groupHasRepetition[depth]);
      depth -= 1;
      if (hadRep && depth > 0) groupHasRepetition[depth] = true;
      const next = pattern.slice(i + 1);
      if (hadRep && /^(?:[*+]|{\s*\d+\s*,\s*\d*\s*}|{\s*(?:[2-9]|\d{2,})\s*})/.test(next)) {
        return true;
      }
      continue;
    }
    if (depth > 0 && (ch === '+' || ch === '*')) {
      groupHasRepetition[depth] = true;
    } else if (depth > 0 && ch === '{') {
      const rest = pattern.slice(i);
      if (/^\{\s*\d+\s*,\s*\d*\s*\}/.test(rest) || /^\{\s*(?:[2-9]|\d{2,})\s*\}/.test(rest)) {
        groupHasRepetition[depth] = true;
      }
    }
  }
  return false;
}

function toSquashedRegexSource(raw: string): string {
  // Hapus \s, \b, dan spasi literal di luar character class agar menangkap "a b a i k a n" / "k.a.m.u".
  let out = raw.replace(/\\s[*+?]?/g, '').replace(/\\b/g, '');
  let inClass = false;
  let cleaned = '';
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!;
    if (ch === '\\') {
      cleaned += ch + (out[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    if (!inClass && ch === ' ') continue;
    cleaned += ch;
  }
  return cleaned;
}

interface CompileResult {
  regexes: RegExp[];
  squashed: RegExp[];
  invalid: string[];
}

export function compilePatterns(patterns: string[]): CompileResult {
  const key = JSON.stringify(patterns);
  const cached = patternCache.get(key);
  if (cached) return cached;

  const regexes: RegExp[] = [];
  const squashed: RegExp[] = [];
  const invalid: string[] = [];
  const slice = patterns.slice(0, MAX_PATTERNS);
  if (patterns.length > MAX_PATTERNS) {
    invalid.push('terlalu banyak pola regex');
  }
  for (const raw of slice) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (isUnsafeRegex(raw)) {
      invalid.push(raw);
      continue;
    }
    try {
      const re = new RegExp(raw, 'i');
      const sq = new RegExp(toSquashedRegexSource(raw), 'i');
      // Uji cepat terhadap string adversarial pendek untuk mencegah backtracking lambat.
      const t0 = performance.now();
      re.test(`${'a'.repeat(28)}!`);
      sq.test(`${'a'.repeat(28)}!`);
      if (performance.now() - t0 > 25) {
        invalid.push(raw);
        continue;
      }
      regexes.push(re);
      squashed.push(sq);
    } catch {
      invalid.push(raw);
    }
  }
  const result = { regexes, squashed, invalid };
  if (patternCache.size > 20) patternCache.clear();
  patternCache.set(key, result);
  return result;
}

/** Kembalikan daftar pola yang tidak valid (dipakai API sebelum menyimpan). */
export function invalidPatterns(patterns: string[]): string[] {
  return compilePatterns(patterns).invalid;
}

export function matchesInjection(text: string, patterns: string[]): boolean {
  const { regexes, squashed } = compilePatterns(patterns);
  if (regexes.length === 0) return false;
  const bounded = normalizeText(text).slice(0, MAX_INJECTION_SCAN_CHARS);
  const folded = foldConfusables(bounded);
  if (regexes.some((re) => re.test(bounded) || re.test(folded))) return true;
  const flat = folded.replace(/[\s._-]+/g, '');
  return squashed.some((re) => re.test(flat));
}

function anyMatch(list: string[], jids: string[], phones: Set<string>): boolean {
  for (const entry of list) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const entryDigits = digitsOf(trimmed);
    if (entryDigits && phones.has(entryDigits)) return true;
    if (jids.some((jid) => jid === trimmed)) return true;
  }
  return false;
}

function isMuted(jids: string[], now: number): boolean {
  const db = getDb();
  const stmt = db.prepare('SELECT until FROM mutes WHERE jid = ?');
  for (const jid of jids) {
    const row = stmt.get(jid) as { until: number } | undefined;
    if (row && Number(row.until) > now) return true;
  }
  return false;
}

function capMap<K, V>(map: Map<K, V>, max = 2000): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function rateAllowed(key: string, now: number, limit: number): boolean {
  const bucket = (rateBuckets.get(key) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (bucket.length === 0) {
    rateBuckets.delete(key);
  } else {
    rateBuckets.set(key, bucket);
  }
  return bucket.length < limit;
}

function commitRate(key: string, now: number): void {
  const bucket = rateBuckets.get(key) ?? [];
  bucket.push(now);
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 2000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((ts) => now - ts >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
    capMap(rateBuckets, 2000);
  }
}

/** Catat strike; kembalikan jumlah strike dan waktu mute bila ambang tercapai. */
export function registerStrike(
  jid: string,
  now: number,
  settings: Settings,
): { count: number; mutedUntil: number | null } {
  const db = getDb();
  const windowStart = now - settings.strike_window_min * 60_000;
  db.prepare('DELETE FROM strikes WHERE jid = ? AND ts < ?').run(jid, windowStart);
  db.prepare('INSERT INTO strikes (jid, ts) VALUES (?, ?)').run(jid, now);
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM strikes WHERE jid = ? AND ts >= ?')
    .get(jid, windowStart) as { n: number } | undefined;
  const count = Number(row?.n ?? 0);

  if (count >= Math.max(1, settings.strike_limit)) {
    const until = now + settings.mute_minutes * 60_000;
    db.prepare(
      'INSERT INTO mutes (jid, until) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET until = excluded.until',
    ).run(jid, until);
    db.prepare('DELETE FROM strikes WHERE jid = ?').run(jid);
    return { count, mutedUntil: until };
  }
  return { count, mutedUntil: null };
}

export function isMutedNow(jid: string, now: number = Date.now()): boolean {
  const row = getDb().prepare('SELECT until FROM mutes WHERE jid = ?').get(jid) as
    | { until: number }
    | undefined;
  return Boolean(row && Number(row.until) > now);
}

/** Cek guard lengkap. Urutan: blocklist -> mute -> allowlist -> panjang -> rate -> cooldown -> injeksi. */
export function checkGuard(input: GuardInput): GuardResult {
  const { settings, now, normalized, bypassLimits } = {
    ...input,
    normalized: normalizeText(input.text),
  };
  const jids = input.senderJids.filter(Boolean);
  if (jids.length === 0) jids.push(input.chatJid);
  const primary = jids[0]!;
  const phones = new Set(jids.map(digitsOf).filter(Boolean));

  if (!bypassLimits) {
    if (anyMatch(settings.blocklist, jids, phones)) {
      return { ok: false, status: 'blocked', reply: null, flags: ['blocklist'], normalized };
    }
    if (isMuted(jids, now)) {
      return { ok: false, status: 'blocked', reply: null, flags: ['muted'], normalized };
    }
    if (settings.allowlist_enabled && !anyMatch(settings.allowlist, jids, phones)) {
      return { ok: false, status: 'blocked', reply: null, flags: ['allowlist'], normalized };
    }
  }

  const maxChars = Math.max(1, settings.max_input_chars);
  if (normalized.length > maxChars) {
    return {
      ok: false,
      status: 'blocked',
      reply: `Pesannya kepanjangan, maksimal ${maxChars} karakter ya 🙏`,
      flags: ['too_long'],
      normalized,
    };
  }

  if (!bypassLimits) {
    const limit = Math.max(1, settings.rate_limit_per_min);
    const key = primary;
    if (!rateAllowed(key, now, limit)) {
      return { ok: false, status: 'ratelimit', reply: null, flags: ['rate_limit'], normalized };
    }
    if (input.isGroup) {
      const cooldownMs = Math.max(0, settings.group_cooldown_sec) * 1000;
      const last = groupLast.get(input.chatJid) ?? 0;
      if (cooldownMs > 0 && now - last < cooldownMs) {
        return { ok: false, status: 'ratelimit', reply: null, flags: ['group_cooldown'], normalized };
      }
      groupLast.set(input.chatJid, now);
      if (groupLast.size > 2000) {
        for (const [k, ts] of groupLast) {
          if (now - ts >= Math.max(cooldownMs, RATE_WINDOW_MS)) groupLast.delete(k);
        }
        capMap(groupLast, 2000);
      }
    }
    commitRate(key, now);
  }

  if (matchesInjection(normalized, settings.injection_patterns)) {
    const flags = ['injection'];
    if (!bypassLimits) {
      const strike = registerStrike(primary, now, settings);
      flags.push(`strike:${strike.count}`);
      if (strike.mutedUntil !== null) flags.push('muted_after_strikes');
    }
    return { ok: false, status: 'injection', reply: settings.refusal_text, flags, normalized };
  }

  return { ok: true, status: 'ok', reply: null, flags: [], normalized };
}

/** Notifikasi "cuma bisa membaca teks" maksimal sekali per nomor per jam. */
export function allowNonTextNotice(jid: string, now: number = Date.now()): boolean {
  const last = nonTextNotices.get(jid);
  if (last !== undefined && now - last < NON_TEXT_WINDOW_MS) return false;
  nonTextNotices.set(jid, now);
  if (nonTextNotices.size > 2000) {
    for (const [key, ts] of nonTextNotices) {
      if (now - ts >= NON_TEXT_WINDOW_MS) nonTextNotices.delete(key);
    }
    capMap(nonTextNotices, 2000);
  }
  return true;
}

/** Hanya untuk test: kosongkan state rate limit/cooldown di memori. */
export function resetGuardState(): void {
  rateBuckets.clear();
  groupLast.clear();
  nonTextNotices.clear();
}
