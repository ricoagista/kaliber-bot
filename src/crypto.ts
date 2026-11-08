import crypto from 'node:crypto';
import { getDb } from './db.js';
import { logger } from './logger.js';

const KEK_SALT = 'kaliber-bot/kek/v2';
const LEGACY_SALT = 'kaliber-bot-salt';
const MAX_CACHE_ENTRIES = 200;

let derivedKek: Buffer | null = null;
let rawSecretKey = '';

let revealSalt: Buffer | null = null;
let revealHash: Buffer | null = null;

const decryptedKeys = new Map<number, string>();

export function setSecretKey(secretKey: string): void {
  if (!secretKey || secretKey.length < 32) {
    throw new Error('SECRET_KEY minimal 32 karakter.');
  }
  rawSecretKey = secretKey;
  derivedKek = crypto.scryptSync(secretKey, KEK_SALT, 32);
  decryptedKeys.clear();
}

function getKek(): Buffer {
  if (!derivedKek) {
    throw new Error('KEK belum diinisialisasi. Panggil setSecretKey() terlebih dahulu.');
  }
  return derivedKek;
}

export function setRevealPassword(password: string): void {
  if (!password) {
    revealSalt = null;
    revealHash = null;
    return;
  }
  if (password.length < 12) {
    throw new Error('REVEAL_PASSWORD minimal 12 karakter.');
  }
  const salt = crypto.randomBytes(16);
  revealSalt = salt;
  revealHash = crypto.scryptSync(password.slice(0, 256), salt, 32);
}

export function hasRevealPassword(): boolean {
  return revealSalt !== null && revealHash !== null;
}

export function verifyRevealPassword(password: string): boolean {
  if (!revealSalt || !revealHash) return false;
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
    return false;
  }
  const candidate = crypto.scryptSync(password, revealSalt, 32);
  return crypto.timingSafeEqual(candidate, revealHash);
}

export function encryptApiKey(plainKey: string): string {
  const kek = getKek();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const encrypted = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return `v2:${packed.toString('base64')}`;
}

function decryptV2(payloadBase64: string): string {
  const kek = getKek();
  const buf = Buffer.from(payloadBase64, 'base64');
  if (buf.length < 28) {
    throw new Error('Ciphertext v2 tidak valid.');
  }
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

function decryptLegacy(ciphertext: string): string {
  // Mendukung format legacy ivHex:authTagHex:cipherHex atau base64(iv||tag||cipher) tanpa prefix v2:
  const parts = ciphertext.split(':');
  if (parts.length === 3) {
    const [ivPart, tagPart, encPart] = parts;
    const isHex = /^[0-9a-fA-F]+$/.test(ivPart) && ivPart.length === 24;
    const iv = Buffer.from(ivPart, isHex ? 'hex' : 'base64');
    const authTag = Buffer.from(tagPart, isHex ? 'hex' : 'base64');
    const data = Buffer.from(encPart, isHex ? 'hex' : 'base64');

    for (const keyCandidate of [
      getKek(),
      crypto.scryptSync(rawSecretKey, LEGACY_SALT, 32),
      crypto.createHash('sha256').update(rawSecretKey).digest(),
    ]) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyCandidate, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        // Coba kandidat KEK legacy berikutnya
      }
    }
  }
  return decryptV2(ciphertext);
}

export function decryptCiphertext(encrypted: string): string {
  if (encrypted.startsWith('v2:')) {
    return decryptV2(encrypted.slice(3));
  }
  return decryptLegacy(encrypted);
}

export function decryptKeyRow(keyId: number, encrypted: string): string {
  const cached = decryptedKeys.get(keyId);
  if (cached !== undefined) {
    return cached;
  }
  const plain = decryptCiphertext(encrypted);
  if (decryptedKeys.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = decryptedKeys.keys().next().value;
    if (oldestKey !== undefined) {
      decryptedKeys.delete(oldestKey);
    }
  }
  decryptedKeys.set(keyId, plain);
  return plain;
}

export function invalidateKeyCache(keyId?: number): void {
  if (keyId === undefined) {
    decryptedKeys.clear();
  } else {
    decryptedKeys.delete(keyId);
  }
}

export function maskLast4(plainKey: string): string {
  const trimmed = plainKey.trim();
  if (trimmed.length <= 4) return trimmed;
  return trimmed.slice(-4);
}

export function prepareKeyStore(): void {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, key_encrypted FROM provider_keys')
    .all() as Array<{ id: number; key_encrypted: string }>;

  const updateStmt = db.prepare('UPDATE provider_keys SET key_encrypted = ? WHERE id = ?');

  for (const row of rows) {
    try {
      const plain = decryptCiphertext(row.key_encrypted);
      if (!row.key_encrypted.startsWith('v2:')) {
        const reencrypted = encryptApiKey(plain);
        updateStmt.run(reencrypted, row.id);
      }
      if (decryptedKeys.size < MAX_CACHE_ENTRIES) {
        decryptedKeys.set(row.id, plain);
      }
    } catch (err) {
      logger.warn({ keyId: row.id, err }, 'Gagal mendekripsi atau memigrasi API key saat startup');
    }
  }
}
