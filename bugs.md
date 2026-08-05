1	# WinZapp Bug Registry
2	
3	This file is the single source of truth for all known bugs in the WinZapp codebase. Every bug found during code audits, testing, or user reports should be documented here so repeated full-project scans are unnecessary.
4	
5	## How This File Works
6	
7	- Each bug has a unique ID (BUG-XXXX), a severity, a status, and a detailed description.
8	- When a bug is fixed, the fixer writes a "Fix Notes" section directly under the bug, describing which file(s) were changed, what line numbers were affected, and what was done. No code snippets needed, just a clear description.
9	- After fix notes are written, the status changes to "FIXED — User Verification Required". The bug stays in this state until the user explicitly confirms the fix works. Only then does it move to "VERIFIED".
10	- Severity levels: SEVERE, HIGH, MEDIUM, LOW, ULTRA LOW, COSMETIC.
11	
12	---
13	
14	## SEVERE
15	
16	### BUG-0001: `_just_paired` unconditionally set to True on every startup
17	**File:** `client/main.py`, line 875
18	**Status:** OPEN
19	
20	Inside the `_connect_bg()` closure (the background thread that connects the WebSocket after init), line 875 unconditionally sets `self._just_paired = True` at the end of the function, regardless of whether the user actually just paired. This overwrites the value that was carefully set to True only when the connection dialog was shown and pairing completed (line 793). On a normal startup where the user was already paired, `_just_paired` starts as False (line 764) but gets flipped to True by this background thread. This means `_check_quick_tip` (line 996) fires on every single launch instead of only after a fresh pairing, and any other logic that checks `_just_paired` to distinguish "first connection" from "reconnection" is broken.
21	
22	---
23	
24	### BUG-0002: Thread-safety crash in FFmpeg download dialog
25	**File:** `client/ui/dialogs/ffmpeg_download.py`, lines 107, 131, 148, 170
26	**Status:** OPEN
27	
28	The background thread `_run_download` catches exceptions and calls `self._finish_error(str(exc))`. The `_finish_error` method (line 93) directly calls `wx.MessageBox`, `self.EndModal`, and `_timer.Stop()`. In wxPython, interacting with GUI elements from a background thread will randomly crash or freeze the app. All calls to `_finish_error` from the download thread must be wrapped in `wx.CallAfter()`.
29	
30	---
31	
32	### BUG-0003: Thread-safety crash in Node.js download dialog
33	**File:** `client/ui/dialogs/node_download.py`, lines 107-113, 121, 151
34	**Status:** OPEN
35	
36	Same bug as BUG-0002. The `_run_download` background thread invokes `_finish_error`, which directly calls `wx.MessageBox` and `self.EndModal(wx.ID_CANCEL)`. These must be marshalled to the main thread via `wx.CallAfter`.
37	
38	---
39	
40	### BUG-0004: `clear_sessions.py` accidentally deletes local database and settings
41	**File:** `clear_sessions.py`, lines 53-54
42	**Status:** OPEN
43	
44	The script aims to clear API session tokens, but blindly calls `shutil.rmtree()` on `client/data`. This directory contains `settings_default.json` and the local SQLite database (`messages.db`). Executing this script will destroy the user's entire local chat history and application settings.
45	
46	---
47	
48	### BUG-0005: Missing `node_modules` in default onedir build
49	**File:** `build.py`, lines 238-239 and 605-608
50	**Status:** OPEN
51	
52	`API_EXCLUDE_DIRS` explicitly contains `"node_modules"`. When the default `--onedir` build mode uses `walk_dir` to assemble the staging directory, it skips `node_modules`. The built Baileys Gateway Server is shipped without its dependencies and will immediately crash when the user attempts to run the app.
53	
54	---
55	
56	### BUG-0006: Destructive Chrome/Chromium force-kill leftover from Puppeteer era
57	**File:** `kill_api.py`, lines 44-45 / `clear_sessions.py`, lines 44-45
58	**Status:** OPEN
59	
60	A leftover from the Puppeteer era, these scripts violently execute `taskkill /F /IM chrome.exe` and `chromium.exe`. This will forcefully close the user's personal web browser system-wide, causing immediate data loss of any open tabs or unsaved web work. Under Baileys, Chrome is never launched by WinZapp, so these kill commands should be removed entirely.
61	
62	---
63	
64	### BUG-0007: `_restart_wpp_session()` uses stale Puppeteer-era close-session/start-session API
65	**File:** `client/main.py`, lines 5132-5198
66	**Status:** OPEN
67	
68	This method was designed for the old WPPConnect+Puppeteer architecture. It POSTs to `/close-session` then `/start-session` to restart a dead Chrome/Puppeteer browser page. Under the Baileys gateway, these endpoints may behave differently or not exist at all. The method's docstring still references "WPPConnect Chrome session" and "Puppeteer page" and "detached frame." If Baileys does not implement these endpoints with the same semantics, calling this method after a suspend/resume cycle could fail silently (the except clauses swallow errors) or worse, accidentally kill and restart the WhatsApp session.
69	
70	---
71	
72	### BUG-0008: `_nudge_whatsapp_socket_stream()` calls a Puppeteer-specific endpoint
73	**File:** `client/main.py`, lines 5073-5111
74	**Status:** OPEN
75	
76	This method calls `/reconnect-socket-stream`, an endpoint that runs `WPP.whatsapp.Cmd.openSocketStream()` inside a Puppeteer-controlled Chrome page. Under Baileys, there is no browser page, no DOM, and no `WPP.whatsapp.Cmd` object. The health checker calls this method on every resume-from-sleep cycle, so it silently fails each time, and the `_DEAD_BROWSER_RESTART_STRIKES` counter accumulates, eventually triggering `_restart_wpp_session()` unnecessarily.
77	
78	---
79	
80	### BUG-0044: Sync creates duplicate top-level chats under raw username/JID when messages arrive offline
81	**File:** `client/main.py`, lines 6821-7035 (`deduplicate_chats`), lines 6349-6550 (`get_remote_chats`)
82	**Status:** OPEN
83	
84	When the app is closed and the user sends/receives messages on their phone, restarting the app triggers a sync where incoming messages under `@lid` or raw JIDs fail to match existing canonical `@s.whatsapp.net` chats in `self.chats`. Instead of merging into the existing named contact chat, a duplicate top-level chat is created with the raw WhatsApp username or JID, routing offline messages into the duplicate chat. **See rewrite #2 (Chat Synchronization & Deduplication Engine)**.
85	
86	---
87	
88	### BUG-0045: Deleted or fake chats cannot be deleted permanently and resurrect on restart
89	**File:** `client/main.py`, lines 6370-6415, 6848-6904
90	**Status:** OPEN
91	
92	Once a phantom or duplicate chat entry appears in `self.chats`, deleting it does not reliably purge both its `@lid` and `@s.whatsapp.net` forms from `self._deleted_chats` and SQLite DB tables. When periodic polling (`get_remote_chats()`) runs or the app restarts, the chat is re-inserted from server state, forcing users to disconnect session and re-pair. **See rewrite #2 (Chat Synchronization & Deduplication Engine)**.
93	
94	---
95	
96	### BUG-0046: Background history sync halts mid-way, creating missing message gaps
97	**File:** `client/main.py`, lines 8055-8095, `client/core/database_bridge.py`, lines 112-159
98	**Status:** OPEN
99	
100	During initial or catch-up sync, history sync threads encounter lock contention or timeout exceptions in `DatabaseBridge._call()`. When an unhandled exception occurs inside a batch, the sync thread terminates quietly without retrying, leaving history sync in an incomplete state with missing message gaps. **See rewrite #2 (Chat Synchronization & Deduplication Engine)**.
101	
102	---
103	
104	## HIGH
105	
106	### BUG-0009: 64-bit pointer truncation in ShellExecuteW in updater
107	**File:** `client/updater.py`, lines 344-346
108	**Status:** OPEN
109	
110	The updater uses `ctypes.windll.shell32.ShellExecuteW` without specifying a `.restype`. In 64-bit Python, `ctypes` defaults to returning a 32-bit `c_int`. The 64-bit `HINSTANCE` pointer returned by the Windows API gets truncated, frequently yielding a negative number or a value <= 32. This falsely triggers the `update_uac_declined` error check, causing legitimate update attempts to abort.
111	
112	---
113	
114	### BUG-0010: xcopy command line corrupted by trailing backslash in updater
115	**File:** `client/updater.py`, line 322
116	**Status:** OPEN
117	
118	In the generated batch script: `xcopy /E /Y /I /H "{source_dir}\*" "{install_dir}\"`. The trailing backslash right before the closing quote (`\"`) causes the Windows Command Prompt to treat it as an escaped literal quote. This swallows the closing quote, corrupting the command line syntax and causing updates to fail silently if paths contain spaces.
119	
120	---
121	
122	### BUG-0011: `start_api.py` fails to use portable Node executable
123	**File:** `start_api.py`, line 33
124	**Status:** OPEN
125	
126	While `build_api.py` and `setup_api.py` correctly prioritize the shipped portable Node binary (`client/node/node.exe`), `start_api.py` hardcodes `subprocess.Popen(["node", ...])`. If `node` is missing from the system PATH or is an incompatible version, the API will fail to start.
127	
128	---
129	
130	### BUG-0012: Global taskkill of node.exe disrupts other applications
131	**File:** `setup_api.py`, line 40
132	**Status:** OPEN
133	
134	The setup script runs `subprocess.run(["taskkill", "/F", "/IM", "node.exe"])` on Windows. This indiscriminately kills all Node.js processes running on the user's computer, disrupting unrelated local development or background applications.
135	
136	---
137	
138	### BUG-0013: Stale Puppeteer environment variable still set on every startup
139	**File:** `client/main.py`, line 3613
140	**Status:** OPEN
141	
142	`os.environ["PUPPETEER_CACHE_DIR"]` is still set to `resource_path("api", ".cache", "puppeteer")` every time the WPP server starts. The project has migrated to Baileys which does not use Puppeteer or Chrome. If any dependency reads `PUPPETEER_CACHE_DIR`, it could attempt to write to a nonexistent directory, causing confusing errors.
143	
144	---
145	
146	### BUG-0014: Health checker docstring and logic reference "auto-restart Puppeteer"
147	**File:** `client/main.py`, line 4890
148	**Status:** OPEN
149	
150	`start_connection_health_checker()` docstring says "Periodically verify session health and auto-restart Puppeteer if closed." The entire recovery path after suspend/resume is built around the assumption that there is a Chrome browser that can crash. Under Baileys, the failure modes are completely different (the Baileys WebSocket to WhatsApp servers can disconnect, but there is no browser page to die), and the recovery mechanism needs to be redesigned.
151	
152	---
153	
154	### BUG-0015: `on_wpp_qrcode()` wraps QR data in unnecessary nested structure
155	**File:** `client/core/websocket_client.py`, lines 894-909
156	**Status:** OPEN
157	
158	`on_wpp_qrcode()` receives `data["data"]` as a base64 image string, then re-wraps it as `{"data": {"qrcode": {"base64": qrcode_base64}}}` before passing to `on_qrcode_update()`. But `_extract_qr_payload()` was specifically fixed to handle the flat string format. This double-wrapping is fragile and misleading.
159	
160	---
161	
162	### BUG-0016: `_set_wpp_limits()` calls a Puppeteer-specific `/set-limit` endpoint
163	**File:** `client/core/websocket_client.py`, lines 966-992
164	**Status:** OPEN
165	
166	This method POSTs to `/set-limit` with `maxMediaSize` and `maxFileSize` parameters. Under Baileys, file size limits are handled differently (they are properties of the Baileys socket configuration). If the Baileys gateway does not implement this endpoint, these calls fail silently, meaning file size limits are never actually raised.
167	
168	---
169	
170	### BUG-0017: `on_wpp_status_find()` calls `_handle_logout()` without `_logout_confirmed()` guard
171	**File:** `client/core/websocket_client.py`, lines 1006-1016
172	**Status:** OPEN
173	
174	When a `status-find` event arrives with `disconnectedMobile`/`notLogged`/`QRCODE` and the user was previously paired and `_wa_connected` is True, it directly calls `_handle_logout()`. This bypasses all the careful multi-strike, timed confirmation, and `_still_linked_on_server()` checks in `_logout_confirmed()`. A single transient status-find event could wipe local data unnecessarily.
175	
176	---
177	
178	### BUG-0018: Stale WPPConnect source files in build config prevent Baileys inclusion
179	**File:** `build.py`, lines 255 and 263-271
180	**Status:** OPEN
181	
182	`API_CUSTOM_SRC_FILES` hardcodes legacy WPPConnect source files (`src/config.ts`, `src/util/createSessionUtil.ts`). Since `"src"` is globally excluded by `API_EXCLUDE_DIRS`, the actual Baileys source files (`server.ts`, `baileysManager.ts`) are never copied to the staging `api_patches` directory, making them invisible in the build output.
183	
184	---
185	
186	### BUG-0019: Unquoted shell path in `start_api.py` breaks on paths with spaces
187	**File:** `start_api.py`, line 37
188	**Status:** OPEN
189	
190	On Linux, `stdout_log` is injected into a `shell=True` command string without surrounding quotes. If the installation path contains spaces, the shell will misinterpret the redirection path, causing the API startup command to fail.
191	
192	---
193	
194	### BUG-0047: Pinned chats fail to stay at the top of the conversation list
195	**File:** `client/main.py`, lines 7779-7985 (`_sort_key`)
196	**Status:** OPEN
197	
198	In `set_chats()`, the sorting key `_sort_key` evaluates `pin = 0 if (self._canonical_jid(rjid) in pinned or rjid in pinned) else 1`. When a chat key is stored as `@lid` while `rjid` or `pinned` set contains `@s.whatsapp.net` (or vice versa), the check returns False (`pin = 1`). Consequently, pinned chats sink down into the list as unpinned chats receive new activity. **See rewrite #6 (Pinned & Priority Chat Management)**.
199	
200	---
201	
202	### BUG-0048: Sent message delivery ticks never progress to Read (blue ticks) or Played
203	**File:** `client/main.py`, lines 10562-10660 (`on_message_status_update`), `client/ui/conversations.py`
204	**Status:** OPEN
205	
206	When Baileys emits `messages.update` status events (`READ`=3, `PLAYED`=4), `on_message_status_update()` fails to match candidate JIDs or update the message record's `MessageUpdate` structure cleanly. As a result, sent messages stay marked as "delivered" indefinitely, never showing blue ticks or voice note played status. **See rewrite #4 (Delivery & Read Receipt Tracker)**.
207	
208	---
209	
210	### BUG-0049: Contact names show as "Unnamed" or raw phone/JID numbers
211	**File:** `client/main.py`, lines 7817-7905, `client/ui/dialogs/new_group.py`, line 70
212	**Status:** OPEN
213	
214	`_resolve_contact_name()` and fallback logic in `set_chats()` fail to resolve pushName or address book names when contacts originate from `@lid` JIDs or Baileys sync. Contacts fall back to unformatted numbers or raw JIDs like `551199999999@c.us`, which screen readers announce digit-by-digit. **See rewrite #3 (Contact & Identity Resolver)**.
215	
216	---
217	
218	### BUG-0050: Broadcast list messages create phantom empty conversations in main chat list
219	**File:** `client/main.py`, lines 6406-6414, lines 7788-7804
220	**Status:** OPEN
221	
222	When a message is sent to a broadcast list or recipient, `get_remote_chats()` and `on_new_message()` create chat entries where `remoteJid` or `key.remoteJid` is a `@broadcast` JID or broadcast recipient. The chat list filter fails to recognize broadcast metadata, adding phantom empty chats to the user's primary chat list. **See rewrite #3 (Contact & Identity Resolver)**.
223	
224	---
225	
226	### BUG-0051: Group participant names and numbers show as blank / unknown
227	**File:** `client/main.py`, lines 7037-7050 (`_group_name_from_chat_dict`), lines 7842-7854
228	**Status:** OPEN
229	
230	In group conversations, participant metadata from Baileys (`groupMetadata.participants`) is not parsed into `self.contacts` or participant caches properly. Inside group chat view and dialogs, group members appear without names or numbers. **See rewrite #3 (Contact & Identity Resolver)**.
231	
232	---
233	
234	### BUG-0052: Presence tracking (online / last seen) fails to update
235	**File:** `client/main.py`, lines 10839-10990 (`on_presence_update`), `client/api_patches/src/baileysManager.ts`
236	**Status:** OPEN
237	
238	The Baileys gateway does not automatically subscribe to presence updates for all contacts without explicit `subscribePresence` socket invocations. As a result, `on_presence_update()` receives few or no presence events, leaving "online" and "last seen" indicators frozen or unavailable. **See rewrite #5 (Presence & Status Tracking Subsystem)**.
239	
240	---
241	
242	### BUG-0053: Chat list renders empty conversation entries with no preview or metadata
243	**File:** `client/main.py`, lines 6490-6504, 7820-7833
244	**Status:** OPEN
245	
246	When `get_remote_chats()` receives chat objects from WhatsApp's server store that have no messages (`msgs: null`) and no activity timestamp (`t: null`), `has_content` evaluation allows empty dicts to enter `self.chats`, rendering blank rows in the conversation list.
247	
248	---
249	
250	## MEDIUM
251	
252	### BUG-0020: Memory leak via circular references in accessibility classes
253	**File:** `client/ui/accessible.py`, lines 145-147, 187-189
254	**Status:** OPEN
255	
256	`AccessibleMessagesList` and `AccessibleAudioSlider` hold a strong reference to `conversations_panel` via `self._panel = conversations_panel`. This creates a strong cyclic reference. Because wxPython relies on C++ lifetimes, this prevents the entire conversation panel and its C++ backing objects from ever being garbage collected. `weakref.proxy(conversations_panel)` should be used instead.
257	
258	---
259	
260	### BUG-0021: Accessibility bug — raw JID read by screen readers in new group dialog
261	**File:** `client/ui/dialogs/new_group.py`, line 70
262	**Status:** OPEN
263	
264	When building the contact list for a new group, the fallback for a contact with no name is `name = contact.get("name") or contact.get("pushName") or jid`. Because it falls back to the raw JID (e.g. `551199999999@c.us`), blind users using NVDA/JAWS will hear "551199999999 at c dot us" instead of a properly formatted phone number. It should be wrapped in `format_number(jid)`.
265	
266	---
267	
268	### BUG-0022: `get_metadata()` acquires `_write_lock` for a read-only query
269	**File:** `client/core/database.py`, lines 316-326
270	**Status:** OPEN
271	
272	`get_metadata()` acquires the `_write_lock` even though it only performs a SELECT query. Since WAL mode allows concurrent readers, this lock is unnecessary for reads and adds contention on every metadata lookup. **See rewrite #8 (Database Architecture)**.
273	
274	---
275	
276	### BUG-0023: Thread-safety crash when iterating status updates
277	**File:** `client/status_panel.py`, line 331
278	**Status:** OPEN
279	
280	`status_updates` is populated by the Socket.IO background thread. Iterating over it on a worker thread using `list(status_updates.items())` without a thread lock is a race condition. If the WebSocket thread adds a status concurrently, Python will raise `RuntimeError: dictionary changed size during iteration`.
281	
282	---
283	
284	### BUG-0024: `_disconnect_timer` race condition between on_connect and on_disconnect
285	**File:** `client/core/websocket_client.py`, lines 92-166
286	**Status:** OPEN
287	
288	`_disconnect_timer` is accessed from the Socket.IO background thread without any lock. If `on_connect` and `on_disconnect` fire in rapid succession, the `.cancel()` and assignment to None on the timer object could race with the timer thread itself firing `_confirm_still_disconnected`. **See rewrite #9 (WebSocket & Connection Management)**.
289	
290	---
291	
292	### BUG-0025: `on_contacts_update()` has premature DB save triggered by earlier loop iterations
293	**File:** `client/core/websocket_client.py`, lines 880-884
294	**Status:** OPEN
295	
296	The `updated` flag is set True when any contact changes, but the DB save on line 882 is gated on `if updated`. This means a contact whose fields did NOT change can still trigger a redundant DB write if a previous contact in the same loop changed.
297	
298	---
299	
300	### BUG-0026: Unhandled exception leaks temporary audio files in status panel
301	**File:** `client/status_panel.py`, lines 718-724
302	**Status:** OPEN
303	
304	In `_play_file`, the newly generated temporary `path` is assigned to `self._audio_temp_file` only after `sl_stream.FileStream()` initialization. If initialization fails, cleanup code ignores the file because `_audio_temp_file` is still None, leaking a temporary media file on disk.
305	
306	---
307	
308	### BUG-0027: Module-level requests monkey-patching does not cover put/delete/head
309	**File:** `client/main.py`, lines 67-79
310	**Status:** OPEN
311	
312	The global HTTP connection pooling hack only patches `requests.get` and `requests.post`. Any code using `requests.put`, `requests.delete`, or `requests.head` bypasses the pool and creates a new TCP connection each time.
313	
314	---
315	
316	### BUG-0028: `_still_linked_on_server()` may parse wrong response shape under Baileys
317	**File:** `client/main.py`, lines 4941-4968
318	**Status:** OPEN
319	
320	This method parses the `/host-device` response expecting `response.phoneNumber._serialized`. The Baileys gateway may return a differently shaped response. If the shape differs, `_still_linked_on_server()` always returns False, and `_logout_confirmed()` loses its safety net, potentially wiping local data more aggressively.
321	
322	---
323	
324	## LOW
325	
326	### BUG-0029: Memory leak of New Contact Dialog on cancel
327	**File:** `client/ui/dialogs/new_conversation.py`, lines 191-197
328	**Status:** OPEN
329	
330	In `_on_new_contact`, `dlg.Destroy()` is only called inside the `if dlg.ShowModal() == wx.ID_OK:` block. If the user cancels or closes the dialog, `dlg.Destroy()` is never called, silently leaking the dialog window.
331	
332	---
333	
334	### BUG-0030: `_own_sent_ids_order` deque initialized from set (non-deterministic order)
335	**File:** `client/core/message_queue.py`, lines 161-163
336	**Status:** OPEN
337	
338	When `_own_sent_ids_order` does not exist, it is initialized as `collections.deque(self.main_window._own_sent_ids)`. Since `_own_sent_ids` is a set, the order is arbitrary. The "oldest 500" eviction logic evicts arbitrary IDs rather than truly the oldest ones.
339	
340	---
341	
342	### BUG-0031: `_now_ts()` imports `datetime` inside the function on every call
343	**File:** `client/core/database.py`, lines 108-114
344	**Status:** OPEN
345	
346	The `_now_ts()` helper imports `datetime` at the top of the function body instead of at module level. While Python caches module imports, the import lookup adds unnecessary overhead on every database write.
347	
348	---
349	
350	### BUG-0032: Invalid process image name for taskkill in `kill_api.py`
351	**File:** `kill_api.py`, line 47
352	**Status:** OPEN
353	
354	`kill_process_by_name("start.js")` results in `taskkill /IM start.js` on Windows. This silently fails because `start.js` is a script argument, not an executable image name (the image is `node.exe`). The system relies entirely on the port-kill fallback.
355	
356	---
357	
358	### BUG-0033: 100% CPU spin loop in uninstaller batch file
359	**File:** `installer/uninstaller.c`, lines 164-166
360	**Status:** OPEN
361	
362	The generated `wzuninstall.bat` file loops tightly (`:loop`, `del`, `if exist goto loop`) checking if `uninstall.exe` is still locked. Because there is no `timeout` or `ping` delay inside the loop, it consumes 100% of a CPU core while waiting for the OS to release the file handle.
363	
364	---
365	
366	### BUG-0034: Dead `_check_wpp_version_pin()` method has unreachable code after `return`
367	**File:** `client/main.py`, lines 3679-3682
368	**Status:** OPEN
369	
370	The method was converted to a no-op for the Baileys migration by adding `return` on line 3681, but line 3682 has unreachable dead code after it. The method is still called from the startup sequence, wasting a function call for nothing.
371	
372	---
373	
374	### BUG-0035: `setup_api.py` may still clone old WPPConnect Server upstream repo
375	**File:** `setup_api.py`
376	**Status:** OPEN
377	
378	If `setup_api.py` still references `wppconnect-team/wppconnect-server` as the repo to clone, it would pull the old Puppeteer-based server code instead of the Baileys gateway.
379	
380	---
381	
382	## ULTRA LOW
383	
384	### BUG-0036: `_vk_mod_to_str()` returns "#+XX" for unknown virtual keys
385	**File:** `client/main.py`, lines 277-278
386	**Status:** OPEN
387	
388	When a virtual key code is not recognized, the function returns its hex code prefixed with "#" (e.g., "#5C"). This format is not user-friendly for screen reader users.
389	
390	---
391	
392	### BUG-0037: `_notif_duration()` cannot distinguish None from zero duration
393	**File:** `client/core/notification_manager.py`, lines 43-54
394	**Status:** OPEN
395	
396	A voice message with `duration=None` (metadata missing) and one with `duration=0` both show "0:00" in the notification. A screen reader user cannot distinguish "zero-length voice message" from "duration unknown."
397	
398	---
399	
400	## COSMETIC
401	
402	### BUG-0038: CLAUDE.md describes WPPConnect as "Puppeteer-driven"
403	**File:** `CLAUDE.md`, line 47
404	**Status:** OPEN
405	
406	The architecture section says the API is a "Puppeteer-driven WhatsApp Web automation server." This is no longer accurate after the Baileys migration.
407	
408	---
409	
410	### BUG-0039: CLAUDE.md references `client/api2/` as "Puppeteer/Chrome auto-install helper"
411	**File:** `CLAUDE.md`, line 48
412	**Status:** OPEN
413	
414	Line 48 describes `client/api2/` as "a small standalone Puppeteer/Chrome auto-install helper script." This directory's purpose should be re-evaluated under Baileys.
415	
416	---
417	
418	### BUG-0040: 30+ comments throughout main.py reference Chrome/Puppeteer crash modes
419	**File:** `client/main.py`, multiple locations
420	**Status:** OPEN
421	
422	Over 30 comments across main.py describe failure modes, recovery logic, and design decisions specific to the old Puppeteer/Chrome architecture. These actively mislead anyone reading the code about what can actually go wrong under Baileys.
423	
424	---
425	
426	### BUG-0041: Stale Puppeteer references in test docstrings
427	**File:** `tests/test_message_backfill.py` (line 254), `tests/test_restart_wpp_session.py` (line 2)
428	**Status:** OPEN
429	
430	Test docstrings mention "single Puppeteer page" and 'Puppeteer\'s own "Attempted to use detached Frame"'. These should reflect the Baileys architecture.
431	
432	---
433	
434	### BUG-0042: Stale Puppeteer references in UI dialog docstrings
435	**File:** `client/ui/dialogs/api_setup.py` (line 23), `client/ui/dialogs/api_startup.py` (line 7)
436	**Status:** OPEN
437	
438	Docstrings reference "npm exec puppeteer browsers install chrome" and "Puppeteer/Chrome download in start.js." Under Baileys, neither Puppeteer nor Chrome are involved.
439	
440	---
441	
442	### BUG-0043: Log message says "Cleaning local Puppeteer cache" under Baileys
443	**File:** `client/main.py`, line 661
444	**Status:** OPEN
445	
446	When custom API mode is enabled and the old `.cache` directory exists, the log says "Custom API enabled. Cleaning local Puppeteer cache..." This is confusing and should be architecture-neutral.
447	
448	---
449	