# WinZapp Bug Registry

This file is the single source of truth for all known bugs in the WinZapp codebase. Every bug found during code audits, testing, or user reports should be documented here so repeated full-project scans are unnecessary.

## How This File Works

- Each bug has a unique ID (BUG-XXXX), a severity, a status, and a detailed description.
- When a bug is fixed, the fixer writes a "Fix Notes" section directly under the bug, describing which file(s) were changed, what line numbers were affected, and what was done. No code snippets needed, just a clear description.
- After fix notes are written, the status changes to "FIXED — User Verification Required". The bug stays in this state until the user explicitly confirms the fix works. Only then does it move to "VERIFIED".
- Severity levels: SEVERE, HIGH, MEDIUM, LOW, ULTRA LOW, COSMETIC.

---

## SEVERE

### BUG-0001: `_just_paired` unconditionally set to True on every startup
**File:** `client/main.py`, line 875
**Status:** OPEN

Inside the `_connect_bg()` closure (the background thread that connects the WebSocket after init), line 875 unconditionally sets `self._just_paired = True` at the end of the function, regardless of whether the user actually just paired. This overwrites the value that was carefully set to True only when the connection dialog was shown and pairing completed (line 793). On a normal startup where the user was already paired, `_just_paired` starts as False (line 764) but gets flipped to True by this background thread. This means `_check_quick_tip` (line 996) fires on every single launch instead of only after a fresh pairing, and any other logic that checks `_just_paired` to distinguish "first connection" from "reconnection" is broken.

---

### BUG-0002: Thread-safety crash in FFmpeg download dialog
**File:** `client/ui/dialogs/ffmpeg_download.py`, lines 107, 131, 148, 170
**Status:** OPEN

The background thread `_run_download` catches exceptions and calls `self._finish_error(str(exc))`. The `_finish_error` method (line 93) directly calls `wx.MessageBox`, `self.EndModal`, and `_timer.Stop()`. In wxPython, interacting with GUI elements from a background thread will randomly crash or freeze the app. All calls to `_finish_error` from the download thread must be wrapped in `wx.CallAfter()`.

---

### BUG-0003: Thread-safety crash in Node.js download dialog
**File:** `client/ui/dialogs/node_download.py`, lines 107-113, 121, 151
**Status:** OPEN

Same bug as BUG-0002. The `_run_download` background thread invokes `_finish_error`, which directly calls `wx.MessageBox` and `self.EndModal(wx.ID_CANCEL)`. These must be marshalled to the main thread via `wx.CallAfter`.

---

### BUG-0004: `clear_sessions.py` accidentally deletes local database and settings
**File:** `clear_sessions.py`, lines 53-54
**Status:** OPEN

The script aims to clear API session tokens, but blindly calls `shutil.rmtree()` on `client/data`. This directory contains `settings_default.json` and the local SQLite database (`messages.db`). Executing this script will destroy the user's entire local chat history and application settings.

---

### BUG-0005: Missing `node_modules` in default onedir build
**File:** `build.py`, lines 238-239 and 605-608
**Status:** OPEN

`API_EXCLUDE_DIRS` explicitly contains `"node_modules"`. When the default `--onedir` build mode uses `walk_dir` to assemble the staging directory, it skips `node_modules`. The built Baileys Gateway Server is shipped without its dependencies and will immediately crash when the user attempts to run the app.

---

### BUG-0006: Destructive Chrome/Chromium force-kill leftover from Puppeteer era
**File:** `kill_api.py`, lines 44-45 / `clear_sessions.py`, lines 44-45
**Status:** OPEN

A leftover from the Puppeteer era, these scripts violently execute `taskkill /F /IM chrome.exe` and `chromium.exe`. This will forcefully close the user's personal web browser system-wide, causing immediate data loss of any open tabs or unsaved web work. Under Baileys, Chrome is never launched by WinZapp, so these kill commands should be removed entirely.

---

### BUG-0007: `_restart_wpp_session()` uses stale Puppeteer-era close-session/start-session API
**File:** `client/main.py`, lines 5132-5198
**Status:** OPEN

