"""Browser-camera gaze engine (gaze_server.py): sessions, calibration and origin checks, without a model."""
import sys
import types
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.argv.append("--simulate")  # gaze_server needs no training stack in simulation
import gaze_server as gs  # noqa: E402

sys.argv.remove("--simulate")


def make_session(w=1707, h=1067):
    args = types.SimpleNamespace(smoothing=3, save_cal=False)
    s = gs.Session(gs.Engine(simulate=True, cpu=True, model=None), args, sim_seed=1)
    s.set_viewport(w, h)
    return s


def feed(s, t, seconds, fps=20):
    out = []
    for k in range(int(seconds * fps)):
        out += s.frame(b"jpeg", t + k / fps)
    return out, t + seconds


def run_layer(s, layer, dots, t, per=1.0):
    s.calib({"action": "start", "layer": layer}, t)
    for d in dots:
        s.calib({"action": "dot", **d}, t)
        _, t = feed(s, t, per)
    res = s.calib({"action": "end"}, t)
    return res[0]["report"], t


def test_gaze_messages_are_in_page_pixels():
    s = make_session()
    out, _ = feed(s, 0.0, 1.0)
    g = [m for m in out if m["type"] == "gaze" and m["ok"]]
    assert g and all(0 <= m["x"] <= 1707 and 0 <= m["y"] <= 1067 for m in g)


def test_layer1_calibration_learns_and_layer2_runs():
    s = make_session()
    rng = np.random.default_rng(0)
    dots = [{"id": i, "x": float(x), "y": float(y)} for i, (x, y) in enumerate(rng.uniform([60, 60], [1640, 1000], (30, 2)))]
    rep, t = run_layer(s, "stabiliser", dots, 0.0)
    assert rep["enabled"] and rep["error_with_px"] < rep["error_without_px"]
    assert s.state()["calibration"]["stabiliser"] is True
    b = rng.uniform([100, 100], [1600, 960], (6, 2))
    d2 = [{"id": i, "look": look, "x": float(b[i, 0]), "y": float(b[i, 1])} for look in (0, 1) for i in range(6)]
    rep2, _ = run_layer(s, "buttons", d2, t)
    assert rep2["buttons"] == 6 and "error_with_px" in rep2


def test_too_few_dots_is_reported_not_crashing():
    s = make_session()
    rep, _ = run_layer(s, "stabiliser", [{"id": 0, "x": 100.0, "y": 100.0}], 0.0)
    assert rep["enabled"] is False and "dots" in rep["error"]


def test_resize_resets_calibration_and_cancel_drops_recording():
    s = make_session()
    rng = np.random.default_rng(1)
    dots = [{"id": i, "x": float(x), "y": float(y)} for i, (x, y) in enumerate(rng.uniform([60, 60], [1640, 1000], (25, 2)))]
    run_layer(s, "stabiliser", dots, 0.0)
    assert s.stab.enabled
    assert s.set_viewport(1280, 720) is True and not s.stab.enabled
    assert s.set_viewport(1281, 720) is False  # within 2 px: same page size
    s.calib({"action": "start", "layer": "stabiliser"}, 0.0)
    s.calib({"action": "cancel"}, 0.0)
    assert s.layer is None


def test_bad_viewport_and_unknown_layer():
    s = make_session()
    with pytest.raises(ValueError):
        s.set_viewport(0, 50)
    assert s.calib({"action": "start", "layer": "nonsense"}, 0.0) is None and s.layer is None


def test_origin_check():
    allowed = list(gs.DEFAULT_ORIGINS) + ["https://meridian.onrender.com"]
    assert gs.origin_allowed("http://localhost:5173", allowed, False)
    assert gs.origin_allowed("https://meridian.onrender.com", allowed, False)
    assert gs.origin_allowed("https://meridian.onrender.com/", allowed, False)
    assert not gs.origin_allowed("https://evil.example", allowed, False)
    assert not gs.origin_allowed("https://meridian.onrender.com.evil.example", allowed, False)
    assert gs.origin_allowed("https://evil.example", allowed, True)


def test_origin_lookalikes_are_refused():
    allowed = list(gs.DEFAULT_ORIGINS)
    assert gs.origin_allowed("http://127.0.0.1:8000", allowed, False)
    assert not gs.origin_allowed("http://localhost.evil.example", allowed, False)
    assert not gs.origin_allowed("http://localhost:5173.evil.example", allowed, False)
