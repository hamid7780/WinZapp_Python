import crypto from 'crypto';
if (!globalThis.crypto) {
  // @ts-ignore
  globalThis.crypto = crypto.webcrypto || crypto;
}

import path from 'path';
import fs from 'fs';
import { Server as SocketIOServer } from 'socket.io';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  downloadMediaMessage,
  proto,
  WASocket,
  WAMessage,
  WAMessageKey,
  isJidGroup,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

function toNumber(t: any): number {
  if (t === null || t === undefined) return 0;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') return parseInt(t, 10);
  if (typeof t === 'object') {
    if (typeof t.toNumber === 'function') {
      return t.toNumber();
    }
    if (typeof t.low === 'number') {
      return t.low;
    }
  }
  return Number(t);
}

function parseBuffer(val: any): Buffer | undefined {
  if (!val) return undefined;
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (typeof val === 'string') {
    const clean = val.includes('base64,') ? val.split('base64,')[1] : val;
    return Buffer.from(clean, 'base64');
  }
  if (typeof val === 'object') {
    if (val.type === 'Buffer' && Array.isArray(val.data)) {
      return Buffer.from(val.data);
    }
    if (Array.isArray(val)) {
      return Buffer.from(val);
    }
  }
  return undefined;
}

function getRealMessage(message: any): any {
  if (!message) return {};
  if (message.ephemeralMessage) {
    return getRealMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage) {
    return getRealMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2) {
    return getRealMessage(message.viewOnceMessageV2.message);
  }
  if (message.documentWithCaptionMessage) {
    return getRealMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

const logger = pino({ level: 'silent' });

export class BaileysManager {
  private io: SocketIOServer;
  private sessions: Map<string, WASocket> = new Map();
  private sessionStatus: Map<string, string> = new Map();
  private pairingCodes: Map<string, string> = new Map();
  private stores: Map<string, any> = new Map();
  private tokensDir: string;
  private messageCache: Map<string, WAMessage> = new Map();
  private lidToPhoneMap: Map<string, string> = new Map();
  private syncTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(io: SocketIOServer) {
    this.io = io;
    this.tokensDir = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(this.tokensDir)) {
      fs.mkdirSync(this.tokensDir, { recursive: true });
    }
    this.autoRestoreSessions();
  }

  private autoRestoreSessions(): void {
    try {
      if (!fs.existsSync(this.tokensDir)) return;
      const entries = fs.readdirSync(this.tokensDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sessionName = entry.name;
          const credsFile = path.join(this.tokensDir, sessionName, 'creds.json');
          if (fs.existsSync(credsFile)) {
            try {
              const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
              if (creds.me && creds.me.id && creds.registered) {
                console.log(`[BaileysManager] Auto-restoring registered session: ${sessionName}`);
                setTimeout(() => this.startSession(sessionName), 500);
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {
      console.error('[BaileysManager] Failed to auto-restore sessions:', e);
    }
  }

  private getSafeSessionName(session: string): string {
    if (!session) return 'default';
    return session.split(':')[0].replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  public getStatus(session: string): string {
    const safeSession = this.getSafeSessionName(session);
    const status = this.sessionStatus.get(safeSession);
    if (!status || status === 'DISCONNECTED') {
      return 'CLOSED';
    }
    return status;
  }

  public isConnected(session: string): boolean {
    const safeSession = this.getSafeSessionName(session);
    return this.sessionStatus.get(safeSession) === 'CONNECTED';
  }

  public getSocket(session: string): WASocket | undefined {
    const safeSession = this.getSafeSessionName(session);
    return this.sessions.get(safeSession);
  }

  public getPairingCode(session: string): string | undefined {
    const safeSession = this.getSafeSessionName(session);
    return this.pairingCodes.get(safeSession);
  }

  public resolveLidToPhone(lid: string): string | undefined {
    const cleanLid = lid.replace('@c.us', '@s.whatsapp.net');
    // 1. Check in-memory map
    const cached = this.lidToPhoneMap.get(cleanLid) || this.lidToPhoneMap.get(lid);
    if (cached) return cached;

    // 2. Scan all stores/contacts
    for (const [session, store] of this.stores.entries()) {
      if (store && store.contacts) {
        for (const id in store.contacts) {
          const c = store.contacts[id];
          if (c) {
            const cleanId = id.replace('@c.us', '@s.whatsapp.net');
            const cleanCLid = c.lid ? c.lid.replace('@c.us', '@s.whatsapp.net') : '';
            if (cleanId === cleanLid && cleanCLid) {
              this.lidToPhoneMap.set(cleanCLid, cleanId);
              return cleanId;
            }
            if (cleanCLid === cleanLid) {
              this.lidToPhoneMap.set(cleanLid, cleanId);
              return cleanId;
            }
          }
        }
      }
    }
    return undefined;
  }

  public onClientConnected(socket: any): void {
    console.log(`[BaileysManager] Resending state for active sessions to socket ${socket.id}`);
    for (const [session, status] of this.sessionStatus.entries()) {
      if (status === 'CONNECTED') {
        const sock = this.sessions.get(session);
        const userJid = sock?.user?.id ? this.normalizeJid(sock.user.id) : '';
        const connPayload = {
          session,
          state: 'open',
          data: {
            state: 'open',
            wuid: userJid,
            phoneNumber: userJid
          }
        };

        socket.emit('connection.update', connPayload);
        socket.emit('session-logged', { status: true, session, data: connPayload.data });
        socket.emit('status-find', { status: 'CONNECTED', session });
        socket.emit('messages.set', { session });
      }
    }
  }

  public async startSession(sessionRaw: string, phone?: string): Promise<string> {
    const session = this.getSafeSessionName(sessionRaw);
    const existingSock = this.sessions.get(session);
    if (existingSock) {
      if (phone || this.sessionStatus.get(session) !== 'CONNECTED') {
        try {
          existingSock.ev.removeAllListeners('connection.update');
          (existingSock.ws as any)?.close();
          existingSock.end(undefined);
        } catch (e) {}
        this.sessions.delete(session);
        this.pairingCodes.delete(session);
      } else {
        const userJid = existingSock.user?.id ? this.normalizeJid(existingSock.user.id) : '';
        const connPayload = {
          session,
          state: 'open',
          data: { state: 'open', wuid: userJid, phoneNumber: userJid }
        };
        this.io.emit('connection.update', connPayload);
        this.io.emit('session-logged', { status: true, session, data: connPayload.data });
        this.io.emit('status-find', { status: 'CONNECTED', session });
        this.io.emit('messages.set', { session });
        return 'CONNECTED';
      }
    }

    this.sessionStatus.set(session, 'INITIALIZING');
    const sessionDir = path.join(this.tokensDir, session);

    // If phone pairing is requested, wipe any stale unregistered auth folder so pairing uses fresh keys
    if (phone && fs.existsSync(sessionDir)) {
      const credsFile = path.join(sessionDir, 'creds.json');
      if (fs.existsSync(credsFile)) {
        try {
          const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
          if (!creds.me || !creds.me.id || !creds.registered) {
            console.log(`[BaileysManager] Session ${session} is unregistered. Wiping stale auth state.`);
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }
        } catch (e) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    }

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const storeFile = path.join(sessionDir, 'baileys_store.json');
    const store = makeInMemoryStore({ logger });
    if (fs.existsSync(storeFile)) {
      try {
        store.readFromFile(storeFile);
        console.log(`[BaileysManager] Loaded store from ${storeFile}`);
      } catch (e) {
        console.error(`[BaileysManager] Failed to load store from ${storeFile}:`, e);
      }
    }
    this.stores.set(session, store);

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
      markOnlineOnConnect: true,
    });

    store.bind(sock.ev);
    this.sessions.set(session, sock);

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (c.id && c.lid) {
          const phone = c.id.replace('@c.us', '@s.whatsapp.net');
          const lid = c.lid.replace('@c.us', '@s.whatsapp.net');
          this.lidToPhoneMap.set(lid, phone);
        }
      }
    });

    sock.ev.on('contacts.update', (contacts) => {
      for (const c of contacts) {
        if (c.id && c.lid) {
          const phone = c.id.replace('@c.us', '@s.whatsapp.net');
          const lid = c.lid.replace('@c.us', '@s.whatsapp.net');
          this.lidToPhoneMap.set(lid, phone);
        }
      }
    });

    sock.ev.on('groups.upsert', (groups) => {
      for (const group of groups) {
        if (group.participants) {
          for (const p of group.participants) {
            if (p.id && p.lid) {
              const phone = p.id.replace('@c.us', '@s.whatsapp.net');
              const lid = p.lid.replace('@c.us', '@s.whatsapp.net');
              this.lidToPhoneMap.set(lid, phone);
            }
          }
        }
      }
    });

    sock.ev.on('groups.update', (groups) => {
      for (const group of groups) {
        if (group.participants) {
          for (const p of group.participants) {
            if (p.id && p.lid) {
              const phone = p.id.replace('@c.us', '@s.whatsapp.net');
              const lid = p.lid.replace('@c.us', '@s.whatsapp.net');
              this.lidToPhoneMap.set(lid, phone);
            }
          }
        }
      }
    });

    // Periodically save the store to file
    const intervalId = setInterval(() => {
      try {
        if (this.sessions.has(session)) {
          store.writeToFile(storeFile);
        } else {
          clearInterval(intervalId);
        }
      } catch (e) {
        console.error(`[BaileysManager] Failed to write store to ${storeFile}:`, e);
      }
    }, 10000);

    // Save auth credentials whenever updated
    sock.ev.on('creds.update', saveCreds);

    // If phone number is supplied and user is not registered, request pairing code
    if (phone && !sock.authState.creds.registered) {
      let cleanPhone = phone.replace(/[^0-9]/g, '');
      if (cleanPhone.startsWith('920') && cleanPhone.length === 13) {
        cleanPhone = '92' + cleanPhone.slice(3);
      }
      const triggerPairing = async (attempts = 0) => {
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          console.log(`[BaileysManager] Pairing code generated for ${session}: ${code}`);
          this.pairingCodes.set(session, code);
          this.io.emit('phoneCode', {
            session,
            data: code,
            phoneCode: code
          });
        } catch (err: any) {
          console.error(`[BaileysManager] Request pairing code attempt ${attempts + 1} error:`, err?.message || err);
          if (attempts < 8 && !sock.authState.creds.registered) {
            setTimeout(() => triggerPairing(attempts + 1), 1000);
          }
        }
      };
      setTimeout(() => triggerPairing(0), 1000);
    }

    // Handle Connection Updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

      if (qr) {
        try {
          const qrBase64 = await QRCode.toDataURL(qr);
          this.sessionStatus.set(session, 'QRCODE');
          this.io.emit('qrCode', {
            session,
            data: qrBase64
          });
        } catch (err) {
          console.error(`[BaileysManager] Error generating QR data URL:`, err);
        }
      }

      if (connection === 'open') {
        const userJid = sock.user?.id ? this.normalizeJid(sock.user.id) : '';
        console.log(`[BaileysManager] Session ${session} connected successfully as ${userJid}!`);
        this.sessionStatus.set(session, 'CONNECTED');

        const connPayload = {
          session,
          state: 'open',
          data: {
            state: 'open',
            wuid: userJid,
            phoneNumber: userJid
          }
        };

        this.io.emit('connection.update', connPayload);
        this.io.emit('session-logged', { status: true, session, data: connPayload.data });
        this.io.emit('status-find', { status: 'CONNECTED', session });
        
        // Defensive fallback: emit messages.set after 5 seconds if not triggered already
        setTimeout(() => {
          this.io.emit('messages.set', { session });
        }, 5000);
      }

      if (receivedPendingNotifications) {
        console.log(`[BaileysManager] receivedPendingNotifications for ${session}`);
        this.io.emit('messages.set', { session });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[BaileysManager] Session ${session} closed. Status code: ${statusCode}, shouldReconnect: ${shouldReconnect}`);

        const closePayload = {
          session,
          state: 'close',
          data: {
            state: 'close',
            statusCode,
            loggedOut: statusCode === DisconnectReason.loggedOut
          }
        };
        this.io.emit('connection.update', closePayload);

        if (statusCode === DisconnectReason.loggedOut) {
          this.sessionStatus.set(session, 'DISCONNECTED');
          this.sessions.delete(session);
          this.pairingCodes.delete(session);
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch (e) {}
          this.io.emit('session-logged', { status: false, session });
          this.io.emit('status-find', { status: 'notLogged', session });
        } else if (shouldReconnect) {
          this.sessionStatus.set(session, 'INITIALIZING');
          this.io.emit('status-find', { status: 'INITIALIZING', session });
          setTimeout(() => this.startSession(session), 3000);
        }
      }
    });

    // Handle Messaging History Sync
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
      console.log(`[BaileysManager] messaging-history.set synced for ${session}: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages, isLatest: ${isLatest}`);
      
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          if (c.id && (c as any).lid) {
            const phone = c.id.replace('@s.whatsapp.net', '@c.us');
            const lid = (c as any).lid.replace('@c.us', '@s.whatsapp.net');
            this.lidToPhoneMap.set(lid, phone);
          }
        }
      }

      if (Array.isArray(messages)) {
        const batchSize = 50;
        let index = 0;
        const processBatch = () => {
          if (index >= messages.length) {
<<<<<<< HEAD
            // Debounce messages.set
            const existingTimer = this.syncTimers.get(session);
            if (existingTimer) {
              clearTimeout(existingTimer);
            }
            this.syncTimers.set(session, setTimeout(() => {
              this.io.emit('messages.set', { session });
              this.syncTimers.delete(session);
            }, 2000));
=======
            if (isLatest === true || isLatest === undefined) {
              this.io.emit('messages.set', { session });
            }
>>>>>>> 3e2a1e951e8c54963eee4f207270f69869a9097f
            return;
          }
          const batch = messages.slice(index, index + batchSize);
          const formattedBatch = [];
          for (const msg of batch) {
            if (!msg.message) continue;
            const msgId = msg.key.id || '';
            if (msgId) {
              this.messageCache.set(msgId, msg);
            }
            const canonicalMsg = this.formatCanonicalMessage(msg);
            canonicalMsg.isMdHistoryMsg = true;
            formattedBatch.push(canonicalMsg);
          }
          if (formattedBatch.length > 0) {
            this.io.emit('messages.upsert', {
              event: 'messages.upsert',
              instance: session,
              data: formattedBatch
            });
          }
          index += batchSize;
          setImmediate(processBatch);
        };
        processBatch();
      } else {
<<<<<<< HEAD
        // Debounce messages.set
        const existingTimer = this.syncTimers.get(session);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        this.syncTimers.set(session, setTimeout(() => {
          this.io.emit('messages.set', { session });
          this.syncTimers.delete(session);
        }, 2000));
=======
        if (isLatest === true || isLatest === undefined) {
          this.io.emit('messages.set', { session });
        }
>>>>>>> 3e2a1e951e8c54963eee4f207270f69869a9097f
      }
    });

    // Handle Messages Upsert
    sock.ev.on('messages.upsert', async (m) => {
      const { messages, type } = m;
      for (const msg of messages) {
        if (!msg.message) continue;

        // Cache message for media download lookup
        const msgId = msg.key.id || '';
        if (msgId) {
          this.messageCache.set(msgId, msg);
        }

        // Cache LID to Phone mappings if participant / key available
        if (msg.key.participant && msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
          if (msg.key.participant.includes('@lid')) {
            const phone = msg.key.remoteJid.replace('@c.us', '@s.whatsapp.net');
            this.lidToPhoneMap.set(msg.key.participant, phone);
          }
        }

        // Format message into Baileys standard dictionary for Python
        const canonicalMsg = this.formatCanonicalMessage(msg);

        // Emit standard Baileys messages.upsert event
        this.io.emit('messages.upsert', {
          event: 'messages.upsert',
          instance: session,
          data: canonicalMsg
        });

        // Handle reactions separately if reaction message
        if (msg.message.reactionMessage) {
          const rm = msg.message.reactionMessage;
          const targetKey = rm.key;
          const reactionId = msg.key.id;
          const targetSerialized = `${targetKey?.fromMe}_${targetKey?.remoteJid}_${targetKey?.id}`;
          const reactionSerialized = `${msg.key.fromMe}_${msg.key.remoteJid}_${msg.key.id}_${msg.key.participant || ''}`;

          this.io.emit('onreactionmessage', {
            session,
            response: {
              id: reactionSerialized,
              msgId: targetSerialized,
              reactionText: rm.text || '',
              timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000)
            }
          });
        }
      }
    });

    // Handle Messages Updates (ACKs / Status Updates)
    sock.ev.on('messages.update', async (updates) => {
      this.io.emit('messages.update', {
        instance: session,
        data: updates
      });
    });

    // Handle Presence Updates
    sock.ev.on('presence.update', (pu) => {
      this.io.emit('presence.update', {
        instance: session,
        data: pu
      });
    });

    // Handle Chats Update (unreadCount, pin, archive)
    sock.ev.on('chats.update', (updates) => {
      const mapped = updates.map((cu) => {
        const jid = this.normalizeJid(cu.id);
        const obj: any = {
          remoteJid: jid,
          id: jid
        };
        if (cu.unreadCount !== undefined) obj.unreadCount = cu.unreadCount;
        if ((cu as any).pinned !== undefined) {
          obj.pinned = (cu as any).pinned;
        } else if ((cu as any).pin !== undefined) {
          obj.pinned = (cu as any).pin;
        }
        if (cu.archived !== undefined) {
          obj.archive = cu.archived;
        } else if ((cu as any).archive !== undefined) {
          obj.archive = (cu as any).archive;
        }
        return obj;
      });
      this.io.emit('chats.update', {
        session,
        data: mapped
      });
    });

    return 'INITIALIZING';
  }

  public async closeSession(sessionRaw: string): Promise<boolean> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (sock) {
      sock.ev.removeAllListeners('connection.update');
      sock.end(undefined);
      this.sessions.delete(session);
    }
    this.sessionStatus.set(session, 'DISCONNECTED');
    this.pairingCodes.delete(session);
    const sessionDir = path.join(this.tokensDir, session);
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (e) {}
    }
    this.io.emit('status-find', { status: 'DISCONNECTED', session });
    return true;
  }

  public async sendMessage(sessionRaw: string, phoneInput: any, messageText: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const jid = this.normalizeJid(phoneInput);
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch (e) {}

    const sent = await sock.sendMessage(jid, { text: messageText });
    return [this.formatCanonicalMessage(sent)];
  }

  public async sendReply(sessionRaw: string, phone: string, text: string, quotedMsgId: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const jid = this.normalizeJid(phone);
    const cleanQuotedId = quotedMsgId.includes('_') ? quotedMsgId.split('_')[2] : quotedMsgId;
    const quotedMsg = this.messageCache.get(cleanQuotedId);

    const sent = await sock.sendMessage(jid, { text }, { quoted: quotedMsg });
    return [this.formatCanonicalMessage(sent)];
  }

  public async sendVoiceBase64(sessionRaw: string, phone: string, base64Data: string, duration?: number): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    let jid = this.normalizeJid(phone);
    if (!base64Data) throw new Error('No base64 voice audio data provided');
    const cleanBase64 = base64Data.includes('base64,') ? base64Data.split('base64,')[1] : base64Data;
    const buffer = Buffer.from(cleanBase64, 'base64');

    const isWav = buffer.subarray(0, 4).toString() === 'RIFF';
    if (isWav) {
      throw new Error('WAV audio is not supported for PTT voice messages — ffmpeg is required on the Python side to convert WAV to OGG/Opus before sending. Please ensure ffmpeg is available in client/lib/.');
    }
    const mimetype = 'audio/ogg; codecs=opus';
    const waveform = new Uint8Array(64).fill(25);

    try {
      await sock.sendPresenceUpdate('recording', jid);
    } catch (e) {}

    let sent: any;
    try {
      sent = await sock.sendMessage(jid, {
        audio: buffer,
        ptt: true,
        mimetype: mimetype,
        seconds: duration || 0,
        waveform: waveform
      } as any);
    } catch (sendErr: any) {
      if (jid.endsWith('@lid')) {
        // Fallback: resolve phone number if sending to @lid failed
        try {
          const pn = this.resolveLidToPhone(jid);
          if (pn) {
            jid = this.normalizeJid(pn);
            sent = await sock.sendMessage(jid, {
              audio: buffer,
              ptt: true,
              mimetype: mimetype,
              seconds: duration || 0,
              waveform: waveform
            } as any);
          } else {
            throw sendErr;
          }
        } catch (fbErr) {
          throw sendErr;
        }
      } else {
        throw sendErr;
      }
    }

    return [this.formatCanonicalMessage(sent)];
  }

  public async sendMediaBase64(
    sessionRaw: string,
    phone: string,
    base64Data: string,
    caption?: string,
    isImage: boolean = true
  ): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const jid = this.normalizeJid(phone);
    const cleanBase64 = base64Data.includes('base64,') ? base64Data.split('base64,')[1] : base64Data;
    const buffer = Buffer.from(cleanBase64, 'base64');

    const content = isImage
      ? { image: buffer, caption: caption || '' }
      : { document: buffer, caption: caption || '', mimetype: 'application/octet-stream' };

    const sent = await sock.sendMessage(jid, content as any);
    return [this.formatCanonicalMessage(sent)];
  }

  public async reactMessage(sessionRaw: string, msgId: string, reaction: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const parts = msgId.split('_');
    const fromMe = parts[0] === 'true';
    const remoteJid = parts.length > 1 ? parts[1] : '';
    const cleanId = parts.length > 2 ? parts[2] : msgId;

    const key: WAMessageKey = {
      remoteJid,
      fromMe,
      id: cleanId
    };

    return await sock.sendMessage(remoteJid, {
      react: {
        text: reaction,
        key
      }
    });
  }

  public async getMediaByMessage(sessionRaw: string, msgId: string, reqBody?: any): Promise<string> {
    const session = this.getSafeSessionName(sessionRaw);
    const cleanId = msgId.includes('_') ? msgId.split('_')[2] : msgId;
    let msg: WAMessage | undefined = this.messageCache.get(cleanId) || this.messageCache.get(msgId);

    const store = this.stores.get(session);
    if (!msg && store && store.messages) {
      for (const jidKey in store.messages) {
        const msgs = store.messages[jidKey];
        if (Array.isArray(msgs)) {
          msg = msgs.find((m: WAMessage) => m.key?.id === cleanId || m.key?.id === msgId);
          if (msg) break;
        }
      }
    }

    if (!msg && reqBody && typeof reqBody === 'object') {
      const remoteJid = reqBody.remoteJid || reqBody.from || reqBody.key?.remoteJid || '';
      const fromMe = reqBody.fromMe ?? reqBody.key?.fromMe ?? false;
      const mediaKey = parseBuffer(reqBody.mediaKey);
      const clientUrl = reqBody.clientUrl || reqBody.url || '';
      const directPath = reqBody.directPath || '';
      const mimetype = reqBody.mimetype || 'audio/ogg; codecs=opus';
      const msgType = reqBody.type === 'ptt' || reqBody.type === 'audio' ? 'audioMessage' : (reqBody.messageType || 'audioMessage');

      msg = {
        key: {
          remoteJid,
          fromMe,
          id: cleanId
        },
        message: {
          [msgType]: {
            url: clientUrl,
            directPath,
            mediaKey,
            mimetype
          }
        }
      } as any;
    }

    if (!msg) {
      throw new Error(`Message ${msgId} not found in gateway cache or payload`);
    }

    // Unwrap the message contents for downloading
    if (msg && msg.message) {
      msg = {
        ...msg,
        message: getRealMessage(msg.message)
      };
    }

    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: (m) => new Promise((resolve) => resolve(m)) }
    );

    return buffer.toString('base64');
  }

  public async getGroupInfo(sessionRaw: string, groupId: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const cleanGroupId = groupId.endsWith('@g.us') ? groupId : `${groupId}@g.us`;
    return await sock.groupMetadata(cleanGroupId);
  }

  public async createGroup(sessionRaw: string, groupName: string, phones: string[]): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const jids = phones.map((p) => this.normalizeJid(p));
    return await sock.groupCreate(groupName, jids);
  }

  public getChats(sessionRaw: string): any[] {
    const session = this.getSafeSessionName(sessionRaw);
    const store = this.stores.get(session);
    const sock = this.sessions.get(session);
    const chats: any[] = [];
    const seenJids = new Set<string>();

    if (store && store.chats) {
      const allChats = store.chats.all();
      for (const c of allChats) {
        if (!c.id || c.id.endsWith('@broadcast') || c.id.endsWith('@newsletter')) continue;
        let jid = this.normalizeJid(c.id);
        const isGroup = jid.endsWith('@g.us');

        if (jid.endsWith('@lid')) {
          const mappedPhone = this.lidToPhoneMap.get(jid);
          if (mappedPhone) {
            jid = mappedPhone;
          }
        }

        if (seenJids.has(jid)) continue;
        seenJids.add(jid);

        const chatTs = toNumber(c.conversationTimestamp || (c as any).t || 0);
        const isWppSystem = jid.startsWith('0@');
        const rawPin = (c as any).pinned ?? (c as any).pin;
        const pinVal = rawPin ? (typeof rawPin === 'number' || typeof rawPin === 'boolean' ? rawPin : 1) : null;
        const unread = c.unreadCount || 0;

        if (isWppSystem) {
          continue;
        }

        // Phantom / Empty Chat Filter for 1:1 and Self chats
        if (!isGroup) {
          const msgs = (store.messages && (store.messages[c.id] || store.messages[jid])) || [];
          const hasMessages = Array.isArray(msgs) ? msgs.length > 0 : (msgs && typeof msgs === 'object' && Object.keys(msgs).length > 0);
          const hasActivity = chatTs > 0 || hasMessages || unread > 0 || Boolean(pinVal);

          if (!hasActivity) {
            continue;
          }
        }
        const contact = (store.contacts && store.contacts[c.id]) || (store.contacts && store.contacts[jid]) || {};
        const name = c.name || (c as any).subject || contact.name || contact.notify || jid.split('@')[0];

        chats.push({
          id: jid,
          remoteJid: jid,
          name: name,
          pushName: contact.notify || contact.name || '',
          unreadCount: c.unreadCount || 0,
          isGroup: isGroup,
          conversationTimestamp: chatTs,
          t: chatTs,
          timestamp: chatTs,
          pinned: pinVal,
          archived: Boolean(c.archived)
        });
      }
    }

    return chats;
  }

  public getContacts(sessionRaw: string): any[] {
    const session = this.getSafeSessionName(sessionRaw);
    const store = this.stores.get(session);
    const sock = this.sessions.get(session);
    const contacts: any[] = [];

    if (store && store.contacts) {
      for (const id in store.contacts) {
        if (!id || id.endsWith('@g.us') || id === 'status@broadcast') continue;
        const c = store.contacts[id];
        const jid = this.normalizeJid(id);
        const isMe = sock?.user?.id ? (this.normalizeJid(sock.user.id) === jid) : false;

        contacts.push({
          id: jid,
          name: c.name || c.notify || jid.split('@')[0],
          notify: c.notify || c.name || '',
          pushname: c.notify || c.name || '',
          pushName: c.notify || c.name || '',
          isMyContact: true,
          isMe,
          number: jid.split('@')[0]
        });
      }
    }

    return contacts;
  }

  public getContact(sessionRaw: string, jid: string): any {
    const session = this.getSafeSessionName(sessionRaw);
    const store = this.stores.get(session);
    const cleanJid = this.normalizeJid(jid);
    const sock = this.sessions.get(session);
    const isMe = sock?.user?.id ? (this.normalizeJid(sock.user.id) === cleanJid) : false;

    if (store && store.contacts) {
      const contact = store.contacts[cleanJid] || store.contacts[jid] || {};
      return {
        id: cleanJid,
        name: contact.name || contact.notify || cleanJid.split('@')[0],
        notify: contact.notify || contact.name || '',
        pushname: contact.notify || contact.name || '',
        pushName: contact.notify || contact.name || '',
        isMyContact: true,
        isMe,
        number: cleanJid.split('@')[0]
      };
    }
    return {
      id: cleanJid,
      name: cleanJid.split('@')[0],
      notify: cleanJid.split('@')[0],
      pushname: cleanJid.split('@')[0],
      pushName: cleanJid.split('@')[0],
      isMyContact: false,
      isMe,
      number: cleanJid.split('@')[0]
    };
  }

  public getMessages(sessionRaw: string, phoneInput: any, count?: number,
                     direction?: string, beforeId?: string): any[] {
    const session = this.getSafeSessionName(sessionRaw);
    const store = this.stores.get(session);
    const jid = this.normalizeJid(phoneInput);
    if (!store || !store.messages) return [];

    let rawMsgs = store.messages[jid] || store.messages[jid.replace('@s.whatsapp.net', '@c.us')] || [];
    if (!Array.isArray(rawMsgs) && rawMsgs && typeof rawMsgs === 'object') {
      rawMsgs = (rawMsgs as any).array || Object.values(rawMsgs);
    }
    if (!Array.isArray(rawMsgs)) rawMsgs = [];

    const limit = count && count > 0 ? count : 200;

    let sliced: any[] = [];
    if (direction === 'before' && beforeId) {
      const bareId = beforeId.includes('_')
        ? beforeId.split('_')[2] || beforeId
        : beforeId;
      let anchorIdx = -1;
      for (let i = 0; i < rawMsgs.length; i++) {
        const m = rawMsgs[i];
        if (m && m.key && (m.key.id === bareId || m.key.id === beforeId)) {
          anchorIdx = i;
          break;
        }
      }
      if (anchorIdx >= 0) {
        sliced = rawMsgs.slice(Math.max(0, anchorIdx - limit), anchorIdx);
      } else {
        sliced = rawMsgs.slice(-limit);
      }
    } else {
      sliced = rawMsgs.slice(-limit);
    }

    const formatted: any[] = [];

    for (const m of sliced) {
      if (m && m.message) {
        formatted.push(this.formatCanonicalMessage(m));
      }
    }

    return formatted;
  }

  public async sendMentioned(sessionRaw: string, phoneInput: any, text: string, mentionedJids: string[] = []): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const jid = this.normalizeJid(phoneInput);
    const mentions = (mentionedJids || []).map((m) => this.normalizeJid(m));

    const sent = await sock.sendMessage(jid, { text, mentions });
    return [this.formatCanonicalMessage(sent)];
  }

  public normalizeJid(phoneInput: any): string {
    if (!phoneInput) return '';
    let phone = Array.isArray(phoneInput) ? phoneInput[0] : String(phoneInput);
    if (!phone) return '';

    phone = phone.trim();

    // Strip device suffix (e.g. :89 or :1) from JIDs
    if (phone.includes(':') && phone.includes('@')) {
      const [local, domain] = phone.split('@');
      phone = `${local.split(':')[0]}@${domain}`;
    }

    if (phone.endsWith('@g.us') || phone.endsWith('@s.whatsapp.net')) {
      return phone;
    }
    if (phone.endsWith('@c.us')) {
      let cleanNum = phone.replace('@c.us', '').replace(/[^0-9]/g, '');
      if (cleanNum.startsWith('920')) {
        cleanNum = '92' + cleanNum.slice(3);
      }
      return `${cleanNum}@s.whatsapp.net`;
    }
    if (phone.endsWith('@lid')) {
      return phone; // Keep LID canonical, do not resolve to phone number!
    }

    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.startsWith('920')) {
      clean = '92' + clean.slice(3);
    }
    return `${clean}@s.whatsapp.net`;
  }

  private formatCanonicalMessage(msg: WAMessage | any): any {
    if (!msg || !msg.key) return null;
    const key = msg.key;
    const realMessage = getRealMessage(msg.message || {});
    const messageType = Object.keys(realMessage)[0] || 'conversation';
    let remoteJid = (key.remoteJid || '').replace('@c.us', '@s.whatsapp.net');
    const participant = key.participant ? key.participant.replace('@c.us', '@s.whatsapp.net') : undefined;

    // ── Resolve @lid → phone so live and sync paths key chats identically ──
    // getChats() resolves @lid chat ids to their phone JID via lidToPhoneMap;
    // if live messages kept the raw @lid, the Python client (whose own
    // mapping cache starts empty and can only be filled from fields this
    // gateway never used to emit) would create a NEW chat under @lid for every
    // incoming 1:1 message while the real chat sits under the phone form —
    // "new message spawns a duplicate chat" and the open conversation never
    // updates. Resolve here, and surface the raw @lid as remoteJidAlt so the
    // Python client can learn the mapping for future lookups too.
    let remoteJidAlt: string | undefined;
    if (remoteJid.endsWith('@lid')) {
      const phone = this.resolveLidToPhone(remoteJid);
      if (phone) {
        remoteJidAlt = remoteJid;
        remoteJid = phone.replace('@c.us', '@s.whatsapp.net');
      }
    }

    let pushName = msg.pushName || '';
    if (!pushName && participant) {
      const senderJid = this.normalizeJid(participant);
      for (const [sess, store] of this.stores.entries()) {
        if (store && store.contacts) {
          const c = store.contacts[senderJid] || store.contacts[participant];
          if (c && (c.notify || c.name)) {
            pushName = c.notify || c.name;
            break;
          }
        }
      }
    }

    const keyOut: any = {
      remoteJid,
      fromMe: key.fromMe || false,
      id: key.id || '',
      participant
    };
    if (remoteJidAlt) {
      keyOut.remoteJidAlt = remoteJidAlt;
    }

    return {
      key: keyOut,
      pushName,
      message: realMessage,
      messageType,
      messageTimestamp: msg.messageTimestamp ? toNumber(msg.messageTimestamp) : Math.floor(Date.now() / 1000),
      broadcast: msg.broadcast || msg.isBroadcast || false,
      isBroadcast: msg.isBroadcast || false
    };
  }


  // ── Chat state ops (mute / pin / archive / clear / delete) ────────────────
  // These endpoints were part of the old WPPConnect client surface but were
  // never reimplemented after the Baileys gateway migration, so the Python
  // client got HTTP 404 for every mute/pin/archive/clear and the 60s chat-list
  // poll quietly reverted the local change ("app keeps breaking"). Baileys
  // exposes chatModify for all of them, so they're implemented for real here.

  public async sendMute(sessionRaw: string, phone: string, timeVal: number,
                        timeType: string, isGroup: boolean): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);

    // timeVal==0 means unmute. Otherwise compute an absolute mute-until
    // timestamp in ms. WPPConnect's sendMute contract: time in units of
    // timeType ('minutes'|'hours'); 0 = remove mute.
    if (timeVal === 0) {
      await sock.chatModify({ mute: null }, jid);
    } else {
      const unitMs = timeType === 'minutes' ? 60_000 : 3_600_000;
      const until = Date.now() + Math.round(Number(timeVal) * unitMs);
      await sock.chatModify({ mute: until }, jid);
    }
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async setPinChat(sessionRaw: string, phone: string, pinned: boolean): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    await sock.chatModify({ pin: pinned }, jid);
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async setArchiveChat(sessionRaw: string, phone: string, archived: boolean): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    // ChatModification's archive member also carries lastMessages; we don't need
    // to alter messages, so pass an empty list. The union member is
    // `{ archive: boolean; lastMessages: LastMessageList }` — providing both
    // satisfies the type without casting.
    await sock.chatModify({ archive: archived, lastMessages: [] } as any, jid);
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async clearChatMessages(sessionRaw: string, phone: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    await sock.chatModify({ clear: true }, jid);
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async deleteChatForEveryone(sessionRaw: string, phone: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    // Baileys has no first-class "delete whole chat" primitive; clear the
    // store copy so the next list-chats no longer reports it.
    const store = this.stores.get(session);
    if (store && store.chats) {
      try {
        store.chats.deleteById(jid);
      } catch (e) {
        // ignore store shape differences
      }
    }
    try {
      await sock.chatModify({ delete: true as any, lastMessages: [] as any }, jid as any);
    } catch (e) {
      // chatModify delete may not be supported server-side; the store removal
      // above already hides it from the chat list.
    }
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async getBlocklist(sessionRaw: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) return [];
    const blocked = await sock.fetchBlocklist();
    return Array.isArray(blocked) ? blocked.map((j) => ({ phone: j })) : [];
  }

  public async setBlockContact(sessionRaw: string, phone: string, block: boolean): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    await sock.updateBlockStatus(jid, block ? 'block' : 'unblock');
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async sendTyping(sessionRaw: string, phone: string, value: boolean): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    await sock.sendPresenceUpdate(value ? 'composing' : 'paused', jid);
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async sendRecording(sessionRaw: string, phone: string, value: boolean): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    await sock.sendPresenceUpdate(value ? 'recording' : 'paused', jid);
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async sendSeen(sessionRaw: string, phone: string, msgId?: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) return false;
    const jid = this.normalizeJid(phone);
    try {
      if (msgId) {
        const cleanId = msgId.includes('_') ? msgId.split('_')[2] : msgId;
        const cachedMsg = this.messageCache.get(cleanId);
        
        let keyToRead: any;
        if (cachedMsg && cachedMsg.key) {
          keyToRead = cachedMsg.key;
        } else {
          keyToRead = {
            remoteJid: jid,
            id: cleanId,
            fromMe: false
          };
          if (jid.endsWith('@g.us') && cachedMsg?.key?.participant) {
            keyToRead.participant = cachedMsg.key.participant;
          }
        }
        await sock.readMessages([keyToRead]);
        return true;
      } else {
        const store = this.stores.get(session);
        if (store && store.chats) {
          const c = store.chats.get(jid);
          if (c) c.unreadCount = 0;
        }
        let msgs: any[] = [];
        if (store?.messages) {
          msgs = store.messages[jid] ||
                 store.messages[jid.replace('@s.whatsapp.net', '@c.us')] ||
                 store.messages[jid.replace('@s.whatsapp.net', '@lid')] ||
                 store.messages[jid.replace('@c.us', '@s.whatsapp.net')] ||
                 [];
        }
        const keysToRead = Array.isArray(msgs)
          ? msgs.filter((m: any) => m && m.key && !m.key.fromMe).map((m: any) => m.key)
          : [];
        if (keysToRead.length > 0) {
          await sock.readMessages(keysToRead);
        }
        return true;
      }
    } catch (err) {
      return false;
    }
  }

  public async getLastSeen(sessionRaw: string, phone: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) return null;
    const jid = this.normalizeJid(phone);
    try {
      const pres = (sock as any).presences && (sock as any).presences.get(jid);
      if (pres && typeof pres.lastSeen === 'number') {
        return { t: pres.lastSeen };
      }
    } catch (e) {
      // presence store not populated — fall through
    }
    return null;
  }

  public async getProfileStatus(sessionRaw: string, phone: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) return '';
    const jid = this.normalizeJid(phone);
    try {
      const results = await sock.fetchStatus(jid);
      if (Array.isArray(results) && results[0]) {
        const st = (results[0] as any).status;
        return st || '';
      }
    } catch (e) {
      // fall through to ''
    }
    return '';
  }

  public async leaveGroup(sessionRaw: string, groupId: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(groupId);
    await sock.groupLeave(jid);
    return [{ id: { _serialized: jid }, fromMe: true, remote: jid }];
  }

  public async addGroupParticipants(sessionRaw: string, groupId: string,
                                    participantIds: string[]): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(groupId);
    const jids = (participantIds || []).map((p) => this.normalizeJid(p));
    await sock.groupParticipantsUpdate(jid, jids, 'add');
    return { groupId: jid, participants: jids };
  }

  public async deleteMessageForEveryone(sessionRaw: string, phone: string,
                                        messageId: string, onlyLocal: boolean): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    // messageId is the fully-serialized id (`<fromMe>_<chat>_<id>[_<participant>]`).
    const parts = String(messageId).split('_');
    const fromMe = parts[0] === 'true';
    const remoteJid = parts.length > 1 ? parts[1] : jid;
    const cleanId = parts.length > 2 ? parts[2] : messageId;
    const key: WAMessageKey = { remoteJid, fromMe, id: cleanId };

    if (onlyLocal) {
      await sock.chatModify({
        deleteForMe: { deleteMedia: true, key, timestamp: Math.floor(Date.now() / 1000) }
      } as any, jid);
    } else {
      await sock.sendMessage(jid, { delete: key } as any);
    }
    return { key };
  }

  public async editMessageForEveryone(sessionRaw: string, phone: string,
                                      messageId: string, newText: string,
                                      options?: any): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    const parts = String(messageId).split('_');
    const fromMe = parts[0] === 'true';
    const remoteJid = parts.length > 1 ? parts[1] : jid;
    const cleanId = parts.length > 2 ? parts[2] : messageId;
    const key: WAMessageKey = { remoteJid, fromMe, id: cleanId };

    const content: any = { text: newText, edit: key };
    if (options && options.mentionedJidList && Array.isArray(options.mentionedJidList)) {
      content.mentions = options.mentionedJidList.map((m: any) => this.normalizeJid(m));
    }
    await sock.sendMessage(jid, content);
    return { key };
  }

  public async forwardMessages(sessionRaw: string, phone: string,
                               messageIds: string[]): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    const store = this.stores.get(session);
    const forwarded = [];
    for (const fullId of (messageIds || [])) {
      const parts = String(fullId).split('_');
      const cleanId = parts.length > 2 ? parts[2] : fullId;
      let source: WAMessage | undefined = this.messageCache.get(cleanId) || this.messageCache.get(fullId);
      if (!source && store && store.messages) {
        for (const jidKey in store.messages) {
          const msgs = store.messages[jidKey];
          if (Array.isArray(msgs)) {
            source = msgs.find((m: WAMessage) => m.key?.id === cleanId);
            if (source) break;
          }
        }
      }
      if (!source) continue;
      const sent = await sock.sendMessage(jid, { forward: source });
      if (sent) forwarded.push(sent.key?.id || '');
    }
    return forwarded.map((id) => ({ id: { _serialized: id }, fromMe: true, remote: jid }));
  }

  public async sendContactVCard(sessionRaw: string, phone: string,
                                contactsIds: string[]): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');
    const jid = this.normalizeJid(phone);
    const store = this.stores.get(session);
    const contacts = (contactsIds || []).map((cid) => {
      const clean = this.normalizeJid(cid);
      let name = clean.split('@')[0];
      if (store && store.contacts) {
        const c = store.contacts[clean] || store.contacts[cid];
        if (c) name = c.name || c.notify || name;
      }
      return { displayName: name, vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nEND:VCARD` };
    });
    const sent = await sock.sendMessage(jid, {
      contacts: { displayName: contacts[0]?.displayName || '', contacts }
    });
    const msgId = sent?.key?.id || '';
    const serializedId = `true_${jid}_${msgId}`;
    return [{
      id: { _serialized: serializedId, id: msgId, fromMe: true, remote: jid },
      from: sock.user?.id || '', to: jid, fromMe: true, type: 'contact'
    }];
  }
}
