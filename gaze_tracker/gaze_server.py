"""Gaze engine for the deployed Meridian: browsers send their camera, this laptop runs the model.

    visitor's browser (Meridian /eye.html, camera permission)
        --JPEG frames over wss://-->  this server (your laptop, GPU)  --gaze points-->  back to that browser
                                      UniGaze + trained head, MediaPipe head features,
                                      that visitor's own calibration and smoothing

Nothing is stored: frames are decoded in memory, used once and dropped. Calibrations live only as long as the
visitor's connection (use --save-cal to keep them). Each connected browser has its own session (its own
calibration, smoother and head tracker); the model is shared.

    pip install -r requirements-server.txt               # once (adds the `websockets` package)
    python gaze_server.py                                # real camera frames from browsers, model on the GPU
    python gaze_server.py --allow-origin https://YOUR-APP.onrender.com
    python gaze_server.py --simulate                     # no model: fake gaze (tests the page and the tunnel)

Make it reachable from the internet for free with a Cloudflare quick tunnel (no account needed):

    cloudflared tunnel --url http://localhost:8766       # prints https://<random>.trycloudflare.com

then open   https://YOUR-APP.onrender.com/eye.html?engine=wss://<random>.trycloudflare.com
(or locally: http://localhost:5173/eye.html?engine=ws://localhost:8766). Details: BROWSER_CAMERA.md.

Protocol (one WebSocket per browser tab):
  browser -> server  text   {"type":"hello","viewport":{"w":..,"h":..}}         first message
                     binary  one JPEG camera frame (unmirrored); send the next one after the reply
                     text   {"type":"calib","action":"start","layer":"stabiliser"|"buttons"}
                            {"type":"calib","action":"dot","id":n,"look":k,"x":..,"y":..}   page px
                            {"type":"calib","action":"pause"|"resume"|"cancel"|"end"}
                     text   {"type":"viewport","w":..,"h":..}                    after a resize
  server -> browser  text   {"type":"ready", ...}  {"type":"gaze","x","y","confidence","ok"}
                            {"type":"face","landmarks":[[x,y] x68],"pose":{...}}  (about 10 per second)
                            {"type":"calib_result","layer","report"}  {"type":"state", ...}
                            {"type":"busy"} when --max-clients are already connected
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
WS_DIR = HERE / "training_workspace"
sys.path.insert(0, str(WS_DIR))
sys.path.insert(0, str(WS_DIR / "scripts"))
sys.path.insert(0, str(HERE))

if "--simulate" in sys.argv:  # the simulation needs no training stack (same trick as meridian_live.py)
    try:
        import pandas  # noqa: F401
    except ImportError:
        import types

        sys.modules["pandas"] = types.ModuleType("pandas")

from button_calibration import ButtonCalibration, dlib68_from_mediapipe  # noqa: E402
from live_navigation_demo import GazeSmoother, HeadStabiliser, STAB_SETTLE_S  # noqa: E402

FACE_EVERY_S = 0.1
DEFAULT_ORIGINS = ("http://localhost", "http://127.0.0.1", "https://localhost")
MAX_FRAME_BYTES = 2_000_000
MIN_LAYER1_DOTS = 20


# ----------------------------------------------------------------------------- the model (shared by all sessions)
class Engine:
    """Loads the gaze model once. predict() is serialised with a lock (one GPU, many sessions)."""

    def __init__(self, simulate: bool, cpu: bool, model: str | None):
        self.simulate = simulate
        self.lock = threading.Lock()
        self.device = "simulated"
        self.model_name = "simulated"
        self.predictor = None
        self.landmarker_path = None
        if simulate:
            return
        import torch
        from src.config import load_config
        from src.infer import GazePredictor
        from live_navigation_demo import ensure_face_landmarker

        cfg = load_config(WS_DIR / "training_config.yaml")
        exported = cfg.paths.checkpoints / "selected" / "gaze_model.pt"
        shipped = WS_DIR / "trained_model" / "gaze_head_stageA.pt"
        model_file = Path(model) if model else (exported if exported.is_file() else shipped)
        self.device = "cuda" if (torch.cuda.is_available() and not cpu) else "cpu"
        if model_file.stat().st_size < 20_000_000:
            print("loading the trained head + UniGaze (the first run downloads ~350 MB) ...")
            self.predictor = GazePredictor.from_head(model_file, cfg, cfg.paths.yunet_model, self.device)
        else:
            self.predictor = GazePredictor.from_export(model_file, cfg.paths.yunet_model, self.device)
        self.model_name = model_file.name
        self.landmarker_path = ensure_face_landmarker(WS_DIR / "models")
        if self.device == "cpu":
            print("NOTE: no CUDA GPU found - running on the CPU, expect a few frames per second per visitor")

    def predict(self, frame_bgr: np.ndarray, t: float) -> dict:
        with self.lock:
            return self.predictor.predict_frame(frame_bgr, t)


# ----------------------------------------------------------------------------- one browser tab
class Session:
    def __init__(self, engine: Engine, args, sim_seed: int = 0):
        self.engine, self.args = engine, args
        self.W = self.H = None
        self.stab = self.buttons = self.smoother = None
        self.head = None
        if not engine.simulate:
            from live_navigation_demo import HeadTracker
            self.head = HeadTracker(engine.landmarker_path)  # MediaPipe VIDEO mode: one per session
        # calibration recording
        self.layer = None
        self.dot = None
        self.paused = False
        self.X, self.P, self.D, self.ids, self.looks = [], [], [], [], []
        self.last_face = 0.0
        self.rng = np.random.default_rng(sim_seed)
        self.sim_look = np.zeros(2)
        self.sim_bias = self.rng.normal(0, 1, 4)

    # viewport (page CSS px) = the coordinate space of everything in this session
    def set_viewport(self, w: float, h: float):
        w, h = float(w), float(h)
        if not (100 <= w <= 20000 and 100 <= h <= 20000):
            raise ValueError("bad viewport")
        changed = self.W is not None and (abs(w - self.W) > 2 or abs(h - self.H) > 2)
        self.W, self.H = w, h
        diag = math.hypot(w, h)
        if self.stab is None or changed:
            # a calibration belongs to one page size: start again after a resize
            self.stab = HeadStabiliser(W=w, H=h)
            self.stab.max_corr = 0.2 * diag
            self.buttons = ButtonCalibration(reach_px=0.06 * diag, max_corr_px=0.12 * diag)
        self.smoother = GazeSmoother(w, h, level=self.args.smoothing - 1)
        return changed

    def state(self) -> dict:
        return {"type": "state", "calibration": {
            "stabiliser": bool(self.stab and self.stab.enabled), "buttons": bool(self.buttons and self.buttons.enabled),
            "stabiliser_report": (self.stab.report or None) if self.stab else None,
            "buttons_report": (self.buttons.report or None) if self.buttons else None}}

    # ---- calibration messages
    def calib(self, msg: dict, t: float):
        act = msg.get("action")
        if act == "start":
            self.layer, self.dot, self.paused = msg.get("layer"), None, False
            if self.layer not in ("stabiliser", "buttons"):
                self.layer = None
                return None
            self.X, self.P, self.D, self.ids, self.looks = [], [], [], [], []
        elif act == "dot" and self.layer:
            x, y = float(msg["x"]), float(msg["y"])
            if self.dot is None or (x, y) != tuple(self.dot["px"]):
                self.sim_look = self.rng.normal(0, 0.03 * math.hypot(self.W, self.H), 2)  # a new look (simulation)
            self.dot = {"id": int(msg["id"]), "look": int(msg.get("look", 0)), "px": (x, y), "t0": t}
        elif act in ("pause", "resume"):
            self.paused = act == "pause"
        elif act == "cancel":
            self.layer = self.dot = None
            return self.state()
        elif act == "end" and self.layer:
            layer, self.layer, self.dot = self.layer, None, None
            n_dots = len(set(self.ids))
            if layer == "stabiliser":
                if n_dots < MIN_LAYER1_DOTS:
                    rep = {"enabled": False, "error": f"only {n_dots} dots had a face: check the light and try again"}
                else:
                    rep = self.stab.fit(np.array(self.X), np.array(self.P), np.array(self.D), np.array(self.ids))
            else:
                if n_dots < 3:
                    rep = {"enabled": False, "error": "too few button looks recorded"}
                else:
                    rep = self.buttons.fit(np.array(self.P), np.array(self.D), np.array(self.ids), np.array(self.looks))
            if self.args.save_cal:
                stamp = time.strftime("%Y%m%d_%H%M%S")
                out = HERE / "training_workspace" / "results" / "browser_sessions"
                out.mkdir(parents=True, exist_ok=True)
                (self.stab if layer == "stabiliser" else self.buttons).save(out / f"{layer}_{stamp}.json")
            print(f"[session] calibration {layer}: {rep}")
            return [{"type": "calib_result", "layer": layer, "report": _jsonable(rep)}, self.state()]
        return None

    def _record(self, t, pred, feats):
        if self.layer is None or self.dot is None or self.paused or t - self.dot["t0"] < STAB_SETTLE_S:
            return
        if self.layer == "stabiliser" and feats is None:
            return
        self.X.append(None if feats is None else np.array(feats, float))
        self.P.append(np.asarray(pred, float))
        self.D.append(self.dot["px"])
        self.ids.append(self.dot["id"])
        self.looks.append(self.dot["look"])

    # ---- one camera frame -> replies
    def frame(self, jpeg: bytes, t: float) -> list[dict]:
        if self.W is None:
            return [{"type": "error", "error": "send hello with the viewport first"}]
        out = []
        if self.engine.simulate:
            raw, feats, ok = self._sim(t)
        else:
            import cv2
            img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                return [{"type": "gaze", "ok": False, "reason": "bad_frame", "x": 0, "y": 0, "confidence": 0}]
            r = self.engine.predict(img, t)
            self.head.update(img, t)
            feats = self.head.features
            ok = bool(r["ok"])
            raw = np.array([r["raw_x_norm"] * self.W, r["raw_y_norm"] * self.H]) if ok else None
            h_img, w_img = img.shape[:2]
            del img  # never kept
            lm = getattr(self.head, "landmarks", None)
            if lm is not None and t - self.last_face >= FACE_EVERY_S:
                self.last_face = t
                face = {"type": "face", "landmarks": dlib68_from_mediapipe(lm, w_img, h_img)}
                if self.head.state is not None:
                    face["pose"] = {"yaw": float(-self.head.state[0] * 60), "pitch": float(self.head.state[1] * 60)}
                out.append(face)
        if not ok:
            self.smoother.update(t, None)
            out.append({"type": "gaze", "ok": False, "x": 0, "y": 0, "confidence": 0})
            return out
        if self.layer == "stabiliser":
            self._record(t, raw, feats)
        p = self.stab.correct(raw, feats)
        if self.layer == "buttons":
            self._record(t, p, feats)
        p = self.buttons.correct(p)
        sm = self.smoother.update(t, np.clip(p / (self.W, self.H), 0.0, 1.0))
        if sm is None:
            out.append({"type": "gaze", "ok": False, "x": 0, "y": 0, "confidence": 0})
        else:
            out.append({"type": "gaze", "ok": True, "x": round(float(sm[0] * self.W), 1),
                        "y": round(float(sm[1] * self.H), 1), "confidence": 0.9})
        return out

    def _sim(self, t):
        """Fake model: looks at the calibration dot (or slowly circles), with a smooth position-dependent error,
        a head-pose effect and noise from look to look - enough to exercise both calibration layers."""
        if self.dot is not None:
            target = np.array(self.dot["px"], float)
        else:
            a = t * 0.4
            target = np.array([self.W / 2 + 0.3 * self.W * math.cos(a), self.H / 2 + 0.3 * self.H * math.sin(a)])
        head = np.array([0.05 * math.sin(t * 0.3), 0.04 * math.cos(t * 0.23), 0, 0.5, 0.45, 0.18, 0.5])
        b = self.sim_bias
        err = np.array([b[0] * 0.08 * self.W + b[1] * 0.1 * (target[0] - self.W / 2),
                        b[2] * 0.08 * self.H + b[3] * 0.1 * (target[1] - self.H / 2)])
        err += head[:2] * np.array([self.W, self.H]) * 0.6 + self.sim_look + self.rng.normal(0, 8, 2)
        return target + err, head, True


def _jsonable(o):
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.bool_):
        return bool(o)
    return o


# ----------------------------------------------------------------------------- server
def origin_allowed(origin: str | None, allowed: list[str], any_origin: bool) -> bool:
    if any_origin:
        return True
    if not origin:  # non-browser clients (tests, curl) send no Origin
        return True
    o = origin.rstrip("/")
    if re.fullmatch(r"(https?)://(localhost|127\.0\.0\.1)(:\d+)?", o):  # this machine, any port
        return True
    return any(o == a.rstrip("/") for a in allowed if a not in DEFAULT_ORIGINS)


async def serve(args, engine: Engine):
    import websockets

    allowed = list(DEFAULT_ORIGINS) + [a.rstrip("/") for a in args.allow_origin]
    active = {"n": 0}
    seed = {"n": 0}

    async def handler(ws):
        origin = None
        try:
            origin = ws.request.headers.get("Origin")
        except AttributeError:
            origin = getattr(ws, "request_headers", {}).get("Origin")
        if not origin_allowed(origin, allowed, args.allow_any_origin):
            print(f"[server] refused origin {origin} (add it with --allow-origin)")
            await ws.close(code=4003, reason="origin not allowed")
            return
        if active["n"] >= args.max_clients:
            await ws.send(json.dumps({"type": "busy", "max_clients": args.max_clients}))
            await ws.close(code=4008, reason="busy")
            return
        active["n"] += 1
        seed["n"] += 1
        loop = asyncio.get_running_loop()
        session = None
        print(f"[server] browser connected from {origin or 'no origin'} ({active['n']} open)")
        try:
            session = await loop.run_in_executor(None, Session, engine, args, seed["n"])
            await ws.send(json.dumps({"type": "ready", "model": engine.model_name, "device": engine.device,
                                      "simulate": engine.simulate, "max_clients": args.max_clients}))
            async for message in ws:
                t = time.time()
                if isinstance(message, (bytes, bytearray)):
                    if len(message) > MAX_FRAME_BYTES:
                        continue
                    replies = await loop.run_in_executor(None, session.frame, bytes(message), t)
                    for r in replies:
                        await ws.send(json.dumps(r, separators=(",", ":")))
                    continue
                try:
                    msg = json.loads(message)
                except ValueError:
                    continue
                kind = msg.get("type")
                if kind in ("hello", "viewport"):
                    v = msg.get("viewport", msg)
                    try:
                        changed = session.set_viewport(v["w"], v["h"])
                    except (KeyError, TypeError, ValueError):
                        await ws.send(json.dumps({"type": "error", "error": "bad viewport"}))
                        continue
                    if changed:
                        await ws.send(json.dumps({"type": "calibration_reset", "reason": "the page size changed"}))
                    await ws.send(json.dumps(session.state()))
                elif kind == "calib":
                    res = session.calib(msg, t)
                    for r in (res if isinstance(res, list) else [res] if res else []):
                        await ws.send(json.dumps(r))
        except websockets.ConnectionClosed:
            pass
        finally:
            active["n"] -= 1
            del session  # calibration and smoothing state of this visitor is dropped here
            print(f"[server] browser disconnected ({active['n']} open)")

    async with websockets.serve(handler, args.host, args.port, max_size=MAX_FRAME_BYTES, ping_interval=20,
                                ping_timeout=20, compression=None):
        print(f"[server] gaze engine on ws://{args.host}:{args.port}/  model={engine.model_name} device={engine.device}")
        print(f"[server] allowed page origins: {'any' if args.allow_any_origin else ', '.join(allowed)}")
        print(f"[server] public URL for free:  cloudflared tunnel --url http://localhost:{args.port}")
        await asyncio.Future()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1", help="127.0.0.1 = reachable only through the tunnel (default)")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="a page origin allowed to connect, e.g. https://meridian.onrender.com (repeatable)")
    ap.add_argument("--allow-any-origin", action="store_true", help="accept any page (not recommended)")
    ap.add_argument("--max-clients", type=int, default=3, help="browsers served at once (GPU budget)")
    ap.add_argument("--smoothing", type=int, default=3, help="1 (light) .. 5 (heavy)")
    ap.add_argument("--model", default=None)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--save-cal", action="store_true", help="keep visitors' calibration files (off by default)")
    ap.add_argument("--simulate", action="store_true", help="no model: fake gaze (tests the page and the tunnel)")
    a = ap.parse_args()
    try:
        import websockets  # noqa: F401
    except ImportError:
        raise SystemExit("Missing package: pip install -r requirements-server.txt")
    engine = Engine(a.simulate, a.cpu, a.model)
    try:
        asyncio.run(serve(a, engine))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
