# WinZapp — Baileys Gateway Migration Progress & Architecture Guide

## 1. Project Goal & Overview
WinZapp has been migrated from legacy **WPPConnect** (heavy Puppeteer / Headless Chrome backend, ~1,000 MB RAM, 30s boot time) to a lightweight **Baileys Gateway Server** (`@whiskeysockets/baileys` direct WebSocket engine, ~50–60 MB RAM, ~1s startup).

**Strategy A Enforcement**: The Python desktop client UI, accessibility engine (`nvda`/`sapi`), encrypted SQLite database (`messages.db`), and user interfaces (`client/main.py`, `client/ui/conversations.py`, `client/ui/dialogs/connect.py`) remain preserved while communicating seamlessly with the new Node.js Gateway Server on port `6300`.

---

## 2. Completed Milestones & Accomplishments

### A. Node.js Baileys Gateway Server (`client/api_patches/src/`)
1. **Baileys WebSocket Manager (`baileysManager.ts`)**:
   - Integrated `@whiskeysockets/baileys` with `useMultiFileAuthState`.
   - Added `getSafeSessionName()` to sanitize session strings and strip colons (`:`), preventing Windows NTFS folder creation failures (`ENOENT`).
   - Implemented direct 8-digit Phone Pairing Code generation via `sock.requestPairingCode(phone)`.
   - Added Node.js v18 Web Crypto polyfill (`globalThis.crypto = crypto.webcrypto || crypto`) at the very top of `server.ts` and `baileysManager.ts`, resolving `ReferenceError: crypto is not defined`.
2. **REST & Socket.IO API Compatibility (`routes.ts` & `server.ts`)**:
   - `/start-session`: Starts session, waits for pairing code, and returns `phoneCode` directly in HTTP JSON response + emits over Socket.IO `phoneCode` event.
   - Socket.IO server running on port `6300` emitting `qrCode`, `phoneCode`, `status-find`, `session-logged`, `messages.upsert`, `onack`, and `onpresencechanged`.
3. **Automated Setup & Compilation (`setup_api.py`)**:
   - Automatically syncs patches from `client/api_patches/` to `client/api/`.
   - Auto-terminates stale background `node.exe` processes before building to ensure newly compiled code (`dist/server.js`) is loaded fresh in RAM.

### B. Python Desktop Client Overhaul (`client/`)
1. **Connection Dialog (`client/ui/dialogs/connect.py`)**:
   - Added automatic country dial code detection (`_detect_default_dial_code()`) via Windows GeoLocation (`GetUserDefaultGeoName`) & system locale (auto-selects `Pakistan (+92)` on PK systems instead of hardcoded `Brazil (+55)`).
   - Added automatic leading zero stripping (e.g. `03001234567` + `92` -> `923001234567`), eliminating invalid 13-digit number mismatches.
   - Fixed `_bg_pairing_flow` race condition where `close-session` was closing the active new session socket during pairing setup.
   - Fixed `_call_start_session()` so `_phone_code_event.set()` is only called when an actual non-empty pairing code is received.
2. **WebSocket Client (`client/core/websocket_client.py`)**:
   - Added guard in `on_wpp_status_find` so status events (`notLogged`/`QRCODE`) are ignored while `_pairing_in_progress` is True. This prevents `show_connection_dial` from closing the open `pairing_dial` dialog.
3. **Legacy WPPConnect Cleanup (`client/main.py` & `client/updater.py`)**:
   - Completely removed legacy WPPConnect 90-second GitHub update checker (`wx.CallLater(90000, self._start_wpp_update_checker)`).
   - Neutered `ensure_wpp_version()`, `_check_wpp_version_pin()`, `_update_wpp_server()`, and `WppUpdateChecker._check_once()`.

---

## 3. Key Files Structure & Map

| File Path | Description |
|---|---|
| [`setup_api.py`](file:///d:/projects/WinZapp_Python/setup_api.py) | Setup script that compiles TypeScript patches in `client/api_patches/` to `client/api/dist/server.js`. |
| [`start_api.py`](file:///d:/projects/WinZapp_Python/start_api.py) | Standalone launcher for the Node.js Baileys Gateway Server on port 6300. |
| [`client/api_patches/src/baileysManager.ts`](file:///d:/projects/WinZapp_Python/client/api_patches/src/baileysManager.ts) | Core Baileys manager handling auth state, pairing codes, sockets, and session lifecycles. |
| [`client/api_patches/src/routes.ts`](file:///d:/projects/WinZapp_Python/client/api_patches/src/routes.ts) | Express REST endpoints matching WPPConnect signatures for client compatibility. |
| [`client/api_patches/src/server.ts`](file:///d:/projects/WinZapp_Python/client/api_patches/src/server.ts) | Express + Socket.IO server startup file with Node 18 crypto polyfills. |
| [`client/main.py`](file:///d:/projects/WinZapp_Python/client/main.py) | Main Python desktop GUI application, tray, audio, accessibility, and app startup engine. |
| [`client/ui/dialogs/connect.py`](file:///d:/projects/WinZapp_Python/client/ui/dialogs/connect.py) | Connection dialog UI, phone field input, country selector, and pairing code modal. |
| [`client/core/websocket_client.py`](file:///d:/projects/WinZapp_Python/client/core/websocket_client.py) | Socket.IO client handling real-time events between Python and Gateway Server. |

---

## 4. Operational Instructions for Developers / AI Agents

### How to Build & Run:
1. **Rebuild Gateway Server**:
   ```cmd
   venv\Scripts\python.exe setup_api.py
   ```
2. **Run Desktop Client**:
   ```cmd
   venv\Scripts\python.exe client/main.py
   ```
3. **Run Test Suite**:
   ```cmd
   venv\Scripts\python.exe -m pytest tests/test_api_patches_in_sync.py tests/test_database.py tests/test_notifications.py
   ```

### Important Verification Checklist:
- All 84 pytest unit tests pass cleanly.
- `client/api_patches/` files match compiled code in `client/api/dist/`.
- No lingering `node.exe` processes lock port `6300`.
