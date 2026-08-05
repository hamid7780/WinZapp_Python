"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRouter = createRouter;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
function createRouter(manager) {
    const router = (0, express_1.Router)();
    // Helper auth check middleware
    const authCheck = (req, res, next) => {
        // Strategy A: Accept all requests from local Python client
        next();
    };
    // Generate Token
    router.post('/api/:session/:secretkey/generate-token', (req, res) => {
        const { session, secretkey } = req.params;
        const token = `${session}_token_${Date.now()}`;
        return res.status(200).json({
            status: 'Success',
            session,
            token
        });
    });
    // Start Session
    router.post('/api/:session/start-session', async (req, res) => {
        try {
            const { session } = req.params;
            const { phone } = req.body || {};
            const status = await manager.startSession(session, phone);
            let phoneCode = manager.getPairingCode(session);
            if (phone && !phoneCode) {
                for (let i = 0; i < 10; i++) {
                    await new Promise((r) => setTimeout(r, 400));
                    phoneCode = manager.getPairingCode(session);
                    if (phoneCode)
                        break;
                }
            }
            return res.status(200).json({
                status,
                session,
                phoneCode: phoneCode || ''
            });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Close Session / Logout
    router.post(['/api/:session/close-session', '/api/:session/logout-session'], async (req, res) => {
        try {
            const { session } = req.params;
            await manager.closeSession(session);
            return res.status(200).json({ status: 'SUCCESS', message: 'Session closed' });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Check Connection Session
    router.get('/api/:session/check-connection-session', authCheck, (req, res) => {
        const { session } = req.params;
        const isConnected = manager.isConnected(session);
        return res.status(200).json({
            status: isConnected,
            message: isConnected ? 'Connected' : 'Disconnected'
        });
    });
    // Status Session
    router.get('/api/:session/status-session', authCheck, (req, res) => {
        const { session } = req.params;
        const status = manager.getStatus(session);
        return res.status(200).json({
            status,
            session
        });
    });
    // Reconnect Socket Stream
    router.post('/api/:session/reconnect-socket-stream', authCheck, async (req, res) => {
        const { session } = req.params;
        manager.startSession(session);
        return res.status(200).json({ status: 'SUCCESS' });
    });
    // Host Device
    router.get('/api/:session/host-device', authCheck, (req, res) => {
        const { session } = req.params;
        const sock = manager.getSocket(session);
        const userJid = sock?.user?.id ? manager.normalizeJid(sock.user.id) : '';
        return res.status(200).json({
            status: 'SUCCESS',
            response: {
                wid: { _serialized: userJid },
                phoneNumber: { _serialized: userJid }
            }
        });
    });
    // Set Limit (No-op compatibility)
    router.post('/api/:session/set-limit', authCheck, (req, res) => {
        return res.status(200).json({ status: 'SUCCESS' });
    });
    // Set Online Presence
    router.post('/api/:session/set-online-presence', authCheck, async (req, res) => {
        const { session } = req.params;
        const { isOnline } = req.body || {};
        const sock = manager.getSocket(session);
        if (sock) {
            try {
                await sock.sendPresenceUpdate(isOnline ? 'available' : 'unavailable');
            }
            catch (e) { }
        }
        return res.status(200).json({ status: 'SUCCESS' });
    });
    // Subscribe Presence
    router.post('/api/:session/subscribe-presence', authCheck, async (req, res) => {
        const { session } = req.params;
        const { phone } = req.body || {};
        const sock = manager.getSocket(session);
        if (sock && phone) {
            try {
                let targetJid = manager.normalizeJid(phone);
                if (targetJid.endsWith('@lid')) {
                    const resolved = manager.resolveLidToPhone(targetJid);
                    if (resolved) {
                        targetJid = manager.normalizeJid(resolved);
                    }
                }
                await sock.presenceSubscribe(targetJid);
            }
            catch (e) { }
        }
        return res.status(200).json({ status: 'SUCCESS' });
    });
    // Send Message
    router.post('/api/:session/send-message', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, message } = req.body || {};
            const resp = await manager.sendMessage(session, phone, message);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Send Reply
    router.post('/api/:session/send-reply', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, message, messageId } = req.body || {};
            const resp = await manager.sendReply(session, phone, message, messageId);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Send Mentioned
    router.post('/api/:session/send-mentioned', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, message } = req.body || {};
            const resp = await manager.sendMessage(session, phone, message);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Send Voice Base64
    router.post('/api/:session/send-voice-base64', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, base64, base64Ptt, base64Data, duration } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            const rawB64 = base64Ptt || base64 || base64Data || '';
            const durationVal = duration ? parseInt(duration, 10) : 0;
            const resp = await manager.sendVoiceBase64(session, phoneVal, rawB64, durationVal);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Send File / Image Base64
    // NOTE: the Python client's send_media_attachment POSTs multipart/form-data
    // (a real `file` field, plus phone/type/caption form fields) to /send-file,
    // NOT a JSON body with a base64 string. The old route only read JSON base64,
    // so every media send from the client arrived with an empty payload and the
    // gateway sent nothing. The multipart route below (multer) handles that
    // client; the base64 routes below it stay for the older JSON callers.
    const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });
    router.post('/api/:session/send-file', authCheck, upload.single('file'), async (req, res) => {
        try {
            const { session } = req.params;
            const body = req.body || {};
            const file = req.file;
            const phoneVal = Array.isArray(body.phone) ? body.phone[0] : body.phone;
            const type = String(body.type || 'document').toLowerCase();
            const isImage = type === 'image';
            const caption = body.caption || '';
            let rawB64 = '';
            if (file && file.buffer && file.buffer.length > 0) {
                rawB64 = file.buffer.toString('base64');
            }
            const resp = await manager.sendMediaBase64(session, phoneVal, rawB64, caption, isImage);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    router.post(['/api/:session/send-file-base64', '/api/:session/send-image'], authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, base64, base64Data, caption, isImage } = req.body || {};
            const rawB64 = base64 || base64Data || '';
            const resp = await manager.sendMediaBase64(session, phone, rawB64, caption, isImage !== false);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // React Message
    router.post('/api/:session/react-message', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { msgId, reaction } = req.body || {};
            await manager.reactMessage(session, msgId, reaction);
            return res.status(200).json({ status: 'SUCCESS' });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Pin Message
    router.post('/api/:session/pin-message', authCheck, async (req, res) => {
        return res.status(200).json({ status: 'SUCCESS' });
    });
    // Send Seen
    router.post('/api/:session/send-seen', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, msgId } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            await manager.sendSeen(session, phoneVal, msgId);
            return res.status(200).json({ status: 'SUCCESS' });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Get Media by Message
    router.post('/api/:session/get-media-by-message/:msgId', authCheck, async (req, res) => {
        try {
            const { session, msgId } = req.params;
            const base64Data = await manager.getMediaByMessage(session, msgId, req.body);
            return res.status(200).json({ status: 'SUCCESS', response: base64Data });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Get Contact by LID
    router.get('/api/:session/contact/pn-lid/:lid', authCheck, (req, res) => {
        const { session, lid } = req.params;
        const phone = manager.resolveLidToPhone(lid);
        const targetJid = phone || lid;
        const contact = manager.getContact(session, targetJid);
        return res.status(200).json({
            status: 'SUCCESS',
            response: {
                _serialized: phone || lid,
                id: { _serialized: phone || lid },
                user: (phone || lid).split('@')[0],
                pnJid: phone || '',
                phoneNumber: phone || '',
                contact: contact
            }
        });
    });
    // Get Contact Info
    router.get('/api/:session/contact/:jid', authCheck, (req, res) => {
        const { session, jid } = req.params;
        const contact = manager.getContact(session, jid);
        return res.status(200).json({
            status: 'SUCCESS',
            response: contact
        });
    });
    // Group Info
    router.get('/api/:session/group-info/:groupId', authCheck, async (req, res) => {
        try {
            const { session, groupId } = req.params;
            const metadata = await manager.getGroupInfo(session, groupId);
            return res.status(200).json({ status: 'SUCCESS', response: metadata });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Create Group
    router.post('/api/:session/create-group', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { groupName, phones } = req.body || {};
            const result = await manager.createGroup(session, groupName, phones || []);
            return res.status(200).json({ status: 'SUCCESS', response: result });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // List Chats
    router.all('/api/:session/list-chats', authCheck, (req, res) => {
        const { session } = req.params;
        const chats = manager.getChats(session);
        return res.status(200).json({ status: 'SUCCESS', response: chats });
    });
    // All Contacts
    router.all('/api/:session/all-contacts', authCheck, (req, res) => {
        const { session } = req.params;
        const contacts = manager.getContacts(session);
        return res.status(200).json({ status: 'SUCCESS', response: contacts });
    });
    // Get Messages
    router.get('/api/:session/get-messages/:phone', authCheck, (req, res) => {
        const { session, phone } = req.params;
        const count = req.query.count ? parseInt(String(req.query.count), 10) : undefined;
        const direction = req.query.direction ? String(req.query.direction) : undefined;
        const beforeId = req.query.id ? String(req.query.id) : undefined;
        const msgs = manager.getMessages(session, phone, count, direction, beforeId);
        return res.status(200).json({ status: 'SUCCESS', response: msgs });
    });
    // ── Chat-state / group / misc endpoints reimplemented after the Baileys
    // ── migration. The Python client still calls these; without them it got 404
    // ── and the 60s chat-list poll reverted mute/pin/archive silently.
    // Send Mute
    router.post('/api/:session/send-mute', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, time, type, isGroup } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            const resp = await manager.sendMute(session, phoneVal, Number(time) || 0, type || 'hours', Boolean(isGroup));
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Pin / Unpin Chat
    router.post('/api/:session/pin-chat', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, state } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            const pinned = String(state).toLowerCase() === 'true';
            const resp = await manager.setPinChat(session, phoneVal, pinned);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Archive Chat
    router.post('/api/:session/archive-chat', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, archive, archived } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            const arch = archive !== undefined ? archive : archived;
            const resp = await manager.setArchiveChat(session, phoneVal, Boolean(arch));
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Clear Chat
    router.post('/api/:session/clear-chat', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            const resp = await manager.clearChatMessages(session, phoneVal);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Delete Chat
    router.post('/api/:session/delete-chat', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            const resp = await manager.deleteChatForEveryone(session, phoneVal);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Blocklist
    router.get('/api/:session/blocklist', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const resp = await manager.getBlocklist(session);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Block / Unblock Contact
    router.post('/api/:session/block-contact', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone } = req.body || {};
            const resp = await manager.setBlockContact(session, phone, true);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    router.post('/api/:session/unblock-contact', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone } = req.body || {};
            const resp = await manager.setBlockContact(session, phone, false);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Typing / Recording presence
    router.post('/api/:session/typing', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, value } = req.body || {};
            const resp = await manager.sendTyping(session, phone, Boolean(value));
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    router.post('/api/:session/recording', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, value } = req.body || {};
            const resp = await manager.sendRecording(session, phone, Boolean(value));
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Last Seen
    router.get('/api/:session/last-seen/:phone', authCheck, async (req, res) => {
        try {
            const { session, phone } = req.params;
            const resp = await manager.getLastSeen(session, phone);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(200).json({ status: 'SUCCESS', response: null });
        }
    });
    // Profile Status (About)
    router.get('/api/:session/profile-status/:phone', authCheck, async (req, res) => {
        try {
            const { session, phone } = req.params;
            const resp = await manager.getProfileStatus(session, phone);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(200).json({ status: 'SUCCESS', response: '' });
        }
    });
    // Leave Group
    router.post('/api/:session/leave-group', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { groupId } = req.body || {};
            const resp = await manager.leaveGroup(session, groupId);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Add Participant To Group
    router.post('/api/:session/add-participant-group', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { groupId, participantId } = req.body || {};
            const resp = await manager.addGroupParticipants(session, groupId, participantId || []);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Delete Message (revoke for everyone / local only)
    router.post('/api/:session/delete-message', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, messageId, onlyLocal } = req.body || {};
            const resp = await manager.deleteMessageForEveryone(session, phone, messageId, Boolean(onlyLocal));
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Edit Message
    router.post('/api/:session/edit-message', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { id, newText, options } = req.body || {};
            const parts = String(id).split('_');
            const phone = parts.length > 1 ? parts[1] : '';
            const resp = await manager.editMessageForEveryone(session, phone, id, newText, options);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Forward Messages
    router.post('/api/:session/forward-messages', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, messageId } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            const ids = Array.isArray(messageId) ? messageId : [messageId];
            const resp = await manager.forwardMessages(session, phoneVal, ids);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Contact VCard
    router.post('/api/:session/contact-vcard', authCheck, async (req, res) => {
        try {
            const { session } = req.params;
            const { phone, contactsId } = req.body || {};
            const phoneVal = Array.isArray(phone) ? phone[0] : phone;
            const resp = await manager.sendContactVCard(session, phoneVal, contactsId || []);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    return router;
}
