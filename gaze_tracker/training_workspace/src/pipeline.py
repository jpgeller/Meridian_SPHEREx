"""High-level steps shared by the notebooks and the command-line scripts, so
both run exactly the same code. Nothing runs at import time."""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd
import torch

from .config import Config
from .dataset import (FaceCropSource, GazeFrameDataset, NormalizedCacheSource,
                      ParticipantTrialBalancedSampler, collate, load_split)
from .preprocessing import build_normalized_cache, cache_paths
from .utils import worker_init_fn


# --------------------------------------------------------------------------
# Image sources per split
# --------------------------------------------------------------------------
def build_cache_for_split(cfg: Config, split: str, num_workers: Optional[int] = None,
                          limit: Optional[int] = None, test_token: Optional[str] = None) -> Dict:
    """GPU-free, CPU-heavy: normalise every face of a split into processed_cache/."""
    df = load_split(cfg, split, test_token)
    return build_normalized_cache(df, cfg.paths.dataset_root, cfg.paths.yunet_model,
                                  dict(cfg["preprocessing"]), cfg.paths.cache, split,
                                  num_workers=cfg["hardware"]["num_workers"] if num_workers is None
                                  else num_workers, limit=limit)


def split_source(cfg: Config, split: str, test_token: Optional[str] = None
                 ) -> Tuple[pd.DataFrame, object, Optional[pd.DataFrame]]:
    """(manifest, image_source, geometry_table) for a split and the configured input mode."""
    df = load_split(cfg, split, test_token)
    mode = cfg["preprocessing"]["input_mode"]
    if mode == "existing_face_crop":
        return df, FaceCropSource(cfg.paths.dataset_root, df["face_path"]), None
    p = cache_paths(cfg.paths.cache, cfg["preprocessing"]["version"], split)
    if not p["images"].is_file() or not p["geometry"].is_file():
        raise FileNotFoundError(f"Normalised cache for '{split}' not found in {p['dir']} - "
                                "build it in notebook 02 (or scripts/build_cache.py).")
    geo = pd.read_parquet(p["geometry"])
    if len(geo) != len(df) or "not_processed" in set(geo["norm_reason"]):
        raise RuntimeError(f"Cache for '{split}' is incomplete - rerun the cache build (it resumes).")
    return df, NormalizedCacheSource(p["images"], p["geometry"], df["sample_id"]), geo


def make_loader(dataset, cfg: Config, batch_size: int, sampler=None, shuffle: bool = False,
                device: str = "cuda"):
    hw = cfg["hardware"]
    nw = int(hw["num_workers"])
    return torch.utils.data.DataLoader(
        dataset, batch_size=batch_size, sampler=sampler, shuffle=shuffle and sampler is None,
        num_workers=nw, pin_memory=bool(hw["pin_memory"]) and device == "cuda",
        persistent_workers=bool(hw["persistent_workers"]) and nw > 0, collate_fn=collate,
        worker_init_fn=worker_init_fn if nw > 0 else None, drop_last=False)


def subset_frames_per_trial(df: pd.DataFrame, k: Optional[int], seed: int = 0) -> np.ndarray:
    """Positions of up to k frames per trial (deterministic) - used to make
    per-epoch validation cheaper. Final evaluation always uses every frame."""
    if not k:
        return np.arange(len(df))
    rng = np.random.default_rng(seed)
    keep = []
    for _, g in df.reset_index(drop=True).groupby("trial_id"):
        idx = g.index.to_numpy()
        keep.extend(sorted(rng.choice(idx, size=min(k, len(idx)), replace=False)))
    return np.array(sorted(keep))


# --------------------------------------------------------------------------
# Frozen features (Stage A, baselines)
# --------------------------------------------------------------------------
def features_path(cfg: Config, split: str, checkpoint_sha: str) -> Path:
    return cfg.paths.cache / cfg["preprocessing"]["version"] / \
        f"features_{split}_{cfg['preprocessing']['input_mode']}_{checkpoint_sha[:12]}.pt"


