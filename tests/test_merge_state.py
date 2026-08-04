"""Tests for MainWindow._merge_lid_into_phone() state migration.

_merge_lid_into_phone() used to copy only message records. Every other piece
of per-chat state the source (@lid) entry carried — sort timestamp `t`,
lastMessage preview, unread count, display name, and pin/mute/archive/deleted
membership — was stranded under the removed key, so the surviving chat had a
stale position, stale unread, lost pin, and the "same contact" flipped forms
on every new message. These tests pin the full-state migration.
"""

import pytest

from main import MainWindow


class _Stub:
    _merge_lid_into_phone = MainWindow._merge_lid_into_phone
    _canonical_jid        = MainWindow._canonical_jid
    _normalize_jid        = staticmethod(MainWindow._normalize_jid)

    def __init__(self):
        self.chats = {}
        self._pinned_chats   = set()
        self._archived_chats = set()
        self._deleted_chats  = set()
        self._muted_chats    = {}
        self._group_name_cache = {}
        self.db = None


def _chat(**overrides):
    c = {
        "remoteJid": "",
        "unreadCount": 0,
        "messages": {"messages": {"records": []}},
    }
    c.update(overrides)
    return c


def _rec(msg_id, ts, **extra):
    m = {"key": {"id": msg_id}, "messageTimestamp": ts}
    m.update(extra)
    return m


class TestMergeStateMigration:
    def test_both_exist_merges_records_dedup_by_id(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid", messages={"messages": {
            "records": [_rec("a", 100), _rec("b", 200)]}})
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net",
                                                        messages={"messages": {"records": [_rec("b", 200)]}})
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert "111@lid" not in s.chats
        dst = s.chats["5511999999999@s.whatsapp.net"]
        ids = {r["key"]["id"] for r in dst["messages"]["messages"]["records"]}
        assert ids == {"a", "b"}

    def test_newer_t_is_kept(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid", t=500)
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net", t=100)
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert s.chats["5511999999999@s.whatsapp.net"]["t"] == 500

    def test_ms_t_is_normalized_before_comparison(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid", t=500)
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net",
                                                        t=1_700_000_000_000)  # ms → 1700000000 s
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        # dst already newer (1700000000 > 500) — stays.
        assert s.chats["5511999999999@s.whatsapp.net"]["t"] == 1_700_000_000_000

    def test_newer_last_message_is_kept(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid", lastMessage=_rec("x", 900))
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net",
                                                        lastMessage=_rec("y", 100))
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert s.chats["5511999999999@s.whatsapp.net"]["lastMessage"]["key"]["id"] == "x"

    def test_unread_counts_add(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid", unreadCount=3)
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net",
                                                        unreadCount=2)
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert s.chats["5511999999999@s.whatsapp.net"]["unreadCount"] == 5

    def test_display_name_fills_when_destination_lacks_one(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid", name="Maria")
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net")
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert s.chats["5511999999999@s.whatsapp.net"]["name"] == "Maria"

    def test_display_name_not_overwritten_when_destination_has_one(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid", name="Maria")
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net",
                                                        name="Saved Name")
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert s.chats["5511999999999@s.whatsapp.net"]["name"] == "Saved Name"

    def test_pin_is_migrated_to_phone_jid(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid")
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net")
        s._pinned_chats = {"111@lid"}
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert "111@lid" not in s._pinned_chats
        assert "5511999999999@s.whatsapp.net" in s._pinned_chats

    def test_mute_is_rekeyed_to_phone_jid(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid")
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net")
        s._muted_chats = {"111@lid": 1785147636}
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert "111@lid" not in s._muted_chats
        assert s._muted_chats["5511999999999@s.whatsapp.net"] == 1785147636

    def test_archive_and_deleted_are_rekeyed(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid")
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net")
        s._archived_chats = {"111@lid"}
        s._deleted_chats = {"111@lid"}
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert "111@lid" not in s._archived_chats
        assert "5511999999999@s.whatsapp.net" in s._archived_chats
        assert "5511999999999@s.whatsapp.net" in s._deleted_chats

    def test_only_lid_exists_renames_and_keeps_its_state(self):
        s = _Stub()
        s.chats["111@lid"] = _chat(remoteJid="111@lid", t=700, unreadCount=2, name="Maria")
        s._merge_lid_into_phone("111@lid", "5511999999999@s.whatsapp.net")
        assert "111@lid" not in s.chats
        dst = s.chats["5511999999999@s.whatsapp.net"]
        assert dst["t"] == 700
        assert dst["unreadCount"] == 2
        assert dst["name"] == "Maria"
        assert dst["remoteJid"] == "5511999999999@s.whatsapp.net"

    def test_no_op_when_lid_chat_absent(self):
        s = _Stub()
        s.chats["5511999999999@s.whatsapp.net"] = _chat(remoteJid="5511999999999@s.whatsapp.net")
        s._merge_lid_into_phone("999@lid", "5511999999999@s.whatsapp.net")
        assert set(s.chats) == {"5511999999999@s.whatsapp.net"}
