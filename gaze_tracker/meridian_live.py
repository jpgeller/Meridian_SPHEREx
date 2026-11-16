"""Meridian live eye tracking: Yassin's gaze model driving the Meridian page.

    webcam -> UniGaze + trained head (GazePredictor)            the model
           -> personal calibration, layer 1 (HeadStabiliser)     100 dots: gaze + head pose + light
           -> personal calibration, layer 2 (ButtonCalibration)  dots on Meridian's own buttons
           -> median-of-5 + One Euro + blink hold (GazeSmoother)
           -> [optional] gaze + head steering (HybridCursor, --head)
           -> Meridian page over a local WebSocket (meridian_bridge.py), which dwells, snaps and presses
    + the real face mesh (MediaPipe 478 points -> the 68 the face panel draws)

The grid demo (scripts/live_navigation_demo.py) is not used: the page is the interface. Calibration is driven
by the page: when it connects it asks "calibrate for much higher precision, or use it as it is?"; if calibrating,
it shows the dots itself (full screen) and tells this program which dot is showing; this program records the
model's predictions and fits the layers.

    python meridian_live.py                       # camera + model (Yassin's laptop: Windows, NVIDIA GPU)
    python meridian_live.py --head                # + head steering (90 % hits on a 6x6 grid vs 25 % without)
    python meridian_live.py --load-cal FILE       # reuse a saved layer-1 calibration (same person, same set-up)
    python meridian_live.py --simulate            # no camera, no model: simulated gaze + face (tests the UI)

then open, full screen (F11):   http://localhost:5173/?gaze_ws=8765
"""
from __future__ import annotations

import argparse
import json
import math
import queue
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
WS = HERE / "training_workspace"
sys.path.insert(0, str(WS))
sys.path.insert(0, str(WS / "scripts"))
sys.path.insert(0, str(HERE))

if "--simulate" in sys.argv:
    # The live filters (One Euro, tracking guard) need only numpy; src/smoothing.py also imports pandas for its
    # offline analysis functions. Let a machine without the training stack run the simulation.
    try:
        import pandas  # noqa: F401
    except ImportError:
        import types

        sys.modules["pandas"] = types.ModuleType("pandas")

from button_calibration import ButtonCalibration, dlib68_from_mediapipe  # noqa: E402
from meridian_bridge import MeridianBridge  # noqa: E402
from live_navigation_demo import (  # noqa: E402
    GazeSmoother, HeadStabiliser, HybridCursor, STAB_SETTLE_S,
)

FACE_HZ = 15.0


class Calibrator:
    """Collects (prediction, head features, dot) while the page shows calibration dots."""

    def __init__(self):
        self.layer = None  # 'stabiliser' | 'buttons'
        self.dot = None  # {'id', 'look', 'px': (x, y), 't0'}
        self.paused = False
        self.reset()

    def reset(self):
        self.X, self.P, self.D, self.ids, self.looks = [], [], [], [], []

    def record(self, t, pred_px, feats):
        if self.layer is None or self.dot is None or self.paused or t - self.dot["t0"] < STAB_SETTLE_S:
            return
        if self.layer == "stabiliser" and feats is None:
            return
        self.X.append(None if feats is None else feats.copy())
        self.P.append(np.asarray(pred_px, float))
        self.D.append(self.dot["px"])
        self.ids.append(self.dot["id"])
        self.looks.append(self.dot.get("look", 0))


