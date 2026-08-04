import logging
import threading
import time
import socketio
import wx
import requests
from core.i18n import I18n
from core.utils import looks_like_binary_blob, _slim_quoted_message, parse_bool_flag as _parse_bool_flag

# ── Message delivery status ──────────────────────────────────────────────────
# The app's own scale (Baileys-shaped, what messages.status stores and what
# ui/conversations.py::_map_status renders): 2=sent, 3=delivered, 4=read,
# 5=played.  Two extra values make the states WhatsApp reports but the app used
# to swallow explicit:
STATUS_FAILED  = -1   # WhatsApp Web gave up on the send
STATUS_PENDING = 0    # created locally, not acked by the server yet

# WhatsApp's own ACK scale is WPP.whatsapp.enums.ACK:
#   -7 MD_DOWNGRADE, -6 INACTIVE, -5 CONTENT_UNUPLOADABLE, -4 CONTENT_TOO_BIG,
#   -3 CONTENT_GONE, -2 EXPIRED, -1 FAILED, 0 CLOCK, 1 SENT, 2 RECEIVED,
#   3 READ, 4 PLAYED, 5 PEER (acked by another of our own devices).
_ACK_TO_STATUS = {
    0: STATUS_PENDING,
    1: 2,
    2: 3,
    3: 4,
    4: 5,
    5: 2,
}


def ack_to_status(wpp_ack):
    """Translate a WhatsApp ACK into the app's status scale.

    Returns None when the ack is not one we understand — the caller must then
    leave the message's status alone. This used to be ``mapping.get(ack, 2)``,
    which reported *every* unrecognised ack as "sent": a FAILED (-1) ack, i.e.
    WhatsApp Web telling us the message will never leave the outbox, showed up
    in the UI as "Enviada". Silence and failure both have to be distinguishable
    from success here, since this is the app's only delivery feedback.
    """
    if not isinstance(wpp_ack, int) or isinstance(wpp_ack, bool):
        return None
    if wpp_ack < 0:
        # -1 FAILED and every more specific failure below it (expired, content
        # gone, too big, …) all mean the same thing to the user: not delivered.
        return STATUS_FAILED
    return _ACK_TO_STATUS.get(wpp_ack)


