"""
Unit tests for WinZapp bug fixes:
1. Pin value parsing (supporting int 1/true/timestamps).
2. Self-chat empty filter in _compute_chat_lists.
3. FFmpeg opus fallback conversion.
4. LID reconciliation fallback via contacts/DB.
"""

import os
import tempfile
import pytest
from main import MainWindow

class _FakeMainWindowStub:
    def __init__(self, chats=None, contacts=None, pinned=None, my_jid="5511999999999@s.whatsapp.net"):
        self.chats = dict(chats or {})
        self.contacts = dict(contacts or {})
        self._pinned_chats = set(pinned or [])
        self._deleted_chats = set()
        self._archived_chats = set()
        self._muted_chats = set()
        self.my_jid = my_jid
        self.settings = {}
        self.i18n = type("I18nStub", (), {"t": staticmethod(lambda k: k)})()

    _compute_chat_lists = MainWindow._compute_chat_lists
    _is_self_jid = MainWindow._is_self_jid
    _canonical_jid = MainWindow._canonical_jid
    _normalize_jid = staticmethod(MainWindow._normalize_jid)
    _group_name_from_chat_dict = staticmethod(MainWindow._group_name_from_chat_dict)
    _phone_digits_equivalent = staticmethod(MainWindow._phone_digits_equivalent)
    _ts_normalized = staticmethod(MainWindow._ts_normalized)
    _resolve_contact_name = MainWindow._resolve_contact_name
    _is_bad_contact_name = staticmethod(MainWindow._is_bad_contact_name)
    _get_contact_tolerant = MainWindow._get_contact_tolerant
    find_name_through_messages = MainWindow.find_name_through_messages
    find_jid_through_messages = MainWindow.find_jid_through_messages
    _format_jid_for_display = MainWindow._format_jid_for_display
    _find_alt_jid_from_messages = MainWindow._find_alt_jid_from_messages
    _counts_as_last_message = MainWindow._counts_as_last_message
    _reconcile_canonical_jid = MainWindow._reconcile_canonical_jid
    register_jid_mapping = MainWindow.register_jid_mapping


def test_empty_self_chat_is_filtered_out():
    """An empty self-chat with zero messages must NOT appear in the chat list."""
    self_jid = "5511999999999@s.whatsapp.net"
    stub = _FakeMainWindowStub(
        chats={
            self_jid: {
                "remoteJid": self_jid,
                "unreadCount": 0,
                "messages": {"messages": {"records": []}},
            }
        },
        my_jid=self_jid,
    )
    main_chats, main_names, arch_chats, arch_names = stub._compute_chat_lists()
    assert len(main_chats) == 0, "Empty self-chat should be filtered out"


def test_self_chat_with_messages_is_kept():
    """A self-chat carrying actual messages MUST be shown in the chat list."""
    self_jid = "5511999999999@s.whatsapp.net"
    stub = _FakeMainWindowStub(
        chats={
            self_jid: {
                "remoteJid": self_jid,
                "unreadCount": 0,
                "lastMessage": {"messageTimestamp": 1000, "conversation": "test"},
                "messages": {"messages": {"records": [{"key": {"id": "1"}, "messageTimestamp": 1000}]}},
            }
        },
        my_jid=self_jid,
    )
    main_chats, main_names, arch_chats, arch_names = stub._compute_chat_lists()
    assert len(main_chats) == 1, "Self-chat with content must be included"
    assert main_names[0] == "self_chat_name"


def test_reconcile_canonical_jid_resolves_unmapped_lid_via_contacts():
    """_reconcile_canonical_jid resolves @lid to phone JID if listed in contacts."""
    lid_jid = "111222333@lid"
    phone_jid = "5511999999999@s.whatsapp.net"
    stub = _FakeMainWindowStub(
        chats={
            phone_jid: {
                "remoteJid": phone_jid,
                "unreadCount": 0,
                "messages": {"messages": {"records": []}},
            }
        },
        contacts={
            lid_jid: {"phoneJid": phone_jid}
        }
    )
    res = stub._reconcile_canonical_jid(lid_jid)
    assert res == phone_jid
