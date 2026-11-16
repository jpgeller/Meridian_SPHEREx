"""Live gaze-navigation demo: webcam -> exported gaze model -> smoothing -> sticky regions -> dwell select.

    python scripts/live_navigation_demo.py                 # 3x3 grid, eye control
    python scripts/live_navigation_demo.py --grid 4x3      # pick the grid from the hit-rate table
    python scripts/live_navigation_demo.py --mouse         # test the interface with the mouse (no camera)
    python scripts/live_navigation_demo.py --grid 6x6 --head   # start in GAZE + HEAD mode
    python scripts/live_navigation_demo.py --check-head    # 15 s check that head tracking works

GAZE + HEAD mode (needs `pip install mediapipe`; the 4 MB face_landmarker.task model is downloaded once
into training_workspace/models/): the eyes place the cursor near the target, then small head movements
steer it the last few hundred pixels while you keep looking at it. If the gaze lands far away from the
cursor for 0.45 s (a real jump), the cursor jumps there and the head reference is reset.

Model: uses checkpoints/selected/gaze_model.pt if you exported one (notebook 04, section 30), otherwise the
trained head shipped in trained_model/gaze_head_stageA.pt + the public UniGaze checkpoint (downloaded once).
Sit like you did during data collection: same laptop, same screen, same lighting, same distance.

PERSONAL CALIBRATION = gaze calibration + head/light stabiliser (software, no hardware): press K.
It runs AUTOMATICALLY at start (skip with --no-cal or --load-cal). 100 dots, ~1.5 s each, ~2.5 min. Look at each dot; between dots change
your head position a little. The demo learns this user's gaze error as a function of where the model
thinks you look AND of head turn/tilt/roll, face position, distance and face brightness, then subtracts it
live. It is only switched on if it beats "no calibration" on dots it did not learn from (5-fold check).
S toggles it for A/B tests. Saved to reports/live_demo/calibration_*.json; reuse with --load-cal <file>.

Keys:  ESC quit | T start/stop the 20-target accuracy test | R show/hide the raw model dot
       K redo the personal calibration | S calibration on/off
       H switch GAZE ONLY <-> GAZE + HEAD | , . head sensitivity | X / Y flip head direction
       C show/hide the smoothed cursor | [ ] less / more smoothing | M toggle mouse control | G cycle grid

What the layers do (none of them make the model itself more accurate):
  1. median of the last 5 predictions  -> removes single-frame outliers
  2. One Euro filter (Casiez 2012)    -> calm when the eyes are still, quick after a jump
  3. TrackingGuard                     -> blink / lost face: hold 0.25 s, then "no gaze" (never guesses)
  4. sticky regions                    -> the highlight moves only after the gaze has stayed in a new
                                          region for SWITCH_S seconds (no flicker at borders)
  5. dwell                             -> selecting needs DWELL_S seconds of steady looking; the timer
                                          pauses while there is no gaze
"""
from __future__ import annotations

import argparse
import collections
import json
import random
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SWITCH_S = 0.30      # gaze must stay in a new region this long before the highlight moves
DWELL_S = 1.00       # steady looking needed to select
COOLDOWN_S = 0.80    # after a selection, no new selection for this long
MARGIN = 0.03        # empty border (fraction of screen) - corners are the least accurate area
GRIDS = [(2, 2), (3, 2), (3, 3), (4, 3), (5, 3), (6, 4), (6, 6)]
LABELS = ["Orion", "Ursa Major", "Cassiopeia", "Scorpius", "Lyra", "Cygnus", "Leo", "Taurus", "Andromeda",
          "Gemini", "Pegasus", "Sagittarius", "Aquila", "Perseus", "Draco", "Virgo", "Aries", "Libra",
          "Cancer", "Pisces", "Capricorn", "Aquarius", "Hercules", "Bootes", "Auriga", "Cepheus", "Corvus",
          "Crux", "Carina", "Centaurus", "Hydra", "Lupus", "Vela", "Puppis", "Monoceros", "Canis Major"]
HEAD_LEVELS = [(2.0, 0.08), (1.4, 0.11), (1.0, 0.15), (0.6, 0.20), (0.35, 0.28)]  # (head min_cutoff Hz, glide s)
SMOOTH_LEVELS = [(1.5, 0.004), (0.8, 0.002), (0.4, 0.001), (0.2, 0.0005), (0.1, 0.0003)]  # (min_cutoff Hz, beta)