This method was designed for the old WPPConnect+Puppeteer architecture. It POSTs to `/close-session` then `/start-session` to restart a dead Chrome/Puppeteer browser page. Under the Baileys gateway, these endpoints may behave differently or not exist at all. The method's docstring still references "WPPConnect Chrome session" and "Puppeteer page" and "detached frame." If Baileys does not implement these endpoints with the same semantics, calling this method after a suspend/resume cycle could fail silently (the except clauses swallow errors) or worse, accidentally kill and restart the WhatsApp session.

---

### BUG-0008: `_nudge_whatsapp_socket_stream()` calls a Puppeteer-specific endpoint
**File:** `client/main.py`, lines 5073-5111
**Status:** OPEN

This method calls `/reconnect-socket-stream`, an endpoint that runs `WPP.whatsapp.Cmd.openSocketStream()` inside a Puppeteer-controlled Chrome page. Under Baileys, there is no browser page, no DOM, and no `WPP.whatsapp.Cmd` object. The health checker calls this method on every resume-from-sleep cycle, so it silently fails each time, and the `_DEAD_BROWSER_RESTART_STRIKES` counter accumulates, eventually triggering `_restart_wpp_session()` unnecessarily.

---

### BUG-0044: Sync creates duplicate top-level chats under raw username/JID when messages arrive offline
**File:** `client/main.py`, lines 6821-7035 (`deduplicate_chats`), lines 6349-6550 (`get_remote_chats`)
**Status:** OPEN

When the app is closed and the user sends/receives messages on their phone, restarting the app triggers a sync where incoming messages under `@lid` or raw JIDs fail to match existing canonical `@s.whatsapp.net` chats in `self.chats`. Instead of merging into the existing named contact chat, a duplicate top-level chat is created with the raw WhatsApp username or JID, routing offline messages into the duplicate chat.

---

### BUG-0045: Deleted or fake chats cannot be deleted permanently and resurrect on restart
**File:** `client/main.py`, lines 6370-6415, 6848-6904
**Status:** OPEN

Once a phantom or duplicate chat entry appears in `self.chats`, deleting it does not reliably purge both its `@lid` and `@s.whatsapp.net` forms from `self._deleted_chats` and SQLite DB tables. When periodic polling (`get_remote_chats()`) runs or the app restarts, the chat is re-inserted from server state, forcing users to disconnect session and re-pair.

---

### BUG-0046: Background history sync halts mid-way, creating missing message gaps
**File:** `client/main.py`, lines 8055-8095, `client/core/database_bridge.py`, lines 112-159
**Status:** OPEN

During initial or catch-up sync, history sync threads encounter lock contention or timeout exceptions in `DatabaseBridge._call()`. When an unhandled exception occurs inside a batch, the sync thread terminates quietly without retrying, leaving history sync in an incomplete state with missing message gaps.

---

## HIGH

### BUG-0009: 64-bit pointer truncation in ShellExecuteW in updater
**File:** `client/updater.py`, lines 344-346
**Status:** OPEN

The updater uses `ctypes.windll.shell32.ShellExecuteW` without specifying a `.restype`. In 64-bit Python, `ctypes` defaults to returning a 32-bit `c_int`. The 64-bit `HINSTANCE` pointer returned by the Windows API gets truncated, frequently yielding a negative number or a value <= 32. This falsely triggers the `update_uac_declined` error check, causing legitimate update attempts to abort.

---

### BUG-0010: xcopy command line corrupted by trailing backslash in updater
**File:** `client/updater.py`, line 322
**Status:** OPEN

In the generated batch script: `xcopy /E /Y /I /H "{source_dir}\\*" "{install_dir}\\"`. The trailing backslash right before the closing quote (`\"`) causes the Windows Command Prompt to treat it as an escaped literal quote. This swallows the closing quote, corrupting the command line syntax and causing updates to fail silently if paths contain spaces.

---

### BUG-0011: `start_api.py` fails to use portable Node executable
**File:** `start_api.py`, line 33
**Status:** OPEN

While `build_api.py` and `setup_api.py` correctly prioritize the shipped portable Node binary (`client/node/node.exe`), `start_api.py` hardcodes `subprocess.Popen(["node", ...])`. If `node` is missing from the system PATH or is an incompatible version, the API will fail to start.

