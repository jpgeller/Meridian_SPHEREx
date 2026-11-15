"""Personalised screen calibration.

A short per-user calibration corrects the person-specific offsets (eye shape,
kappa angle, seating) that a model trained on six people cannot know.

Protocol used for evaluation (no frame is used for both fitting and scoring):
  * calibration points come ONLY from session `calibration.calibration_session`
    (default S01) of that participant: for a k-point layout we take, for each
    canonical layout point, the S01 trial whose target is nearest to it;
  * scoring uses ONLY that participant's OTHER sessions (S02-S05);
  * the uncalibrated model is scored on exactly the same frames, so the
    improvement is a paired comparison.

The live application uses the same `PersonalCalibration` class: show the k
points, record model predictions while the user fixates, call fit(), then
apply() every prediction.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .metrics import regression_metrics
from .utils import read_json, write_json


def canonical_layout(k: int, margin: float = 0.1) -> np.ndarray:
    """Normalised calibration-point layouts used by common eye trackers."""
    lo, hi = margin, 1 - margin
    if k == 5:
        return np.array([[0.5, 0.5], [lo, lo], [hi, lo], [lo, hi], [hi, hi]])
    side = {9: 3, 16: 4, 25: 5}.get(k)
    if side is None:
        raise ValueError("k must be 5, 9, 16 or 25")
    g = np.linspace(lo, hi, side)
    return np.array([[x, y] for y in g for x in g])


def _design(p: np.ndarray, method: str) -> np.ndarray:
    x, y = p[:, 0], p[:, 1]
    cols = [np.ones_like(x), x, y]
    if method == "ridge_poly2":
        cols += [x * y, x ** 2, y ** 2]
    elif method != "ridge_affine":
        raise ValueError(method)
    return np.stack(cols, axis=1)


@dataclass
class PersonalCalibration:
    """Ridge-regularised affine (or quadratic) map: model prediction -> screen.

    The ridge penalty shrinks toward the IDENTITY map (not toward zero), so
    with few points the calibration stays close to the uncalibrated model."""
    method: str = "ridge_affine"
    alpha: float = 1.0
    coef: Optional[np.ndarray] = None
    n_points: int = 0
    info: Dict = field(default_factory=dict)

    def fit(self, pred_norm: np.ndarray, target_norm: np.ndarray) -> "PersonalCalibration":
        P, T = np.asarray(pred_norm, float), np.asarray(target_norm, float)
        if len(P) < 3:
            raise ValueError("need at least 3 calibration observations")
        X = _design(P, self.method)
        prior = np.zeros((X.shape[1], 2))
        prior[1, 0] = prior[2, 1] = 1.0            # identity: x' = x, y' = y
        reg = self.alpha * np.eye(X.shape[1])
        reg[0, 0] = 0.0                            # do not penalise the offset
        A = X.T @ X + reg
        self.coef = np.linalg.solve(A, X.T @ T + reg @ prior)
        self.n_points = len(P)
        return self

    def apply(self, pred_norm: np.ndarray) -> np.ndarray:
        if self.coef is None:
            raise RuntimeError("calibration not fitted")
        return _design(np.atleast_2d(pred_norm), self.method) @ self.coef

    def save(self, path) -> None:
        write_json(path, {"method": self.method, "alpha": self.alpha, "coef": self.coef,
                          "n_points": self.n_points, "info": self.info})

    @classmethod
    def load(cls, path) -> "PersonalCalibration":
        d = read_json(path)
        return cls(d["method"], d["alpha"], np.asarray(d["coef"]), d["n_points"], d.get("info", {}))


def select_calibration_trials(session_df: pd.DataFrame, k: int) -> List[str]:
    """For each layout point, the nearest distinct trial in this session."""
    trials = session_df.drop_duplicates("trial_id")
    pos = trials[["target_x_norm", "target_y_norm"]].to_numpy()
    ids = trials["trial_id"].to_numpy()
    chosen: List[str] = []
    for pt in canonical_layout(k):
        order = np.argsort(np.linalg.norm(pos - pt, axis=1))
        for j in order:
            if ids[j] not in chosen:
                chosen.append(ids[j])
                break
    return chosen


def evaluate_calibration(pred_df: pd.DataFrame, cfg, point_counts: Sequence[int] = (5, 9, 16),
                         method: Optional[str] = None, alpha: Optional[float] = None) -> pd.DataFrame:
    """Per participant and k: uncalibrated vs calibrated error on held-out sessions."""
    ccfg = cfg["calibration"]
    method = method or ccfg["method"]
    alpha = float(alpha if alpha is not None else ccfg["ridge_alpha"])
    calib_session = ccfg["calibration_session"]
    W, H = cfg.screen_px
    rows = []
    for pid, g in pred_df.groupby("participant_id"):
        cal_pool = g[g["session_id"] == calib_session]
        test = g[g["session_id"] != calib_session]
        if cal_pool.empty or test.empty:
            continue
        Pt = test[["pred_x_norm", "pred_y_norm"]].to_numpy()
        Tt = test[["target_x_norm", "target_y_norm"]].to_numpy()
        base = regression_metrics(Pt, Tt, W, H)
        rows.append({"participant_id": pid, "k_points": 0, "method": "none",
                     "eval_frames": len(test), "mean_euclid_px": base["mean_euclid_px"],
                     "median_euclid_px": base["median_euclid_px"],
                     "within_100px": base["within_100px"]})
        for k in point_counts:
            tids = select_calibration_trials(cal_pool, k)
            cal = cal_pool[cal_pool["trial_id"].isin(tids)]
            assert set(cal["sample_id"]).isdisjoint(test["sample_id"])
            model = PersonalCalibration(method if not (method == "ridge_poly2" and k < 9)
                                        else "ridge_affine", alpha)
            model.fit(cal[["pred_x_norm", "pred_y_norm"]].to_numpy(),
                      cal[["target_x_norm", "target_y_norm"]].to_numpy())
            m = regression_metrics(model.apply(Pt), Tt, W, H)
            rows.append({"participant_id": pid, "k_points": k, "method": model.method,
                         "eval_frames": len(test), "mean_euclid_px": m["mean_euclid_px"],
                         "median_euclid_px": m["median_euclid_px"], "within_100px": m["within_100px"],
                         "improvement_px": base["mean_euclid_px"] - m["mean_euclid_px"]})
    if not rows:
        raise ValueError(f"Calibration evaluation needs, per participant, the calibration session "
                         f"'{calib_session}' AND at least one other session to score on.")
    return pd.DataFrame(rows)