# ----------------------------------------------------------------------------- pure logic (no camera / GUI)
class RegionNavigator:
    """Sticky region highlight + dwell selection on a cols x rows grid. Coordinates are normalised (0-1)."""

    def __init__(self, cols: int, rows: int, switch_s=SWITCH_S, dwell_s=DWELL_S, cooldown_s=COOLDOWN_S,
                 margin=MARGIN):
        self.cols, self.rows, self.margin = cols, rows, margin
        self.switch_s, self.dwell_s, self.cooldown_s = switch_s, dwell_s, cooldown_s
        self.current: Optional[int] = None
        self.candidate: Optional[int] = None
        self.candidate_since = 0.0
        self.dwell = 0.0
        self.last_t: Optional[float] = None
        self.cooldown_until = 0.0

    def cell_rect(self, i: int):
        m = self.margin
        cw, ch = (1 - 2 * m) / self.cols, (1 - 2 * m) / self.rows
        c, r = i % self.cols, i // self.cols
        return m + c * cw, m + r * ch, m + (c + 1) * cw, m + (r + 1) * ch

    def region_at(self, x: float, y: float) -> int:
        m = self.margin
        c = int(np.clip((x - m) / (1 - 2 * m) * self.cols, 0, self.cols - 1))
        r = int(np.clip((y - m) / (1 - 2 * m) * self.rows, 0, self.rows - 1))
        return r * self.cols + c

    def update(self, t: float, xy: Optional[np.ndarray]) -> Optional[int]:
        """Feed one (smoothed) gaze point or None (no gaze). Returns a region index when it is selected."""
        dt = 0.0 if self.last_t is None else max(0.0, min(t - self.last_t, 0.2))
        self.last_t = t
        if xy is None:                         # no gaze: keep the highlight, pause the dwell timer
            self.candidate = None
            return None
        reg = self.region_at(float(xy[0]), float(xy[1]))
        if self.current is None:
            self.current, self.dwell = reg, 0.0
        elif reg != self.current:
            if reg != self.candidate:
                self.candidate, self.candidate_since = reg, t
            elif t - self.candidate_since >= self.switch_s:
                self.current, self.candidate, self.dwell = reg, None, 0.0
            return None                        # gaze is outside the highlighted region: no dwell progress
        else:
            self.candidate = None
        if t < self.cooldown_until:
            return None
        self.dwell += dt
        if self.dwell >= self.dwell_s:
            self.dwell, self.cooldown_until = 0.0, t + self.cooldown_s
            return self.current
        return None

    @property
    def progress(self) -> float:
        return min(1.0, self.dwell / self.dwell_s)


class GazeSmoother:
    """median-of-N -> One Euro (pixel units) -> TrackingGuard. Returns normalised xy or None."""

    def __init__(self, W: int, H: int, level: int = 2, median_n: int = 5, hold_s: float = 0.25):
        from src.smoothing import TrackingGuard
        self.W, self.H, self.median_n = W, H, median_n
        self.buf = collections.deque(maxlen=median_n)
        self.guard = TrackingGuard(hold_s)
        self.set_level(level)

    def set_level(self, level: int):
        from src.smoothing import OneEuroFilter
        self.level = int(np.clip(level, 0, len(SMOOTH_LEVELS) - 1))
        mc, beta = SMOOTH_LEVELS[self.level]
        self.filter = OneEuroFilter(min_cutoff=mc, beta=beta, d_cutoff=1.0)

    def update(self, t: float, xy_norm: Optional[np.ndarray]):
        if xy_norm is None:
            self.buf.clear()
            self.filter.reset()                # restart cleanly after a blink / lost face
            out = self.guard.update(t, None)
        else:
            self.buf.append(np.asarray(xy_norm, float) * (self.W, self.H))
            med = np.median(np.array(self.buf), axis=0)
            out = self.guard.update(t, self.filter(t, med))
        return None if out is None else np.asarray(out) / (self.W, self.H)


# ----------------------------------------------------------------------------- head tracking (MediaPipe)
FACE_LANDMARKER_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/"
                       "float16/1/face_landmarker.task")


def ensure_face_landmarker(models_dir: Path) -> Path:
    path = models_dir / "face_landmarker.task"
    if path.is_file() and path.stat().st_size > 1_000_000:
        return path
    models_dir.mkdir(parents=True, exist_ok=True)
    print("downloading MediaPipe face_landmarker.task (~4 MB) ...")
    import urllib.request
    try:
        urllib.request.urlretrieve(FACE_LANDMARKER_URL, path)
    except Exception as e:
        raise SystemExit(f"Download failed ({e}).\nDownload it in a browser from\n  {FACE_LANDMARKER_URL}\n"
                         f"and save it as\n  {path}")
    if path.stat().st_size < 1_000_000:
        path.unlink()
        raise SystemExit(f"Downloaded file is not the model. Get it manually from {FACE_LANDMARKER_URL} -> {path}")
    return path


