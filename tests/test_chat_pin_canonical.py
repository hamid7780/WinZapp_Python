"""Tests for pin-state tracking under the canonical JID form.

Chat pins live in the _pinned_chats set, keyed by JID. Because a conversation
can be represented by both a @lid key and a phone key, a pin stored under one
form was lost when a merge kept the other form — the sort key (_compute_chat_lists)
compares canonical JIDs, so a pin recorded only under the non-surviving form
never floated the chat. These tests pin the canonical-keyed behavior of
on_chat_pin_update() and _apply_pin_state().
"""

from main import MainWindow


class _Stub:
    _canonical_jid    = MainWindow._canonical_jid
    _normalize_jid    = staticmethod(MainWindow._normalize_jid)
    on_chat_pin_update = MainWindow.on_chat_pin_update
    _apply_pin_state  = MainWindow._apply_pin_state

    def __init__(self):
        self.chats = {}
        self._pinned_chats = set()
        self._lid_to_phone = {}
        self._phone_to_lid = {}
        self._schedule_calls = 0
        self.db = None

    def _schedule_set_chats(self):
        self._schedule_calls += 1


def _mw(lid_to_phone=None, phone_to_lid=None):
    s = _Stub()
    s._lid_to_phone = dict(lid_to_phone or {})
    s._phone_to_lid = dict(phone_to_lid or {})
    return s


class TestOnChatPinUpdateCanonical:
    def test_pin_on_phone_jid_is_stored_under_phone(self):
        s = _mw()
        s.on_chat_pin_update("5511999999999@s.whatsapp.net", True)
        assert "5511999999999@s.whatsapp.net" in s._pinned_chats

    def test_pin_on_lid_jid_is_stored_under_canonical_phone(self):
        s = _mw({"111@lid": "5511999999999@s.whatsapp.net"},
                {"5511999999999@s.whatsapp.net": "111@lid"})
        s.on_chat_pin_update("111@lid", True)
        assert "5511999999999@s.whatsapp.net" in s._pinned_chats
        assert "111@lid" in s._pinned_chats  # mirrored to the alt form too

    def test_pin_on_lid_with_no_mapping_is_stored_under_lid(self):
        s = _mw()
        s.on_chat_pin_update("111@lid", True)
        assert "111@lid" in s._pinned_chats

    def test_unpin_on_lid_removes_both_forms(self):
        s = _mw({"111@lid": "5511999999999@s.whatsapp.net"},
                {"5511999999999@s.whatsapp.net": "111@lid"})
        s._pinned_chats = {"5511999999999@s.whatsapp.net", "111@lid"}
        s.on_chat_pin_update("111@lid", False)
        assert s._pinned_chats == set()

    def test_unpin_via_phone_removes_lid_too(self):
        s = _mw({"111@lid": "5511999999999@s.whatsapp.net"},
                {"5511999999999@s.whatsapp.net": "111@lid"})
        s._pinned_chats = {"5511999999999@s.whatsapp.net", "111@lid"}
        s.on_chat_pin_update("5511999999999@s.whatsapp.net", False)
        assert s._pinned_chats == set()


class TestApplyPinStateCanonical:
    def test_pin_under_lid_mirrors_to_phone(self):
        s = _mw({"111@lid": "5511999999999@s.whatsapp.net"},
                {"5511999999999@s.whatsapp.net": "111@lid"})
        s._apply_pin_state("111@lid", True)
        assert "5511999999999@s.whatsapp.net" in s._pinned_chats
        assert "111@lid" in s._pinned_chats

    def test_pin_under_phone_mirrors_to_lid(self):
        s = _mw({"111@lid": "5511999999999@s.whatsapp.net"},
                {"5511999999999@s.whatsapp.net": "111@lid"})
        s._apply_pin_state("5511999999999@s.whatsapp.net", True)
        assert "5511999999999@s.whatsapp.net" in s._pinned_chats
        assert "111@lid" in s._pinned_chats

    def test_unpin_under_phone_removes_lid_mirror(self):
        s = _mw({"111@lid": "5511999999999@s.whatsapp.net"},
                {"5511999999999@s.whatsapp.net": "111@lid"})
        s._pinned_chats = {"5511999999999@s.whatsapp.net", "111@lid"}
        s._apply_pin_state("5511999999999@s.whatsapp.net", False)
        assert s._pinned_chats == set()
