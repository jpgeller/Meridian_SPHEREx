"""Layer 2 of the calibration (button_calibration.py): pure numpy, no camera."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from button_calibration import MP_TO_DLIB68, ButtonCalibration, dlib68_from_mediapipe  # noqa: E402


def _looks(rng, centres, bias, look_sd, frames=20, looks=2):
    P, D, B, L = [], [], [], []
    for look in range(looks):
        for b, c in enumerate(centres):
            look_err = rng.normal(0, look_sd, 2)
            for _ in range(frames):
                P.append(c + bias[b] + look_err + rng.normal(0, 10, 2))
                D.append(c), B.append(b), L.append(look)
    return np.array(P), np.array(D), np.array(B), np.array(L)


def test_a_fixed_offset_at_each_button_is_learned_and_removed():
    rng = np.random.default_rng(0)
    centres = rng.uniform([200, 200], [2300, 1400], (25, 2))
    bias = rng.normal(0, 90, (25, 2))  # systematic: the same at every look
    cal = ButtonCalibration(reach_px=120)
    rep = cal.fit(*_looks(rng, centres, bias, look_sd=15))
    assert rep["enabled"] and rep["error_with_px"] < 0.5 * rep["error_without_px"]
    # where the gaze lands for a button, the corrected gaze is close to its centre (neighbours blend in a little)
    misses = [np.linalg.norm(cal.correct(centres[b] + bias[b]) - centres[b]) for b in range(25)]
    assert np.median(misses) < 0.4 * np.median(np.linalg.norm(bias, axis=1))


def test_purely_random_error_is_not_helped_and_the_layer_stays_off():
    for seed in range(8):
        _random_case(seed)


def _random_case(seed):
    rng = np.random.default_rng(seed)
    centres = rng.uniform([200, 200], [2300, 1400], (25, 2))
    cal = ButtonCalibration(reach_px=120)
    rep = cal.fit(*_looks(rng, centres, np.zeros((25, 2)), look_sd=100))
    assert not rep["enabled"]
    p = np.array([500.0, 500.0])
    assert np.allclose(cal.correct(p), p)


def test_far_from_every_button_nothing_is_moved():
    rng = np.random.default_rng(2)
    centres = np.array([[300.0, 300.0], [600.0, 300.0], [450.0, 600.0]])
    cal = ButtonCalibration(reach_px=100)
    cal.fit(*_looks(rng, centres, np.full((3, 2), 80.0), look_sd=5))
    far = np.array([2400.0, 1500.0])
    assert np.linalg.norm(cal.correct(far) - far) < 1


def test_mediapipe_to_68_points():
    assert len(MP_TO_DLIB68) == 68 and max(MP_TO_DLIB68) < 478

    class P:
        def __init__(self, i):
            self.x, self.y = i / 1000, i / 2000

    pts = dlib68_from_mediapipe([P(i) for i in range(478)], 1280, 720)
    assert len(pts) == 68 and pts[36] == [round(33 / 1000 * 1280, 1), round(33 / 2000 * 720, 1)]
