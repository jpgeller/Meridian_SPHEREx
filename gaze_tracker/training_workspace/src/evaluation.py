"""Evaluation: prediction tables, metric reports and the one-time test gate.

The prediction table is the single source for every metric and figure:

    sample_id, participant_id, session_id, trial_id, target_index, frame_index,
    capture_time, target_x/y_norm, target_x/y_px, pred_x/y_norm, pred_x/y_px,
    resid_x/y_px, euclid_px, region, checkpoint_id, preprocessing_version, model_name

Test-set rule: nothing in this module reads test data except through
`open_test_gate` -> dataset.load_split(..., test_unseal_token) inside notebook 06.
"""
from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import pandas as pd

from .dataset import TEST_GATE_FILE
from .metrics import (grouped_metrics, hierarchical_bootstrap, regression_metrics, screen_region,
                      trial_average)
from .utils import now_iso, read_json, sha256_file, write_json

CONFIRMATION_PHRASE = "I confirm the model and all settings are final"


def prediction_table(manifest: pd.DataFrame, pred_norm: np.ndarray, width: int, height: int,
                     checkpoint_id: str, preprocessing_version: str, model_name: str) -> pd.DataFrame:
    if len(manifest) != len(pred_norm):
        raise ValueError("manifest and predictions are not aligned")
    pred_norm = np.asarray(pred_norm, dtype=np.float64)
    if not np.isfinite(pred_norm).all():
        raise ValueError("non-finite predictions")
    cols = ["sample_id", "participant_id", "session_id", "trial_id", "target_index", "frame_index",
            "capture_time", "target_x_norm", "target_y_norm", "target_x_px", "target_y_px"]
    df = manifest[cols].reset_index(drop=True).copy()
    df["pred_x_norm"], df["pred_y_norm"] = pred_norm[:, 0], pred_norm[:, 1]
    df["pred_x_px"], df["pred_y_px"] = pred_norm[:, 0] * width, pred_norm[:, 1] * height
    df["resid_x_px"] = df["pred_x_px"] - df["target_x_px"]
    df["resid_y_px"] = df["pred_y_px"] - df["target_y_px"]
    df["euclid_px"] = np.hypot(df["resid_x_px"], df["resid_y_px"])
    df["region"] = screen_region(df["target_x_norm"], df["target_y_norm"])
    df["checkpoint_id"] = checkpoint_id
    df["preprocessing_version"] = preprocessing_version
    df["model_name"] = model_name
    return df


def evaluate_predictions(pred_df: pd.DataFrame, cfg, bootstrap: bool = True) -> Dict:
    """Frame-level, trial-level, per-participant/session/region metrics + CIs."""
    W, H = cfg.screen_px
    ev = cfg["evaluation"]
    kw = dict(pixel_thresholds=ev["pixel_thresholds"],
              diag_fractions=ev["diagonal_fraction_thresholds"], monitor_mm=cfg.monitor_mm)
    P = pred_df[["pred_x_norm", "pred_y_norm"]].to_numpy()
    T = pred_df[["target_x_norm", "target_y_norm"]].to_numpy()
    out = {"frame_level": regression_metrics(P, T, W, H, **kw)}
    tr = trial_average(pred_df)
    out["trial_level"] = regression_metrics(tr[["pred_x_norm", "pred_y_norm"]].to_numpy(),
                                            tr[["target_x_norm", "target_y_norm"]].to_numpy(), W, H, **kw)
    out["per_participant"] = grouped_metrics(pred_df, ["participant_id"], W, H, **kw).to_dict("records")
    out["per_session"] = grouped_metrics(pred_df, ["participant_id", "session_id"], W, H, **kw
                                         ).to_dict("records")
    out["per_region"] = grouped_metrics(pred_df, ["region"], W, H, **kw).to_dict("records")
    out["participant_macro_mean_euclid_px"] = float(np.mean([r["mean_euclid_px"]
                                                             for r in out["per_participant"]]))
    radii = ev.get("interface_target_radii_px", [])
    out["target_selection_success"] = {
        f"radius_{r}px": float((pred_df["euclid_px"] <= r).mean()) for r in radii}
    out["target_selection_note"] = ("Share of frames whose prediction lands inside a circular "
                                    "target of that radius centred on the fixation target. This is "
                                    "a hit rate on positive fixations only; it is not precision/"
                                    "recall (no negative/idle trials exist in this dataset).")
    if bootstrap:
        out["bootstrap_mean_euclid"] = hierarchical_bootstrap(
            pred_df, W, H, iterations=int(ev["bootstrap_iterations"]),
            seed=int(cfg["reproducibility"]["seed"]))
        out["per_participant_bootstrap"] = {
            pid: hierarchical_bootstrap(g, W, H, iterations=int(ev["bootstrap_iterations"]),
                                        seed=int(cfg["reproducibility"]["seed"]))
            for pid, g in pred_df.groupby("participant_id")}
    out["limitations"] = (f"{pred_df['participant_id'].nunique()} participant(s); results describe "
                          "these people under this setup and do not estimate population-wide "
                          "accuracy. Errors are image-capture-label errors in screen pixels, "
                          "not angular gaze errors.")
    return out


