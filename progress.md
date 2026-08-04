# WinZapp — Progress Map

## What this is

WinZapp is a free, self-hosted Windows desktop WhatsApp client for **accessibility** (blind/low-vision users via NVDA/JAWS/Narrator through `accessible_output2`). It is a hybrid app: a Python 3.14 + wxPython GUI process (`client/`) drives a locally-run **Baileys Gateway Server** (`client/api/`, Node.js) that acts as the WhatsApp Web gateway. The two talk over local HTTP REST (`http://127.0.0.1:6300/api/...`) and Socket.IO.

> **WPPConnect is gone.** The legacy `@wppconnect-team` translation layer was completely removed. The gateway and Python UI now communicate strictly using native Baileys data structures.

## Current status (2026-08-04)

**753 passing / 0 failing** pytest tests across the entire test suite!

- `python setup_api.py` compiles clean with 0 TypeScript errors.
- `python -m pytest` passes **753/753 tests**.

## Comprehensive Refactoring & Native Baileys Migration

### Phase A — Gateway Server & Native Data Shapes
1. **Baileys WebSocket Manager (`baileysManager.ts`)**:
   - Integrated `@whiskeysockets/baileys` with `useMultiFileAuthState`.
   - Stripped legacy translation functions (`_normalize_wpp_message`, `formatWppMessage`, `baileysStatusToAck`, `ack_to_status`).
   - Standardized Socket.IO events to native Baileys payloads: `messages.upsert`, `messages.update`, `presence.update`, `chats.update`.
   - Native JID handling (`@s.whatsapp.net`, `@g.us`, `@lid`) across REST and Socket.IO without arbitrary `@c.us` conversions.
   - Automatic disk data wipe implemented on logout/pairing reset (`clear_local_data()`).

### Phase B — Critical Tracing & Fixes

1. **Voice Message Immediate Send Failure Fix**:
   - Extracted `msg_id` from canonical native message responses (`key.id`) instead of `resp.id` (which was `None`), fixing immediate status timeouts.
   - Added WAV audio header detection (`RIFF`) and automatic mimetype fallback (`audio/wav`) in `sendVoiceBase64` so voice recording works even on systems without FFmpeg binaries.
   - Configured FFmpeg Opus conversion to 48000 Hz Mono PTT standard (`-ar 48000 -b:a 32k`).

2. **Phantom / Empty Chat List Clean-up**:
   - Filtered out 1:1 and self chats from `getChats()` in `baileysManager.ts` that have no activity (`conversationTimestamp === 0`, no messages, no unread, not pinned).
   - Resolved `@lid` JIDs using `lidToPhoneMap` to prevent duplicate unnamed phantom chats.

3. **Pinned Chat Stability Fix**:
   - Updated `chats.update` delta handling in `baileysManager.ts` to only include `pinned` property when explicitly modified, preventing unread or last-message updates from accidentally clearing pinned status.
   - Fixed real-time `pinned` key detection in `websocket_client.py`.

4. **Self-Chat & Group Participant Name Resolution**:
   - Ensured self-chat (`isSelf`) is never skipped if it contains messages, and formatted it with proper display name.
   - Added fallback to `store.contacts` inside `formatCanonicalMessage` for missing `pushName` values on group participant messages.

5. **Read Receipt & Unread Sync**:
   - Preserved clean native JIDs in `mark_conversation_as_read` (`main.py`).
   - Added `store.chats.get(jid).unreadCount = 0` reset inside `sendSeen` in `baileysManager.ts`.

6. **Socket Auto-Reconnect Safeguard**:
   - Updated `connection === 'close'` handler in `baileysManager.ts` to emit `status-find` with `status: 'INITIALIZING'` (instead of `'DISCONNECTED'`) when `shouldReconnect: true`, preventing false logout triggers.

7. **Process Management**:
   - Enforced `taskkill /F /IM node.exe` in `setup_api.py` during builds to clear orphaned gateway processes.

## Key files

| File | Role |
|---|---|
| `client/main.py` | Python wxPython UI + business logic (~14k lines). |
| `client/core/websocket_client.py` | Socket.IO client, event normalization, live/historical routing. |
| `client/core/database.py` / `database_bridge.py` | Async SQLite (aiosqlite) + sync façade. |
| `client/core/message_queue.py` | Outgoing-send queue with ambiguous-failure handling. |
| `client/ui/conversations.py` | Conversation list/panel rendering, voice recording/playback. |
| `client/api_patches/src/` | **Source of truth** for the Baileys gateway (copied to `client/api/src/`, compiled to `dist/`). |
| `client/api/` | Built gateway (git-ignored except `dist/`, `start.js`, `package.json`, `config.json`). |
| `setup_api.py` | Sync `api_patches` → `api` + `npm install` + build + process kill. |
| `build.py` | PyInstaller release build (onedir/onefile). |

## How to run / build / test

```powershell
# Dev run
cd client; python main.py

# Rebuild gateway after touching client/api_patches/src/
venv\Scripts\python.exe setup_api.py

# Tests (from repo root)
pytest
```
