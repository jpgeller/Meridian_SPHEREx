"""Temporal smoothing for the live gaze cursor.

Smoothing trades jitter for latency; it does NOT make static predictions more
accurate. Rules enforced here:

* filters run only over ORDERED, timestamped predictions of ONE trial (or one
  continuous live stream) - never across participants, sessions or trials;
* smoothed results are always reported separately from the static benchmark.

Limitation of the collected data: each trial contains ~10 frames spread over
~1 s that start 0.8 s AFTER the target moved, and nothing is recorded during
target transitions. So static fixation jitter can be measured, but response
delay, overshoot and error right after a transition cannot. `TRANSITION_PROTOCOL`
describes the continuous recording needed for that.
"""
from __future__ import annotations

import math
from typing import Callable, Dict, Optional

import numpy as np
import pandas as pd

TRANSITION_PROTOCOL = (
    "To measure response delay/overshoot: record CONTINUOUSLY at the camera frame rate while "
    "targets jump (including the first 0-800 ms after each jump), store a timestamp per frame "
    "and per target change, then run the model + filter on the stream and measure time-to-"
    "within-R px, peak overshoot and settling error per jump.")


class NoFilter:
    def reset(self): pass
    def __call__(self, t: float, xy: np.ndarray) -> np.ndarray:
        return np.asarray(xy, float)


class EMAFilter:
    def __init__(self, alpha: float = 0.3):
        self.alpha = float(alpha); self.state = None
    def reset(self): self.state = None
    def __call__(self, t, xy):
        xy = np.asarray(xy, float)
        self.state = xy if self.state is None else self.alpha * xy + (1 - self.alpha) * self.state
        return self.state


class OneEuroFilter:
    """Casiez et al., CHI 2012. Low jitter when still, low lag when moving."""
    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.01, d_cutoff: float = 1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.reset()

    def reset(self):
        self.x = self.dx = self.t = None

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, t, xy):
        xy = np.asarray(xy, float)
        if self.t is None:
            self.x, self.dx, self.t = xy, np.zeros_like(xy), t
            return xy
        dt = max(t - self.t, 1e-3)
        dx = (xy - self.x) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        self.dx = a_d * dx + (1 - a_d) * self.dx
        cutoff = self.min_cutoff + self.beta * np.abs(self.dx)
        a = np.array([self._alpha(c, dt) for c in np.atleast_1d(cutoff)])
        self.x = a * xy + (1 - a) * self.x
        self.t = t
        return self.x


class KalmanCV:
    """Constant-velocity Kalman filter per axis (process noise q, measurement r)."""
    def __init__(self, q: float = 1e-3, r: float = 1e-3):
        self.q, self.r = q, r; self.reset()

    def reset(self):
        self.s = None; self.P = None; self.t = None

    def __call__(self, t, xy):
        z = np.asarray(xy, float)
        if self.s is None:
            self.s = np.array([z[0], z[1], 0.0, 0.0]); self.P = np.eye(4); self.t = t
            return z
        dt = max(t - self.t, 1e-3); self.t = t
        F = np.eye(4); F[0, 2] = F[1, 3] = dt
        Q = self.q * np.diag([dt ** 3 / 3, dt ** 3 / 3, dt, dt])
        Hm = np.zeros((2, 4)); Hm[0, 0] = Hm[1, 1] = 1
        self.s = F @ self.s; self.P = F @ self.P @ F.T + Q
        S = Hm @ self.P @ Hm.T + self.r * np.eye(2)
        K = self.P @ Hm.T @ np.linalg.inv(S)
        self.s = self.s + K @ (z - Hm @ self.s); self.P = (np.eye(4) - K @ Hm) @ self.P
        return self.s[:2].copy()


FILTERS: Dict[str, Callable[[], object]] = {
    "none": NoFilter, "ema": EMAFilter, "one_euro": OneEuroFilter, "kalman": KalmanCV}


def smooth_predictions(pred_df: pd.DataFrame, make_filter: Callable[[], object],
                       group_cols=("participant_id", "session_id", "trial_id")) -> pd.DataFrame:
    """Apply a fresh filter to each trial, in capture-time order."""
    out = pred_df.sort_values(list(group_cols) + ["capture_time"]).copy()
    sx, sy = np.empty(len(out)), np.empty(len(out))
    pos = 0
    for _, g in out.groupby(list(group_cols), sort=False):
        f = make_filter()
        for t, x, y in zip(g["capture_time"], g["pred_x_norm"], g["pred_y_norm"]):
            sx[pos], sy[pos] = f(float(t), np.array([x, y]))
            pos += 1
    out["pred_x_norm"], out["pred_y_norm"] = sx, sy
    return out


def fixation_jitter(pred_df: pd.DataFrame, width: int, height: int) -> Dict[str, float]:
    """Static jitter: RMS distance of each frame's prediction from its trial's
    mean prediction (precision, independent of accuracy)."""
    d = pred_df.copy()
    d["px"], d["py"] = d["pred_x_norm"] * width, d["pred_y_norm"] * height
    g = d.groupby("trial_id")
    dev = np.hypot(d["px"] - g["px"].transform("mean"), d["py"] - g["py"].transform("mean"))
    return {"rms_jitter_px": float(np.sqrt((dev ** 2).mean())),
            "median_jitter_px": float(np.median(dev)),
            "p95_jitter_px": float(np.percentile(dev, 95))}


class TrackingGuard:
    """Live-use safety: hold the last cursor briefly when the face is lost
    (blink, look-away), then report 'no gaze' instead of extrapolating."""
    def __init__(self, hold_seconds: float = 0.25):
        self.hold = hold_seconds; self.last = None; self.last_t = None

    def update(self, t: float, xy: Optional[np.ndarray]) -> Optional[np.ndarray]:
        if xy is not None:
            self.last, self.last_t = np.asarray(xy, float), t
            return self.last
        if self.last is not None and t - self.last_t <= self.hold:
            return self.last
        self.last = None
        return None
