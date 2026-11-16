"""Second calibration layer: targets on Meridian's own buttons.

The first layer (HeadStabiliser in training_workspace/scripts/live_navigation_demo.py, 100 dots over the whole
screen) learns the user's gaze error as a function of where the model thinks they look and of head pose. What is
left (~126-146 px on Yassin's laptop) is partly systematic: at a given spot the gaze still lands off in the same
direction. This layer measures that leftover offset exactly where the buttons are, by showing a dot on every
button (twice), and subtracts it near each button.

    correction(p) = sum_b w_b(p) * offset_b / sum_b w_b(p),   w_b = exp(-|p - landing_b|^2 / (2 * reach^2))
    (landing_b = button centre + offset_b: where the gaze lands when the person looks at button b)

It can only remove the part of the error that repeats at the same place; the part that changes from one look to
the next stays. It is switched on only if it beats "no button layer" by at least 10 % on looks it did not learn from (look 1 is
checked with an offset learned from look 2, and the other way round).

Pure numpy, no camera: tested in tests/test_button_calibration.py.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


class ButtonCalibration:
    def __init__(self, reach_px: float = 150.0, max_corr_px: float = 300.0):
        self.reach, self.max_corr = reach_px, max_corr_px
        self.centres = None  # (n, 2) where the gaze lands when looking at each button, screen px
        self.offsets = None  # (n, 2) median (prediction - centre) there
        self.enabled = False
        self.report: dict = {}

    def _offsets(self, pred, dot, button, look, use_looks):
        cs, offs = [], []
        for b in np.unique(button):
            m = (button == b) & np.isin(look, use_looks)
            if m.sum() < 3:
                continue
            off = np.median(pred[m] - dot[m], axis=0)
            # keyed by where the gaze LANDS when looking at this button (centre + offset): that is the point the
            # live gaze is compared with. Keyed by the centre, a large offset weakened its own correction.
            cs.append(dot[m][0] + off)
            offs.append(off)
        return np.array(cs), np.array(offs)

    def _correct(self, p, centres, offsets):
        if centres is None or not len(centres):
            return p
        p = np.atleast_2d(p)
        d2 = ((p[:, None, :] - centres[None]) ** 2).sum(-1)
        w = np.exp(-d2 / (2 * self.reach ** 2))
        ws = w.sum(1, keepdims=True)
        corr = np.where(ws > 1e-6, (w @ offsets) / np.maximum(ws, 1e-12), 0.0)
        # far from every calibrated button: fade the correction out instead of extrapolating it
        fade = np.clip(ws, 0.0, 1.0)
        corr = np.clip(corr * fade, -self.max_corr, self.max_corr)
        return p - corr

    def fit(self, pred_px: np.ndarray, dot_px: np.ndarray, button_id: np.ndarray, look_id: np.ndarray) -> dict:
        """pred_px: gaze after the first layer (screen px); dot_px: the button centre shown; look_id: 0 or 1."""
        pred, dot = np.asarray(pred_px, float), np.asarray(dot_px, float)
        button, look = np.asarray(button_id), np.asarray(look_id)
        before, after = [], []
        for test_look in np.unique(look):
            train = [l for l in np.unique(look) if l != test_look]
            if not train:
                continue
            c, o = self._offsets(pred, dot, button, look, train)
            m = look == test_look
            # one value per look at a button: the median of its frames (what a dwell sees)
            for b in np.unique(button[m]):
                mb = m & (button == b)
                raw = np.median(pred[mb], axis=0)
                fixed = np.median(self._correct(pred[mb], c, o), axis=0)
                before.append(np.linalg.norm(raw - dot[mb][0]))
                after.append(np.linalg.norm(fixed - dot[mb][0]))
        self.centres, self.offsets = self._offsets(pred, dot, button, look, np.unique(look))
        b = float(np.mean(before)) if before else float("nan")
        a = float(np.mean(after)) if after else float("nan")
        # at least 10 % better: with 2 looks per button the check is noisy (pure noise passed 5 % by luck)
        self.enabled = bool(before) and a < 0.90 * b
        self.report = {"buttons": int(len(self.centres)), "frames": int(len(pred)),
                       "error_without_px": round(b, 1), "error_with_px": round(a, 1), "enabled": self.enabled,
                       "checked_on": "looks not used for fitting" if before else "nothing (needs 2 looks per button)"}
        return self.report

    def correct(self, xy_px: np.ndarray) -> np.ndarray:
        if not self.enabled:
            return np.asarray(xy_px, float)
        return self._correct(np.asarray(xy_px, float), self.centres, self.offsets)[0]

    def save(self, path: Path):
        Path(path).write_text(json.dumps({"centres": self.centres.tolist(), "offsets": self.offsets.tolist(),
                                          "reach": self.reach, "report": self.report}, indent=1))

    def load(self, path: Path) -> dict:
        d = json.loads(Path(path).read_text())
        self.centres, self.offsets = np.array(d["centres"]), np.array(d["offsets"])
        self.reach, self.report = d.get("reach", self.reach), d["report"]
        self.enabled = bool(self.report.get("enabled"))
        return self.report


# MediaPipe Face Mesh (478 points) -> the 68-point dlib layout Meridian's face panel draws
# (jaw 0-16, brows 17-26, nose 27-35, eyes 36-47, mouth 48-67).
MP_TO_DLIB68 = [
    162, 234, 93, 58, 172, 136, 149, 148, 152, 377, 378, 365, 397, 288, 323, 454, 389,  # jaw
    71, 63, 105, 66, 107,  # right brow
    336, 296, 334, 293, 301,  # left brow
    168, 197, 5, 4,  # nose bridge
    75, 97, 2, 326, 305,  # nose bottom
    33, 160, 158, 133, 153, 144,  # right eye
    362, 385, 387, 263, 373, 380,  # left eye
    61, 39, 37, 0, 267, 269, 291, 405, 314, 17, 84, 181,  # outer lips
    78, 82, 13, 312, 308, 317, 14, 87,  # inner lips
]


def dlib68_from_mediapipe(landmarks, width: int, height: int) -> list[list[float]]:
    """MediaPipe normalised landmarks -> 68 [x, y] points in camera pixels (dlib order)."""
    return [[round(landmarks[i].x * width, 1), round(landmarks[i].y * height, 1)] for i in MP_TO_DLIB68]
