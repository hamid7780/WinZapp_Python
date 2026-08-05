1	1	# WinZapp Systems Rewrite Candidates
2	2	
3	3	This document details all major systems in WinZapp requiring complete architectural rewrites. For every system, it clearly documents:
4	4	1. **Why rewrite is necessary**
5	5	2. **Proposed new design**
6	6	3. **Benefits of rewrite**
7	7	4. **Consequences of previous design**
8	8	
9	9	---
10	10	
11	11	## 1. The Application Core — client/main.py
12	12	
13	13	### Why rewrite is necessary
14	14	MainWindow is an 14,168-line god object that handles GUI initialization, process management, WebSocket routing, HTTP requests, JID normalization, chat deduplication, audio playback, update checks, and tray management. All four application threads (wx UI thread, Socket.IO background thread, asyncio DB thread, message queue worker thread) directly mutate MainWindow attributes simultaneously. Any minor edit in one area risks breaking unrelated subsystems across the 14,000 lines.
15	15	
16	16	### Proposed new design
17	17	Decompose MainWindow into dedicated single-responsibility controllers:
18	18	- `ProcessManager`: Manages Node.js gateway process lifecycle.
19	19	- `AppController`: Manages UI state, navigation, and window lifecycle.
20	20	- `SessionManager`: Manages connection state, offline mode, and health checks.
21	21	- `SyncCoordinator`: Coordinates history sync and database population.
22	22	Subsystems will communicate via a thread-safe EventBus instead of directly mutating main window state.
23	23	
24	24	### Benefits of rewrite
25	25	- Modularity: Code is organized into small, understandable modules under 500 lines each.
26	26	- Thread Safety: State mutations happen safely through an EventBus on designated threads.
27	27	- Testability: Subsystems can be unit tested without initializing a full wx.App frame.
28	28	
29	29	### Consequences of previous design
30	30	- Random UI freezes ("WinZapp stopped responding") caused by cross-thread attribute mutation.
31	31	- Over 30 dead code paths and comments left over from the Puppeteer era causing erratic suspend/resume behavior.
32	32	- High risk of regression whenever any feature or bug fix was introduced.
33	33	
34	34	---
35	35	
36	36	## 2. Chat Synchronization & Deduplication Engine
37	37	
38	38	### Why rewrite is necessary
39	39	When the app closes and reopens after messaging on a phone, sync creates duplicate top-level chats under raw phone numbers or `@lid` JIDs instead of merging into the existing contact chat. History sync routinely halts mid-way, and deleted or fake chats cannot be permanently removed without clearing local data. **See BUG-0044, BUG-0045, BUG-0046**
40	40	
41	41	### Proposed new design
42	42	Implement a single-pass `CanonicalJidRegistry` and transactional `SyncEngine`:
43	43	- Every incoming chat and message JID is mapped to its canonical form (`@s.whatsapp.net`) *before* touching memory or DB.
44	44	- History sync will run in atomic batches with proper progress checkpoints and exception recovery so sync never hangs.
45	45	- Chat deletions will atomically purge both `@lid` and `@s.whatsapp.net` variants from both DB tables and memory caches, ignoring stale server list snapshots.
46	46	
47	47	### Benefits of rewrite
48	48	- Zero duplicate chats when syncing history after offline phone usage.
49	49	- Smooth, uninterrupted history sync that recovers automatically if interrupted.
50	50	- Permanent chat deletion that doesn't resurrect deleted or phantom chats on restart.
51	51	
52	52	### Consequences of previous design
53	53	- Users get duplicate top-level chats for the same contact after every sync.
54	54	- Sync halts silently, leaving missing message gaps in chat history.
55	55	- Users are forced to disconnect their session and re-pair just to clear duplicate or fake chats.
56	56	
57	57	---
58	58	
59	59	## 3. Contact & Identity Resolver
60	60	
61	61	### Why rewrite is necessary
62	62	Contacts frequently show up as "Unnamed", raw phone digits (e.g., `55119...`), or raw `@lid` strings. In group chats, participant names and numbers fail to display completely, and broadcast list messages pollute the main chat list as independent empty conversations. **See BUG-0049, BUG-0050, BUG-0051**
63	63	
64	64	### Proposed new design
65	65	Build a centralized `IdentityResolver` with strict priority cascade:
66	66	1. Address book contact name (from phone contacts sync)
67	67	2. Saved pushName / profile name
68	68	3. Formatted phone number (via `format_number`)
69	69	4. Explicit fallback string (never raw JIDs or unformatted numbers)
70	70	Broadcast messages will be strictly classified by a dedicated `BroadcastManager` and prevented from ever creating main chat list entries.
71	71	
72	72	### Benefits of rewrite
73	73	- 100% human-readable contact names across all chat lists, message headers, and group participant lists.
74	74	- Full screen-reader accessibility for blind users (no raw JID digits read out loud by NVDA/JAWS).
75	75	- Main chat list remains clean, showing only real 1:1 and group conversations.
76	76	
77	77	### Consequences of previous design
78	78	- Blind users hear raw JID strings like "551199999999 at c dot us".
79	79	- Broadcast list sends create phantom empty chats in the main list.
80	80	- Group participants appear nameless and numberless.
81	81	
82	82	---
83	83	
84	84	## 4. Delivery & Read Receipt Tracker
85	85	
86	86	### Why rewrite is necessary
87	87	Messages only display "delivered" status ticks. "Read" (blue ticks) and "played" (voice note receipts) statuses never update in the UI. Sent messages often remain stuck with "unconfirmed" status indicators. **See BUG-0048**
88	88	
89	89	### Proposed new design
90	90	Rewrite message status handling to map Baileys numeric/string status codes (`SERVER_ACK`=1, `DELIVERY_ACK`=2, `READ`=3, `PLAYED`=4) into a unified `MessageStatus` model. Update both DB records and UI elements via atomic `CallAfter` signals when receipt events arrive.
91	91	
92	92	### Benefits of rewrite
93	93	- Accurate, real-time receipt indicators (sent, delivered, read, played) for all outgoing messages and voice notes.
94	94	- Screen readers correctly announce message status changes ("Message read", "Audio played").
95	95	
96	96	### Consequences of previous design
97	97	- Users can never tell if their recipient read their message or listened to their voice note.
98	98	- Sent messages stay marked as pending/unconfirmed even after successful delivery.
99	99	
100	100	---
101	101	
102	102	## 5. Presence & Status Tracking Subsystem
103	103	
104	104	### Why rewrite is necessary
105	105	"Last seen" and "online" presence indicators do not work reliably. Typing ("composing") and voice recording ("recording") announcements fail to trigger or freeze screen reader announcements. **See BUG-0052**
106	106	
107	107	### Proposed new design
108	108	Implement an active `PresenceTracker` that automatically subscribes to presence updates for active chats via Baileys `subscribePresence` socket calls, maintaining an in-memory presence state per contact with accurate auto-clearing timers.
109	109	
110	110	### Benefits of rewrite
111	111	- Reliable real-time online/offline and last-seen timestamps.
112	112	- Audio screen reader announcements when a contact starts typing or recording a voice note in the active chat.
113	113	
114	114	### Consequences of previous design
115	115	- Presence state remains stale or unavailable.
116	116	- Typing/recording notifications miss updates or interrupt screen reader focus incorrectly.
117	117	
118	118	---
119	119	
120	120	## 6. Pinned & Priority Chat Management
121	121	
122	122	### Why rewrite is necessary
123	123	Pinned chats do not stay at the top of the conversation list. They sink down into the list as new messages arrive in unpinned chats. **See BUG-0047**
124	124	
125	125	### Proposed new design
126	126	Re-architect `ChatSorter` to enforce strict bucket sorting:
127	127	- Bucket 0: Pinned chats (sorted internally by last activity timestamp).
128	128	- Bucket 1: Regular chats (sorted by last activity timestamp).
129	129	- Bucket 2: Archived chats (isolated in Archived tab).
130	130	Pin state will be indexed by canonical phone JID so `@lid` and `@s.whatsapp.net` aliases always evaluate as pinned.
131	131	
132	132	### Benefits of rewrite
133	133	- Pinned chats permanently remain at the top of the chat list, regardless of incoming messages in unpinned chats.
134	134	- Instant keyboard navigation to pinned chats for screen reader users.
135	135	
136	136	### Consequences of previous design
137	137	- Pinned chats lose their top position whenever any other chat receives a message.
138	138	- Users miss important pinned conversations because they drift down the list.
139	139	
140	140	---
141	141	
142	142	## 7. The Conversations UI — client/ui/conversations.py
143	143	
144	144	### Why rewrite is necessary
145	145	The 417 KB `ConversationsPanel` file mixes view rendering with sorting, unread counting, name resolution, attachment parsing, audio playback, and key binding.
146	146	
147	147	### Proposed new design
148	148	Split into modular UI components:
149	149	- `ChatListPanel`: Only renders conversation list rows.
150	150	- `MessageHistoryPanel`: Only renders message timeline.
151	151	- `AudioPlayerWidget`: Manages voice note playback.
152	152	- `SearchControl`: Manages search bar and results.
153	153	
154	154	### Benefits of rewrite
155	155	- Clean separation of concerns (MVC architecture).
156	156	- Fast UI updates without re-rendering the entire panel on every message.
157	157	
158	158	### Consequences of previous design
159	159	- Entire conversation list re-renders on minor status updates, causing focus loss for screen readers.
160	160	- Audio slider leaks memory and cyclic references prevent garbage collection.
161	161	
162	162	---
163	163	
164	164	## 8. The Database Architecture — client/core/database.py & database_bridge.py
165	165	
166	166	### Why rewrite is necessary
167	167	`DatabaseBridge` uses a sync-over-async anti-pattern (asyncio event loop inside a daemon thread called synchronously from wx Python). Blocking calls time out or freeze the main thread. **See BUG-0054, BUG-0061**
168	168	
169	169	### Proposed new design
170	170	Replace `aiosqlite` and `DatabaseBridge` with a clean, synchronous `sqlite3` manager using WAL mode and write-serialization locks. Reads execute concurrently without blocking.
171	171	
172	172	### Benefits of rewrite
173	173	- Eliminates thread-deadlocks and "WinZapp stopped responding" freezes.
174	174	- Simplifies DB code by removing futures, timeouts, and loop drain logic.
175	175	
176	176	### Consequences of previous design
177	177	- Application hangs indefinitely when DB thread wedged behind busy SQLite writes.
178	178	- Read queries acquired write locks needlessly, choking concurrent UI reads.
179	179	
180	180	---
181	181	
182	182	## 9. WebSocket & Connection Management — client/core/websocket_client.py
183	183	
184	184	### Why rewrite is necessary
185	185	`WebSocketClient` is tightly coupled to `MainWindow` and contains stale logic expecting Puppeteer Chrome browser crashes (`browserClose`). **See BUG-0007, BUG-0008, BUG-0024, BUG-0055**
186	186	
187	187	### Proposed new design
188	188	Decouple `WebSocketClient` into a pure network client emitting typed domain events (`MessageReceived`, `ReceiptUpdated`, `PresenceChanged`) over an EventBus.
189	189	
190	190	### Benefits of rewrite
191	191	- Isolated network layer that can be tested with mock Socket.IO servers.
192	192	- Eliminates invalid Chrome crash recovery triggers under Baileys.
193	193	
194	194	### Consequences of previous design
195	195	- Network events directly mutated main window state, causing race conditions.
196	196	- False "browserClose" triggers caused accidental session restarts.
197	197	
198	198	---
199	199	
200	200	## 10. Connection & Pairing Flow — client/ui/dialogs/connect.py
201	201	
202	202	### Why rewrite is necessary
203	203	Uses nested modal dialog loops (`ShowModal()` inside `ShowModal()`), where `EndModal()` fails to unwind properly, causing pairing to succeed in background while main UI never appears.
204	204	
205	205	### Proposed new design
206	206	Replace nested modal dialogs with a single multi-page wizard dialog (`PairingWizardDialog`) with explicit state transitions.
207	207	
208	208	### Benefits of rewrite
209	209	- Guaranteed clean transition from pairing completion to main window display.
210	210	- Fully accessible keyboard navigation for pairing code input.
211	211	
212	212	### Consequences of previous design
213	213	- App got stuck after pairing: connected sound played but main window never appeared.
214	214	
215	215	---
216	216	
217	217	## 11. Suspend/Resume Power & Connection Recovery
218	218	
219	219	### Why rewrite is necessary
220	220	Suspend/resume recovery attempts to call Puppeteer endpoints (`/reconnect-socket-stream`, `/close-session`), failing continuously under Baileys and triggering destructive local data wipes. **See BUG-0014**
221	221	
222	222	### Proposed new design
223	223	Implement a `PowerManager` listening to Windows `EVT_POWER_RESUME` that directly verifies Baileys socket connectivity and initiates a clean Baileys reconnect if disconnected.
224	224	
225	225	### Benefits of rewrite
226	226	- Instant recovery when laptop wakes from sleep.
227	227	- No false logout triggers or accidental database wipes.
228	228	
229	229	### Consequences of previous design
230	230	- Waking from sleep left the app offline indefinitely or wiped local user data by mistake.
231	231	
232	232	---
233	233	
234	234	## 12. Packaging & Build Pipeline — build.py & setup_api.py
235	235	
236	236	### Why rewrite is necessary
237	237	`build.py` excludes `node_modules` and references non-existent WPPConnect source files, producing broken desktop builds missing Baileys gateway dependencies. **See BUG-0005, BUG-0018**
238	238	
239	239	### Proposed new design
240	240	Update `build.py` and `setup_api.py` to package the compiled Baileys gateway (`client/api/dist/` and `node_modules/`), validating Node binary presence and runtime files before PyInstaller execution.
241	241	
242	242	### Benefits of rewrite
243	243	- 100% reliable production installer and portable zip releases.
244	244	- Clean build scripts reflecting actual Baileys gateway structure.
245	245	
246	246	### Consequences of previous design
247	247	- Built executables crashed immediately on launch due to missing Node dependencies.
248	248	
249	249	---
250	250	
251	251	## 13. Database Encryption & Secret Management
252	252	
253	253	### Why rewrite is necessary
254	254	The Fernet key for DB encryption and WA_token storage is stored in a plaintext `secret.key` file. While portable, this exposes the key to direct filesystem inspection. **See BUG-0062**
255	255	
256	256	### Proposed new design
257	257	Replace plaintext `secret.key` with a Windows DPAPI-encrypted vault using `cryptography.hazmat.primitives.hashes` and `win32crypt`. Derive the Fernet key at runtime by hashing a user-specific secret (e.g., `settings.json` checksum) with DPAPI protection.
258	258	
259	259	### Benefits of rewrite
260	260	- Fernet key is never stored plaintext on disk.
261	261	- Maintains cross-device portability of encrypted data via DPAPI roaming.
262	262	
263	263	### Consequences of previous design
264	264	- Exposed Fernet key in plaintext to any process with filesystem access.
265	265	
266	266	---
267	267	
268	268	## 14. Audio & Notification Sound Management
269	269	
270	270	### Why rewrite is necessary
271	271	Sound files are hardcoded to specific paths (`sounds/message.wav`, `sounds/error.wav`), preventing users from customize or disable individual sounds. **See BUG-0053**
272	272	
273	273	### Proposed new design
274	274	Introduce a `SoundManager` class that loads sounds from a configurable directory (`data/sounds/`) with per-sound enable/disable flags in `settings.json`.
275	275	
276	276	### Benefits of rewrite
277	277	- User-customizable sound files and volumes.
278	278	- Centralized sound control without hardcoded paths.
279	279	
280	280	### Consequences of previous design
281	281	- Users couldn't replace or disable notification sounds.
282	282	
283	283	---
284	284	
285	285	## 15. Accessibility & Screen Reader Integration
286	286	
287	287	### Why rewrite is necessary
288	288	Batch UI updates (e.g., new messages, status changes) lack proper `wx.UIAction` wrapping, causing screen readers to miss announcements or announce outdated information. **See BUG-0056**
289	289	
290	290	### Proposed new design
291	291	Implement a centralized `AccessibilityManager` that wraps all UI mutations in `wx.UIAction` contexts with explicit labels. Prioritize live region updates for dynamic content.
292	292	
293	293	### Benefits of rewrite
294	294	- Reliable screen reader announcements for all UI changes.
295	295	- Reduced cognitive load for blind users navigating the app.
296	296	
297	297	### Consequences of previous design
298	298	- Screen readers failed to announce new messages or status updates.
299	299	- UI elements reported incorrect or stale states.
300	300	
301	301	---
302	302	
303	303	## 16. Update Checker & Auto-Updater
304	304	
305	305	### Why rewrite is necessary
306	306	The updater downloads releases to a fixed temp path (`C:\Temp\WinZappUpdate\`), causing conflicts on multi-user systems. It also lacks version comparison for pre-releases. **See BUG-0057**
307	307	
308	308	### Proposed new design
309	309	Use `tempfile.mkdtemp()` for user-specific temp directories. Implement semantic version parsing (`packaging` module) to handle pre-releases and build metadata.
310	310	
311	311	### Benefits of rewrite
312	312	- Safe concurrent updates on shared machines.
313	313	- Accurate version comparisons including pre-releases.
314	314	
315	315	### Consequences of previous design
316	316	- Update failures on systems without `C:\Temp\`.
317	317	- Incorrect update notifications for pre-release users.
318	318	
319	319	---
320	320	
321	321	## 17. Error Reporting & Crash Handling
322	322	
323	323	### Why rewrite is necessary
324	324	Crashes log only to `log.log` locally without user-visible error dialogs or automated reporting. Users have no way to submit crash reports. **See BUG-0058**
325	325	
326	326	### Proposed new design
327	327	Integrate a user-facing `ErrorReporter` with:
328	328	- Modal error dialogs showing simplified messages.
329	329	- Optional detailed log snippets for user submission.
330	330	- Anonymous crash reports to a privacy-focused endpoint (e.g., Sentry with IP scrubbing).
331	331	
332	332	### Benefits of rewrite
333	333	- Users understand when errors occur and can take action.
334	334	- Developers receive actionable crash data for fixing issues.
335	335	
336	336	### Consequences of previous design
337	337	- Silent crashes left users confused and unable to report issues.
338	338	- Developers lacked visibility into real-world failure modes.
339	339	
340	340	---
341	341	
342	342	## 18. Settings Management & Persistence
343	343	
344	344	### Why rewrite is necessary
345	345	Settings are split between `settings.json` and hardcoded defaults in `config.py`, making it impossible to track which settings are user-modified versus defaults. **See BUG-0059**
346	346	
347	347	### Proposed new design
348	348	Create a unified `SettingsManager` that:
349	349	- Loads defaults from `settings_default.json`.
350	350	- Merges user overrides from `settings.json`.
351	351	- Tracks modified keys for reset-to-default functionality.
352	352	
353	353	### Benefits of rewrite
354	354	- Clear distinction between user settings and defaults.
355	355	- Simplified settings reset without deleting the entire `settings.json` file.
356	356	
357	357	### Consequences of previous design
358	358	- Users couldn't reset individual settings to defaults.
359	359	- Settings drift occurred between versions due to missing migration logic.
360	360	
361	361	---
362	362	
363	363	## 19. Localization & i18n System
364	364	
365	365	### Why rewrite is necessary
366	366	Translations are scattered across individual files (e.g., `i18n.py`, menu items in `main.py`), making it impossible for contributors to submit complete translations without modifying Python source code. **See BUG-0060**
367	367	
368	368	### Proposed new design
369	369	Adopt a standard `gettext`/.po file workflow:
370	370	- Extract translatable strings into `.pot` templates.
371	371	- Maintain language-specific `.po` files in `locales/`.
372	372	- Compile to `.mo` files at build time.
373	373	
374	374	### Benefits of rewrite
375	375	- Decentralized translation contributions via platforms like Weblate.
376	376	- Simplified maintenance of translation files.
377	377	
378	378	### Consequences of previous design
379	379	- Translation updates required direct code modifications.
380	380	- Inconsistent translation coverage across the app.
381	381	
382	382	---
383	383	
384	384	## 20. Group Chat Management & Participant Resolution
385	385	
386	386	### Why rewrite is necessary
387	387	Group participant lists frequently show outdated or incomplete information. Adding/removing participants via the UI doesn't update the server state reliably. **See BUG-0063**
388	388	
389	389	### Proposed new design
390	390	Implement a `GroupManager` that:
391	391	- Fetches fresh participant lists via Baileys `groupMetadata` on chat open.
392	392	- Caches participant JID ↔ name mappings in a time-expiring LRU cache.
393	393	- Uses Baileys `groupParticipantsUpdate` to push server-side changes to the UI.
394	394	
395	395	### Benefits of rewrite
396	396	- Always-current group participant lists.
397	397	- Reliable UI updates when members join/leave.
398	398	
399	399	### Consequences of previous design
400	400	- Stale participant lists caused confusion about group membership.
401	401	- UI failed to reflect server-side membership changes.
402	402	
403	403	---
404	404	
405	405	## 21. Message Search & Filtering
406	406	
407	407	### Why rewrite is necessary
408	408	Search only matches exact message content strings, not senders, dates, or message types (images, voice notes). **See BUG-0064**
409	409	
410	410	### Proposed new design
411	411	Build a `SearchEngine` supporting:
412	412	- Full-text content search with stemming/tokenization.
413	413	- Sender name/JID filters.
414	414	- Date range filters.
415	415	- Message type filters (text, image, video, document, voice).
416	416	
417	417	### Benefits of rewrite
418	418	- Powerful, flexible message search capabilities.
419	419	- Improved productivity for users managing large chat histories.
420	420	
421	421	### Consequences of previous design
422	422	- Users couldn't search by sender or date.
423	423	- Media messages were excluded from search results.
424	424	
425	425	---
426	426	
427	427	## 22. Media Download & Cache Management
428	428	
429	429	### Why rewrite is necessary
430	430	Media files (images, videos, documents) are downloaded to a flat `media/` directory with unintuitive filenames. No cache invalidation exists—old versions persist indefinitely. **See BUG-0065**
431	431	
432	432	### Proposed new design
433	433	Implement a `MediaManager` with:
434	434	- Hash-based filenames (e.g., `sha256:ABC123.jpg`).
435	435	- LRU cache with configurable size limit.
436	436	- Automatic verification of existing files before re-download.
437	437	
438	438	### Benefits of rewrite
439	439	- Efficient disk usage via caching and deduplication.
440	440	- Faster media loading by avoiding redundant downloads.
441	441	
442	442	### Consequences of previous design
443	443	- Media directory consumed excessive disk space over time.
444	444	- Users re-downloaded the same file multiple times.
445	445	
446	446	---
447	447	
448	448	## 23. Voice Message Recording & Playback
449	449	
450	450	### Why rewrite is necessary
451	451	Recording uses `pyaudio` with hardcoded parameters (sample rate, channels), causing compatibility issues on some systems. Playback lacks a visual waveform and progress slider. **See BUG-0066**
452	452	
453	453	### Proposed new design
454	454	Replace `pyaudio` with `sounddevice` for cross-platform reliability. Add a `VoiceMessagePlayer` with:
455	455	- Waveform visualization using `matplotlib` or `pyqtgraph`.
456	456	- Seekable progress slider.
457	457	- Playback speed controls.
458	458	
459	459	### Benefits of rewrite
460	460	- Reliable recording across all supported Windows versions.
461	461	- Enhanced user experience with visual feedback and controls.
462	462	
463	463	### Consequences of previous design
464	464	- Recording failures on systems with non-standard audio configurations.
465	465	- Users couldn't scrub through voice messages.
466	466	
467	467	---
468	468	
469	469	## 24. Emoji & Sticker Handling
470	470	
471	471	### Why rewrite is necessary
472	472	Emoji input relies on `wx.TextCompleter` with a static list, missing modern emojis and skin tone variants. Sticker packs are not supported. **See BUG-0067**
473	473	
474	474	### Proposed new design
475	475	Integrate a modern emoji picker using `emoji-data-python` with:
476	476	- Search by name or keyword.
477	477	- Skin tone and gender variant selectors.
478	478	- Sticker pack support via WhatsApp's official sticker API.
479	479	
480	480	### Benefits of rewrite
481	481	- Access to the full Unicode emoji catalog.
482	482	- Sticker sending and receiving capabilities.
483	483	
484	484	### Consequences of previous design
485	485	- Limited emoji selection frustrated users.
486	486	- Absence of stickers reduced engagement.
487	487	
488	488	---
489	489	
490	490	## 25. Theme & UI Customization
491	491	
492	492	### Why rewrite is necessary
493	493	Theming is hardcoded to light/dark modes with no user customization. Font sizes and colors can't be adjusted. **See BUG-0068**
494	494	
495	495	### Proposed new design
496	496	Introduce a `ThemeManager` that:
497	497	- Loads themes from `themes/` directory (JSON files).
498	498	- Allows users to create/share custom themes.
499	499	- Supports dynamic font scaling and color overrides.
500	500	
501	501	### Benefits of rewrite
502	502	- Personalized visual experience for users.
503	503	- Improved accessibility through font scaling.
504	504	
505	505	### Consequences of previous design
506	506	- Users with visual impairments struggled with fixed font sizes.
507	507	- No option to customize colors or layouts.
508	508	
509	509	---
510	510	
511	511	## 26. Logging & Diagnostics
512	512	
513	513	### Why rewrite is necessary
514	514	Logs are written to a single `log.log` file that's truncated on every launch. No log rotation or archival exists. **See BUG-0069**
515	515	
516	516	### Proposed new design
517	517	Implement log rotation with `logging.handlers.RotatingFileHandler` (keep 5 files, 5MB each). Add a diagnostics mode (`--diag` CLI flag) that captures:
518	518	- Full log output with timestamps.
519	519	- System info (OS, Python version, wxPython version).
520	520	- Config and settings dumps.
521	521	
522	522	### Benefits of rewrite
523	523	- Retain historical logs for debugging.
524	524	- Simplify troubleshooting for user-reported issues.
525	525	
526	526	### Consequences of previous design
527	527	- Critical debugging information was lost after each launch.
528	528	- Users had to reproduce issues without historical context.
529	529	
530	530	---
