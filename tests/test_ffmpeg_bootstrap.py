"""Tests for the ffmpeg bootstrap that makes voice messages work.

Voice send needs ffmpeg to encode WAV→OGG, and playback needs it to decode
OGG→WAV. It is not bundled in the repo or a declared dependency, so a fresh
dev machine had neither — sends silently fell back to raw WAV labelled
"audio/ogg" (recipient couldn't play) or failed outright. _ensure_ffmpeg()
downloads the same portable binary build.py bundles, into the same lib/
location _find_api_ffmpeg() checks first.

MainWindow is a wx.Frame and can't be instantiated headlessly, so the bootstrap
is exercised against a small stub carrying only the state it touches.
"""

from main import MainWindow


class _Stub:
    _ensure_ffmpeg   = MainWindow._ensure_ffmpeg
    _download_ffmpeg = MainWindow._download_ffmpeg

    def __init__(self, find_result=None, download_result=""):
        self._ffmpeg_bootstrap_fired = False
        self.find_result = find_result
        self.download_result = download_result
        self.download_calls = 0

    def _find_api_ffmpeg(self):
        return self.find_result

    def _download_ffmpeg(self, target_dir):
        self.download_calls += 1
        if isinstance(self.download_result, Exception):
            raise self.download_result
        return self.download_result


class TestEnsureFfmpeg:
    def test_noop_when_ffmpeg_already_found(self):
        s = _Stub(find_result="C:/ffmpeg/ffmpeg.exe")
        assert s._ensure_ffmpeg() == "C:/ffmpeg/ffmpeg.exe"
        assert s._ffmpeg_bootstrap_fired is False, "no download needed"

    def test_downloads_when_missing_and_returns_the_binary(self):
        s = _Stub(find_result=None, download_result="C:/lib/ffmpeg.exe")
        assert s._ensure_ffmpeg() == "C:/lib/ffmpeg.exe"
        assert s.download_calls == 1
        assert s._ffmpeg_bootstrap_fired is True

    def test_fires_only_once_per_process(self):
        """The guard: after one bootstrap attempt the flag latches so a second
        call (e.g. the next voice message) doesn't re-download."""
        s = _Stub(find_result=None, download_result="")
        assert s._ensure_ffmpeg() == ""
        assert s.download_calls == 1
        assert s._ensure_ffmpeg() is None  # second call — guard latched
        assert s.download_calls == 1

    def test_first_miss_sets_the_guard_even_when_download_fails(self):
        """A failed download must still latch the flag — otherwise every send
        retries the network call."""
        s = _Stub(find_result=None, download_result=RuntimeError("offline"))
        assert s._ensure_ffmpeg() is None
        assert s._ffmpeg_bootstrap_fired is True
        assert s._ensure_ffmpeg() is None
        assert s.download_calls == 1


class TestSendRefusesNonOgg:
    """The raw-WAV fallback was removed: only real OGG (OggS magic) may be sent
    as a PTT voice message, so a recipient is never handed an unplayable file."""

    def test_wav_magic_is_not_ogg(self):
        assert not b"RIFF\x24\x00".startswith(b"OggS")

    def test_ogg_magic_is_accepted(self):
        assert b"OggS\x00\x02\x00\x00".startswith(b"OggS")

    def test_ffmpeg_opus_output_is_ogg(self):
        """ffmpeg -c:a libopus emits OggS — the guarantee the send path relies on."""
        assert b"OggS\x00\x02\x00\x00".startswith(b"OggS")
