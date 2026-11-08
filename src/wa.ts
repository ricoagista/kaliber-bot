import fs from 'node:fs';
import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  proto,
  useMultiFileAuthState,
  type AuthenticationCreds,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import type { WaConnectionState, WaController, WaStatusSnapshot } from './api.js';
import { logger } from './logger.js';
import { handleMessage } from './pipeline.js';

function normalizeJidSafe(jid?: string | null): string {
  if (!jid || typeof jid !== 'string') return '';
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid.trim();
  }
}

function extractMessageContent(msg: WAMessage): {
  text: string;
  hasMedia: boolean;
  mentionedJids: string[];
} {
  let m = msg.message;
  if (!m) return { text: '', hasMedia: false, mentionedJids: [] };

  // Unwrap ephemeral / viewOnce wrappers bila ada
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    '';

  const hasMedia = Boolean(
    m.imageMessage ||
      m.videoMessage ||
      m.audioMessage ||
      m.documentMessage ||
      m.stickerMessage
  );

  const contextInfo =
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    null;

  const mentionedJids = (contextInfo?.mentionedJid ?? [])
    .map((j) => normalizeJidSafe(j))
    .filter(Boolean);

  return {
    text: text.trim(),
    hasMedia,
    mentionedJids,
  };
}

export class WaBot implements WaController {
  private readonly authDir: string;
  private sock: WASocket | null = null;
  private creds: AuthenticationCreds | null = null;
  private state: WaConnectionState = 'disconnected';
  private qrDataUrl: string | null = null;
  private pairingCode: string | null = null;
  private me: string | null = null;
  private lastError: string | null = null;
  private loggedOut = false;
  private stopping = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectingPromise: Promise<void> | null = null;
  private socketReadyWaiters: Array<() => void> = [];

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  getStatus(): WaStatusSnapshot {
    return {
      state: this.state,
      qrDataUrl: this.qrDataUrl,
      pairingCode: this.pairingCode,
      me: this.me,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.notifySocketReady();
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Abaikan error saat penutupan socket
      }
      this.sock = null;
    }
  }

  private clearAuthDir(): void {
    try {
      if (fs.existsSync(this.authDir)) {
        fs.rmSync(this.authDir, { recursive: true, force: true });
      }
      fs.mkdirSync(this.authDir, { recursive: true });
    } catch (err) {
      logger.warn({ err, authDir: this.authDir }, 'Gagal membersihkan direktori wa-auth');
    }
  }

  private notifySocketReady(): void {
    const waiters = this.socketReadyWaiters.splice(0, this.socketReadyWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private waitForSocketOpen(timeoutMs = 15_000): Promise<void> {
    if (this.sock && (this.qrDataUrl || this.state === 'connecting')) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.socketReadyWaiters.indexOf(onReady);
        if (idx >= 0) this.socketReadyWaiters.splice(idx, 1);
        reject(new Error('Waktu tunggu koneksi socket WhatsApp habis (15 detik).'));
      }, timeoutMs);

      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };

      this.socketReadyWaiters.push(onReady);
    });
  }

  async connect(): Promise<void> {
    if (this.connectingPromise) {
      return this.connectingPromise;
    }
    this.connectingPromise = this.doConnect().finally(() => {
      this.connectingPromise = null;
    });
    return this.connectingPromise;
  }

  private async doConnect(): Promise<void> {
    if (this.stopping) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    fs.mkdirSync(this.authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.creds = authState.creds;
    this.state = 'connecting';

    const baileysLogger = logger.child({ module: 'baileys' });
    baileysLogger.level = 'silent';

    const sock = makeWASocket({
      auth: authState,
      logger: baileysLogger as never,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: ({ syncType }) =>
        syncType !== proto.HistorySync.HistorySyncType.FULL &&
        syncType !== proto.HistorySync.HistorySyncType.RECENT,
    });

    this.sock = sock;

    sock.ev.on('creds.update', () => {
      this.creds = authState.creds;
      void saveCreds();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.state = 'connecting';
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 1 });
        } catch (err) {
          logger.warn({ err }, 'Gagal merender QR ke DataURL');
        }
        this.notifySocketReady();
      }

      if (connection === 'open') {
        this.state = 'open';
        this.loggedOut = false;
        this.reconnectAttempt = 0;
        this.qrDataUrl = null;
        this.pairingCode = null;
        this.lastError = null;
        const rawMe = sock.user?.id || authState.creds.me?.id || '';
        this.me = normalizeJidSafe(rawMe) || rawMe || null;
        this.notifySocketReady();
        logger.info({ me: this.me }, 'WhatsApp terhubung');
      }

      if (connection === 'close') {
        const errObj = lastDisconnect?.error as {
          message?: string;
          output?: { statusCode?: number };
        } | undefined;
        const statusCode = errObj?.output?.statusCode;
        this.lastError = errObj?.message ?? (statusCode ? `Kode ${statusCode}` : null);

        if (statusCode === DisconnectReason.loggedOut) {
          this.state = 'logged_out';
          this.loggedOut = true;
          this.qrDataUrl = null;
          this.pairingCode = null;
          this.me = null;
          this.clearAuthDir();
          logger.warn('Sesi WhatsApp logged out. Direktori wa-auth dibersihkan.');
          return;
        }

        if (!this.stopping) {
          this.state = 'disconnected';
          const delay = Math.min(60_000, 2000 * Math.pow(2, Math.min(this.reconnectAttempt, 5)));
          this.reconnectAttempt++;
          logger.info({ delayMs: delay, attempt: this.reconnectAttempt }, 'Menjadwalkan reconnect WhatsApp');
          this.reconnectTimer = setTimeout(() => {
            void this.connect();
          }, delay);
          this.reconnectTimer.unref?.();
        }
      }
    });

    sock.ev.on('messages.upsert', (event) => {
      if (event.type !== 'notify') return;
      for (const msg of event.messages) {
        void this.handleIncoming(sock, msg);
      }
    });
  }

  async requestPairing(phone: string): Promise<string> {
    if (this.state === 'open' || this.creds?.registered) {
      throw new Error('WhatsApp sudah terhubung atau terdaftar.');
    }

    let digits = phone.replace(/\D+/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    if (digits.length < 8 || digits.length > 15) {
      throw new Error('Nomor telepon harus 8 sampai 15 digit.');
    }

    if (this.loggedOut || !this.sock) {
      this.clearAuthDir();
      this.loggedOut = false;
      await this.connect();
    }

    await this.waitForSocketOpen(15_000);
    if (!this.sock) {
      throw new Error('Socket WhatsApp belum siap.');
    }

    const code = await this.sock.requestPairingCode(digits);
    this.pairingCode = code;
    return code;
  }

  async logout(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        try {
          this.sock.end(undefined);
        } catch {
          // Abaikan
        }
      }
      this.sock = null;
    }
    this.clearAuthDir();
    this.state = 'disconnected';
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.me = null;
    this.lastError = null;
    this.loggedOut = false;
    this.reconnectAttempt = 0;
    await this.connect();
  }

  private getBotJids(): Set<string> {
    const jids = new Set<string>();
    const credsMe = this.creds?.me as
      | { id?: string; lid?: string; phoneNumber?: string }
      | undefined;
    const sockUser = this.sock?.user as
      | { id?: string; lid?: string; phoneNumber?: string }
      | undefined;

    for (const raw of [
      credsMe?.id,
      credsMe?.lid,
      credsMe?.phoneNumber,
      sockUser?.id,
      sockUser?.lid,
      sockUser?.phoneNumber,
    ]) {
      const norm = normalizeJidSafe(raw);
      if (norm) jids.add(norm);
    }
    return jids;
  }

  private async handleIncoming(sock: WASocket, msg: WAMessage): Promise<void> {
    try {
      const key = msg.key;
      if (!key) return;
      const remoteJid = key.remoteJid ?? '';
      if (!remoteJid) return;

      const isStatus = remoteJid === 'status@broadcast';
      const isGroup = remoteJid.endsWith('@g.us');
      const chatId = isGroup ? remoteJid : normalizeJidSafe(remoteJid) || remoteJid;

      // Kumpulkan kandidat JID pengirim
      const rawCandidates = isGroup
        ? [key.participant, key.participantAlt]
        : [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt];

      const normalizedCandidates = Array.from(
        new Set(rawCandidates.map((c) => normalizeJidSafe(c)).filter(Boolean))
      );

      // Utamakan JID berakhiran @s.whatsapp.net sebagai senderId utama
      const pnJid = normalizedCandidates.find((j) => j.endsWith('@s.whatsapp.net'));
      const senderId = pnJid ?? normalizedCandidates[0] ?? chatId;
      const altSenderIds = normalizedCandidates.filter((j) => j !== senderId);

      const { text, hasMedia, mentionedJids } = extractMessageContent(msg);

      let isMentioned = false;
      if (isGroup && mentionedJids.length > 0) {
        const botJids = this.getBotJids();
        isMentioned = mentionedJids.some((m) => botJids.has(m));
      }

      const rawTs = msg.messageTimestamp;
      let timestampMs: number | undefined;
      if (typeof rawTs === 'number') {
        timestampMs = rawTs * 1000;
      } else if (rawTs && typeof (rawTs as { toNumber?: () => number }).toNumber === 'function') {
        timestampMs = (rawTs as { toNumber: () => number }).toNumber() * 1000;
      }

      const result = await handleMessage({
        messageId: key.id ?? undefined,
        chatId,
        senderId,
        altSenderIds,
        text,
        isGroup,
        isMentioned,
        hasMedia,
        fromMe: Boolean(key.fromMe),
        isStatus,
        timestampMs,
      });

      if (result.reply) {
        await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
        const humanDelay = 1000 + Math.floor(Math.random() * 2000);
        await new Promise((resolve) => setTimeout(resolve, humanDelay));

        if (isGroup) {
          await sock.sendMessage(remoteJid, { text: result.reply }, { quoted: msg });
        } else {
          await sock.sendMessage(remoteJid, { text: result.reply });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Gagal memproses pesan masuk WhatsApp');
    }
  }
}
