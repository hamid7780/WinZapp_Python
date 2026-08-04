"""Tests for MainWindow._canonical_jid().

Every chat-list key, sort compare and pin lookup must agree on ONE JID form
per conversation, or a contact can be keyed/comparared under two different
strings (@lid vs @s.whatsapp.net). _canonical_jid() collapses @lid → its
resolved phone form (falling back to the @lid itself) and @c.us →
@s.whatsapp.net, so all of them agree.
"""

import pytest

from main import MainWindow


class _Stub:
    """Carries only the attributes _canonical_jid touches: the static
    _normalize_jid (also bound from MainWindow) and _lid_to_phone."""

    _canonical_jid   = MainWindow._canonical_jid
    _normalize_jid   = staticmethod(MainWindow._normalize_jid)

    def __init__(self, lid_to_phone=None):
        self._lid_to_phone = dict(lid_to_phone or {})


def _mw(lid_to_phone=None):
    return _Stub(lid_to_phone)


class TestCanonicalJid:
    def test_lid_resolves_to_phone_when_mapping_known(self):
        mw = _mw({"12345@lid": "5511999999999@s.whatsapp.net"})
        assert mw._canonical_jid("12345@lid") == "5511999999999@s.whatsapp.net"

    def test_lid_with_no_mapping_keeps_lid(self):
        mw = _mw({})
        assert mw._canonical_jid("12345@lid") == "12345@lid"

    def test_legacy_cus_becomes_modern(self):
        mw = _mw({})
        assert mw._canonical_jid("5511999999999@c.us") == "5511999999999@s.whatsapp.net"

    def test_modern_phone_passes_through(self):
        mw = _mw({})
        assert mw._canonical_jid("5511999999999@s.whatsapp.net") == "5511999999999@s.whatsapp.net"

    def test_device_suffix_is_stripped(self):
        mw = _mw({})
        assert mw._canonical_jid("5511999999999:60@c.us") == "5511999999999@s.whatsapp.net"

    def test_group_is_unchanged(self):
        mw = _mw({})
        assert mw._canonical_jid("1203631234567890@g.us") == "1203631234567890@g.us"

    def test_broadcast_is_unchanged(self):
        mw = _mw({})
        assert mw._canonical_jid("status@broadcast") == "status@broadcast"

    def test_empty_is_empty(self):
        mw = _mw({})
        assert mw._canonical_jid("") == ""
        assert mw._canonical_jid(None) == ""

    def test_lid_to_phone_mapping_still_normalizes_cus(self):
        """The mapping may resolve to a @c.us form — must still canonicalize."""
        mw = _mw({"12345@lid": "5511999999999@c.us"})
        assert mw._canonical_jid("12345@lid") == "5511999999999@s.whatsapp.net"

    def test_lid_resolving_to_lid_roundtrip_is_safe(self):
        mw = _mw({"12345@lid": "67890@lid"})
        assert mw._canonical_jid("12345@lid") == "67890@lid"
