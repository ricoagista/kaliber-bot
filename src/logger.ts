import pino from 'pino';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'authorization',
  'headers.authorization',
  'ADMIN_TOKEN',
  'ROUTER_KEY',
  'token',
  'apiKey',
];

/**
 * Logger tunggal untuk bot dan Baileys. Level `warn` agar tidak berisik dan
 * hemat CPU di STB, dengan redaksi rahasia.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || 'warn',
  redact: {
    paths: redactPaths,
    censor: '[redacted]',
  },
});

/** Samarkan nomor: sisakan 4 digit awal dan 4 digit akhir. */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 8) return '****';
  return `${digits.slice(0, 4)}****${digits.slice(-4)}`;
}

/** Samarkan JID chat; grup dipertahankan bentuknya tanpa nomor anggota. */
export function maskChatId(jid: string): string {
  if (jid.endsWith('@g.us')) {
    const digits = jid.split('@')[0]?.replace(/\D/g, '') ?? '';
    return `grup-${digits.slice(-4) || '****'}@g.us`;
  }
  return maskPhone(jid);
}