---

### BUG-0012: Global taskkill of node.exe disrupts other applications
**File:** `setup_api.py`, line 40
**Status:** OPEN

The setup script runs `subprocess.run(["taskkill", "/F", "/IM", "node.exe"])` on Windows. This indiscriminately kills all Node.js processes running on the user's computer, disrupting unrelated local development or background applications.

---

### BUG-0013: Stale Puppeteer environment variable still set on every startup
**File:** `client/main.py`, line 3613
**Status:** OPEN

`os.environ["PUPPETEER_CACHE_DIR"]` is still set to `resource_path("api", ".cache", "puppeteer")` every time the WPP server starts. The project has migrated to Baileys which does not use Puppeteer or Chrome. If any dependency reads `PUPPETEER_CACHE_DIR`, it could attempt to write to a nonexistent directory, causing confusing errors.

---

### BUG-0014: Health checker docstring and logic reference "auto-restart Puppeteer"
**File:** `client/main.py`, line 4890
**Status:** OPEN

`start_connection_health_checker()` docstring says "Periodically verify session health and auto-restart Puppeteer if closed." The entire recovery path after suspend/resume is built around the assumption that there is a Chrome browser that can crash. Under Baileys, the failure modes are completely different (the Baileys WebSocket to WhatsApp servers can disconnect, but there is no browser page to die), and the recovery mechanism needs to be redesigned.

---

### BUG-0015: `on_wpp_qrcode()` wraps QR data in unnecessary nested structure
**File:** `client/core/websocket_client.py`, lines 894-909
**Status:** OPEN

`on_wpp_qrcode()` receives `data["data"]` as a base64 image string, then re-wraps it as `{"data": {"qrcode": {"base64": qrcode_base64}}}` before passing to `on_qrcode_update()`. But `_extract_qr_payload()` was specifically fixed to handle the flat string format. This double-wrapping is fragile and misleading.

---

### BUG-0016: `_set_wpp_limits()` calls a Puppeteer-specific `/set-limit` endpoint
**File:** `client/core/websocket_client.py`, lines 966-992
**Status:** OPEN

This method POSTs to `/set-limit` with `maxMediaSize` and `maxFileSize` parameters. Under Baileys, file size limits are handled differently (they are properties of the Baileys socket configuration). If the Baileys gateway does not implement this endpoint, these calls fail silently, meaning file size limits are never actually raised.

---

### BUG-0017: `on_wpp_status_find()` calls `_handle_logout()` without `_logout_confirmed()` guard
**File:** `client/core/websocket_client.py`, lines 1006-1016
**Status:** OPEN

When a `status-find` event arrives with `disconnectedMobile`/`notLogged`/`QRCODE` and the user was previously paired and `_wa_connected` is True, it directly calls `_handle_logout()`. This bypasses all the careful multi-strike, timed confirmation, and `_still_linked_on_server()` checks in `_logout_confirmed()`. A single transient status-find event could wipe local data unnecessarily.

---

### BUG-0018: Stale WPPConnect source files in build config prevent Baileys inclusion
**File:** `build.py`, lines 255 and 263-271
**Status:** OPEN

`API_CUSTOM_SRC_FILES` hardcodes legacy WPPConnect source files (`src/config.ts`, `src/util/createSessionUtil.ts`). Since `"src"` is globally excluded by `API_EXCLUDE_DIRS`, the actual Baileys source files (`server.ts`, `baileysManager.ts`) are never copied to the staging `api_patches` directory, making them invisible in the build output.

---

### BUG-0019: Unquoted shell path in `start_api.py` breaks on paths with spaces
**File:** `start_api.py`, line 37
**Status:** OPEN

On Linux, `stdout_log` is injected into a `shell=True` command string without surrounding quotes. If the installation path contains spaces, the shell will misinterpret the redirection path, causing the API startup command to fail.

---

### BUG-0047: Pinned chats fail to stay at the top of the conversation list
**File:** `client/main.py`, lines 7779-7985 (`_sort_key`)
**Status:** OPEN

