"""Synthetic fixtures. No real facial images and no pretrained weights are
needed: a miniature dataset with the EXACT schema of the capture app
(annotations.jsonl, targets.json, session_metadata.json, quality_report.json,
event logs, raw/face/left_eye/right_eye PNGs) is generated in a temp folder."""
import hashlib
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SPLIT_OF = {**{f"P00{i}": "train" for i in range(1, 7)}, "P007": "validation",
            "P008": "validation", "P009": "test", "P010": "test"}
RAW_W, RAW_H = 160, 90
SCREEN = (2560, 1600)
TRIALS, FRAMES = 3, 10


def _write_png(path: Path, img: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    assert cv2.imwrite(str(path), img)


def make_dataset(root: Path, participants=None, sessions=("S01",), seed=0) -> Path:
    rng = np.random.default_rng(seed)
    participants = participants or list(SPLIT_OF)
    (root / "logs").mkdir(parents=True, exist_ok=True)
    for pid in participants:
        split = SPLIT_OF[pid]
        for sid in sessions:
            sdir = root / split / pid / sid
            targets, rows, events = [], [], []
            t = 1_000_000.0 + rng.uniform(0, 1000)
            events.append({"time": t, "event": "state", "from": "STABILIZING", "to": "CAPTURING"})
            for ti in range(TRIALS):
                x = int(rng.integers(100, SCREEN[0] - 100)); y = int(rng.integers(100, SCREEN[1] - 100))
                targets.append({"target_index": ti, "x_px": x, "y_px": y,
                                "x_norm": round(x / SCREEN[0], 6), "y_norm": round(y / SCREEN[1], 6)})
                onset = t + ti * 3.0
                for fi in range(FRAMES):
                    sid_ = f"{pid}_{sid}_T{ti:04d}_F{fi:02d}"
                    raw = rng.integers(0, 255, (RAW_H, RAW_W, 3), dtype=np.uint8)
                    face = rng.integers(60, 200, (224, 224, 3), dtype=np.uint8)
                    eye = rng.integers(60, 200, (112, 112, 3), dtype=np.uint8)
                    imgs = {k: f"{k}/{sid_}.png" for k in ("raw", "face", "left_eye", "right_eye")}
                    _write_png(sdir / imgs["raw"], raw)
                    _write_png(sdir / imgs["face"], face)
                    _write_png(sdir / imgs["left_eye"], eye)
                    _write_png(sdir / imgs["right_eye"], eye)
                    rows.append({
                        "sample_id": sid_, "participant_id": pid, "session_id": sid,
                        "mode": "official", "split": split, "target_index": ti, "frame_index": fi,
                        "target_x_px": x, "target_y_px": y, "target_x_norm": round(x / SCREEN[0], 6),
                        "target_y_norm": round(y / SCREEN[1], 6), "screen_width_px": SCREEN[0],
                        "screen_height_px": SCREEN[1], "target_onset_time": onset,
                        "capture_time": onset + 0.85 + 0.08 * fi, "state_at_capture": "CAPTURING",
                        "images": imgs, "raw_width": RAW_W, "raw_height": RAW_H,
                        "raw_pixel_sha256": hashlib.sha256(raw.tobytes()).hexdigest(),
                        "face_box": [40, 10, 60, 60], "left_eye_box": [80, 25, 15, 15],
                        "right_eye_box": [55, 25, 15, 15], "left_eye_center": [88.0, 32.0],
                        "right_eye_center": [62.0, 32.0], "detector": "synthetic",
                        "quality": {"face_score": 0.95, "sharpness": 120.0, "brightness": 110.0}})
            sdir.mkdir(parents=True, exist_ok=True)
            (sdir / "annotations.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
            (sdir / "targets.json").write_text(json.dumps({
                "screen_width_px": SCREEN[0], "screen_height_px": SCREEN[1], "count": TRIALS,
                "targets": targets}))
            (sdir / "session_metadata.json").write_text(json.dumps({
                "participant_id": pid, "session_id": sid, "split": split, "mode": "official",
                "monitor": {"width_px": SCREEN[0], "height_px": SCREEN[1]},
                "camera": {"width": RAW_W, "height": RAW_H}, "protocol": {"frames_per_target": FRAMES}}))
            (sdir / "quality_report.json").write_text(json.dumps({"status": "complete"}))
            (root / "logs" / f"official_{pid}_{sid}_events.jsonl").write_text(
                "".join(json.dumps(e) + "\n" for e in events))
    # a pilot session that must be ignored
    p = root / "pilot" / "PILOT01" / "S01"
    p.mkdir(parents=True, exist_ok=True)
    (p / "annotations.jsonl").write_text("")
    return root


def write_config(tmp: Path, dataset_root: Path) -> Path:
    raw = yaml.safe_load((ROOT / "training_config.yaml").read_text())
    raw["paths"]["dataset_root"] = str(dataset_root)
    raw["dataset"]["expected_raw_px"] = [RAW_W, RAW_H]
    raw["evaluation"]["bootstrap_iterations"] = 50
    ws = tmp / "ws"
    ws.mkdir(exist_ok=True)
    path = ws / "training_config.yaml"
    path.write_text(yaml.safe_dump(raw))
    return path


@pytest.fixture
def synth(tmp_path):
    from src.config import load_config
    ds = make_dataset(tmp_path / "NASA_EyeTracking_Dataset")
    cfg = load_config(write_config(tmp_path, ds))
    return cfg


def _tiny_vit_cls():
    from timm.models.vision_transformer import VisionTransformer

    class CLSViT(VisionTransformer):
        """Like UniGaze's subclass: forward_features returns the normed CLS token."""
        def forward_features(self, x):
            return super().forward_features(x)[:, 0]
    return CLSViT


class TinyViT(__import__("torch").nn.Module):
    """Stand-in with UniGaze's interface (vit.blocks, vit.norm,
    vit.forward_features -> CLS, gaze_fc). Used to test freezing, parameter
    groups and the training loop without the 86M-parameter model."""

    def __init__(self, img=32, dim=32, depth=4):
        import torch.nn as nn
        super().__init__()
        self.vit = _tiny_vit_cls()(img_size=img, patch_size=16, embed_dim=dim, depth=depth,
                                     num_heads=2, num_classes=0, global_pool="token")
        self.gaze_fc = nn.Linear(dim, 2)
