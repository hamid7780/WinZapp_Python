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
          this.io.emit('status-find', { status: 'DISCONNECTED', session });
          setTimeout(() => this.startSession(session), 3000);
        }
      }
    });

    // Handle Messaging History Sync
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      console.log(`[BaileysManager] messaging-history.set synced for ${session}: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`);
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (!msg.message) continue;
          const msgId = msg.key.id || '';
          if (msgId) {
            this.messageCache.set(msgId, msg);
          }
          const canonicalMsg = this.formatCanonicalMessage(msg);
          canonicalMsg.isMdHistoryMsg = true;

          this.io.emit('messages.upsert', {
            event: 'messages.upsert',
            instance: session,
            data: canonicalMsg
          });
        }
      }
      this.io.emit('messages.set', { session });
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

        // Also emit WPPConnect style received-message for extra safety
        this.io.emit('received-message', {
          session,
          response: this.formatWppMessage(msg, session)
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

    // Handle Messages Updates (ACKs)
    sock.ev.on('messages.update', async (updates) => {
      for (const u of updates) {
        if (u.update.status) {
          const ackVal = this.baileysStatusToAck(u.update.status);
          const remoteJid = u.key.remoteJid || '';
          const msgId = u.key.id || '';
          const serializedId = `${u.key.fromMe}_${remoteJid}_${msgId}`;

          this.io.emit('onack', {
            session,
            id: { _serialized: serializedId, id: msgId, fromMe: u.key.fromMe, remote: remoteJid },
            ack: ackVal,
            to: remoteJid
          });
        }
      }
    });

    // Handle Presence Updates
    sock.ev.on('presence.update', (pu) => {
      const jid = pu.id;
      const presences = pu.presences;
      if (presences && presences[jid]) {
        const p = presences[jid];
        const statusStr = p.lastKnownPresence || 'offline';
        this.io.emit('onpresencechanged', {
          session,
          id: jid,
          presence: statusStr
        });
      }
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

  public async sendMessage(sessionRaw: string, phone: string, text: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const jid = this.normalizeJid(phone);
    
    // Snappy UX: slight human typing simulation (150ms)
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch (e) {}

    const sent = await sock.sendMessage(jid, { text });
    const msgId = sent?.key?.id || '';
    const serializedId = `true_${jid}_${msgId}`;

    return [{
      id: { _serialized: serializedId, id: msgId, fromMe: true, remote: jid },
      from: sock.user?.id || '',
      to: jid,
      fromMe: true,
      type: 'chat',
      body: text,
      timestamp: sent?.messageTimestamp || Math.floor(Date.now() / 1000)
    }];
  }

  public async sendReply(sessionRaw: string, phone: string, text: string, quotedMsgId: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const jid = this.normalizeJid(phone);
    const cleanQuotedId = quotedMsgId.includes('_') ? quotedMsgId.split('_')[2] : quotedMsgId;
    const quotedMsg = this.messageCache.get(cleanQuotedId);

    const sent = await sock.sendMessage(jid, { text }, { quoted: quotedMsg });
    const msgId = sent?.key?.id || '';
    const serializedId = `true_${jid}_${msgId}`;

    return [{
      id: { _serialized: serializedId, id: msgId, fromMe: true, remote: jid },
      from: sock.user?.id || '',
      to: jid,
      fromMe: true,
      type: 'chat',
      body: text,
      timestamp: sent?.messageTimestamp || Math.floor(Date.now() / 1000)
    }];
  }

  public async sendVoiceBase64(sessionRaw: string, phone: string, base64Data: string): Promise<any> {
    const session = this.getSafeSessionName(sessionRaw);
    const sock = this.sessions.get(session);
    if (!sock) throw new Error('Session not connected');

    const jid = this.normalizeJid(phone);
    if (!base64Data) throw new Error('No base64 voice audio data provided');
    const cleanBase64 = base64Data.includes('base64,') ? base64Data.split('base64,')[1] : base64Data;
    const buffer = Buffer.from(cleanBase64, 'base64');

    try {
      await sock.sendPresenceUpdate('recording', jid);
    } catch (e) {}

    const sent = await sock.sendMessage(jid, {
      audio: buffer,
      ptt: true,
      mimetype: 'audio/ogg; codecs=opus'
    });

    const msgId = sent?.key?.id || '';
    const serializedId = `true_${jid}_${msgId}`;

    return [{
      id: { _serialized: serializedId, id: msgId, fromMe: true, remote: jid },
      from: sock.user?.id || '',
      to: jid,
      fromMe: true,
      type: 'ptt',
      timestamp: sent?.messageTimestamp || Math.floor(Date.now() / 1000)
    }];
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
    const msgId = sent?.key?.id || '';
    const serializedId = `true_${jid}_${msgId}`;

    return [{
      id: { _serialized: serializedId, id: msgId, fromMe: true, remote: jid },
      from: sock.user?.id || '',
      to: jid,
      fromMe: true,
      type: isImage ? 'image' : 'document',
      timestamp: sent?.messageTimestamp || Math.floor(Date.now() / 1000)
    }];
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
        const jid = this.normalizeJid(c.id);
        if (seenJids.has(jid)) continue;
        seenJids.add(jid);

        const chatTs = toNumber(c.conversationTimestamp || (c as any).t || 0);

        const isSelf = sock?.user?.id ? (this.normalizeJid(sock.user.id) === jid) : false;
        const isWppSystem = jid.startsWith('0@');

        if (isSelf || isWppSystem) {
          const msgs = store.messages[c.id] || store.messages[jid] || [];
          const hasMessages = Array.isArray(msgs) ? msgs.length > 0 : (msgs && typeof msgs === 'object' && Object.keys(msgs).length > 0);
          if (!hasMessages && c.unreadCount === 0 && !c.pinned) {
            continue;
          }
        }

        const contact = (store.contacts && store.contacts[c.id]) || (store.contacts && store.contacts[jid]) || {};
        const isGroup = jid.endsWith('@g.us');
        const name = c.name || (c as any).subject || contact.name || contact.notify || jid.split('@')[0];

        chats.push({
          id: { _serialized: jid },
          remoteJid: jid,
          name: name,
          pushName: contact.notify || contact.name || '',
          unreadCount: c.unreadCount || 0,
          isGroup: isGroup,
          t: chatTs,
          timestamp: chatTs
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
          id: { _serialized: jid },
          name: c.name || c.notify || jid.split('@')[0],
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
        id: { _serialized: cleanJid },
        name: contact.name || contact.notify || cleanJid.split('@')[0],
        pushname: contact.notify || contact.name || '',
        pushName: contact.notify || contact.name || '',
        isMyContact: true,
        isMe,
        number: cleanJid.split('@')[0]
      };
    }
    return {
      id: { _serialized: cleanJid },
      name: cleanJid.split('@')[0],
      pushname: cleanJid.split('@')[0],
      pushName: cleanJid.split('@')[0],
      isMyContact: false,
      isMe,
      number: cleanJid.split('@')[0]
    };
  }

  public getMessages(sessionRaw: string, phoneInput: any, count?: number): any[] {
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
    const sliced = rawMsgs.slice(-limit);
    const formatted: any[] = [];

    for (const m of sliced) {
      if (m && m.message) {
        formatted.push(this.formatWppMessage(m, session));
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
    const msgId = sent?.key?.id || '';
    const serializedId = `true_${jid}_${msgId}`;

    return [{
      id: { _serialized: serializedId, id: msgId, fromMe: true, remote: jid },
      from: sock.user?.id || '',
      to: jid,
      fromMe: true,
      type: 'chat',
      body: text,
      timestamp: sent?.messageTimestamp || Math.floor(Date.now() / 1000)
    }];
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

  private baileysStatusToAck(status: number): number {
    switch (status) {
      case 1: // PENDING
      case 2: // SERVER_ACK
        return 1;
      case 3: // DELIVERY_ACK
        return 2;
      case 4: // READ
        return 3;
      case 5: // PLAYED
        return 4;
      default:
        return 1;
    }
  }

  private formatCanonicalMessage(msg: WAMessage): any {
    const key = msg.key;
    const realMessage = getRealMessage(msg.message || {});
    const messageType = Object.keys(realMessage)[0] || 'conversation';
    const remoteJid = (key.remoteJid || '').replace('@c.us', '@s.whatsapp.net');

    return {
      key: {
        remoteJid,
        fromMe: key.fromMe || false,
        id: key.id || '',
        participant: key.participant ? key.participant.replace('@c.us', '@s.whatsapp.net') : undefined
      },
      pushName: msg.pushName || '',
      message: realMessage,
      messageType,
      messageTimestamp: msg.messageTimestamp ? toNumber(msg.messageTimestamp) : Math.floor(Date.now() / 1000)
    };
  }

  private formatWppMessage(msg: WAMessage, session?: string): any {
    const key = msg.key;
    const remoteJid = (key.remoteJid || '').replace('@c.us', '@s.whatsapp.net');
    const msgId = key.id || '';
    const serializedId = `${key.fromMe}_${remoteJid}_${msgId}`;

    const sessionName = session || this.sessions.keys().next().value || 'default';
    const myJid = this.normalizeJid(this.sessions.get(sessionName)?.user?.id || '');

    const realMessage = getRealMessage(msg.message || {});
    const text = realMessage.conversation || realMessage.extendedTextMessage?.text || realMessage.imageMessage?.caption || realMessage.videoMessage?.caption || realMessage.documentMessage?.caption || '';

    const isAudio = Boolean(realMessage.audioMessage);
    const isPtt = isAudio && Boolean(realMessage.audioMessage?.ptt !== false);
    const isImage = Boolean(realMessage.imageMessage);
    const isVideo = Boolean(realMessage.videoMessage);
    const isDocument = Boolean(realMessage.documentMessage);
    const isSticker = Boolean(realMessage.stickerMessage);

    let type = 'chat';
    if (isPtt) type = 'ptt';
    else if (isAudio) type = 'audio';
    else if (isImage) type = 'image';
    else if (isVideo) type = 'video';
    else if (isDocument) type = 'document';
    else if (isSticker) type = 'sticker';

    const duration = realMessage.audioMessage?.seconds || realMessage.videoMessage?.seconds || 0;
    const ts = msg.messageTimestamp ? toNumber(msg.messageTimestamp) : Math.floor(Date.now() / 1000);

    const fromJid = key.fromMe ? myJid : remoteJid;
    const toJid = key.fromMe ? remoteJid : myJid;

    // Extract media fields for clientUrl, mediaKey, and directPath
    const mediaMsg = realMessage.audioMessage || realMessage.imageMessage || realMessage.videoMessage || realMessage.documentMessage || realMessage.stickerMessage;
    const mediaKey = mediaMsg?.mediaKey ? (Buffer.isBuffer(mediaMsg.mediaKey) ? mediaMsg.mediaKey.toString('base64') : (typeof mediaMsg.mediaKey === 'object' && mediaMsg.mediaKey.type === 'Buffer' ? Buffer.from(mediaMsg.mediaKey.data).toString('base64') : String(mediaMsg.mediaKey))) : '';
    const clientUrl = mediaMsg?.url || '';
    const directPath = mediaMsg?.directPath || '';

    return {
      id: { _serialized: serializedId, id: msgId, fromMe: key.fromMe || false, remote: remoteJid },
      from: fromJid,
      to: toJid,
      fromMe: key.fromMe || false,
      type,
      body: text,
      caption: text,
      text,
      duration,
      seconds: duration,
      mimetype: realMessage.audioMessage?.mimetype || realMessage.imageMessage?.mimetype || realMessage.documentMessage?.mimetype || '',
      t: ts,
      timestamp: ts,
      participant: key.participant || '',
      author: key.participant || '',
      clientUrl,
      mediaKey,
      directPath,
      sender: {
        id: key.fromMe ? myJid : (key.participant || remoteJid),
        pushname: key.fromMe ? 'Me' : (msg.pushName || '')
      }
    };
  }
}
