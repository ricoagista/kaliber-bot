import { mkdirSync, rmSync } from 'node:fs';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  extractMessageContent,
  getContentType,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type AuthenticationCreds,
  type ConnectionState,
  type WAMessage,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import type { WaControl, WaSnapshot } from './api.js';
import { handleMessage } from './pipeline.js';
import { logger, maskPhone } from './logger.js';

const MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'ptvMessage',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function disconnectCode(error: unknown): number | undefined {
  const err = error as { output?: { statusCode?: number }; statusCode?: number } | undefined;
  return err?.output?.statusCode ?? err?.statusCode;
}

function normalizedIdentity(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const jid = raw.includes('@') ? raw : `${raw}@s.whatsapp.net`;
  try {
    return jidNormalizedUser(jid);
  } catch {
    return null;
  }
}

function textFromContent(content: proto.IMessage, type: keyof proto.IMessage | undefined): string | null {
  switch (type) {
    case 'conversation':
      return content.conversation ?? null;
    case 'extendedTextMessage':
      return content.extendedTextMessage?.text ?? null;
    case 'imageMessage':
      return content.imageMessage?.caption ?? null;
    case 'videoMessage':
      return content.videoMessage?.caption ?? null;
    case 'documentMessage':
      return content.documentMessage?.caption ?? null;
    default:
      return null;
  }
}

function contextOf(
  content: proto.IMessage,
  type: keyof proto.IMessage | undefined,
): proto.IContextInfo | undefined {
  const node = type ? (content[type] as { contextInfo?: proto.IContextInfo } | undefined) : undefined;
  return node?.contextInfo ?? (content as { contextInfo?: proto.IContextInfo }).contextInfo;
}

/**
 * Pengelola koneksi WhatsApp. Reconnect dengan backoff kecuali sesi logged out.
 * Semua pengiriman dilakukan setelah pipeline menghasilkan teks.
 */
export class WaBot implements WaControl {
  private sock: WASocket | null = null;
  private connections: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private state: WaSnapshot['state'] = 'disconnected';
  private qrRaw: string | null = null;
  private qrDataUrl: string | null = null;
  private pairingCode: string | null = null;
  private me: string | null = null;
  private lastError: string | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private loggedOut = false;
  private loggingOut = false;
  private creds: AuthenticationCreds | null = null;

  constructor(
    private readonly authDir: string,
    private readonly onMessage: typeof handleMessage = handleMessage,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    if (sock) void sock.end(undefined).catch(() => undefined);
  }

