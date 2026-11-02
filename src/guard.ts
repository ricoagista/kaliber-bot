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

/** Normalisasi Unicode dan buang karakter tak terlihat/kontrol. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function digitsOf(raw: string): string {
  return raw.replace(/\D/g, '');
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
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    try {
      regexes.push(new RegExp(raw, 'i'));
      // Varian tanpa spasi menangkap serangan "a b a i k a n".
      squashed.push(new RegExp(raw.replace(/\\s[*+?]?/g, ''), 'i'));
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
  if (regexes.some((re) => re.test(text))) return true;
  const flat = text.replace(/\s+/g, '');
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

function rateAllowed(key: string, now: number, limit: number): boolean {
  const bucket = (rateBuckets.get(key) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
  rateBuckets.set(key, bucket);
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
  }
  return true;
}

/** Hanya untuk test: kosongkan state rate limit/cooldown di memori. */
export function resetGuardState(): void {
  rateBuckets.clear();
  groupLast.clear();
  nonTextNotices.clear();
}