class HeadTracker:
    """Head direction from MediaPipe face landmarks, like a 'nose pointer':
    nose tip relative to the midpoint of the outer eye corners, divided by the eye-corner distance.
    That cancels sideways/forward movement of the whole head and keeps mostly the head ROTATION.
    Returns (h, v): h grows when the head turns to the user's right, v when the head tilts down."""

    NOSE, EYE_R_OUTER, EYE_L_OUTER = 1, 33, 263

    def __init__(self, model_path: Path):
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mpt
            from mediapipe.tasks.python import vision
        except ImportError:
            raise SystemExit("GAZE + HEAD needs MediaPipe:  pip install mediapipe")
        self.mp = mp
        opts = vision.FaceLandmarkerOptions(base_options=mpt.BaseOptions(model_asset_path=str(model_path)),
                                            running_mode=vision.RunningMode.VIDEO, num_faces=1)
        self.lm = vision.FaceLandmarker.create_from_options(opts)
        self.last_ms = -1
        self.state = None
        self.features = None
        self.landmarks = None  # the last MediaPipe face landmarks (Meridian's face panel draws them)
        from src.smoothing import OneEuroFilter
        self.filter = OneEuroFilter(min_cutoff=1.0, beta=5.0, d_cutoff=1.0)   # rotation units: calm when still

    def update(self, frame_bgr: np.ndarray, t: float):
        import cv2
        ms = int(t * 1000)
        if ms <= self.last_ms:
            ms = self.last_ms + 1
        self.last_ms = ms
        img = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
        res = self.lm.detect_for_video(img, ms)
        if not res.face_landmarks:
            self.state = None
            self.features = None
            self.landmarks = None
            self.filter.reset()
            return None
        p = res.face_landmarks[0]
        self.landmarks = p
        h_img, w_img = frame_bgr.shape[:2]
        pt = lambda i: np.array([p[i].x * w_img, p[i].y * h_img])
        a, b, n = pt(self.EYE_R_OUTER), pt(self.EYE_L_OUTER), pt(self.NOSE)
        d = np.linalg.norm(b - a)
        if d < 10:
            return None
        rel = (n - (a + b) / 2) / d
        # unmirrored camera: turning to the user's right moves the nose to the LEFT in the image
        hv = np.array([-rel[0], rel[1]])
        self.state = np.asarray(self.filter(t, hv), float)
        # features for the head stabiliser: rotation (h, v, roll), position (x, y), distance (scale), light
        xs = np.array([q.x for q in p]) * w_img
        ys = np.array([q.y for q in p]) * h_img
        x0, x1 = int(max(xs.min(), 0)), int(min(xs.max(), w_img - 1))
        y0, y1 = int(max(ys.min(), 0)), int(min(ys.max(), h_img - 1))
        bright = float(frame_bgr[y0:y1 + 1, x0:x1 + 1].mean()) / 255.0 if (x1 > x0 and y1 > y0) else 0.5
        mid = (a + b) / 2
        roll = float(np.arctan2(b[1] - a[1], b[0] - a[0]))
        self.features = np.array([self.state[0], self.state[1], roll, mid[0] / w_img, mid[1] / h_img,
                                  d / w_img, bright])
        return self.state.copy()


class HybridCursor:
    """GAZE + HEAD. Eyes give an anchor; head rotation since the anchor steers the cursor from there.
    All positions in screen pixels."""

    def __init__(self, W: int, H: int, gain: float = 3500.0, jump_px: float = 500.0, jump_s: float = 0.45,
                 glide_s: float = 0.15, head_hold_s: float = 0.5):
        self.W, self.H, self.gain, self.jump_px, self.jump_s = W, H, gain, jump_px, jump_s
        self.glide_s, self.head_hold_s = glide_s, head_hold_s
        self.sign = np.array([1.0, 1.0])
        self.reset()

    def reset(self):
        self.anchor = self.head_ref = self.cursor = None
        self.far_since = None
        self.shown = None              # what is drawn: glides toward `cursor`, never teleports
        self.last_t = None
        self.head_lost_since = None

    def update(self, t: float, gaze_px: Optional[np.ndarray], head: Optional[np.ndarray]):
        target = self._target(t, gaze_px, head)
        if target is None:
            self.shown, self.last_t = None, t
            return None
        if self.shown is None or self.last_t is None:
            self.shown = np.array(target, float)
        else:                          # exponential glide: ~glide_s time constant, frame-rate independent
            a = 1.0 - np.exp(-max(t - self.last_t, 0.0) / self.glide_s)
            self.shown = self.shown + a * (np.asarray(target) - self.shown)
        self.last_t = t
        return self.shown.copy()

    def _target(self, t: float, gaze_px: Optional[np.ndarray], head: Optional[np.ndarray]):
        if gaze_px is None and self.cursor is None:
            return None
        if head is None:               # head lost: hold the cursor briefly, then fall back to gaze
            if self.head_lost_since is None:
                self.head_lost_since = t
            if self.cursor is not None and t - self.head_lost_since < self.head_hold_s:
                return self.cursor
            if gaze_px is not None:
                self.anchor, self.head_ref, self.cursor = np.array(gaze_px, float), None, np.array(gaze_px, float)
            return self.cursor
        self.head_lost_since = None
        if self.anchor is None or self.head_ref is None:
            if gaze_px is None:
                return self.cursor
            self.anchor, self.head_ref = np.array(gaze_px, float), head.copy()
        self.cursor = self.anchor + self.sign * self.gain * (head - self.head_ref)
        self.cursor = np.clip(self.cursor, [0, 0], [self.W - 1, self.H - 1])
        if gaze_px is not None:
            if np.linalg.norm(np.asarray(gaze_px) - self.cursor) > self.jump_px:
                if self.far_since is None:
                    self.far_since = t
                elif t - self.far_since >= self.jump_s:  # a real gaze jump: move there, reset head reference
                    self.anchor, self.head_ref, self.far_since = np.array(gaze_px, float), head.copy(), None
                    self.cursor = self.anchor.copy()
            else:
                self.far_since = None
        return self.cursor


# ----------------------------------------------------------------------------- personal gaze + head calibration
STAB_FEATURES = ["head_h", "head_v", "roll", "face_x", "face_y", "face_scale", "face_brightness"]
GAZE_TERMS = ["x", "y", "x^2", "y^2", "x*y"]           # where the model THINKS you look (normalised 0-1)
STAB_DOT_S, STAB_SETTLE_S = 1.5, 0.6
CAL_INTRO_S = 5.0                                       # instruction screen before the first dot                    # per dot: 0.6 s for the eyes to land, then 0.9 s recorded