class WebSocketClient:
    def __init__(self, main_window, connect, instance_name):
        self.main_window = main_window
        self.connect = connect
        self.instance_name = instance_name.split(":")[0]
        #Initialize i18n
        self.i18n = I18n(self.main_window)
        self.i18n.get_language()

        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=0,      # 0 = unlimited
            reconnection_delay=2,
            reconnection_delay_max=60,
            logger=False,
            engineio_logger=False,
        )
        # WPPConnect Server emits all events on root "/" namespace via req.io.emit().
        # Registering handlers without namespace defaults them to "/" (root).
        self.sio.on("connect", self.on_connect)
        self.sio.on("disconnect", self.on_disconnect)
        self.sio.on("qrCode", self.on_wpp_qrcode)
        self.sio.on("session-logged", self.on_wpp_session_logged)
        self.sio.on("messages.upsert", self.on_messages_upsert)
        self.sio.on("messages.set", self.on_messages_set)
        self.sio.on("phoneCode", self.on_wpp_phone_code)
        self.sio.on("status-find", self.on_wpp_status_find)
        self.sio.on("chats.update", self.on_chats_update)
        self.sio.on("chats-update", self.on_chats_update)
        self.sio.on("messages.update", self.on_messages_update)
        self.sio.on("contacts.update", self.on_contacts_update)
        self.sio.on("presence.update", self.on_presence_update)

        # threading.Event used by on_continue() to wait for the phoneCode that
        # WPPConnect emits asynchronously via Socket.IO after /start-session.
        self._phone_code_event = threading.Event()
        self._phone_code_value: str = ""

        # Debounce timer for on_disconnect() — see that method.
        self._disconnect_timer = None

    def on_connect(self):
        logging.info("[WebSocketClient] WebSocket connected.")
        # Cancel any pending "confirm still disconnected" check from
        # on_disconnect() — we just reconnected, so that transient blip
        # never needs to be declared offline at all.
        if self._disconnect_timer is not None:
            self._disconnect_timer.cancel()
            self._disconnect_timer = None
        # Record when we connected so on_messages_upsert can use a stable
        # cutoff time rather than the ever-advancing time.time().
        self._connect_time = time.time()
        # This fires both on the initial connect and on every automatic
        # reconnect after a transport-level drop. on_disconnect() pauses the
        # MessageQueue by setting _wa_connected = False, but nothing else
        # reliably flips it back to True on a plain reconnect (WPPConnect
        # only re-emits "session-logged" around pairing/login, not on every
        # reconnect) — so a brief network blip could pause sending forever
        # even though WhatsApp itself never actually disconnected. Re-check
        # via HTTP and flush the queue so it self-heals like a manual resync.
        threading.Thread(target=self._recheck_connection_after_connect, daemon=True).start()

    def _recheck_connection_after_connect(self):
        try:
            self.main_window.check_wa_connection_http()
            if getattr(self.main_window, "_wa_connected", False):
                if hasattr(self.main_window, "message_queue"):
                    self.main_window.message_queue.flush()
                # Every Socket.IO (re)connect — not only the ones where
                # check_wa_connection_http() above also flips _wa_connected
                # from False to True — gets a catch-up sync opportunity.
                # WPPConnect's HTTP status can stay "CONNECTED" throughout a
                # purely transport-level Socket.IO drop (a brief network
                # blip too short for the 30s health check to ever see it as
                # down), so live messages.upsert events emitted during that
                # gap are simply gone — nothing else re-delivers them. This
                # is the client-side half of the "connection looks perfectly
                # stable yet a message silently never arrives, and F5 fixes
                # it" reports: was a live delivery gap, not a bug in how an
                # arrived message got processed. _sync_completed is reset so
                # trigger_sync_if_needed() is willing to run again; the
                # existing cooldown/backoff in that method still protects
                # against a flaky connection reconnecting every few seconds
                # turning this into a sync storm.
                self.main_window._sync_completed = False
                if hasattr(self.main_window, "trigger_sync_if_needed"):
                    self.main_window.trigger_sync_if_needed()
        except Exception:
            logging.exception("[WebSocketClient] _recheck_connection_after_connect error")

    def on_disconnect(self):
        logging.info("[WebSocketClient] WebSocket disconnected.")
        # Debounced: python-socketio auto-reconnects on its own within a few
        # seconds for an ordinary transient blip (Wi-Fi/NAT power-save churn,
        # a brief hiccup against the local WPPConnect server) — declaring the
        # app offline immediately for every one of those used to flicker the
        # title/tray between connected/disconnected and, once
        # _recheck_connection_after_connect() saw the reconnect, force a full
        # resync every time — even though WhatsApp itself never actually went
        # down and outgoing sends (which go over the REST API, not this
        # socket) were never actually blocked. Wait a few seconds and only
        # declare it if the socket is STILL down by then; a genuine outage is
        # still caught either by this (a little later) or by the 30-second
        # health check regardless.
        if self._disconnect_timer is not None:
            self._disconnect_timer.cancel()

        def _confirm_still_disconnected():
            if not self.sio.connected:
                self.main_window._set_wa_connected(False, "socket disconnected", False)

        self._disconnect_timer = threading.Timer(
            5.0, lambda: wx.CallAfter(_confirm_still_disconnected)
        )
        self._disconnect_timer.daemon = True
        self._disconnect_timer.start()

    def on_connection_update(self, info):
        logging.debug(f"[WebSocketClient] event payload: {info}")
        #Checks the new connection state
        data             = info.get("data", {})
        connection_state = data.get("state", "")
        if connection_state == "open":
            # A confirmed live connection means any earlier logout is done
            # and re-pairing succeeded — clear the _handle_logout guard so a
            # genuinely new future logout is handled again instead of being
            # silently ignored as a stale duplicate.
            self._logout_handled = False
            # Store the user's own JID so self-chat detection and group-admin
            # checks have access to it throughout the session.
            wuid = data.get("wuid", "")
            if wuid:
                self.main_window.my_jid = wuid
                self.main_window.resolve_self_lid()
            # Mark WhatsApp as connected: this leaves automatic offline mode,
            # resumes the MessageQueue, clears the status text and retriggers a
            # sync that was skipped while the connection was down.
            self.main_window._set_wa_connected(True, "session-logged")
            if hasattr(self.main_window, "message_queue"):
                self.main_window.message_queue.flush()

            # Save the paired status so next startup knows pairing was fully completed.
            pi = self.main_window.settings.setdefault("privateinfo", {})
            if not pi.get("paired"):
                pi["paired"] = True
                self.main_window.save_settings()

            self.on_pairing_complete()

            # A pairing in progress that reaches "open" isn't necessarily
            # safe yet — WPPConnect's own Puppeteer/Chrome session can crash
            # moments later (confirmed live via wppconnect.log: a
            # "browserClose" event followed by taskkill errors for Chrome's
            # already-dead child processes) without Node.js itself going
            # down and, critically, without ever telling WinZapp anything
            # went wrong: the Socket.IO connection to the still-alive
            # WPPConnect Server process never drops, so on_connection_update
            # never gets a "close" to react to and the app just sits there
            # believing it's connected forever, with no window ever shown
            # and no error. This watchdog is the only check independent of
            # WPPConnect telling us anything: if this attempt hasn't
            # received real chat data by the time it fires, it treats the
            # pairing as failed on its own.
            if getattr(self.main_window, "_pairing_in_progress", False):
                self._start_pairing_watchdog()
        elif connection_state == "close":
            was_connected = self.main_window._wa_connected
            self.main_window._set_wa_connected(False, "session closed")

            # Detect permanent WhatsApp logout (status 401 = loggedOut).
            status_code  = (
                data.get("statusCode")
                or data.get("status")
                or (data.get("lastDisconnect") or {}).get("statusCode")
            )
            is_logout = (
                data.get("loggedOut", False)
                or status_code == 401
            )
            # A connection that closes again — for ANY reason, not just an
            # explicit 401/loggedOut — while a pairing attempt is still in
            # progress and before WPPConnect ever delivered real chat data
            # means WhatsApp never actually finished linking the device, even
            # though it may have briefly reported "open" and made WinZapp
            # announce itself as connected. _pairing_in_progress is a narrow
            # window (set when Connect.on_continue() starts, cleared once
            # messages.set arrives) specifically so this never fires for an
            # ordinary reconnect hiccup on an already-established, already-
            # synced account — only for a pairing that never truly completed.
            pairing_failed = (
                not is_logout
                and getattr(self.main_window, "_pairing_in_progress", False)
                and not getattr(self.main_window, "messages_set_completed", False)
            )
            if is_logout or pairing_failed:
                if pairing_failed:
                    logging.warning(
                        "[WebSocketClient] Connection closed during an active pairing "
                        "before the initial sync ever started (statusCode=%s) — "
                        "treating as a failed pairing.", status_code,
                    )
                    wx.CallAfter(self._handle_pairing_failed)
                else:
                    # Permanent logout: clear credentials and redirect to pairing.
                    wx.CallAfter(self._handle_logout)
            else:
                # Temporary disconnection (network glitch, WhatsApp session interrupted).
                # Mark WA as disconnected so the MessageQueue stops trying to send.
                # Do NOT show a blocking dialog — Baileys reconnects automatically and
                # fires connection.update(state=open) when it succeeds.  A blocking
                # dialog would freeze the UI and prevent that recovery.
                def _notify_disconnection():
                    mw = self.main_window
                    mw._set_wa_connected(False, "temporary disconnection")
                    mw.error_sound.play()
                    mw.output(self.i18n.t("wa_disconnected_temp"), interrupt=False)
                    mw._set_status(self.i18n.t("tray_wa_disconnected"))
                wx.CallAfter(_notify_disconnection)

    def _start_pairing_watchdog(self, timeout: float = 45.0):
        """
        Safety net for a pairing that reached "open" and is then never heard
        from again — no further Socket.IO event at all, not even a "close".

        Runs on a plain threading.Timer, independent of both the wx main
        thread and the Socket.IO background thread, specifically so it still
        fires even if one of those is stuck: the failure mode this exists
        for (WPPConnect's own Puppeteer/Chrome session crashing right after
        briefly reporting "open", confirmed live via wppconnect.log showing
        a "browserClose" event) leaves Node.js itself running and the
        Socket.IO connection to it intact, so nothing ever tells
        on_connection_update's "close" branch to react — the ordinary
        recovery path never gets a chance to run at all.
        """
        my_attempt = self.connect._pairing_attempt_id

        def _check():
            if self.connect._pairing_attempt_id != my_attempt:
                return  # superseded — cancelled, or a newer attempt started
            if not getattr(self.main_window, "_pairing_in_progress", False):
                return  # already resolved: synced, cancelled, or already recovered
            logging.warning(
                "[WebSocketClient] Pairing attempt still hadn't received real "
                "chat data %.0fs after appearing to open — treating as a "
                "failed pairing (watchdog).", timeout,
            )
            wx.CallAfter(self._handle_pairing_failed)

        t = threading.Timer(timeout, _check)
        t.daemon = True
        t.start()

    def _handle_logout(self):
        """Handle a permanent WhatsApp logout (device removed from account)."""
        self._reset_credentials_and_show_pairing("device_logged_out")

    def _handle_pairing_failed(self):
        """
        A pairing attempt appeared to succeed — WPPConnect briefly reported
        the connection as "open" and WinZapp announced it as connected — but
        it closed again before the initial sync ever started, meaning
        WhatsApp itself never actually finished linking the device (a
        rejected/timed-out pairing, reported live as the phone showing "Não
        foi possível conectar o dispositivo" seconds after WinZapp had
        already played the connected sound).

        Recovers exactly like a permanent logout: without this, the "close"
        branch of on_connection_update only recognizes explicit 401/loggedOut
        signals as a reason to reset and re-show the pairing dialog, so this
        kind of failure — which carries neither — left the app sitting
        indefinitely on a half-finished pairing with no error, no window,
        and no way back to the connection dialog.
        """
        self._reset_credentials_and_show_pairing("pairing_failed_msg")

    def _reset_credentials_and_show_pairing(self, message_key: str):
        """Shared recovery for _handle_logout()/_handle_pairing_failed().

        Runs on the wx main thread (via wx.CallAfter).  Shows an informative
        dialog, wipes the now-invalid credentials from settings, disconnects
        the socket, and opens the connection dialog so the user can re-pair.

        Multiple independent event paths can decide the same underlying
        problem happened (on_connection_update's 401/loggedOut check, its new
        failed-pairing check, and on_wpp_status_find's notLogged/
        disconnectedMobile check) and all schedule one of the two methods
        above via wx.CallAfter before any has run. Since CallAfter callbacks
        are dispatched one at a time on this same thread, a simple flag
        checked at entry is enough to make every call after the first a
        no-op — without it the error dialog appeared twice, credentials were
        wiped twice, and two pairing dialogs could end up stacked on screen.
        """
        if getattr(self, "_logout_handled", False):
            return
        self._logout_handled = True

        mw = self.main_window
        mw._wa_connected = False
        mw._pairing_in_progress = False
        mw.error_sound.play()

        wx.MessageBox(
            self.i18n.t(message_key),
            self.i18n.t("error").format(app_name=mw.app_name),
            wx.OK | wx.ICON_ERROR,
        )

        # Wipe the invalidated credentials so next startup goes to pairing.
        old_token = mw._get_wa_token()
        pi = mw.settings.setdefault("privateinfo", {})
        mw._set_wa_token("")
        pi.pop("WA_phone_number", None)
        pi.pop("paired", None)
        mw.messages_set_completed = False
        mw.token = ""
        mw.save_settings()

        # Wipe all cached chats/contacts/media to avoid cross-account data leakage
        mw.clear_local_data()

        # Best-effort: close the WPPConnect session so Chrome is released.
        if old_token:
            def _close():
                try:
                    requests.post(
                        f"{mw.wpp_server}:{mw.wpp_port}/api/{old_token}/close-session",
                        headers={"Authorization": f"Bearer {old_token}", "Content-Type": "application/json"},
                        timeout=5,
                    )
                except Exception:
                    pass
            threading.Thread(target=_close, daemon=True).start()

        # Disconnect the socket (may already be disconnecting).
        try:
            self.sio.disconnect()
        except Exception:
            pass

        # Reset connection state as if this were a fresh launch — see the
        # matching comment in main.py's _on_disconnect() for why: without
        # this, _set_wa_connected()'s startup grace window stays permanently
        # disabled after re-pairing (it only applies while
        # "never _wa_connect_announced"), so the first not-yet-settled check
        # right after the new pairing completes gets mistaken for a real
        # outage.
        mw._wa_connected = False
        mw._wa_connect_announced = False
        mw._auto_offline = False
        mw._wa_offline_strikes = 0
        mw._wa_startup_time = time.time()

        # Redirect to pairing dialog.
        self.connect.show_connection_dial()

    def on_pairing_complete(self):
        # End the dialogs' modal loops on the main thread to avoid wx
        # thread-safety issues. Guards against the case where the app is
        # already paired (no dialogs open).
        #
        # connection_dial (and pairing_dial, its child) are shown via
        # ShowModal() — Destroy()ing a dialog directly while its modal loop
        # is still running never signals that loop to unwind, so wx never
        # re-enables the parent window ShowModal() disabled when it started.
        # The dialog object goes away but the main window stays blocked for
        # input — reported live as "reconnected successfully, but the main
        # window was frozen/unusable and kept announcing 'connection
        # restored' in the background".
        #
        # EndModal() ONLY here — never Destroy(). Both dialogs already
        # Destroy() themselves right after their own ShowModal() call
        # returns (show_pairing_dial() / show_connection_dial() in
        # connect.py).
        #
        # Close ONLY the innermost modal here. pairing_dial is nested INSIDE
        # connection_dial's own modal loop (on_continue() opens it from a
        # button handler running inside connection_dial.ShowModal()), and wx
        # only allows EndModal() on the loop that is actually running.
        #
        # EndModal() does NOT unwind its loop immediately — it merely signals
        # it — and that still-running loop keeps dispatching pending events,
        # including any wx.CallAfter queued from within it. So closing
        # connection_dial from here was impossible: both inline and via a
        # CallAfter chained off this same handler ran while pairing_dial's
        # loop was still the running one, and wx rejected it with a hard
        # assertion ("IsRunning()" failed ... "Use ScheduleExit() on not
        # running loop"). log.log confirmed the ordering — the parent's close
        # attempt logged BEFORE "pairing_dial modal loop returned".
        #
        # connection_dial is therefore closed by show_pairing_dial() itself,
        # right after its own ShowModal() returns (see connect.py), which is
        # the only point where control is provably back in the parent's loop.
        def _end_innermost_dialog():
            # Phone-pairing flow: pairing_dial is on top, and closing it lets
            # show_pairing_dial() resume and close connection_dial in turn.
            if hasattr(self.connect, 'pairing_dial'):
                try:
                    dlg = self.connect.pairing_dial
                    # `if dlg` — not wx.IsDestroyed(dlg), which does not exist:
                    # that call raised AttributeError on every single pairing,
                    # so this whole block fell straight into the except below and
                    # neither EndModal() nor anything else ever ran. A wxPython
                    # wrapper whose C++ window is gone is falsy, which is the
                    # check connect.py already uses for this same dialog.
                    if dlg and dlg.IsModal():
                        logging.info("[on_pairing_complete] Ending pairing_dial modal loop.")
                        dlg.EndModal(wx.ID_OK)
                        return
                    logging.info("[on_pairing_complete] pairing_dial not modal — falling through to connection_dial.")
                except Exception:
                    logging.exception("[on_pairing_complete] Failed to end pairing_dial.")
                    return
            else:
                logging.info("[on_pairing_complete] No pairing_dial attribute — closing connection_dial directly.")
            # QR-code flow (or pairing_dial already gone): connection_dial is
            # itself the innermost running loop, so it can be ended here.
            if hasattr(self.connect, 'connection_dial'):
                try:
                    dlg = self.connect.connection_dial
                    # See the pairing_dial guard above for why this is `if dlg`.
                    if dlg and dlg.IsModal():
                        logging.info("[on_pairing_complete] Ending connection_dial modal loop.")
                        dlg.EndModal(wx.ID_OK)
                    else:
                        logging.info("[on_pairing_complete] connection_dial not modal — nothing to end.")
                except Exception:
                    logging.exception("[on_pairing_complete] Failed to end connection_dial.")
            else:
                logging.info("[on_pairing_complete] No connection_dial attribute — nothing to close.")

        logging.info("[on_pairing_complete] Scheduling dialog close via CallAfter.")
        wx.CallAfter(_end_innermost_dialog)


    @staticmethod
    def _extract_qr_payload(info) -> tuple:
        """(base64_image, pairing_code) from a 'qrCode' event, whatever its shape.

        WPPConnect Server emits, from exportQR() in createSessionUtil.ts:

            req.io.emit('qrCode', {data: 'data:image/png;base64,…', session: …})

        i.e. ``info["data"]`` is a *string*. This used to be read as
        ``info["data"]["qrcode"]["base64"]``, so every single event raised
        AttributeError on the string — swallowed by python-socketio, which runs
        with logging disabled, so nothing ever appeared in the log.

        The damage was not cosmetic: this handler is the only thing that
        refreshes the QR. WhatsApp rotates it roughly every 20 s, so the dialog
        was left showing the one-shot copy fetched from status-session when it
        opened, long expired by the time anyone pointed a phone at it — read as
        an invalid code. The pairing-code refresh path rode on the same event
        and was equally dead.

        Nested shapes are still accepted in case a different WPPConnect build
        wraps it, and top-level keys are used as a last resort.
        """
        if not isinstance(info, dict):
            return "", ""
        base64_img, pairing_code = "", ""
        raw = info.get("data")
        if isinstance(raw, str):
            base64_img = raw
        elif isinstance(raw, dict):
            inner = raw.get("qrcode")
            if isinstance(inner, dict):
                base64_img = inner.get("base64") or ""
                pairing_code = inner.get("pairingCode") or ""
            elif isinstance(inner, str):
                base64_img = inner
            base64_img = base64_img or raw.get("base64") or ""
            pairing_code = pairing_code or raw.get("pairingCode") or ""
        base64_img = base64_img or info.get("qrcode") or info.get("base64") or ""
        pairing_code = pairing_code or info.get("pairingCode") or ""
        return (base64_img if isinstance(base64_img, str) else "",
                str(pairing_code) if pairing_code else "")

    def on_qrcode_update(self, info):
        logging.debug(f"[WebSocketClient] event payload: {info}")
        base64_img, pairing_code = self._extract_qr_payload(info)
        if not base64_img and not pairing_code:
            logging.warning("[on_qrcode_update] qrCode event carried nothing usable: %r",
                            list(info.keys()) if isinstance(info, dict) else type(info).__name__)
            return
        logging.info("[on_qrcode_update] Refreshed QR (%d bytes of image, pairing_code=%s).",
                     len(base64_img), bool(pairing_code))

        def _update_ui():
            # Use connection_mode to determine which mode we're in
            if self.connect.connection_mode == "qrcode" and base64_img:
                # QR-CODE mode: update the image
                self.main_window.pairing_code_updated_sound.play()
                self.main_window.speak_output.output(self.i18n.t("qrcode_image_updated"))
                self.connect.display_qrcode_image(base64_img)
            elif self.connect.connection_mode == "phone" and pairing_code:
                # Pairing code mode: update the text field only if it still exists.
                # `if field` — not wx.IsDestroyed(field), which does not exist and
                # raised AttributeError here on every single rotated code. Caught
                # by the bare `except Exception: pass` this used to have, it made
                # WPPConnect's whole qrCode-carrying-a-pairingCode refresh path
                # silently dead: the dialog kept showing the first code while
                # WhatsApp had already rotated it. A destroyed wx wrapper is falsy
                # and any call on it raises RuntimeError, so the `and` below is the
                # whole guard needed (same idiom as connect.py's update_pairing_code).
                field = getattr(self.connect, "pairing_code_field", None)
                if field:
                    try:
                        current_val = field.GetValue().strip()
                        if current_val != pairing_code.strip():
                            self.main_window.pairing_code_updated_sound.play()
                            self.main_window.speak_output.output(self.i18n.t("qrcode_updated"))
                            field.SetValue(pairing_code)
                    except RuntimeError:
                        pass  # dialog destroyed between the check and the call
                    except Exception:
                        # Never let a refresh failure go unnoticed again — this
                        # bug hid behind a silent `pass` for exactly that reason.
                        logging.exception("[on_qrcode_update] Failed to refresh the pairing code field.")
            elif (
                base64_img
                and not self.main_window._is_pairing_dialog_active()
                and self.main_window.settings.get("privateinfo", {}).get("paired")
                and not getattr(self.main_window, "_auto_repair_dialog_shown", False)
            ):
                # WPPConnect just generated a real QR/pairing code with no
                # pairing dialog open at all — it only does this once it has
                # already decided the stored session can't be restored, so
                # this is a reliable "you need to re-pair" signal on its own,
                # unlike the coarse status-session string the health-check
                # poll watches (which needs several minutes of confirmation
                # to rule out a normal slow boot). Surfacing the pairing
                # dialog immediately — instead of leaving the user staring at
                # "offline" for up to _LOGOUT_STARTUP_GRACE_SECONDS /
                # _AUTO_RESTART_LOGOUT_GRACE_SECONDS with no explanation —
                # was an explicit, accepted tradeoff: this dialog's own
                # Cancel/close buttons quit the app / drop the WebSocket for
                # good, which is fine here specifically because a session
                # that reached this point has nothing left to lose by
                # closing — see the conversation this was decided in.
                # _auto_repair_dialog_shown latches so a 20-30s QR refresh
                # while the user is still deciding what to do doesn't pop
                # a second nested dialog.
                self.main_window._auto_repair_dialog_shown = True
                logging.warning(
                    "[on_qrcode_update] Session needs re-pairing while "
                    "previously paired, with no pairing dialog open — "
                    "showing it proactively instead of waiting for the "
                    "slower confirmed-logout detection."
                )
                # Same sound + MessageBox as the confirmed-logout path's own
                # _logout_with_warning() (main.py) — recognisable, expected
                # feedback that something happened, just without that path's
                # _on_disconnect() call (no data wipe). Also bring the window
                # to the foreground first: if it was minimized to the tray
                # (background mode), a modal dialog appearing behind/under
                # everything with no prior audible cue is easy to miss
                # entirely — reported live as exactly that.
                self.main_window.restore_window()
                self.main_window.error_sound.play()
                wx.MessageBox(
                    self.i18n.t("device_logged_out"),
                    self.i18n.t("error").format(app_name=self.main_window.app_name),
                    wx.OK | wx.ICON_ERROR,
                )
                self.connect.show_connection_dial()

        wx.CallAfter(_update_ui)

    def on_messages_set(self, info):
        self.main_window.messages_set_completed = True
        # Real chat data has arrived — this pairing (if one was in progress)
        # has genuinely succeeded, so it's no longer at risk of being treated
        # as a failed pairing by on_connection_update if the socket later
        # drops for an ordinary/unrelated reason.
        self.main_window._pairing_in_progress = False
        # _try_start_sync_thread() atomically checks "already running or
        # already completed" and starts self.sync_thread under a lock —
        # WPPConnect sends messages.set in multiple batches during initial
        # sync, and this same method also gets called directly (not via a
        # real messages.set event) elsewhere, so more than one caller can
        # race to start a sync within milliseconds of each other. A plain
        # is_alive() check here (the old code) has a gap between checking
        # and starting that another thread's own check can land in — two
        # sync threads running at once was reported live as "sincronizando
        # conversas" announced twice and, worse, concurrent writes to the
        # single DatabaseBridge connection failing outright and flooding the
        # screen with error dialogs.
        self.main_window._try_start_sync_thread()

    def on_messages_upsert(self, info):
        """
        Handle real-time incoming messages from the WPPConnect.

        In WPPConnect v2 the websocket envelope is
          {"event": "messages.upsert", "instance": ..., "data": <message_or_list>, ...}
        where "data" is either a single message dict OR an array of messages
        (the gateway batches historical messages into arrays of up to 50).
        """
        try:
            raw_data = info.get("data", {})

            # Normalise to a list: the gateway may emit a single message dict
            # (live traffic) OR an array of messages (batched history sync).
            if isinstance(raw_data, list):
                messages = [m for m in raw_data if isinstance(m, dict) and m.get("key")]
            elif isinstance(raw_data, dict) and raw_data.get("key"):
                messages = [raw_data]
            else:
                return

            for msg in messages:
                self._process_single_upsert(msg)

        except Exception:
            logging.exception("[WebSocketClient] on_messages_upsert error")

    def _process_single_upsert(self, msg: dict):
        """Process a single messages.upsert message dict."""
        # ── Skip history-sync echoes ───────────────────────────────────────
        # WPPConnect/Baileys fires messages.upsert for historical messages
        # (isMdHistoryMsg=True) during its initial sync phase. These are
        # normally the same records already fetched by sync_chat_messages via
        # the REST API and placed in the correct chronological position, so
        # treating them as live new messages would append them at the bottom
        # of the conversation as if they had just been sent — dispatch them
        # to the historical handler to be saved silently instead.
        #
        # BUT: this assumption only holds for a chat that hasn't been synced
        # yet (not present in self.chats). Once a chat is already in the
        # list, WPPConnect can still tag a genuinely new, real-time message
        # with isMdHistoryMsg=True (observed in practice) — silently routing
        # it to on_historical_message would save it without a notification,
        # sound, or unread-count bump, effectively "losing" it from the
        # user's point of view. So: only take the silent path for chats not
        # yet in the list; an already-listed chat always gets full live
        # treatment regardless of the flag.
        if msg.get("isMdHistoryMsg"):
            key = msg.get("key", {})
            remote_jid = self.main_window._normalize_jid(key.get("remoteJid", ""))
            if remote_jid not in self.main_window.chats:
                wx.CallAfter(self.main_window.on_historical_message, msg)
                return
            # Chat already known/synced — fall through to live handling below.

        # Extract JID mapping from WebSocket message
        self.main_window._extract_lid_mapping(msg)
        # fromMe=True can mean two things:
        #   (a) WinZapp sent this message via MessageQueue — already rendered
        #       in the UI; the WebSocket echo must be ignored.
        #   (b) The user sent this message from another device (phone, official
        #       Windows app) — must be added to the conversation like any
        #       incoming message (but without playing a notification sound).
        # We distinguish the two cases via _own_sent_ids, which is populated
        # by MessageQueue immediately after the API returns the real message ID.
        if msg.get("key", {}).get("fromMe", False):
            # Own reactions are applied optimistically in _on_own_reaction_sent;
            # suppress the WebSocket echo so the reaction count isn't doubled.
            if msg.get("messageType") == "reactionMessage":
                return
            msg_id = msg.get("key", {}).get("id", "")
            _lock = getattr(self.main_window, "_own_sent_ids_lock", None)
            if _lock is not None:
                with _lock:
                    _is_own = msg_id and msg_id in self.main_window._own_sent_ids
            else:
                _is_own = msg_id and msg_id in getattr(self.main_window, "_own_sent_ids", set())
            if _is_own:
                return  # echo of our own send — skip
            # Otherwise: sent from another device — fall through to on_new_message
        wx.CallAfter(self.main_window.on_new_message, msg)

    def on_messages_update(self, info):
        """
        Handle messages.update — delivery/read status changes for sent messages.

        WPPConnect v2 sends:
          {"data": [{"key": {"id": ..., "remoteJid": ..., "fromMe": true},
                     "status": "READ"|"DELIVERY_ACK"|"SERVER_ACK",
                     "update": {"status": 4}}]}
        """
        try:
            data = info.get("data", [])
            if isinstance(data, dict):
                data = [data]
            if not isinstance(data, list):
                return
            for update in data:
                if not isinstance(update, dict):
                    continue
                if not update.get("key", {}).get("fromMe"):
                    continue
                wx.CallAfter(self.main_window.on_message_status_update, update)
        except Exception:
            logging.exception("[WebSocketClient] on_messages_update error")

    def on_chats_update(self, info):
        """
        Handle chats.update — partial chat state changes (e.g. unreadCount reset
        when the user reads messages on another device via app-state sync).

        WPPConnect emits:
          {"data": [{"remoteJid": ..., "unreadCount": 0, ...}]}
        """
        try:
            data = info.get("data", [])
            if isinstance(data, dict):
                data = [data]
            if not isinstance(data, list):
                return
            for chat_update in data:
                if not isinstance(chat_update, dict):
                    continue
                jid = chat_update.get("remoteJid") or chat_update.get("id", "")
                if not jid:
                    continue
                jid = self.main_window._normalize_jid(jid)
                unread = chat_update.get("unreadCount")
                if unread is not None:
                    wx.CallAfter(self.main_window.on_chat_unread_update, jid, int(unread))
                
                archive = chat_update.get("archive") if chat_update.get("archive") is not None else chat_update.get("archived")
                if archive is not None:
                    # bool("false") is True — parsing this the naive way is how
                    # conversations that were never archived on WhatsApp kept
                    # jumping into the Archived tab. Only act on a value we can
                    # actually interpret.
                    archived_flag = _parse_bool_flag(archive)
                    if archived_flag is not None:
                        wx.CallAfter(self.main_window.on_chat_archive_update, jid, archived_flag)

                # Handle pin/unpin updates in real-time. Act whenever the update
                # carries a `pin` field AT ALL — an explicit null/0 means the
                # chat was unpinned and must not be ignored, or a stale pin
                # lingers until the next 60s list-chats poll (and even then only
                # if the poll's own reconciliation fires). An update that simply
                # omits the key (e.g. an unreadCount-only delta) is not a pin
                # change and is skipped.
                if "pinned" in chat_update or "pin" in chat_update:
                    pin = chat_update.get("pinned") if "pinned" in chat_update else chat_update.get("pin")
                    if isinstance(pin, str):
                        if pin.lower() == "true": pin = True
                        elif pin.lower() == "false": pin = False
                        else:
                            try: pin = float(pin)
                            except ValueError: pin = None
                    is_pinned = False
                    if isinstance(pin, bool):
                        is_pinned = pin
                    elif isinstance(pin, (int, float)):
                        # Matches the threshold get_remote_chats() (main.py)
                        # uses for the same field from the polled list-chats
                        # response — pin is a pin-timestamp in real WhatsApp
                        # data, so any genuine value is always far above this,
                        # but keeping both call sites on the same threshold
                        # avoids the two ever disagreeing on a borderline value.
                        is_pinned = pin > 0
                    # pin absent-or-null here means unpinned (the field was
                    # explicitly cleared), so is_pinned stays False.
                    wx.CallAfter(self.main_window.on_chat_pin_update, jid, is_pinned)
        except Exception:
            logging.exception("[WebSocketClient] on_chats_update error")

    def on_presence_update(self, info):
        """
        Handle presence.update — online/typing/last-seen changes for contacts.

        WPPConnect wraps the Baileys payload as:
          {"data": {"id": "55XXX@s.whatsapp.net",
                    "presences": {"55XXX@s.whatsapp.net": {
                        "lastKnownPresence": "available"|"unavailable"|"composing"|...,
                        "lastSeen": <unix_ts>|null}}}}
        """
        try:
            data      = info.get("data", {})
            jid       = data.get("id", "")
            presences = data.get("presences", {})
            if not jid or not isinstance(presences, dict):
                return
            wx.CallAfter(self.main_window.on_presence_update, jid, presences)
        except Exception:
            logging.exception("[WebSocketClient] on_presence_update error")



    def on_contacts_update(self, info):
        """
        Handle contacts.update to keep contact names and pictures fresh.

        WPPConnect v2 emits this event with "data" being either a single
        contact dict or a list of contact dicts:
          {"remoteJid": ..., "pushName": ..., "profilePicUrl": ..., "instanceId": ...}
        New messages (1:1 and group) arrive via messages.upsert.
        """
        try:
            data = info.get("data", [])
            if isinstance(data, dict):
                data = [data]
            if not isinstance(data, list):
                return
            updated = False
            for contact in data:
                if not isinstance(contact, dict):
                    continue
                # Normalise @c.us → @s.whatsapp.net so the lookup matches the
                # contacts dict, which always stores entries under the modern
                # @s.whatsapp.net format.
                jid = self.main_window._normalize_jid(contact.get("remoteJid", ""))
                if not jid:
                    continue
                existing = self.main_window.contacts.get(jid)
                # Bridge @lid JIDs to their canonical phone JID before giving up.
                if existing is None and jid.endswith("@lid"):
                    phone_jid = getattr(self.main_window, "_lid_to_phone", {}).get(jid, "")
                    if phone_jid:
                        existing = self.main_window.contacts.get(phone_jid)
                        if existing is not None:
                            jid = phone_jid
                if existing is None:
                    # Contact was absent from self.contacts (filtered out by
                    # get_remote_contacts because it had no pushName in the DB
                    # at sync time). If this event carries a name, create the
                    # entry now so future lookups can find it.
                    push = contact.get("pushName", "")
                    if push:
                        entry = {
                            "remoteJid": jid,
                            "pushName": push,
                            "profilePicUrl": contact.get("profilePicUrl") or "",
                            "type": "contact",
                            "isSaved": True,
                        }
                        self.main_window.contacts[jid] = entry
                        updated = True
                        try:
                            self.main_window.db.upsert_contact(jid, entry)
                        except Exception:
                            pass
                    continue
                if contact.get("pushName") and contact["pushName"] != existing.get("pushName"):
                    existing["pushName"] = contact["pushName"]
                    updated = True
                if contact.get("profilePicUrl") and contact["profilePicUrl"] != existing.get("profilePicUrl"):
                    existing["profilePicUrl"] = contact["profilePicUrl"]
                    updated = True
                if updated and hasattr(self.main_window, "db"):
                    try:
                        self.main_window.db.upsert_contact(jid, existing)
                    except Exception:
                        pass
            if updated:
                # Refresh conversation names shown in the UI (debounced —
                # contacts.update can fire in bursts for many contacts at once)
                wx.CallAfter(self.main_window._schedule_set_chats)
        except Exception:
            logging.exception("[WebSocketClient] on_contacts_update error")

    # ── WPPConnect Event Handlers ─────────────────────────────────────────────

    def on_wpp_qrcode(self, data):
        try:
            if not isinstance(data, dict):
                return
            # WPPConnect emits: {"data": "data:image/png;base64,...", "session": "..."}
            qrcode_base64 = data.get("data")
            if qrcode_base64:
                self.on_qrcode_update({
                    "data": {
                        "qrcode": {
                            "base64": qrcode_base64
                        }
                    }
                })
        except Exception:
            logging.exception("[WebSocketClient] on_wpp_qrcode error")

    def on_wpp_session_logged(self, data):
        try:
            if not isinstance(data, dict):
                return
            status = data.get("status", False)
            session = data.get("session", "")

            # Ignore events for other sessions (multi-session server scenario)
            if session and session != self.instance_name:
                return

            # Notify the connection state immediately (non-blocking).
            self.on_connection_update({
                "data": {
                    "state": "open" if status else "close"
                }
            })

            if status:
                # Fetch host-device JID and raise WA file limits on a background
                # thread so we don't block the Socket.IO event loop.
                threading.Thread(target=self._fetch_host_device_jid, daemon=True).start()
                threading.Thread(target=self._set_wpp_limits, daemon=True).start()
                # WPPConnect does not emit messages.set; trigger sync here instead,
                # using the same guards as on_messages_set to prevent double-sync.
                self.on_messages_set({})
        except Exception:
            logging.exception("[WebSocketClient] on_wpp_session_logged error")

    def _fetch_host_device_jid(self):
        try:
            url = f"{self.main_window.wpp_server}:{self.main_window.wpp_port}/api/{self.main_window.token}/host-device"
            headers = {
                "Authorization": f"Bearer {self.main_window.token}",
                "Content-Type": "application/json",
            }
            res = requests.get(url, headers=headers, timeout=5)
            if res.status_code in (200, 201):
                res_data = res.json()
                resp = res_data.get("response", res_data)
                phone_obj = resp.get("phoneNumber", {}) if isinstance(resp, dict) else {}
                wuid = ""
                if isinstance(phone_obj, dict):
                    wuid = phone_obj.get("_serialized", "")
                elif isinstance(phone_obj, str):
                    wuid = phone_obj
                if not wuid and isinstance(resp, dict):
                    wid = resp.get("wid")
                    wuid = wid.get("_serialized", "") if isinstance(wid, dict) else ""
                if wuid:
                    self.main_window.my_jid = wuid
                    wx.CallAfter(self.main_window.resolve_self_lid)
        except Exception:
            logging.exception("[WebSocketClient] Failed to fetch host device JID")

    def _set_wpp_limits(self):
        """Push raised file-size limits into WhatsApp Web via the setLimit API.

        WPPConnect documented maximums:
          maxMediaSize — 70 MB  (images, videos, audio)
          maxFileSize  — 1 GB   (documents)
        """
        mw = self.main_window
        url = f"{mw.wpp_server}:{mw.wpp_port}/api/{mw.token}/set-limit"
        headers = {
            "Authorization": f"Bearer {mw.token}",
            "Content-Type": "application/json",
        }
        limits = [
            ("maxMediaSize", 70 * 1024 * 1024),    # 70 MB
            ("maxFileSize",  1 * 1024 * 1024 * 1024),  # 1 GB
        ]
        for limit_type, value in limits:
            try:
                requests.post(
                    url,
                    json={"type": limit_type, "value": value},
                    headers=headers,
                    timeout=10,
                )
            except Exception:
                pass

    def on_wpp_status_find(self, data):
        try:
            if not isinstance(data, dict):
                return
            status = data.get("status")
            session = data.get("session")
            logging.info(f"[WebSocketClient] Received status-find: {status}, session: {session}")
            
            # If session is provided in the payload, ignore it if it is not ours
            if session and session != self.instance_name:
                return
                
            if status in ("disconnectedMobile", "notLogged", "QRCODE"):
                if getattr(self.main_window, "_pairing_in_progress", False):
                    logging.info("[on_wpp_status_find] Pairing in progress — ignoring status-find trigger.")
                    return
                if not self.main_window.settings.get("privateinfo", {}).get("paired"):
                    if hasattr(self.connect, "_is_pairing_dialog_active") and not self.connect._is_pairing_dialog_active():
                        wx.CallAfter(self.connect.show_connection_dial)
                    elif not hasattr(self.connect, "_is_pairing_dialog_active"):
                        wx.CallAfter(self.connect.show_connection_dial)
                elif self.main_window._wa_connected:
                    wx.CallAfter(self._handle_logout)
        except Exception:
            logging.exception("[WebSocketClient] on_wpp_status_find error")

    def on_wpp_phone_code(self, data):
        """Handle the 'phoneCode' Socket.IO event emitted by WPPConnect Server.

        WPPConnect does NOT return the pairing code in the HTTP response of
        /start-session — it emits it asynchronously via Socket.IO.  We store
        the code and set a threading.Event so that on_continue() in connect.py
        can unblock its wait loop and immediately show the pairing dialog.
        """
        try:
            if not isinstance(data, dict):
                return
            code = data.get("data") or data.get("phoneCode") or ""
            if code:
                # Diagnostic: WPPConnect only emits this event when WhatsApp
                # Web itself fires its internal conn.auth_code_change (see
                # host.layer.js) — there's no client-side timer forcing this.
                # Logged with the previous value + a timestamp so a real
                # pairing session's log file can show definitively whether
                # consecutive events really carry different codes (WhatsApp
                # genuinely rotating it) or the same one repeated (which
                # would point to a bug — none found by reading the code, but
                # worth being able to confirm from a real run instead of
                # just trusting that reading).
                logging.info(
                    "[WebSocketClient] phoneCode event: new=%s previous=%s at %s",
                    code, self._phone_code_value, time.strftime("%H:%M:%S"),
                )
                self._phone_code_value = str(code)
                self._phone_code_event.set()
                if self.connect:
                    wx.CallAfter(self.connect.update_pairing_code, str(code))
        except Exception:
            logging.exception("[WebSocketClient] on_wpp_phone_code error")