def baseline_predictions(train_df: pd.DataFrame, n: int, kind: str) -> np.ndarray:
    """Naive predictors: 'center' (0.5, 0.5) or 'train_mean' (mean training target)."""
    if kind == "center":
        return np.full((n, 2), 0.5)
    if kind == "train_mean":
        return np.tile(train_df[["target_x_norm", "target_y_norm"]].mean().to_numpy(), (n, 1))
    raise ValueError(kind)


# --------------------------------------------------------------------------
# One-time test gate
# --------------------------------------------------------------------------
def open_test_gate(cfg, checkpoint_path: Path, confirmation: str, decision_record: Dict,
                   override_reason: Optional[str] = None) -> str:
    """Unlock the test split ONCE for a frozen checkpoint.

    Requires the exact confirmation phrase, an existing checkpoint and a
    decision record (which run, why it was chosen - written BEFORE seeing test
    data). Refuses if the test set was already evaluated, unless an override
    reason is given (that reason is recorded permanently)."""
    if confirmation.strip() != CONFIRMATION_PHRASE:
        raise PermissionError(f"Type exactly: {CONFIRMATION_PHRASE!r}")
    checkpoint_path = Path(checkpoint_path)
    if not checkpoint_path.is_file():
        raise FileNotFoundError(checkpoint_path)
    reports = cfg.paths.reports
    history_file = reports / "test_unsealed.json"
    history = read_json(history_file) if history_file.is_file() else {"evaluations": []}
    if history["evaluations"] and not override_reason:
        raise PermissionError(
            "The test set has already been evaluated "
            f"({history['evaluations'][-1]['time']}). Re-evaluating after seeing test results "
            "invalidates them as an unbiased estimate. Pass override_reason='...' only if you "
            "accept and will report that.")
    token = secrets.token_hex(16)
    write_json(reports / TEST_GATE_FILE, {"token": token, "opened": now_iso(),
                                          "checkpoint": str(checkpoint_path)})
    history["evaluations"].append({"time": now_iso(), "checkpoint": str(checkpoint_path),
                                   "checkpoint_sha256": sha256_file(checkpoint_path),
                                   "decision_record": decision_record,
                                   "override_reason": override_reason, "completed": False})
    write_json(history_file, history)
    return token


def close_test_gate(cfg, results_path: Path) -> None:
    reports = cfg.paths.reports
    gate = reports / TEST_GATE_FILE
    if gate.is_file():
        gate.unlink()
    history_file = reports / "test_unsealed.json"
    history = read_json(history_file)
    history["evaluations"][-1].update(completed=True, results=str(results_path), closed=now_iso())
    write_json(history_file, history)