# ----------------------------------------------------------------------------- simulation (no camera, no model)
class SimTracker:
    """Fake model + face for testing the page: the 'eye' looks at the dot being shown (or wanders over the
    page's buttons), the 'model' adds a large smooth error that depends on position and head pose (what
    layer 1 learns), a smaller fixed error near each spot (what layer 2 learns) and noise from look to look."""

    def __init__(self, W, H, bridge, seed=3):
        self.W, self.H, self.bridge = W, H, bridge
        self.rng = np.random.default_rng(seed)
        c = self.rng.uniform([0, 0], [W, H], (30, 2))
        w1 = self.rng.normal(0, 1, (30, 2))
        w2 = self.rng.normal(0, 1, (60, 2))
        c2 = self.rng.uniform([0, 0], [W, H], (60, 2))
        self.big = lambda p: np.exp(-((p[None] - c) ** 2).sum(-1) / (2 * 700.0 ** 2)) @ w1 * 220.0
        self.local = lambda p: np.exp(-((p[None] - c2) ** 2).sum(-1) / (2 * 180.0 ** 2)) @ w2 * 45.0
        self.head = np.zeros(7)
        self.look_noise = np.zeros(2)
        self.look_target = None
        self.next_wander = 0.0
        self.calib_dot = None
        frames = json.loads((HERE.parent / "web/tests-e2e/fixtures/face-sample.json").read_text())["frames"]
        self.faces = frames

    def gaze(self, t):
        if self.calib_dot is not None:
            target = np.array(self.calib_dot, float)
        else:
            if t >= self.next_wander or self.look_target is None:
                items = [b for b in self.bridge.targets if b.get("kind") == "button"]
                if items:
                    b = items[self.rng.integers(len(items))]
                    self.look_target = np.array(self.bridge.viewport_to_screen(b["x"] + b["w"] / 2, b["y"] + b["h"] / 2))
                else:
                    self.look_target = np.array([self.W / 2, self.H / 2])
                self.look_noise = self.rng.normal(0, 70, 2)
                self.next_wander = t + 2.5
            target = self.look_target
        # head drifts slowly; it shifts the prediction (layer 1 learns this from the features)
        self.head = 0.98 * self.head + self.rng.normal(0, 0.01, 7)
        feats = np.array([self.head[0], self.head[1], self.head[2] * 0.2, 0.5 + self.head[3] * 0.1,
                          0.45 + self.head[4] * 0.1, 0.18 + self.head[5] * 0.02, 0.5 + self.head[6] * 0.1])
        err = self.big(target) + self.local(target) + feats[:2] * 900 + self.look_noise + self.rng.normal(0, 25, 2)
        return {"ok": True, "raw_px": target + err}, feats

    def set_calib_dot(self, px):
        if px is not None and (self.calib_dot is None or px != self.calib_dot):
            self.look_noise = self.rng.normal(0, 70, 2)  # a new look
        self.calib_dot = px

    def face(self, t):
        f = self.faces[int(t * 15) % len(self.faces)]
        return {"type": "face", **f}


