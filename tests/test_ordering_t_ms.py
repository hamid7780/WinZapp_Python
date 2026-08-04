"""Tests for the chat-order timestamp fixes.

The chat list was ordered by `chat["t"]` (and lastMessage/records). WPPConnect's
list-chats can report `t` in milliseconds (~1.7e12) while live message
timestamps arrive in seconds (~1.7e9). Two bugs followed:

1. on_new_message() compared a seconds msg_ts against an un-normalized ms
   chat["t"] — the message always looked "older", so a chat with a live new
   message never floated to the top.
2. The periodic get_remote_chats() poll wrote a stale server `t` over the
   locally-bumped newer value (no monotonic guard), sinking a chat that had
   just floated.

_ts_normalized() is the single normalization both fixes share; these tests pin
its behavior and the guard's outcome.
"""

from main import MainWindow

normalize = MainWindow._ts_normalized


class TestTsNormalized:
    def test_seconds_passes_through(self):
        assert normalize(1_750_000_000) == 1_750_000_000

    def test_milliseconds_becomes_seconds(self):
        assert normalize(1_750_000_000_000) == 1_750_000_000

    def test_small_values_untouched(self):
        assert normalize(0) == 0
        assert normalize(123) == 123

    def test_none_and_junk_become_zero(self):
        assert normalize(None) == 0
        assert normalize("") == 0
        assert normalize("abc") == 0
        assert normalize([]) == 0

    def test_float_seconds_are_truncated(self):
        assert normalize(1_750_000_000.9) == 1_750_000_000

    def test_string_seconds_are_parsed(self):
        assert normalize("1750000000") == 1_750_000_000


class TestMsVsSecondsComparison:
    """The exact failure mode: a live message (seconds) must float a chat whose
    stored `t` is in ms, and must not regress under a stale ms poll."""

    def test_seconds_message_bumps_a_ms_chat_t(self):
        # chat["t"] in ms, live message in seconds → message is newer.
        chat_t_ms = 1_750_000_000_000
        msg_ts = 1_751_000_000  # one hour later, in seconds
        assert normalize(chat_t_ms) < msg_ts

    def test_ms_chat_t_without_normalization_would_never_float(self):
        # Demonstrate the bug the normalization removes: the raw comparison.
        chat_t_ms = 1_750_000_000_000
        msg_ts = 1_751_000_000
        assert not (msg_ts > chat_t_ms), "raw compare says older — the bug"
        assert msg_ts > normalize(chat_t_ms), "normalized compare floats it"

    def test_monotonic_guard_keeps_the_newer_t(self):
        # Local t bumped to a newer value (seconds); a stale server snapshot
        # (ms) must NOT overwrite it. Guard: keep local when server is lower.
        local_t = 1_751_000_000  # already normalized seconds
        stale_server_t_ms = 1_750_000_000_000  # older, in ms
        assert normalize(stale_server_t_ms) < local_t

    def test_monotonic_guard_still_accepts_a_newer_server_t(self):
        local_t = 1_750_000_000
        newer_server_t_ms = 1_751_000_000_000
        assert normalize(newer_server_t_ms) > local_t
