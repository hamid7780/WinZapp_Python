"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRouter = createRouter;
const express_1 = require("express");
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
                await sock.presenceSubscribe(manager.normalizeJid(phone));
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
            const { phone, base64, base64Ptt, base64Data } = req.body || {};
            const rawB64 = base64Ptt || base64 || base64Data || '';
            const resp = await manager.sendVoiceBase64(session, phone, rawB64);
            return res.status(200).json({ status: 'SUCCESS', response: resp });
        }
        catch (err) {
            return res.status(500).json({ status: 'ERROR', message: err.message });
        }
    });
    // Send File / Image Base64
    router.post(['/api/:session/send-file-base64', '/api/:session/send-image', '/api/:session/send-file'], authCheck, async (req, res) => {
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
    router.post('/api/:session/send-seen', authCheck, (req, res) => {
        return res.status(200).json({ status: 'SUCCESS' });
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
        const { lid } = req.params;
        const phone = manager.resolveLidToPhone(lid) || lid;
        return res.status(200).json({
            status: 'SUCCESS',
            response: {
                _serialized: phone,
                user: phone.split('@')[0]
            }
        });
    });
    // Get Contact Info
    router.get('/api/:session/contact/:jid', authCheck, (req, res) => {
        const { jid } = req.params;
        const cleanJid = manager.normalizeJid(jid);
        return res.status(200).json({
            status: 'SUCCESS',
            response: {
                id: { _serialized: cleanJid },
                name: cleanJid.split('@')[0],
                pushname: cleanJid.split('@')[0]
            }
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
        const msgs = manager.getMessages(session, phone);
        return res.status(200).json({ status: 'SUCCESS', response: msgs });
    });
    return router;
}