def make_cal_dots(n: int, seed: int = 0):
    """n dots spread evenly over the screen (jittered grid, 4-96 %), in random order."""
    rng = np.random.default_rng(seed)
    cols = int(np.ceil(np.sqrt(n * 1.6)))
    rows = int(np.ceil(n / cols))
    pts = [((c + rng.uniform(0.2, 0.8)) / cols, (r + rng.uniform(0.2, 0.8)) / rows)
           for r in range(rows) for c in range(cols)]
    rng.shuffle(pts)
    return [(0.04 + 0.92 * x, 0.04 + 0.92 * y) for x, y in pts[:n]]


class HeadStabiliser:
    """Personal calibration of the gaze model for ONE user in the CURRENT set-up.
    Learns the model's error (prediction - dot) as a ridge regression on
      * where the model thinks you look (x, y and quadratic terms)  -> per-user gaze calibration
      * head turn/tilt/roll, face position, distance, face brightness -> head + lighting stabiliser
    Checked on dots it did not learn from (5-fold, by dot); switched on only if it beats 'no calibration'.
    Corrections are capped, and features are never extrapolated beyond what the calibration covered."""

    def __init__(self, alpha: float = 3.0, max_corr_px: float = 500.0, W: int = 2560, H: int = 1600):
        self.alpha, self.max_corr, self.W, self.H = alpha, max_corr_px, W, H
        self.mu = self.sd = self.coef = self.bias = self.zmin = self.zmax = None
        self.enabled, self.report = False, {}

    def design(self, pred_px: np.ndarray, feats: np.ndarray) -> np.ndarray:
        P = np.atleast_2d(pred_px) / (self.W, self.H)
        x, y = P[:, 0], P[:, 1]
        return np.column_stack([x, y, x * x, y * y, x * y, np.atleast_2d(feats)])

    @staticmethod
    def _fit(X, Y, alpha):
        mu, sd = X.mean(0), X.std(0) + 1e-6
        Z = (X - mu) / sd
        bias = Y.mean(0)
        A = np.linalg.solve(Z.T @ Z + alpha * len(Z) * np.eye(Z.shape[1]) / 100.0, Z.T @ (Y - bias))
        return mu, sd, A, bias

    def _apply(self, X, mu, sd, A, bias, zmin=None, zmax=None):
        Z = (X - mu) / sd
        if zmin is not None:
            Z = np.clip(Z, zmin, zmax)
        return np.clip(bias + Z @ A, -self.max_corr, self.max_corr)

    def fit(self, feats: np.ndarray, pred_px: np.ndarray, dot_px: np.ndarray, dot_id: np.ndarray) -> dict:
        X = self.design(pred_px, feats)
        Y = pred_px - dot_px
        fold = dot_id % 5
        before, after = [], []
        for k in range(5):
            tr, te = fold != k, fold == k
            if te.sum() == 0 or tr.sum() < 30:
                continue
            mu, sd, A, bias = self._fit(X[tr], Y[tr], self.alpha)
            Ztr = (X[tr] - mu) / sd
            corr = self._apply(X[te], mu, sd, A, bias, Ztr.min(0), Ztr.max(0))
            before.append(np.linalg.norm(Y[te], axis=1))
            after.append(np.linalg.norm(Y[te] - corr, axis=1))
        self.mu, self.sd, self.coef, self.bias = self._fit(X, Y, self.alpha)
        Z = (X - self.mu) / self.sd
        self.zmin, self.zmax = Z.min(0), Z.max(0)
        b, a = float(np.concatenate(before).mean()), float(np.concatenate(after).mean())
        self.enabled = a < 0.95 * b
        self.report = {"dots": int(len(np.unique(dot_id))), "frames": int(len(X)),
                       "error_without_px": round(b, 1), "error_with_px": round(a, 1),
                       "enabled": bool(self.enabled), "terms": GAZE_TERMS + STAB_FEATURES}
        return self.report

    def correct(self, xy_px: np.ndarray, feats: Optional[np.ndarray]) -> np.ndarray:
        if not self.enabled or self.coef is None:
            return xy_px
        if feats is None:                       # head not found by MediaPipe: use the average head state
            feats = self.mu[len(GAZE_TERMS):] * 1.0
        X = self.design(xy_px, feats)
        return xy_px - self._apply(X, self.mu, self.sd, self.coef, self.bias, self.zmin, self.zmax)[0]

    def save(self, path: Path):
        path.write_text(json.dumps({k: getattr(self, k).tolist() for k in ("mu", "sd", "coef", "bias", "zmin", "zmax")}
                                   | {"report": self.report, "W": self.W, "H": self.H}, indent=1))

    def load(self, path: Path):
        d = json.loads(Path(path).read_text())
        for k in ("mu", "sd", "coef", "bias", "zmin", "zmax"):
            setattr(self, k, np.array(d[k]))
        self.report, self.enabled = d["report"], bool(d["report"].get("enabled", True))
        return self.report


# ----------------------------------------------------------------------------- camera (latest frame only)
class LatestFrameCamera:
    """Reads frames in a background thread and keeps only the newest one (no lag build-up)."""

    def __init__(self, index: int, width: int, height: int):
        import cv2
        self.cap = cv2.VideoCapture(index, cv2.CAP_DSHOW) if sys.platform == "win32" else cv2.VideoCapture(index)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, 30)
        if not self.cap.isOpened():
            raise RuntimeError(f"Camera {index} could not be opened (close the capture app / other camera apps)")
        self.frame, self.t, self.lock, self.running = None, 0.0, threading.Lock(), True
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while self.running:
            ok, f = self.cap.read()
            if ok:
                with self.lock:
                    self.frame, self.t = f, time.time()

    def read(self):
        with self.lock:
            return (None, 0.0) if self.frame is None else (self.frame, self.t)

    def size(self):
        import cv2
        return int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    def close(self):
        self.running = False
        time.sleep(0.05)
        self.cap.release()


