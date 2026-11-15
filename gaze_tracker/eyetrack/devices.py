"""Camera capture thread and monitor enumeration."""
from __future__ import annotations

import sys
import threading
import time
from typing import Dict, List, Optional, Tuple

import cv2

from . import config as cfg


class Camera:
    """Reads the webcam on a background thread and keeps the newest frame.
    Frames are handed out untouched (no mirroring, no colour changes)."""

    def __init__(self, index: int = cfg.CAMERA_INDEX):
        self.index = index
        self._cap = None
        self._lock = threading.Lock()
        self._frame = None
        self._seq = 0
        self._time = 0.0
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self.error: Optional[str] = None
        self._info: Dict = {"index": index, "opened": False}

    def start(self) -> bool:
        backend = cv2.CAP_DSHOW if sys.platform.startswith("win") else cv2.CAP_ANY
        cap = cv2.VideoCapture(self.index, backend)
        if not cap.isOpened():
            cap.release()
            cap = cv2.VideoCapture(self.index)
        if not cap.isOpened():
            self.error = f"Camera {self.index} could not be opened."
            return False
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, cfg.CAMERA_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cfg.CAMERA_HEIGHT)
        cap.set(cv2.CAP_PROP_FPS, cfg.CAMERA_FPS)
        self._cap = cap
        try:
            backend_name = cap.getBackendName()
        except Exception:
            backend_name = "unknown"
        self._info = {
            "index": self.index, "opened": True, "backend": backend_name,
            "requested": {"width": cfg.CAMERA_WIDTH, "height": cfg.CAMERA_HEIGHT,
                          "fps": cfg.CAMERA_FPS},
            "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            "fps": float(cap.get(cv2.CAP_PROP_FPS)),
            "mirrored": False, "color_order_in_files": "RGB",
        }
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return True

    def _loop(self) -> None:
        while self._running:
            ok, frame = self._cap.read()
            if not ok or frame is None:
                time.sleep(0.02)
                continue
            now = time.time()
            with self._lock:
                self._frame, self._time = frame, now
                self._seq += 1

    def latest(self) -> Tuple[int, Optional[object], float]:
        """(sequence number, frame, grab time). The frame must not be modified."""
        with self._lock:
            return self._seq, self._frame, self._time

    def info(self) -> Dict:
        info = dict(self._info)
        _, frame, _ = self.latest()
        if frame is not None:                       # what the camera really delivers
            info["width"], info["height"] = int(frame.shape[1]), int(frame.shape[0])
        return info

    @property
    def ok(self) -> bool:
        return bool(self._info.get("opened"))

    def seconds_since_frame(self) -> float:
        _, frame, t = self.latest()
        return float("inf") if frame is None else time.time() - t

    def stop(self) -> None:
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=1.5)
        if self._cap is not None:
            self._cap.release()


def set_dpi_awareness() -> None:
    """Make Windows report real pixels so target coordinates are exact."""
    if not sys.platform.startswith("win"):
        return
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)   # per-monitor
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def list_monitors(tk_root=None) -> List[Dict]:
    """Monitors as dicts: index, x, y, width_px, height_px, primary."""
    monitors: List[Dict] = []
    if sys.platform.startswith("win"):
        try:
            import ctypes
            from ctypes import wintypes

            class MONITORINFO(ctypes.Structure):
                _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                            ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

            user32 = ctypes.windll.user32
            proc_type = ctypes.WINFUNCTYPE(ctypes.c_int, wintypes.HMONITOR, wintypes.HDC,
                                           ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

            def callback(hmon, _hdc, _rect, _lparam):
                mi = MONITORINFO()
                mi.cbSize = ctypes.sizeof(MONITORINFO)
                if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                    r = mi.rcMonitor
                    monitors.append({"x": r.left, "y": r.top,
                                     "width_px": r.right - r.left,
                                     "height_px": r.bottom - r.top,
                                     "primary": bool(mi.dwFlags & 1)})
                return 1

            user32.EnumDisplayMonitors(0, 0, proc_type(callback), 0)
        except Exception:
            monitors = []
    if not monitors and tk_root is not None:
        monitors = [{"x": 0, "y": 0, "width_px": tk_root.winfo_screenwidth(),
                     "height_px": tk_root.winfo_screenheight(), "primary": True}]
    monitors.sort(key=lambda m: (not m["primary"], m["x"], m["y"]))
    for i, m in enumerate(monitors):
        m["index"] = i
        m["width_mm"] = cfg.MONITOR_WIDTH_MM
        m["height_mm"] = cfg.MONITOR_HEIGHT_MM
        m["viewing_distance_mm"] = cfg.VIEWING_DISTANCE_MM
    return monitors