  async snapshot(): Promise<WaSnapshot> {
    return {
      state: this.state,
      qrDataUrl: this.qrDataUrl,
      pairingCode: this.pairingCode,
      me: this.me,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  async requestPairing(phone: string): Promise<string> {
    if (this.state === 'open') throw new Error('WhatsApp sudah terhubung');
    if (this.creds?.registered) {
      throw new Error('Sesi WhatsApp sudah tersimpan. Logout dulu untuk pairing ulang.');
    }
    if (this.loggedOut) {
      this.loggedOut = false;
      this.resetAuthDir();
    }
    if (!this.sock) await this.connect();

    const sock = this.sock;
    if (!sock) throw new Error('Koneksi WhatsApp belum siap, coba lagi sebentar');

    await Promise.race([
      sock.waitForSocketOpen(),
      sleep(15_000).then(() => {
        throw new Error('Timeout menunggu koneksi WhatsApp');
      }),
    ]);
    const code = await sock.requestPairingCode(phone);
    this.pairingCode = code;
    this.lastError = null;
    return code;
  }

  async logout(): Promise<void> {
    this.loggingOut = true;
    const sock = this.sock;
    this.sock = null;
    this.state = 'disconnected';
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.me = null;
    this.creds = null;
    try {
      if (sock) await sock.logout();
    } catch {
      try {
        await sock?.end(undefined);
      } catch {
        // abaikan
      }
    }
    this.resetAuthDir();
    this.loggedOut = false;
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.loggingOut = false;
    if (!this.stopped) await this.connect();
  }

  private resetAuthDir(): void {
    try {
      rmSync(this.authDir, { recursive: true, force: true });
      mkdirSync(this.authDir, { recursive: true });
    } catch (err) {
      logger.error({ err }, 'gagal menghapus sesi WA');
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.connections) return this.connections;
    this.connections = this.openSocket().finally(() => {
      this.connections = null;
    });
    return this.connections;
  }

  private async openSocket(): Promise<void> {
    this.state = 'connecting';
    this.lastError = null;
    try {
      mkdirSync(this.authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      this.creds = state.creds;

      const sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = sock;

      sock.ev.on('creds.update', () => {
        void saveCreds();
        this.creds = { ...state.creds };
      });
      sock.ev.on('connection.update', (update) => {
        void this.onConnectionUpdate(update);
      });
      sock.ev.on('messages.upsert', (event) => {
        if (event.type !== 'notify') return;
        for (const message of event.messages) {
          void this.handleIncoming(message).catch((err) => {
            logger.error({ err }, 'gagal memproses pesan WA');
          });
        }
      });
    } catch (err) {
      this.state = 'disconnected';
      this.lastError = err instanceof Error ? err.message : 'gagal memulai WhatsApp';
      logger.error({ err }, 'gagal membuat socket WA');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.loggedOut || this.reconnectTimer) return;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.lastError = `terputus, mencoba lagi dalam ${Math.round(delay / 1000)} detik`;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    if (this.loggingOut) return;

    if (update.qr) {
      this.state = 'connecting';
      this.pairingCode = null;
      this.qrRaw = update.qr;
      try {
        const dataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 256 });
        // Hindari menimpa QR yang lebih baru.
        if (this.qrRaw === update.qr) this.qrDataUrl = dataUrl;
      } catch {
        this.qrDataUrl = null;
      }
    }

    if (update.connection === 'open') {
      this.state = 'open';
      this.qrRaw = null;
      this.qrDataUrl = null;
      this.pairingCode = null;
      this.reconnectAttempt = 0;
      this.lastError = null;
      const me = this.creds?.me;
      this.me = me?.phoneNumber ? maskPhone(me.phoneNumber) : me?.id ? maskPhone(me.id.split('@')[0] ?? '') : null;
      logger.warn({ me: this.me }, 'WhatsApp terhubung');
      return;
    }

    if (update.connection === 'close') {
      const code = disconnectCode(update.lastDisconnect?.error);
      this.sock = null;
      this.qrRaw = null;
      this.qrDataUrl = null;
      this.pairingCode = null;

      if (code === DisconnectReason.loggedOut) {
        this.loggedOut = true;
        this.state = 'logged_out';
        this.lastError = 'Sesi WhatsApp berakhir. Minta pairing code baru untuk login.';
        this.resetAuthDir();
        this.creds = null;
        logger.warn('WA logged out, reconnect dihentikan');
        return;
      }

      this.state = 'disconnected';
      this.loggerDisconnect(code, update.lastDisconnect?.error);
      this.scheduleReconnect();
    }
  }

  private loggerDisconnect(code: number | undefined, error: unknown): void {
    const message = error instanceof Error ? error.message : 'terputus';
    this.lastError = `koneksi terputus (${code ?? '?'}): ${message}`;
    logger.warn({ code }, 'koneksi WA terputus');
  }

  private botIdentities(): Set<string> {
    const set = new Set<string>();
    const me = this.creds?.me;
    for (const raw of [me?.id, me?.lid, me?.phoneNumber, this.sock?.user?.id, this.sock?.user?.lid]) {
      const normalized = normalizedIdentity(raw);
      if (normalized) set.add(normalized);
    }
    return set;
  }

  private async handleIncoming(msg: WAMessage): Promise<void> {
    const key = msg.key;
    const chatId = key?.remoteJid;
    if (!key || !chatId) return;
    if (key.fromMe) return;
    if (isJidStatusBroadcast(chatId) || isJidNewsletter(chatId) || chatId.endsWith('@broadcast')) return;

    const content = extractMessageContent(msg.message);
    if (!content) return;

    const type = getContentType(content);
    const isGroup = isJidGroup(chatId) === true;
    const text = textFromContent(content, type);
    const hasMedia = type ? MEDIA_TYPES.has(type) : false;

    const candidates = [
      isGroup ? key.participant : key.remoteJid,
      key.participant,
      key.participantAlt,
      key.remoteJid,
      key.remoteJidAlt,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const unique = [...new Set(candidates)];
    if (unique.length === 0) return;

    // Utamakan nomor PN agar strike/riwayat stabil walau LID berubah.
    const senderId = unique.find((jid) => jid.endsWith('@s.whatsapp.net')) ?? unique[0]!;
    const altSenderIds = unique.filter((jid) => jid !== senderId);

    const context = contextOf(content, type);
    const mentionedJids = context?.mentionedJid ?? [];
    const identities = this.botIdentities();
    const mentioned = mentionedJids.some((jid) => {
      const normalized = normalizedIdentity(jid);
      return normalized !== null && identities.has(normalized);
    });

    const rawText = text ?? '';
    if (rawText.trim() === '' && hasMedia) {
      // Pipeline yang memutuskan balasan "hanya teks" dan rate limitnya.
    } else if (rawText.trim() === '') {
      return;
    }

    const timestampMs = Number(msg.messageTimestamp ?? 0) * 1000;

    const result = await this.onMessage({
      chatId,
      senderId,
      altSenderIds,
      isGroup,
      text: rawText,
      hasMedia,
      messageId: key.id ?? undefined,
      timestamp: timestampMs > 0 ? timestampMs : undefined,
      mentioned,
    });

    if (!result.reply || !this.sock) return;

    const sock = this.sock;
    try {
      await sock.sendPresenceUpdate('composing', chatId).catch(() => undefined);
      await sleep(1000 + Math.floor(Math.random() * 2000));
      await sock.sendMessage(chatId, { text: result.reply }, isGroup ? { quoted: msg } : undefined);
    } catch (err) {
      logger.error({ err, chat: maskPhone(senderId) }, 'gagal mengirim balasan WA');
    }
  }
}
