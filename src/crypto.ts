import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;

/**
 * Format v2 menyimpan IV+tag+ciphertext dengan kunci turunan tetap (KEK).
 * Format lama menyimpan salt acak per record sehingga scrypt harus dijalankan
 * setiap kali dekripsi; record lama dimigrasikan sekali saat start.
 */
const V2_PREFIX = 'v2:';
const KEK_SALT = Buffer.from('kaliber-bot/kek/v2', 'utf8');

const MAX_CACHED_KEYS = 200;

let secretKey: string | null = null;
let derivedKek: Buffer | null = null;
let revealPasswordHash: string | null = null;
const decryptedKeys = new Map<number, string>();

/** Set SECRET_KEY dari env (dipanggil sekali di index.ts). */
export function setSecretKey(key: string): void {
  if (key !== secretKey) {
    derivedKek = null;
    decryptedKeys.clear();
  }
  secretKey = key;
}

export function getSecretKey(): string | null {
  return secretKey;
}

/** Turunkan KEK sekali per proses (scrypt mahal, jangan per pesan). */
function getKek(): Buffer {
  if (!secretKey) throw new Error('SECRET_KEY tidak diatur');
  if (!derivedKek) {
    derivedKek = scryptSync(secretKey, KEK_SALT, KEY_LENGTH);
  }
  return derivedKek;
}

/** Enkripsi API key dengan AES-256-GCM, IV acak per key (format v2). */
export function encryptKey(plaintext: string): string {
  const key = getKek();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return V2_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptV2(body: string): string {
  const data = Buffer.from(body, 'base64');
  if (data.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('encrypted key rusak');
  }
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encryptedData = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, getKek(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8');
}

/** Format lama: base64(salt | iv | tag | ciphertext), salt 16 byte. */
function decryptLegacy(encrypted: string): string {
  if (!secretKey) throw new Error('SECRET_KEY tidak diatur');
  const data = Buffer.from(encrypted, 'base64');
  if (data.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('encrypted key rusak');
  }
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encryptedData = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const key = scryptSync(secretKey, salt, KEY_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8');
}

/** Dekripsi API key; mendukung format v2 maupun format lama. */
export function decryptKey(encrypted: string): string {
  if (!secretKey) throw new Error('SECRET_KEY tidak diatur');
  if (encrypted.startsWith(V2_PREFIX)) return decryptV2(encrypted.slice(V2_PREFIX.length));
  return decryptLegacy(encrypted);
}

export function isLegacyEncrypted(encrypted: string): boolean {
  return !encrypted.startsWith(V2_PREFIX);
}

function rememberKey(keyId: number, plaintext: string): void {
  if (decryptedKeys.size >= MAX_CACHED_KEYS && !decryptedKeys.has(keyId)) {
    const oldest = decryptedKeys.keys().next();
    if (!oldest.done) decryptedKeys.delete(oldest.value);
  }
  decryptedKeys.set(keyId, plaintext);
}

/**
 * Dekripsi dengan cache per key id. Dipakai jalur pesan agar tidak ada kerja
 * kripto berulang; cache dibuang saat key diubah/dihapus.
 */
export function decryptKeyCached(keyId: number, encrypted: string): string {
  const cached = decryptedKeys.get(keyId);
  if (cached !== undefined) return cached;
  const plaintext = decryptKey(encrypted);
  rememberKey(keyId, plaintext);
  return plaintext;
}

/** Invalidasi cache dekripsi (tanpa argumen: semua). */
export function invalidateKeyCache(keyId?: number): void {
  if (keyId === undefined) {
    decryptedKeys.clear();
  } else {
    decryptedKeys.delete(keyId);
  }
}

/** Mask key: `gsk_••••ab12`. */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export function keyLast4(key: string): string {
  return key.slice(-4);
}

/** Hash password reveal dengan scrypt (salt:hash dalam base64). */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

/** Bandingkan constant-time; batasi panjang password agar scrypt tidak membebani CPU. */
export function verifyPassword(password: string, stored: string): boolean {
  if (!password || password.length > 256) return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  try {
    const salt = Buffer.from(parts[0]!, 'base64');
    const expected = Buffer.from(parts[1]!, 'base64');
    if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
    const actual = scryptSync(password, salt, KEY_LENGTH);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Password reveal hanya berasal dari env (REVEAL_PASSWORD) dan disimpan sebagai
 * hash di memori. Tidak pernah masuk SQLite atau respons web.
 */
export function setRevealPassword(password: string): void {
  revealPasswordHash = password ? hashPassword(password) : null;
}

export function hasRevealPassword(): boolean {
  return revealPasswordHash !== null;
}

export function verifyRevealPassword(password: string): boolean {
  return revealPasswordHash !== null && verifyPassword(password, revealPasswordHash);
}
