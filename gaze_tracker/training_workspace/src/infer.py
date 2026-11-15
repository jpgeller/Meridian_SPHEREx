"""Deployment: export a selected checkpoint and predict screen coordinates
from live webcam frames.

The live path calls the SAME preprocessing functions as training
(preprocessing.YuNetLandmarker + normalize_face + ImageNet normalisation), so
there is no second, drifting implementation.

    predictor = GazePredictor.from_export("checkpoints/final/gaze_model.pt",
                                          yunet_path=cfg.paths.yunet_model, device="cuda")
    out = predictor.predict_frame(frame_bgr, timestamp)
    # out = {"ok": True, "x_px": ..., "y_px": ..., "x_norm": ..., ...} or {"ok": False, "reason": ...}
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import torch

from .preprocessing import YuNetLandmarker, normalize_face, to_model_tensor
from .utils import now_iso, sha256_file


def export_model(model, cfg, out_path: Path, selection: Dict, unigaze_info: Dict) -> Path:
    """Save backbone + head + preprocessing settings in one file.
    The file contains UniGaze-derived weights (ModelGo MG-NC-RAI-2.0)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "format": "nasa-gaze-screen-regressor/1",
        "exported": now_iso(),
        "model_state": model.state_dict(),
        "head_config": dict(cfg["model"]["head"]),
        "embed_dim": cfg["model"]["embed_dim"],
        "preprocessing": dict(cfg["preprocessing"]),
        "screen_px": list(cfg.screen_px),
        "selection": selection,
        "unigaze_checkpoint": unigaze_info,
        "license": "UniGaze-derived weights: ModelGo MG-NC-RAI-2.0 (non-commercial).",
    }, out_path)
    return out_path


def load_exported(path: Path, device: str = "cuda"):
    from unigaze.models.mae_gaze import MAE_Gaze
    from .models import CoordinateHead, UniGazeScreenRegressor
    blob = torch.load(path, map_location="cpu", weights_only=False)
    h = blob["head_config"]
    use = bool(h.get("use_gaze_angles", True))
    head = CoordinateHead(int(blob["embed_dim"]) + (2 if use else 0), h.get("type", "mlp"),
                          int(h.get("hidden_dim", 256)), float(h.get("dropout", 0.0)))
    model = UniGazeScreenRegressor(MAE_Gaze(model_type="vit_b_16"), head, use)
    model.load_state_dict(blob["model_state"], strict=True)
    model.eval().to(device)
    return model, blob


def load_from_head(head_path: Path, cfg, device: str = "cuda", allow_download: bool = True):
    """Rebuild the deployed model from the small head file shipped in the repository
    (trained_model/gaze_head_stageA.pt, ~0.8 MB) plus the public UniGaze checkpoint.

    The UniGaze checkpoint (~350 MB) is downloaded once from Hugging Face into
    checkpoints/hf_cache and its SHA-256 is checked against the one used in training,
    so the rebuilt model is bit-identical to the model that was evaluated."""
    from .models import build_regressor, load_unigaze
    blob = torch.load(Path(head_path), map_location="cpu", weights_only=True)
    if blob.get("format") != "nasa-gaze-head/1":
        raise ValueError(f"{head_path} is not a gaze head file")
    unigaze, info = load_unigaze(cfg, allow_download=allow_download)
    want = blob["unigaze_checkpoint"]["sha256"]
    if info["sha256"] != want:
        raise RuntimeError(f"UniGaze checkpoint SHA-256 {info['sha256']} does not match the one used in "
                           f"training ({want}). Delete checkpoints/hf_cache and run again.")
    model = build_regressor(unigaze, cfg)
    model.head.load_state_dict(blob["head_state"], strict=True)
    model.eval().to(device)
    return model, blob


class GazePredictor:
    def __init__(self, model, blob: Dict, yunet_path: Path, device: str = "cuda",
                 calibration=None, use_fp16: bool = True):
        self.model, self.blob, self.device = model, blob, device
        self.prep = blob["preprocessing"]
        if self.prep.get("input_mode") != "unigaze_normalized":
            raise ValueError("Live inference is implemented for the unigaze_normalized input mode")
        self.det = YuNetLandmarker(Path(yunet_path))
        self.W, self.H = blob["screen_px"]
        self.calibration = calibration
        self.dtype = torch.float16 if (use_fp16 and device == "cuda") else None

    @classmethod
    def from_export(cls, path: Path, yunet_path: Path, device: str = "cuda", calibration=None):
        model, blob = load_exported(path, device)
        return cls(model, blob, yunet_path, device, calibration)

    @classmethod
    def from_head(cls, head_path: Path, cfg, yunet_path: Path, device: str = "cuda", calibration=None):
        model, blob = load_from_head(head_path, cfg, device)
        return cls(model, blob, yunet_path, device, calibration)

    @torch.no_grad()
    def predict_frame(self, frame_bgr: np.ndarray, timestamp: Optional[float] = None) -> Dict:
        t0 = time.perf_counter()
        lm = self.det.detect(frame_bgr)
        if lm is None:
            return {"ok": False, "reason": "no_face", "timestamp": timestamp}
        nf = normalize_face(frame_bgr, lm, self.prep)
        if not nf.ok:
            return {"ok": False, "reason": nf.reason, "timestamp": timestamp}
        t1 = time.perf_counter()
        x = to_model_tensor(nf.image_rgb).to(self.device)
        with torch.autocast(device_type="cuda" if self.device == "cuda" else "cpu",
                            dtype=self.dtype, enabled=self.dtype is not None):
            out = self.model(x)
        xy = out["screen_xy"].float().cpu().numpy()[0]
        if self.device == "cuda":
            torch.cuda.synchronize()
        t2 = time.perf_counter()
        if self.calibration is not None:
            xy = self.calibration.apply(xy[None])[0]
        xy_clamped = np.clip(xy, 0.0, 1.0)            # clamp ONLY here, never in training
        return {"ok": True, "x_norm": float(xy_clamped[0]), "y_norm": float(xy_clamped[1]),
                "x_px": float(xy_clamped[0] * (self.W - 1)), "y_px": float(xy_clamped[1] * (self.H - 1)),
                "raw_x_norm": float(xy[0]), "raw_y_norm": float(xy[1]),
                "off_screen": bool((xy < 0).any() or (xy > 1).any()),
                "landmark_score": nf.extras["landmark_score"], "timestamp": timestamp,
                "preprocess_ms": (t1 - t0) * 1e3, "model_ms": (t2 - t1) * 1e3}
