"""
ffmpeg_download.py — WinZapp automatic portable FFmpeg download dialog.

Shown when client/lib/ffmpeg.exe is absent.  Downloads the Windows x64
portable FFmpeg distribution and extracts it into client/lib/ so voice
messaging works correctly.
"""

import io
import logging
import os
import shutil
import sys
import tempfile
import threading
import zipfile

import requests
import wx

from app_paths import resource_path

log = logging.getLogger(__name__)

_FFMPEG_URL = "https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v4.4.1/ffmpeg-4.4.1-win-64.zip"

class FfmpegDownloadDialog(wx.Dialog):
    """Progress dialog for downloading + extracting portable FFmpeg.

    Modal result:
      wx.ID_OK     — FFmpeg is ready; caller may continue
      wx.ID_CANCEL — user cancelled or an error occurred; caller should exit
    """

    _PULSE_MS = 80

    def __init__(self, parent):
        title = "Downloading FFmpeg..."
        style = wx.DEFAULT_DIALOG_STYLE & ~wx.CLOSE_BOX
        super().__init__(parent, title=title, style=style)

        self._cancelled = False
        self._build_ui()

        self._timer = wx.Timer(self)
        self.Bind(wx.EVT_TIMER, self._on_pulse, self._timer)
        self.Bind(wx.EVT_CLOSE, self._on_cancel)

        t = threading.Thread(target=self._run_download, daemon=True)
        t.start()

        self._timer.Start(self._PULSE_MS)

    def _build_ui(self):
        self._status_lbl = wx.StaticText(
            self,
            label="Connecting to download server...",
        )

        self._gauge = wx.Gauge(self, range=100, style=wx.GA_HORIZONTAL | wx.GA_SMOOTH)

        cancel_btn = wx.Button(self, wx.ID_CANCEL, label="Cancel")
        cancel_btn.Bind(wx.EVT_BUTTON, self._on_cancel)

        sizer = wx.BoxSizer(wx.VERTICAL)
        sizer.Add(self._status_lbl, 0, wx.ALL | wx.EXPAND, 12)
        sizer.Add(self._gauge, 0, wx.ALL | wx.EXPAND, 12)
        sizer.Add(cancel_btn, 0, wx.ALIGN_CENTER | wx.BOTTOM, 12)

        self.SetSizer(sizer)
        sizer.Fit(self)
        self.SetMinSize((520, -1))
        self.Centre()

    def _set_status(self, text: str):
        wx.CallAfter(self._status_lbl.SetLabel, text)
        wx.CallAfter(self.Layout)

    def _on_pulse(self, _event):
        self._gauge.Pulse()

    def _on_cancel(self, _event=None):
        if self._cancelled:
            return
        self._cancelled = True
        self._timer.Stop()
        self.EndModal(wx.ID_CANCEL)

    def _finish_success(self):
        self._timer.Stop()
        self.EndModal(wx.ID_OK)

    def _finish_error(self, details: str = ""):
        self._timer.Stop()
        msg = "An error occurred while downloading FFmpeg."
        if details:
            msg = f"{msg}\n\n{details}"
        wx.MessageBox(msg, "Download Error", wx.OK | wx.ICON_ERROR, self)
        self.EndModal(wx.ID_CANCEL)

    def _download_zip(self, url: str, dest_path: str) -> bool:
        try:
            response = requests.get(url, stream=True, timeout=(30, 300))
            response.raise_for_status()
        except requests.RequestException as exc:
            if not self._cancelled:
                self._finish_error(str(exc))
            return False

        total = int(response.headers.get("content-length", 0))
        downloaded = 0
        chunk_size = 512 * 1024

        try:
            with open(dest_path, "wb") as fh:
                for chunk in response.iter_content(chunk_size=chunk_size):
                    if self._cancelled:
                        return False
                    if not chunk:
                        continue
                    fh.write(chunk)
                    downloaded += len(chunk)
                    mb_down = downloaded / (1024 * 1024)
                    if total:
                        mb_total = total / (1024 * 1024)
                        self._set_status(f"Downloading... {mb_down:.1f} MB / {mb_total:.1f} MB")
                    else:
                        self._set_status(f"Downloading... {mb_down:.1f} MB")
        except Exception as exc:
            if not self._cancelled:
                self._finish_error(str(exc))
            return False

        return not self._cancelled

    def _extract_ffmpeg(self, zip_path: str, lib_dir: str) -> bool:
        self._set_status("Extracting FFmpeg...")
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                for member in zf.infolist():
                    if self._cancelled:
                        return False
                    if member.filename.endswith("ffmpeg.exe"):
                        with zf.open(member) as src_fh, open(os.path.join(lib_dir, "ffmpeg.exe"), "wb") as dst_fh:
                            shutil.copyfileobj(src_fh, dst_fh)
        except Exception as exc:
            if not self._cancelled:
                self._finish_error(f"Extraction failed: {exc}")
            return False

        return not self._cancelled

    def _run_download(self):
        lib_dir = resource_path("lib")
        os.makedirs(lib_dir, exist_ok=True)

        tmp_zip = tempfile.mktemp(suffix=".zip", prefix="winzapp_ffmpeg_")
        try:
            ok = self._download_zip(_FFMPEG_URL, tmp_zip)
            if not ok or self._cancelled:
                return

            ok = self._extract_ffmpeg(tmp_zip, lib_dir)
            if not ok or self._cancelled:
                return

            lib_exe = os.path.join(lib_dir, "ffmpeg.exe")
            if not os.path.isfile(lib_exe):
                if not self._cancelled:
                    self._finish_error("Failed to find ffmpeg.exe after extraction.")
                return

            if not self._cancelled:
                wx.CallAfter(self._finish_success)

        finally:
            try:
                os.remove(tmp_zip)
            except Exception:
                pass