In `set_chats()`, the sorting key `_sort_key` evaluates `pin = 0 if (self._canonical_jid(rjid) in pinned or rjid in pinned) else 1`. When a chat key is stored as `@lid` while `rjid` or `pinned` set contains `@s.whatsapp.net` (or vice versa), the check returns False (`pin = 1`). Consequently, pinned chats sink down into the list as unpinned chats receive new activity.

---

### BUG-0048: Sent message delivery ticks never progress to Read (blue ticks) or Played
**File:** `client/main.py`, lines 10562-10660 (`on_message_status_update`), `client/ui/conversations.py`
**Status:** OPEN

When Baileys emits `messages.update` status events (`READ`=3, `PLAYED`=4), `on_message_status_update()` fails to match candidate JIDs or update the message record's `MessageUpdate` structure cleanly. As a result, sent messages stay marked as "delivered" indefinitely, never showing blue ticks or voice note played status.

---

### BUG-0049: Contact names show as "Unnamed" or raw phone/JID numbers
**File:** `client/main.py`, lines 7817-7905, `client/ui/dialogs/new_group.py`, line 70
**Status:** OPEN

`_resolve_contact_name()` and fallback logic in `set_chats()` fail to resolve pushName or address book names when contacts originate from `@lid` JIDs or Baileys sync. Contacts fall back to unformatted numbers or raw JIDs like `551199999999@c.us`, which screen readers announce digit-by-digit.

---

### BUG-0050: Broadcast list messages create phantom empty conversations in main chat list
**File:** `client/main.py`, lines 6406-6414, lines 7788-7804
**Status:** OPEN

When a message is sent to a broadcast list or recipient, `get_remote_chats()` and `on_new_message()` create chat entries where `remoteJid` or `key.remoteJid` is a `@broadcast` JID or broadcast recipient. The chat list filter fails to recognize broadcast metadata, adding phantom empty chats to the user's primary chat list.

---

### BUG-0051: Group participant names and numbers show as blank / unknown
**File:** `client/main.py`, lines 7037-7050 (`_group_name_from_chat_dict`), lines 7842-7854
**Status:** OPEN

In group conversations, participant metadata from Baileys (`groupMetadata.participants`) is not parsed into `self.contacts` or participant caches properly. Inside group chat view and dialogs, group members appear without names or numbers.

---

### BUG-0052: Presence tracking (online / last seen) fails to update
**File:** `client/main.py`, lines 10839-10990 (`on_presence_update`), `client/api_patches/src/baileysManager.ts`
**Status:** OPEN

The Baileys gateway does not automatically subscribe to presence updates for all contacts without explicit `subscribePresence` socket invocations. As a result, `on_presence_update()` receives few or no presence events, leaving "online" and "last seen" indicators frozen or unavailable.

---

### BUG-0053: Chat list renders empty conversation entries with no preview or metadata
**File:** `client/main.py`, lines 6490-6504, 7820-7833
**Status:** OPEN

When `get_remote_chats()` receives chat objects from WhatsApp's server store that have no messages (`msgs: null`) and no activity timestamp (`t: null`), `has_content` evaluation allows empty dicts to enter `self.chats`, rendering blank rows in the conversation list.

---

## MEDIUM

### BUG-0020: Memory leak via circular references in accessibility classes
**File:** `client/ui/accessible.py`, lines 145-147, 187-189
**Status:** OPEN

`AccessibleMessagesList` and `AccessibleAudioSlider` hold a strong reference to `conversations_panel` via `self._panel = conversations_panel`. This creates a strong cyclic reference. Because wxPython relies on C++ lifetimes, this prevents the entire conversation panel and its C++ backing objects from ever being garbage collected. `weakref.proxy(conversations_panel)` should be used instead.

---

### BUG-0021: Accessibility bug — raw JID read by screen readers in new group dialog
**File:** `client/ui/dialogs/new_group.py`, line 70
**Status:** OPEN

When building the contact list for a new group, the fallback for a contact with no name is `name = contact.get("name") or contact.get("pushName") or jid`. Because it falls back to the raw JID (e.g. `551199999999@c.us`), blind users using NVDA/JAWS will hear "551199999999 at c dot us" instead of a properly formatted phone number. It should be wrapped in `format_number(jid)`.

