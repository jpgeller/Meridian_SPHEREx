"""Baselines that every neural model must beat.

B1  naive: screen centre, mean training target.
B2a ridge regression on frozen UniGaze CLS features (768-d).
B2b ridge on a low-dimensional, geometry-informed feature set:
    UniGaze gaze direction (normalised frame and de-normalised camera frame),
    normalised head pose, approximate face position and eye position in the
    image. This is "frozen UniGaze gaze outputs + a calibrated screen mapping"
    (option 2 in the brief).

Regularisation strength is chosen by leave-one-PARTICIPANT-out
cross-validation on the TRAINING participants only (GroupKFold), so the
validation participants are untouched until the final comparison.
"""
from __future__ import annotations

from typing import Dict, Optional, Sequence

import numpy as np
import pandas as pd

from . import geometry as geo


def geometric_features(gaze_pitchyaw: np.ndarray, geometry: pd.DataFrame,
                       manifest: pd.DataFrame) -> np.ndarray:
    """Build the B2b feature matrix (row-aligned inputs)."""
    R = geometry[[f"R{i}" for i in range(9)]].to_numpy(float).reshape(-1, 3, 3)
    g_cam = geo.denormalize_gaze(gaze_pitchyaw, R)
    fc = geometry[["face_cx_mm", "face_cy_mm", "face_cz_mm"]].to_numpy(float)
    fc_dir = fc / np.linalg.norm(fc, axis=1, keepdims=True)
    head = geometry[["head_pitch_norm", "head_yaw_norm"]].to_numpy(float)
    W = manifest["raw_width"].to_numpy(float); H = manifest["raw_height"].to_numpy(float)
    eye_mid = np.array([[(l[0] + r[0]) / 2, (l[1] + r[1]) / 2] for l, r in
                        zip(manifest["left_eye_center"], manifest["right_eye_center"])])
    eye_mid = eye_mid / np.c_[W, H]
    iod = np.array([np.hypot(l[0] - r[0], l[1] - r[1]) for l, r in
                    zip(manifest["left_eye_center"], manifest["right_eye_center"])]) / W
    X = np.c_[gaze_pitchyaw, g_cam, head, fc_dir, eye_mid, iod]
    if not np.isfinite(X).all():
        raise ValueError("non-finite geometric features (did normalisation fail for some rows?)")
    return X


def fit_ridge_grouped(X: np.ndarray, Y: np.ndarray, groups: Sequence[str],
                      alphas: Sequence[float] = (0.1, 1, 10, 100, 1000, 10000),
                      poly_degree: int = 1, width: int = 2560, height: int = 1600) -> Dict:
    """Standardise -> (optional polynomial) -> Ridge; alpha by leave-one-
    participant-out CV on the given (training) rows."""
    from sklearn.linear_model import Ridge
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import PolynomialFeatures, StandardScaler

    def make(alpha):
        steps = [StandardScaler()]
        if poly_degree > 1:
            steps += [PolynomialFeatures(poly_degree, include_bias=False), StandardScaler()]
        return make_pipeline(*steps, Ridge(alpha=alpha))

    groups = np.asarray(groups)
    k = len(np.unique(groups))
    cv = GroupKFold(n_splits=k)
    scale = np.array([width, height])
    scores = {}
    for a in alphas:
        errs = []
        for tr, va in cv.split(X, Y, groups):
            m = make(a).fit(X[tr], Y[tr])
            errs.append(np.linalg.norm((m.predict(X[va]) - Y[va]) * scale, axis=1).mean())
        scores[a] = float(np.mean(errs))
    best = min(scores, key=scores.get)
    model = make(best).fit(X, Y)
    return {"model": model, "alpha": best, "cv_mean_euclid_px_by_alpha": scores}
