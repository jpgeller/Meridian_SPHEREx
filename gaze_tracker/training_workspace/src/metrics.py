"""Regression metrics for screen-coordinate gaze estimation.

All inputs are normalised screen coordinates; the screen size converts them to
pixels. Definitions:

    residual            r_i = y_hat_i - y_i                  (per axis, px)
    Euclidean error     e_i = ||r_i||_2                      (px)  <- primary
    mean abs X / Y      mean |r_x|, mean |r_y|               (NOT the same as e)
    RMSE                sqrt(mean(e_i^2))
    bias                mean r_x, mean r_y  (systematic offset)
    R^2                 per axis, 1 - SS_res / SS_tot

Errors are also given as % of the screen diagonal (resolution independent),
and in millimetres ONLY when the monitor's physical size was measured and
entered in training_config.yaml. No angular error is computed: there is no
calibrated camera/screen geometry (see README "Scientific limitations").

Frames of one fixation trial are correlated; `trial_level=True` averages the
prediction error per trial first so every gaze position counts once.
"""
from __future__ import annotations

from typing import Dict, Iterable, Optional, Sequence

import numpy as np
import pandas as pd


def residuals_px(pred_norm: np.ndarray, true_norm: np.ndarray, width: int, height: int) -> np.ndarray:
    pred_norm = np.asarray(pred_norm, dtype=np.float64)
    true_norm = np.asarray(true_norm, dtype=np.float64)
    if pred_norm.shape != true_norm.shape:
        raise ValueError("shape mismatch")
    if not (np.isfinite(pred_norm).all() and np.isfinite(true_norm).all()):
        raise ValueError("non-finite predictions or targets")
    return (pred_norm - true_norm) * np.array([width, height], dtype=np.float64)


def regression_metrics(pred_norm: np.ndarray, true_norm: np.ndarray, width: int, height: int,
                       pixel_thresholds: Sequence[float] = (16, 32, 64, 100),
                       diag_fractions: Sequence[float] = (0.01, 0.02, 0.05, 0.10),
                       monitor_mm: Optional[tuple] = None) -> Dict[str, float]:
    r = residuals_px(pred_norm, true_norm, width, height)
    if len(r) == 0:
        raise ValueError("no samples")
    e = np.linalg.norm(r, axis=1)
    diag = float(np.hypot(width, height))
    t = np.asarray(true_norm, dtype=np.float64) * np.array([width, height])

    def r2(axis):
        ss_tot = ((t[:, axis] - t[:, axis].mean()) ** 2).sum()
        return float(1 - (r[:, axis] ** 2).sum() / ss_tot) if ss_tot > 0 else float("nan")

    out = {
        "n": int(len(e)),
        "mean_abs_x_px": float(np.abs(r[:, 0]).mean()),
        "mean_abs_y_px": float(np.abs(r[:, 1]).mean()),
        "mean_euclid_px": float(e.mean()),
        "median_euclid_px": float(np.median(e)),
        "rmse_px": float(np.sqrt((e ** 2).mean())),
        "p90_euclid_px": float(np.percentile(e, 90)),
        "p95_euclid_px": float(np.percentile(e, 95)),
        "max_euclid_px": float(e.max()),
        "bias_x_px": float(r[:, 0].mean()),
        "bias_y_px": float(r[:, 1].mean()),
        "residual_std_x_px": float(r[:, 0].std(ddof=1)) if len(r) > 1 else float("nan"),
        "residual_std_y_px": float(r[:, 1].std(ddof=1)) if len(r) > 1 else float("nan"),
        "r2_x": r2(0), "r2_y": r2(1),
        "mean_euclid_norm_diag": float(e.mean() / diag),
        "mean_euclid_pct_diag": float(100 * e.mean() / diag),
        "median_euclid_pct_diag": float(100 * np.median(e) / diag),
    }
    for px in pixel_thresholds:
        out[f"within_{int(px)}px"] = float((e <= px).mean())
    for f in diag_fractions:
        out[f"within_{f:g}_diag"] = float((e <= f * diag).mean())
    if monitor_mm is not None:
        mm_per_px = np.array([monitor_mm[0] / width, monitor_mm[1] / height])
        e_mm = np.linalg.norm(r * mm_per_px, axis=1)
        out["mean_euclid_mm"] = float(e_mm.mean())
        out["median_euclid_mm"] = float(np.median(e_mm))
    return out