---

### BUG-0022: `get_metadata()` acquires `_write_lock` for a read-only query
**File:** `client/core/database.py`, lines 316-326
**Status:** OPEN

`get_metadata()` acquires the `_write_lock` even though it only performs a SELECT query. Since WAL mode allows concurrent readers, this lock is unnecessary for reads and adds contention on every metadata lookup.

---

### BUG-0023: Thread-safety crash when iterating status updates
**File:** `client/status_panel.py`, line 331
**Status:** OPEN

`status_updates` is populated by the Socket.IO background thread. Iterating over it on a worker thread using `list(status_updates.items())` without a thread lock is a race condition. If the WebSocket thread adds a status concurrently, Python will raise `RuntimeError: dictionary changed size during iteration`.

---

### BUG-0024: `_disconnect_timer` race condition between on_connect and on_disconnect
**File:** `client/core/websocket_client.py`, lines 92-166
**Status:** OPEN

`_disconnect_timer` is accessed from the Socket.IO background thread without any lock. If `on_connect` and `on_disconnect` fire in rapid succession, the `.cancel()` and assignment to None on the timer object could race with the timer thread itself firing `_confirm_still_disconnected`.

---

### BUG-0025: `on_contacts_update()` has premature DB save triggered by earlier loop iterations
**File:** `client/core/websocket_client.py`, lines 880-884
**Status:** OPEN

The `updated` flag is set True when any contact changes, but the DB save on line 882 is gated on `if updated`. This means a contact whose fields did NOT change can still trigger a redundant DB write if a previous contact in the same loop changed.

---

### BUG-0026: Unhandled exception leaks temporary audio files in status panel
**File:** `client/status_panel.py`, lines 718-724
**Status:** OPEN

In `_play_file`, the newly generated temporary `path` is assigned to `self._audio_temp_file` only after `sl_stream.FileStream()` initialization. If initialization fails, cleanup code ignores the file because `_audio_temp_file` is still None, leaking a temporary media file on disk.

---

### BUG-0027: Module-level requests monkey-patching does not cover put/delete/head
**File:** `client/main.py`, lines 67-79
**Status:** OPEN

The global HTTP connection pooling hack only patches `requests.get` and `requests.post`. Any code using `requests.put`, `requests.delete`, or `requests.head` bypasses the pool and creates a new TCP connection each time.

---

### BUG-0028: `_still_linked_on_server()` may parse wrong response shape under Baileys
**File:** `client/main.py`, lines 4941-4968
**Status:** OPEN

This method parses the `/host-device` response expecting `response.phoneNumber._serialized`. The Baileys gateway may return a differently shaped response. If the shape differs, `_still_linked_on_server()` always returns False, and `_logout_confirmed()` loses its safety net, potentially wiping local data more aggressively.

---

## LOW

### BUG-0029: Memory leak of New Contact Dialog on cancel
**File:** `client/ui/dialogs/new_conversation.py`, lines 191-197
**Status:** OPEN

In `_on_new_contact`, `dlg.Destroy()` is only called inside the `if dlg.ShowModal() == wx.ID_OK:` block. If the user cancels or closes the dialog, `dlg.Destroy()` is never called, silently leaking the dialog window.

---

### BUG-0030: `_own_sent_ids_order` deque initialized from set (non-deterministic order)
**File:** `client/core/message_queue.py`, lines 161-163
**Status:** OPEN

When `_own_sent_ids_order` does not exist, it is initialized as `collections.deque(self.main_window._own_sent_ids)`. Since `_own_sent_ids` is a set, the order is arbitrary. The "oldest 500" eviction logic evicts arbitrary IDs rather than truly the oldest ones.

---

### BUG-0031: `_now_ts()` imports `datetime` inside the function on every call
**File:** `client/core/database.py`, lines 108-114
**Status:** OPEN

The `_now_ts()` helper imports `datetime` at the top of the function body instead of at module level. While Python caches module imports, the import lookup adds unnecessary overhead on every database write.

---

### BUG-0032: Invalid process image name for taskkill in `kill_api.py`
**File:** `kill_api.py`, line 47
**Status:** OPEN