# ----------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--screen", default=None, help="physical screen px, e.g. 2560x1600 (default: training_config)")
    ap.add_argument("--model", default=None)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--head", action="store_true", help="gaze + head steering")
    ap.add_argument("--smoothing", type=int, default=3, help="1 (light) .. 5 (heavy)")
    ap.add_argument("--load-cal", default=None, help="saved layer-1 calibration JSON")
    ap.add_argument("--load-buttons", default=None, help="saved layer-2 (buttons) calibration JSON")
    ap.add_argument("--simulate", action="store_true", help="no camera / model: simulated gaze and face")
    a = ap.parse_args()

    if a.screen:
        W, H = (int(v) for v in a.screen.lower().split("x"))
    else:
        from src.config import load_config
        W, H = load_config(WS / "training_config.yaml").screen_px
    out_dir = WS / "results" / "live_demo"
    if a.simulate:  # simulated calibrations are not a person's: keep them out of the results folder
        import tempfile

        out_dir = Path(tempfile.gettempdir()) / "meridian_live_simulated"
    out_dir.mkdir(parents=True, exist_ok=True)

    bridge = MeridianBridge(port=a.port, screen_w=W, screen_h=H).start()
    stab = HeadStabiliser(W=W, H=H)
    buttons = ButtonCalibration(reach_px=0.06 * math.hypot(W, H))  # ~180 px on 2560 x 1600
    if a.load_cal:
        print("layer 1 loaded:", stab.load(Path(a.load_cal)))
    if a.load_buttons:
        print("layer 2 loaded:", buttons.load(Path(a.load_buttons)))
    smoother = GazeSmoother(W, H, level=a.smoothing - 1)
    hybrid = HybridCursor(W, H) if a.head else None
    cal = Calibrator()
    inbox: queue.Queue = queue.Queue()
    bridge.listeners.append(inbox.put)

    def state_msg():
        return {"type": "tracker", "simulate": a.simulate, "head": bool(a.head), "screen": [W, H],
                "calibration": {"stabiliser": bool(stab.enabled), "buttons": bool(buttons.enabled),
                                "stabiliser_report": stab.report or None, "buttons_report": buttons.report or None}}

    bridge.on_connect.append(lambda: bridge.send(state_msg()))

    sim = SimTracker(W, H, bridge) if a.simulate else None
    predictor = cam = head_tracker = None
    if not a.simulate:
        import torch
        from src.config import load_config
        from src.infer import GazePredictor
        from live_navigation_demo import HeadTracker, LatestFrameCamera, ensure_face_landmarker
        cfg = load_config(WS / "training_config.yaml")
        exported = cfg.paths.checkpoints / "selected" / "gaze_model.pt"
        shipped = WS / "trained_model" / "gaze_head_stageA.pt"
        model_file = Path(a.model) if a.model else (exported if exported.is_file() else shipped)
        dev = "cuda" if (torch.cuda.is_available() and not a.cpu) else "cpu"
        if model_file.stat().st_size < 20_000_000:
            print("loading the trained head + UniGaze (the first run downloads ~350 MB) ...")
            predictor = GazePredictor.from_head(model_file, cfg, cfg.paths.yunet_model, dev)
        else:
            predictor = GazePredictor.from_export(model_file, cfg.paths.yunet_model, dev)
        head_tracker = HeadTracker(ensure_face_landmarker(WS / "models"))
        cam = LatestFrameCamera(a.camera, 1280, 720)
        print(f"model {model_file.name} on {dev}; camera {cam.size()}")

    def handle(msg, t):
        if msg.get("type") != "calib":
            return
        act = msg.get("action")
        if act == "start":
            cal.layer, cal.dot, cal.paused = msg.get("layer"), None, False
            cal.reset()
            print(f"[calibration] {cal.layer}: started")
        elif act == "dot" and cal.layer:
            px = bridge.viewport_to_screen(float(msg["x"]), float(msg["y"]))
            cal.dot = {"id": int(msg["id"]), "look": int(msg.get("look", 0)), "px": px, "t0": t}
            if sim:
                sim.set_calib_dot(px)
        elif act in ("pause", "resume"):
            cal.paused = act == "pause"
        elif act == "cancel":
            cal.layer, cal.dot = None, None
            if sim:
                sim.set_calib_dot(None)
            bridge.send(state_msg())
        elif act == "end" and cal.layer:
            layer, cal.layer, cal.dot = cal.layer, None, None
            if sim:
                sim.set_calib_dot(None)
            stamp = time.strftime("%Y%m%d_%H%M%S")
            n_dots = len(set(cal.ids))
            if layer == "stabiliser":
                if n_dots < 20:
                    rep = {"enabled": False, "error": f"only {n_dots} dots had a face: check the light and try again"}
                else:
                    rep = stab.fit(np.array(cal.X), np.array(cal.P), np.array(cal.D), np.array(cal.ids))
                    stab.save(out_dir / f"calibration_{stamp}.json")
            else:
                if n_dots < 3:
                    rep = {"enabled": False, "error": "too few button looks recorded"}
                else:
                    rep = buttons.fit(np.array(cal.P), np.array(cal.D), np.array(cal.ids), np.array(cal.looks))
                    buttons.save(out_dir / f"buttons_{stamp}.json")
            print(f"[calibration] {layer}: {rep}")
            bridge.send({"type": "calib_result", "layer": layer, "report": rep})
            bridge.send(state_msg())

    last_face = 0.0
    last_frame_t = 0.0
    print(f"open http://localhost:5173/?gaze_ws={a.port} full screen; Ctrl+C to stop")
    try:
        while True:
            t = time.time()
            while not inbox.empty():
                handle(inbox.get_nowait(), t)
            if sim:
                time.sleep(1 / 30)
                r, feats = sim.gaze(t)
                ft, ok = t, True
                raw_px = r["raw_px"]
                if t - last_face >= 1 / FACE_HZ:
                    last_face = t
                    bridge.send(sim.face(t))
            else:
                frame, ft = cam.read()
                if frame is None or ft == last_frame_t:
                    time.sleep(0.002)
                    continue
                last_frame_t = ft
                r = predictor.predict_frame(frame, ft)
                hv = head_tracker.update(frame, ft)
                feats = head_tracker.features
                ok = bool(r["ok"])
                raw_px = np.array([r["raw_x_norm"] * W, r["raw_y_norm"] * H]) if ok else None
                if head_tracker.landmarks is not None and ft - last_face >= 1 / FACE_HZ:
                    last_face = ft
                    h_img, w_img = frame.shape[:2]
                    pose = None
                    if head_tracker.state is not None:
                        pose = {"yaw": float(-head_tracker.state[0] * 60), "pitch": float(head_tracker.state[1] * 60)}
                    bridge.send_face(dlib68_from_mediapipe(head_tracker.landmarks, w_img, h_img),
                                     **({"pose": pose} if pose else {}))
            if not ok:
                sm = smoother.update(ft, None)
            else:
                # layer 1 learns from the raw model output; layer 2 from what layer 1 gives
                if cal.layer == "stabiliser":
                    cal.record(ft, raw_px, feats)
                p = stab.correct(raw_px, feats)
                if cal.layer == "buttons":
                    cal.record(ft, p, feats)
                p = buttons.correct(p)
                sm = smoother.update(ft, np.clip(p / (W, H), 0.0, 1.0))
            if hybrid is not None and not sim:
                cur = hybrid.update(ft, None if sm is None else sm * (W, H), hv)
                sm = None if cur is None else cur / (W, H)
            if sm is None:
                bridge.send_gaze(None, None, 0)
            else:
                bridge.send_gaze(sm[0] * W, sm[1] * H, 0.9)
    except KeyboardInterrupt:
        pass
    finally:
        if cam is not None:
            cam.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
