"""Tests for MainWindow._reconcile_canonical_jid().

Both message funnels (on_new_message, on_historical_message) call this to route
an incoming message to the canonical chat when the same conversation already
exists under the other JID form. Without it, a history echo arriving under
@lid while the contact is stored under the phone form (or vice versa) created
a second chat entry — the "one contact, multiple chats" symptom. The helper is
tested directly because MainWindow is a wx.Frame and can't be instantiated in
tests; the stub carries only the attributes the helper touches.
"""

from main import MainWindow


class _Stub:
    _reconcile_canonical_jid = MainWindow._reconcile_canonical_jid
    _canonical_jid           = MainWindow._canonical_jid
    _normalize_jid           = staticmethod(MainWindow._normalize_jid)
    _merge_lid_into_phone    = MainWindow._merge_lid_into_phone

    def __init__(self):
        self.chats = {}
        self._lid_to_phone = {}
        self._phone_to_lid = {}
        self._pinned_chats = set()
        self._archived_chats = set()
        self._deleted_chats = set()
        self._muted_chats = {}
        self._group_name_cache = {}
        self.db = None


def _chat(remote_jid):
    return {"remoteJid": remote_jid, "unreadCount": 0,
            "messages": {"messages": {"records": []}}}


class TestReconcileCanonicalJid:
    def test_phone_message_merges_into_existing_lid_chat(self):
        """NEW-format message (remoteJid=phone) arrives while a @lid chat for
        the same contact already exists — must route into the phone entry and
        collapse the @lid copy, not create a second chat."""
        s = _Stub()
        s.chats["111@lid"] = _chat("111@lid")
        s.chats["5511999999999@s.whatsapp.net"] = _chat("5511999999999@s.whatsapp.net")
        s._lid_to_phone = {"111@lid": "5511999999999@s.whatsapp.net"}
        s._phone_to_lid = {"5511999999999@s.whatsapp.net": "111@lid"}
        out = s._reconcile_canonical_jid("5511999999999@s.whatsapp.net")
        assert out == "5511999999999@s.whatsapp.net"
        assert "111@lid" not in s.chats, "the @lid duplicate must be merged away"
        assert "5511999999999@s.whatsapp.net" in s.chats

    def test_lid_message_merges_into_existing_phone_chat(self):
        """OLD-format message (remoteJid=@lid) arrives while the phone chat
        already exists — must route into the phone entry, not a new @lid one."""
        s = _Stub()
        s.chats["5511999999999@s.whatsapp.net"] = _chat("5511999999999@s.whatsapp.net")
        s._lid_to_phone = {"111@lid": "5511999999999@s.whatsapp.net"}
        s._phone_to_lid = {"5511999999999@s.whatsapp.net": "111@lid"}
        out = s._reconcile_canonical_jid("111@lid")
        assert out == "5511999999999@s.whatsapp.net"
        assert "111@lid" not in s.chats

    def test_lid_message_with_only_lid_chat_renames_to_phone(self):
        """@lid message arrives, only a @lid chat exists, and the mapping is
        known — the chat is renamed to the phone form (canonical), not kept
        under @lid."""
        s = _Stub()
        s.chats["111@lid"] = _chat("111@lid")
        s._lid_to_phone = {"111@lid": "5511999999999@s.whatsapp.net"}
        s._phone_to_lid = {"5511999999999@s.whatsapp.net": "111@lid"}
        out = s._reconcile_canonical_jid("111@lid")
        assert out == "5511999999999@s.whatsapp.net"
        assert "111@lid" not in s.chats
        assert "5511999999999@s.whatsapp.net" in s.chats

    def test_unmapped_lid_message_keeps_lid(self):
        """@lid message whose mapping is NOT yet known — nothing to merge into;
        the caller creates the @lid entry (the background resolver bridges it
        later)."""
        s = _Stub()
        out = s._reconcile_canonical_jid("999@lid")
        assert out == "999@lid"
        assert s.chats == {}

    def test_phone_message_with_no_lid_known_passes_through(self):
        s = _Stub()
        out = s._reconcile_canonical_jid("5511999999999@s.whatsapp.net")
        assert out == "5511999999999@s.whatsapp.net"
        assert s.chats == {}

    def test_group_and_broadcast_pass_through(self):
        s = _Stub()
        assert s._reconcile_canonical_jid("1203631234567890@g.us") == "1203631234567890@g.us"
        assert s._reconcile_canonical_jid("status@broadcast") == "status@broadcast"

    def test_empty_returns_empty(self):
        s = _Stub()
        assert s._reconcile_canonical_jid("") == ""
        assert s._reconcile_canonical_jid(None) is None