def screen_region(x_norm: np.ndarray, y_norm: np.ndarray, margin: float = 0.1) -> np.ndarray:
    """'corner' / 'edge' / 'center' / 'middle' label per target."""
    x = np.asarray(x_norm); y = np.asarray(y_norm)
    ex = (x < margin) | (x > 1 - margin)
    ey = (y < margin) | (y > 1 - margin)
    lab = np.full(len(x), "middle", dtype=object)
    lab[(np.abs(x - 0.5) < 1 / 6) & (np.abs(y - 0.5) < 1 / 6)] = "center"
    lab[ex | ey] = "edge"
    lab[ex & ey] = "corner"
    return lab


def trial_average(pred_df: pd.DataFrame) -> pd.DataFrame:
    """Average predictions over the frames of each trial (one row per trial)."""
    keys = ["participant_id", "session_id", "trial_id"]
    agg = pred_df.groupby(keys, as_index=False).agg(
        pred_x_norm=("pred_x_norm", "mean"), pred_y_norm=("pred_y_norm", "mean"),
        target_x_norm=("target_x_norm", "first"), target_y_norm=("target_y_norm", "first"),
        frames=("sample_id", "size"))
    return agg


def grouped_metrics(pred_df: pd.DataFrame, by: Sequence[str], width: int, height: int,
                    **kw) -> pd.DataFrame:
    rows = []
    for key, g in pred_df.groupby(list(by)):
        m = regression_metrics(g[["pred_x_norm", "pred_y_norm"]].to_numpy(),
                               g[["target_x_norm", "target_y_norm"]].to_numpy(), width, height, **kw)
        key = key if isinstance(key, tuple) else (key,)
        m.update(dict(zip(by, key)))
        rows.append(m)
    return pd.DataFrame(rows)


def macro_mean_euclid_px(pred_df: pd.DataFrame, width: int, height: int) -> float:
    """Selection metric: mean Euclidean px error per participant, then the
    unweighted mean over participants (each validation person counts equally)."""
    per = []
    for _, g in pred_df.groupby("participant_id"):
        r = residuals_px(g[["pred_x_norm", "pred_y_norm"]].to_numpy(),
                         g[["target_x_norm", "target_y_norm"]].to_numpy(), width, height)
        per.append(np.linalg.norm(r, axis=1).mean())
    return float(np.mean(per))


# --------------------------------------------------------------------------
# Uncertainty: hierarchical bootstrap
# --------------------------------------------------------------------------
def hierarchical_bootstrap(pred_df: pd.DataFrame, width: int, height: int, iterations: int = 2000,
                           seed: int = 0, resample_participants: bool = False,
                           stat=np.mean) -> Dict[str, float]:
    """Bootstrap CI of the mean Euclidean error that respects the data's
    structure: frames are first averaged within each trial (they are near
    duplicates), then sessions are resampled within participant and trials
    within session.

    resample_participants=False (default) gives a CI *conditional on these
    participants* - with only two validation/test people a participant-level
    bootstrap cannot estimate population variability and is reported only as
    an illustration."""
    df = pred_df.copy()
    df["e"] = np.linalg.norm(residuals_px(df[["pred_x_norm", "pred_y_norm"]].to_numpy(),
                                          df[["target_x_norm", "target_y_norm"]].to_numpy(),
                                          width, height), axis=1)
    trial_err = df.groupby(["participant_id", "session_id", "trial_id"])["e"].mean()
    struct = {p: {s: g.to_numpy() for s, g in gp.groupby(level="session_id")}
              for p, gp in trial_err.groupby(level="participant_id")}
    rng = np.random.default_rng(seed)
    pids = sorted(struct)
    stats = np.empty(iterations)
    for b in range(iterations):
        chosen = rng.choice(pids, size=len(pids), replace=True) if resample_participants else pids
        vals = []
        for p in chosen:
            sids = list(struct[p])
            for s in rng.choice(sids, size=len(sids), replace=True):
                t = struct[p][s]
                vals.append(rng.choice(t, size=len(t), replace=True))
        stats[b] = stat(np.concatenate(vals))
    point = float(stat(trial_err.to_numpy()))
    return {"point_trial_level_px": point, "ci95_low_px": float(np.percentile(stats, 2.5)),
            "ci95_high_px": float(np.percentile(stats, 97.5)), "iterations": iterations,
            "participants": len(pids), "resample_participants": resample_participants,
            "interpretation": ("CI conditional on these participants (sessions and trials "
                               "resampled)" if not resample_participants else
                               "participants resampled - unreliable with so few people")}