# ----------------------------------------------------------------------------- drawing
def make_background(W: int, H: int, seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    yy = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    img = np.zeros((H, W, 3), np.float32)
    img[..., 0] = 28 + 30 * yy; img[..., 1] = 10 + 12 * yy; img[..., 2] = 8 + 6 * yy      # BGR night sky
    n = (W * H) // 2500
    xs, ys = rng.integers(0, W, n), rng.integers(0, H, n)
    b = rng.uniform(80, 255, n)
    img[ys, xs] = b[:, None]
    return img.clip(0, 255).astype(np.uint8)


def render(bg, nav: RegionNavigator, W, H, smooth_xy, raw_xy, show_raw, show_cursor, status, flash,
           test_target, mode_name, smooth_level, fps):
    import cv2
    img = bg.copy()
    over = img.copy()
    for i in range(nav.cols * nav.rows):
        x0, y0, x1, y1 = nav.cell_rect(i)
        p0, p1 = (int(x0 * W) + 6, int(y0 * H) + 6), (int(x1 * W) - 6, int(y1 * H) - 6)
        if i == nav.current:
            cv2.rectangle(over, p0, p1, (180, 120, 40), -1)
        if flash and flash[0] == i:
            cv2.rectangle(over, p0, p1, (60, 200, 60), -1)
        if test_target == i:
            cv2.rectangle(over, p0, p1, (40, 160, 230), -1)
    cv2.addWeighted(over, 0.35, img, 0.65, 0, img)
    for i in range(nav.cols * nav.rows):
        x0, y0, x1, y1 = nav.cell_rect(i)
        p0, p1 = (int(x0 * W) + 6, int(y0 * H) + 6), (int(x1 * W) - 6, int(y1 * H) - 6)
        col = (255, 220, 150) if i == nav.current else (120, 100, 90)
        cv2.rectangle(img, p0, p1, col, 3 if i == nav.current else 1)
        label = LABELS[i % len(LABELS)]
        fs = max(0.9, W / 1800)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fs, 2)
        cx, cy = (p0[0] + p1[0]) // 2, (p0[1] + p1[1]) // 2
        cv2.putText(img, label, (cx - tw // 2, cy + th // 2), cv2.FONT_HERSHEY_SIMPLEX, fs, (235, 235, 235), 2,
                    cv2.LINE_AA)
        if i == nav.current and nav.progress > 0:
            r = int(min(p1[0] - p0[0], p1[1] - p0[1]) * 0.18)
            cv2.ellipse(img, (cx, cy - th - r - 10), (r, r), -90, 0, int(360 * nav.progress), (80, 230, 255), 8,
                        cv2.LINE_AA)
    if show_raw and raw_xy is not None:
        cv2.circle(img, (int(raw_xy[0] * W), int(raw_xy[1] * H)), 7, (0, 0, 255), -1, cv2.LINE_AA)
    if show_cursor and smooth_xy is not None:
        c = (int(smooth_xy[0] * W), int(smooth_xy[1] * H))
        cv2.circle(img, c, 26, (255, 255, 255), 3, cv2.LINE_AA)
        cv2.circle(img, c, 5, (255, 255, 255), -1, cv2.LINE_AA)
    bar = (f"{mode_name} | grid {nav.cols}x{nav.rows} | smoothing {smooth_level + 1}/5 "
           f"| {fps:4.1f} fps | {status}")
    cv2.rectangle(img, (0, H - 44), (W, H), (0, 0, 0), -1)
    cv2.putText(img, bar, (16, H - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (210, 210, 210), 2, cv2.LINE_AA)
    cv2.putText(img, "ESC quit  T test  K stabiliser  S on/off  H gaze/gaze+head  , . head gain  X Y flip  R raw  C cursor  [ ] smooth  M mouse  G grid",
                (W - 1640, H - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (150, 150, 150), 1, cv2.LINE_AA)
    return img


# ----------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", default="3x3", help="cols x rows, e.g. 3x3 or 4x3")
    ap.add_argument("--model", default=None, help="default: checkpoints/selected/gaze_model.pt")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--mouse", action="store_true", help="start with mouse control (no camera needed)")
    ap.add_argument("--smoothing", type=int, default=3, help="1 (light) .. 5 (heavy)")
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--head", action="store_true", help="start in GAZE + HEAD mode")
    ap.add_argument("--head-gain", type=float, default=3500.0, help="pixels per unit of head rotation")
    ap.add_argument("--check-head", action="store_true", help="15 s head-tracking check, then exit")
    ap.add_argument("--cal-points", type=int, default=100, help="dots in the personal calibration (K)")
    ap.add_argument("--no-cal", action="store_true", help="skip the calibration at start (press K later)")
    ap.add_argument("--load-cal", default=None, help="load a saved calibration JSON (same person, same set-up)")
    a = ap.parse_args()

    import cv2
    from src.config import load_config
    ws = Path(__file__).resolve().parent.parent
    cfg = load_config(ws / "training_config.yaml")
    W, H = cfg.screen_px
    cols, rows = (int(v) for v in a.grid.lower().split("x"))
    grid_i = GRIDS.index((cols, rows)) if (cols, rows) in GRIDS else 0
    nav = RegionNavigator(cols, rows)
    smoother = GazeSmoother(W, H, level=a.smoothing - 1)
    hybrid = HybridCursor(W, H, gain=a.head_gain)
    stab = HeadStabiliser(W=W, H=H)
    cal_dots = make_cal_dots(a.cal_points)
    stab_cal = {"on": False, "i": 0, "t0": 0.0, "X": [], "P": [], "D": [], "id": [], "paused": False,
                "break_done": False}
    head_tracker = None
    head_mode = a.head

    def start_head():
        nonlocal head_tracker
        if head_tracker is None:
            head_tracker = HeadTracker(ensure_face_landmarker(ws / "models"))
        apply_head_level()

    def apply_head_level():
        # the same [ ] smoothing level also controls the head filter and the cursor glide in GAZE + HEAD
        mc, glide = HEAD_LEVELS[smoother.level]
        hybrid.glide_s = glide
        if head_tracker is not None:
            head_tracker.filter.min_cutoff = mc

    if a.check_head:
        import cv2
        start_head()
        cam0 = LatestFrameCamera(a.camera, 1280, 720)
        print("Turn your head slowly LEFT/RIGHT and UP/DOWN. h should grow to your right, v when looking down.")
        t_end, last = time.time() + 15, 0.0
        try:
            while time.time() < t_end:
                f, ft = cam0.read()
                if f is None or ft == last:
                    time.sleep(0.005); continue
                last = ft
                hv = head_tracker.update(f, ft)
                print("no face" if hv is None else f"h = {hv[0]:+.3f}   v = {hv[1]:+.3f}", end="\r")
        finally:
            cam0.close()
        print("\nhead tracking OK" if head_tracker.state is not None else "\nno face found - check light/camera")
        return 0

    predictor, cam, mouse_mode = None, None, a.mouse

    def start_eyes():
        nonlocal predictor, cam
        import torch
        from src.infer import GazePredictor
        # model: --model <file>, else your own export (notebook 04, section 30), else the trained head shipped
        # in the repository (trained_model/gaze_head_stageA.pt) + the public UniGaze checkpoint (downloaded once)
        exported = cfg.paths.checkpoints / "selected" / "gaze_model.pt"
        shipped = ws / "trained_model" / "gaze_head_stageA.pt"
        model_file = Path(a.model) if a.model else (exported if exported.is_file() else shipped)
        if not model_file.is_file():
            raise SystemExit(f"Model not found: {model_file}")
        dev = "cuda" if (torch.cuda.is_available() and not a.cpu) else "cpu"
        if dev == "cpu":
            print("NOTE: running on the CPU (no CUDA PyTorch found) - it works, but expect a low frame rate")
        if predictor is None:
            if model_file.stat().st_size < 20_000_000:          # the small head file (full exports are ~350 MB)
                print("loading the shipped head + UniGaze (first run downloads ~350 MB from Hugging Face) ...")
                predictor = GazePredictor.from_head(model_file, cfg, cfg.paths.yunet_model, dev)
            else:
                predictor = GazePredictor.from_export(model_file, cfg.paths.yunet_model, dev)
            print("model:", model_file, "| device:", dev, "| selection:", predictor.blob.get("selection"))
        if cam is None:
            cam = LatestFrameCamera(a.camera, 1280, 720)
            if cam.size() != (1280, 720):
                print(f"WARNING: camera gives {cam.size()}, training used 1280x720 - accuracy may drop")

    if not mouse_mode:
        start_eyes()
    if head_mode and not mouse_mode:
        start_head()

    win = "Gaze navigation"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
    mouse = {"xy": None}

    def on_mouse(event, x, y, flags, param):
        mouse["xy"] = np.array([x / W, y / H])
    cv2.setMouseCallback(win, on_mouse)

    bg = make_background(W, H)
    show_raw, show_cursor = False, True
    flash, status = None, "look at a region for 1 s to select it"
    last_frame_t, fps, fps_t, fps_n = 0.0, 0.0, time.time(), 0
    test = {"on": False, "targets": [], "i": 0, "t0": 0.0, "hits": 0, "times": [], "results": []}
    log_dir = cfg.paths.reports / "live_demo"
    log_dir.mkdir(parents=True, exist_ok=True)
    banner = {"text": "", "until": 0.0}
    if a.load_cal:
        start_head()
        print("loaded calibration:", stab.load(Path(a.load_cal)))
    elif not mouse_mode and not a.no_cal:
        # calibration comes FIRST: intro screen for CAL_INTRO_S seconds, then the dots, then the grid
        start_head()
        stab_cal.update(on=True, i=0, t0=time.time() + CAL_INTRO_S, X=[], P=[], D=[], id=[], paused=False,
                        break_done=True)

    def new_test():
        n = cols * rows
        seq = [random.randrange(n) for _ in range(20)]
        for k in range(1, len(seq)):                       # no repeats in a row
            while seq[k] == seq[k - 1]:
                seq[k] = random.randrange(n)
        test.update(on=True, targets=seq, i=0, t0=time.time(), hits=0, times=[], results=[])

    try:
        while True:
            t = time.time()
            raw = None
            if mouse_mode:
                raw = mouse["xy"]
                sm = smoother.update(t, raw)
            else:
                frame, ft = cam.read()
                if frame is None or ft == last_frame_t:
                    key = cv2.waitKey(2) & 0xFF
                    if key == 27:
                        break
                    continue
                last_frame_t = ft
                r = predictor.predict_frame(frame, ft)
                need_head = head_mode or stab_cal["on"] or stab.enabled
                if need_head:
                    hv = head_tracker.update(frame, ft)
                feats = head_tracker.features if (need_head and head_tracker is not None) else None
                raw = None
                if r["ok"]:
                    raw_px = np.array([r["raw_x_norm"] * W, r["raw_y_norm"] * H])   # unclamped model output
                    if stab_cal["on"] and not stab_cal["paused"]:
                        dt_dot = ft - stab_cal["t0"]
                        if dt_dot >= STAB_SETTLE_S and feats is not None:
                            dx, dy = cal_dots[stab_cal["i"]]
                            stab_cal["X"].append(feats.copy()); stab_cal["P"].append(raw_px)
                            stab_cal["D"].append([dx * W, dy * H]); stab_cal["id"].append(stab_cal["i"])
                    raw_px = stab.correct(raw_px, feats)
                    raw = np.clip(raw_px / (W, H), 0.0, 1.0)
                sm = smoother.update(ft, raw)
                if stab_cal["on"] and not stab_cal["paused"] and ft - stab_cal["t0"] >= STAB_DOT_S:
                    stab_cal["i"] += 1
                    stab_cal["t0"] = ft
                    if stab_cal["i"] >= len(cal_dots):
                        stab_cal["on"] = False
                        n_dots = len(set(stab_cal["id"]))
                        if n_dots < max(20, len(cal_dots) // 2):
                            status = (f"calibration: only {n_dots} dots had a face - check lighting, press K again")
                            banner["text"], banner["until"] = status, time.time() + 4.0
                        else:
                            rep_ = stab.fit(np.array(stab_cal["X"]), np.array(stab_cal["P"]),
                                            np.array(stab_cal["D"]), np.array(stab_cal["id"]))
                            stab.save(log_dir / f"calibration_{time.strftime('%Y%m%d_%H%M%S')}.json")
                            status = (f"calibration {'ON' if rep_['enabled'] else 'OFF (did not help)'}: error "
                                      f"{rep_['error_without_px']:.0f} -> {rep_['error_with_px']:.0f} px on dots it "
                                      f"did not learn from ({rep_['dots']} dots, {rep_['frames']} frames)")
                            print(status)
                            banner["text"], banner["until"] = status, time.time() + 4.0
                if head_mode:
                    cur = hybrid.update(ft, None if sm is None else sm * (W, H), hv)
                    sm = None if cur is None else cur / (W, H)
                if stab_cal["on"]:
                    status = ("BREAK - rest your eyes, press SPACE to continue" if stab_cal["paused"] else
                              f"CALIBRATION {stab_cal['i'] + 1}/{len(cal_dots)}: look at the dot; between dots "
                              f"change your head position a little (turn, tilt, lean, closer/farther)")
                elif not r["ok"]:
                    status = f"no gaze ({r['reason']}) - face the camera"
                elif not test["on"] and not status.startswith("calibration"):
                    status = "look at a region for 1 s to select it"

            sel = None if stab_cal["on"] else nav.update(t, sm)
            if sel is not None:
                flash = (sel, t + 0.4)
                if test["on"]:
                    tgt = test["targets"][test["i"]]
                    hit = sel == tgt
                    test["hits"] += hit
                    test["times"].append(t - test["t0"])
                    test["results"].append({"target": tgt, "selected": sel, "hit": bool(hit),
                                            "seconds": round(t - test["t0"], 2)})
                    test["i"] += 1
                    test["t0"] = t
                    if test["i"] >= len(test["targets"]):
                        test["on"] = False
                        res = {"grid": f"{cols}x{rows}", "stabiliser": bool(stab.enabled),
                               "mode": "mouse" if mouse_mode else ("gaze+head" if head_mode else "gaze"),
                               "head_gain": hybrid.gain if head_mode else None,
                               "smoothing_level": smoother.level + 1, "n": len(test["results"]),
                               "hit_rate": test["hits"] / len(test["results"]),
                               "median_seconds_per_selection": float(np.median(test["times"])),
                               "trials": test["results"], "time": time.strftime("%Y-%m-%d %H:%M:%S")}
                        f = log_dir / f"accuracy_test_{time.strftime('%Y%m%d_%H%M%S')}.json"
                        f.write_text(json.dumps(res, indent=1))
                        status = (f"TEST DONE: {test['hits']}/{res['n']} correct "
                                  f"({100 * res['hit_rate']:.0f} %), median {res['median_seconds_per_selection']:.1f} s"
                                  f" per selection - saved {f.name}")
                        print(status)
                else:
                    status = f"selected: {LABELS[sel % len(LABELS)]}"
            if flash and t > flash[1]:
                flash = None
            if test["on"]:
                status = (f"TEST {test['i'] + 1}/20: look at the ORANGE region | correct so far "
                          f"{test['hits']}/{test['i']}")

            fps_n += 1
            if t - fps_t >= 1.0:
                fps, fps_n, fps_t = fps_n / (t - fps_t), 0, t
            img = render(bg, nav, W, H, sm, raw, show_raw, show_cursor, status, flash,
                         test["targets"][test["i"]] if test["on"] else None,
                         "MOUSE" if mouse_mode else ("GAZE + HEAD" if head_mode else "GAZE ONLY"), smoother.level, fps)
            if stab_cal["on"]:
                img[:] = (img * 0.25).astype(np.uint8)
                if time.time() < stab_cal["t0"] and stab_cal["i"] == 0:
                    lines = ["CALIBRATION  (about 2.5 minutes, gaze + head together)",
                             f"{len(cal_dots)} dots will appear one at a time. Look straight at each dot.",
                             "Between dots, change your head position a little:",
                             "turn, tilt, lean, move a bit closer or farther.",
                             f"Starting in {int(np.ceil(stab_cal['t0'] - time.time()))} ..."]
                    for k, line in enumerate(lines):
                        cv2.putText(img, line, (W // 2 - 760, H // 2 - 160 + 80 * k), cv2.FONT_HERSHEY_SIMPLEX,
                                    1.5 if k == 0 else 1.2, (235, 235, 235), 3 if k == 0 else 2, cv2.LINE_AA)
                elif stab_cal["paused"]:
                    cv2.putText(img, f"Break ({stab_cal['i']}/{len(cal_dots)} done) - press SPACE to continue",
                                (W // 2 - 600, H // 2), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (230, 230, 230), 3,
                                cv2.LINE_AA)
                else:
                    dx, dy = cal_dots[stab_cal["i"]]
                    c = (int(dx * W), int(dy * H))
                    left = max(0.0, STAB_DOT_S - (time.time() - stab_cal["t0"]))
                    cv2.circle(img, c, int(14 + 50 * left / STAB_DOT_S), (255, 255, 255), 3, cv2.LINE_AA)
                    cv2.circle(img, c, 10, (40, 200, 255), -1, cv2.LINE_AA)
                    cv2.putText(img, f"{stab_cal['i'] + 1}/{len(cal_dots)}", (c[0] + 30, c[1] - 30),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.9, (200, 200, 200), 2, cv2.LINE_AA)
            if time.time() < banner["until"]:
                cv2.rectangle(img, (W // 2 - 1000, H // 2 - 70), (W // 2 + 1000, H // 2 + 50), (0, 0, 0), -1)
                cv2.putText(img, banner["text"][:110], (W // 2 - 970, H // 2), cv2.FONT_HERSHEY_SIMPLEX, 1.1,
                            (120, 255, 160), 2, cv2.LINE_AA)
            cv2.imshow(win, img)
            key = cv2.waitKey(1) & 0xFF
            if key == 27:
                break
            elif key in (ord("r"), ord("R")):
                show_raw = not show_raw
            elif key in (ord("c"), ord("C")):
                show_cursor = not show_cursor
            elif key == ord("["):
                smoother.set_level(smoother.level - 1); apply_head_level()
                status = f"smoothing {smoother.level + 1}/5"
            elif key == ord("]"):
                smoother.set_level(smoother.level + 1); apply_head_level()
                status = f"smoothing {smoother.level + 1}/5"
            elif key in (ord("t"), ord("T")):
                if test["on"]:
                    test["on"] = False
                    status = "test stopped"
                else:
                    new_test()
            elif key in (ord("k"), ord("K")) and not mouse_mode:
                start_head()
                stab.enabled = False
                stab_cal.update(on=True, i=0, t0=time.time() + CAL_INTRO_S, X=[], P=[], D=[], id=[],
                                paused=False, break_done=True)
            elif key == 32 and stab_cal["on"] and stab_cal["paused"]:
                stab_cal["paused"], stab_cal["t0"] = False, time.time()
                test["on"] = False
            elif key in (ord("s"), ord("S")) and stab.coef is not None:
                stab.enabled = not stab.enabled
                status = f"calibration {'ON' if stab.enabled else 'OFF'}"
            elif key in (ord("h"), ord("H")) and not mouse_mode:
                head_mode = not head_mode
                if head_mode:
                    start_head()
                hybrid.reset()
                test["on"] = False
                status = "GAZE + HEAD: look at the target, then nudge with small head turns" if head_mode else "GAZE ONLY"
            elif key == ord(","):
                hybrid.gain = max(500.0, hybrid.gain / 1.25); status = f"head gain {hybrid.gain:.0f}"
            elif key == ord("."):
                hybrid.gain = min(20000.0, hybrid.gain * 1.25); status = f"head gain {hybrid.gain:.0f}"
            elif key in (ord("x"), ord("X")):
                hybrid.sign[0] *= -1; status = "head left/right flipped"
            elif key in (ord("y"), ord("Y")):
                hybrid.sign[1] *= -1; status = "head up/down flipped"
            elif key in (ord("m"), ord("M")):
                mouse_mode = not mouse_mode
                if not mouse_mode:
                    start_eyes()
                    if head_mode:
                        start_head()
                hybrid.reset()
                smoother = GazeSmoother(W, H, level=smoother.level)
            elif key in (ord("g"), ord("G")):
                grid_i = (grid_i + 1) % len(GRIDS)
                cols, rows = GRIDS[grid_i]
                nav = RegionNavigator(cols, rows)
                test["on"] = False
    finally:
        if cam is not None:
            cam.close()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