`kill_process_by_name("start.js")` results in `taskkill /IM start.js` on Windows. This silently fails because `start.js` is a script argument, not an executable image name (the image is `node.exe`). The system relies entirely on the port-kill fallback.

---

### BUG-0033: 100% CPU spin loop in uninstaller batch file
**File:** `installer/uninstaller.c`, lines 164-166
**Status:** OPEN

The generated `wzuninstall.bat` file loops tightly (`:loop`, `del`, `if exist goto loop`) checking if `uninstall.exe` is still locked. Because there is no `timeout` or `ping` delay inside the loop, it consumes 100% of a CPU core while waiting for the OS to release the file handle.

---

### BUG-0034: Dead `_check_wpp_version_pin()` method has unreachable code after `return`
**File:** `client/main.py`, lines 3679-3682
**Status:** OPEN

The method was converted to a no-op for the Baileys migration by adding `return` on line 3681, but line 3682 has unreachable dead code after it. The method is still called from the startup sequence, wasting a function call for nothing.

---

### BUG-0035: `setup_api.py` may still clone old WPPConnect Server upstream repo
**File:** `setup_api.py`
**Status:** OPEN

If `setup_api.py` still references `wppconnect-team/wppconnect-server` as the repo to clone, it would pull the old Puppeteer-based server code instead of the Baileys gateway.

---

## ULTRA LOW

### BUG-0036: `_vk_mod_to_str()` returns "#+XX" for unknown virtual keys
**File:** `client/main.py`, lines 277-278
**Status:** OPEN

When a virtual key code is not recognized, the function returns its hex code prefixed with "#" (e.g., "#5C"). This format is not user-friendly for screen reader users.

---

### BUG-0037: `_notif_duration()` cannot distinguish None from zero duration
**File:** `client/core/notification_manager.py`, lines 43-54
**Status:** OPEN

A voice message with `duration=None` (metadata missing) and one with `duration=0` both show "0:00" in the notification. A screen reader user cannot distinguish "zero-length voice message" from "duration unknown."

---

## COSMETIC

### BUG-0038: CLAUDE.md describes WPPConnect as "Puppeteer-driven"
**File:** `CLAUDE.md`, line 47
**Status:** OPEN

The architecture section says the API is a "Puppeteer-driven WhatsApp Web automation server." This is no longer accurate after the Baileys migration.

---

### BUG-0039: CLAUDE.md references `client/api2/` as "Puppeteer/Chrome auto-install helper"
**File:** `CLAUDE.md`, line 48
**Status:** OPEN

Line 48 describes `client/api2/` as "a small standalone Puppeteer/Chrome auto-install helper script." This directory's purpose should be re-evaluated under Baileys.

---

### BUG-0040: 30+ comments throughout main.py reference Chrome/Puppeteer crash modes
**File:** `client/main.py`, multiple locations
**Status:** OPEN

Over 30 comments across main.py describe failure modes, recovery logic, and design decisions specific to the old Puppeteer/Chrome architecture. These actively mislead anyone reading the code about what can actually go wrong under Baileys.

---

### BUG-0041: Stale Puppeteer references in test docstrings
**File:** `tests/test_message_backfill.py` (line 254), `tests/test_restart_wpp_session.py` (line 2)
**Status:** OPEN

Test docstrings mention "single Puppeteer page" and 'Puppeteer\'s own "Attempted to use detached Frame"'. These should reflect the Baileys architecture.

---

### BUG-0042: Stale Puppeteer references in UI dialog docstrings
**File:** `client/ui/dialogs/api_setup.py` (line 23), `client/ui/dialogs/api_startup.py` (line 7)
**Status:** OPEN

Docstrings reference "npm exec puppeteer browsers install chrome" and "Puppeteer/Chrome download in start.js." Under Baileys, neither Puppeteer nor Chrome are involved.

---

### BUG-0043: Log message says "Cleaning local Puppeteer cache" under Baileys
**File:** `client/main.py`, line 661
**Status:** OPEN

When custom API mode is enabled and the old `.cache` directory exists, the log says "Custom API enabled. Cleaning local Puppeteer cache..." This is confusing and should be architecture-neutral.

---
