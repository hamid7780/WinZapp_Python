"""Tests for the Phase E name fixes.

1. ConversationsPanel._sender_label() must return a number/label — not a blank
   string — for a group participant whose @lid has no phone mapping and whose
   message carries no pushName. Before this fix such messages rendered as
   `": body"` (blank sender).
2. MainWindow._group_name_from_chat_dict() resolves a group name from the raw
   WPPConnect chat shape (groupMetadata.subject), which the chat list relies on.

ConversationsPanel is a wx.Panel; MainWindow is a wx.Frame. Neither can be
instantiated in tests, so the methods are exercised against small stubs that
carry only the attributes they touch — same approach as tests/test_sender_names.py.
"""

import pytest

from main import MainWindow
from ui.conversations import ConversationsPanel


class _FakeI18n:
    def t(self, key):
        return {
            "unknown_group": "Grupo sem nome",
            "unknown_contact": "Contato desconhecido",
            "phone_label": "Telefone",
        }.get(key, key)


class _FakeMainWindow:
    _is_bad_contact_name = staticmethod(MainWindow._is_bad_contact_name)

    def __init__(self, contacts=None, chats=None, lid_to_phone=None,
                 phone_to_lid=None):
        self.contacts = contacts or {}
        self.chats = chats or {}
        self._lid_to_phone = lid_to_phone or {}
        self._phone_to_lid = phone_to_lid or {}
        self._presence_pushname_map = {}
        self.i18n = _FakeI18n()

    def _is_self_jid(self, jid):
        return False

    def self_reference_label(self):
        return "Eu"

    @staticmethod
    def _normalize_jid(jid):
        return jid


class _PanelStub:
    _sender_label = ConversationsPanel._sender_label
    _get_participant_name = ConversationsPanel._get_participant_name

    def __init__(self, main_window, sorted_messages=None,
                 group_participants_cache=None):
        self.main_window = main_window
        self._sorted_messages = sorted_messages or []
        self._group_participants_cache = group_participants_cache or []


def _group_msg(participant, push_name="", remote_jid="1234567890@g.us"):
    return {
        "key": {"remoteJid": remote_jid, "participant": participant, "fromMe": False},
        "pushName": push_name,
        "message": {"conversation": "oi"},
        "messageType": "conversation",
        "messageTimestamp": 1700000000,
    }


class TestSenderLabelLidFallback:
    def test_unmapped_lid_participant_with_no_pushname_gets_a_number_fallback(self):
        """The reported bug: an @lid with no phone mapping and no pushName on
        the message returned '' → the message line rendered ': body'. It must
        fall through to _get_participant_name, which at minimum yields the
        @lid local part (never blank)."""
        mw = _FakeMainWindow(lid_to_phone={}, phone_to_lid={})
        panel = _PanelStub(mw)
        msg = _group_msg("111222333@lid", push_name="")
        label = panel._sender_label(msg)
        assert label != "", "_sender_label must not return blank for a group participant"
        assert "111222333" in label

    def test_lid_with_phone_mapping_gets_formatted_number(self):
        mw = _FakeMainWindow(
            lid_to_phone={"111222333@lid": "5511999999999@s.whatsapp.net"},
            phone_to_lid={"5511999999999@s.whatsapp.net": "111222333@lid"},
        )
        panel = _PanelStub(mw)
        msg = _group_msg("111222333@lid", push_name="")
        label = panel._sender_label(msg)
        # +55 11 99999-9999 — any non-blank, non-lid string is fine.
        assert label and "111222333" not in label.split("@")[0]

    def test_lid_participant_with_pushname_uses_pushname(self):
        mw = _FakeMainWindow(lid_to_phone={}, phone_to_lid={})
        panel = _PanelStub(mw)
        msg = _group_msg("111222333@lid", push_name="Carlos")
        assert panel._sender_label(msg) == "Carlos"

    def test_normal_phone_participant_still_formats_as_number(self):
        mw = _FakeMainWindow()
        panel = _PanelStub(mw)
        msg = _group_msg("5511999999999@s.whatsapp.net", push_name="")
        label = panel._sender_label(msg)
        assert label and "5511999999999" in label.replace(" ", "").replace("-", "").replace("+", "")


class TestGroupNameFromChatDict:
    def test_name_from_flat_name_key(self):
        assert MainWindow._group_name_from_chat_dict({"name": "Família"}) == "Família"

    def test_subject_under_group_metadata(self):
        chat = {"groupMetadata": {"subject": "Trabalho"}}
        assert MainWindow._group_name_from_chat_dict(chat) == "Trabalho"

    def test_bad_placeholders_rejected(self):
        assert MainWindow._group_name_from_chat_dict({"name": "Unknown User"}) == ""
        assert MainWindow._group_name_from_chat_dict({"name": "Contato sem nome"}) == ""
        assert MainWindow._group_name_from_chat_dict({"name": "1234567890"}) == ""

    def test_returns_empty_when_no_name_anywhere(self):
        assert MainWindow._group_name_from_chat_dict({}) == ""
        assert MainWindow._group_name_from_chat_dict({"groupMetadata": {}}) == ""