def extract_split_features(cfg: Config, unigaze, checkpoint_sha: str, split: str, device: str,
                           precision: str, batch_size: int = 128, test_token: Optional[str] = None,
                           overwrite: bool = False) -> Dict:
    """Frozen UniGaze CLS features + gaze angles for every row of a split.
    Cached on disk keyed by checkpoint hash and preprocessing version."""
    from .models import extract_features
    out = features_path(cfg, split, checkpoint_sha)
    df, src, geo = split_source(cfg, split, test_token)
    if out.is_file() and not overwrite:
        blob = torch.load(out, weights_only=False)
        if list(blob["sample_id"]) == list(df["sample_id"]):
            return blob
    ds = GazeFrameDataset(df, src, train=False)
    loader = make_loader(ds, cfg, batch_size, device=device)
    f = extract_features(unigaze, loader, device, precision)
    order = np.argsort(f["index"].numpy())
    blob = {"features": f["features"][order], "gaze_pitchyaw": f["gaze_pitchyaw"][order],
            "sample_id": list(df["sample_id"]), "usable": np.asarray(src.ok, bool),
            "checkpoint_sha": checkpoint_sha, "preprocessing": dict(cfg["preprocessing"])}
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(blob, out)
    return blob


def head_inputs(blob: Dict, use_gaze_angles: bool) -> torch.Tensor:
    from .models import head_input
    return head_input(blob["features"], blob["gaze_pitchyaw"], use_gaze_angles).float()


# --------------------------------------------------------------------------
# Stage B loaders
# --------------------------------------------------------------------------
def stage_b_loaders(cfg: Config, device: str):
    tr_df, tr_src, _ = split_source(cfg, "train")
    va_df, va_src, _ = split_source(cfg, "validation")
    sc = cfg["stage_b"]
    seed = int(cfg["reproducibility"]["seed"])
    train_ds = GazeFrameDataset(tr_df, tr_src, train=True, aug_cfg=cfg["augmentation"], seed=seed)
    sampler = ParticipantTrialBalancedSampler(tr_df, tr_src.ok,
                                              cfg["sampler"]["trials_per_participant_per_epoch"],
                                              cfg["sampler"]["frames_per_trial_per_epoch"], seed=seed)

    def train_loader_fn(epoch: int):
        sampler.set_epoch(epoch)
        idx = list(iter(sampler))
        return make_loader(torch.utils.data.Subset(train_ds, idx), cfg, int(sc["batch_size"]),
                           shuffle=False, device=device)

    keep = subset_frames_per_trial(va_df, sc.get("val_frames_per_trial"), seed)
    keep = keep[np.asarray(va_src.ok, bool)[keep]]
    val_ds = GazeFrameDataset(va_df, va_src, train=False)
    val_loader = make_loader(torch.utils.data.Subset(val_ds, keep), cfg, int(sc["batch_size"]) * 2,
                             device=device)
    return train_loader_fn, val_loader, va_df, keep


def predict_split(cfg: Config, model, split: str, device: str, precision: str,
                  test_token: Optional[str] = None, batch_size: int = 64):
    """Predictions for EVERY usable frame of a split (final evaluations)."""
    from .trainer import predict_loader
    df, src, geo = split_source(cfg, split, test_token)
    ok = np.asarray(src.ok, bool)
    ds = torch.utils.data.Subset(GazeFrameDataset(df, src, train=False), np.where(ok)[0])
    pred = predict_loader(model, make_loader(ds, cfg, batch_size, device=device), device, precision)
    # dataset items carry their ORIGINAL manifest position; sorting by it
    # realigns predictions with the usable manifest rows
    order = np.argsort(pred["index"])
    rows = np.where(ok)[0]
    return df.iloc[rows].reset_index(drop=True), pred["screen_xy"][order], \
        pred["gaze_pitchyaw"][order], {"tracking_failures": int((~ok).sum()), "frames": len(df)}
