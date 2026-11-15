"""Figures. Every function takes REAL data (histories, prediction tables) and
saves PNG + SVG; nothing here fabricates values.

Screen plots use the monitor's own coordinate system: origin top-left, y
increasing DOWNWARD (the y-axis is inverted), equal aspect so 2560x1600 is
drawn as 16:10. `_screen_axes` is the single place that sets this up.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

import numpy as np
import pandas as pd

PALETTE = ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB",
           "#000000", "#EE7733", "#009988"]


def _plt():
    import matplotlib
    import matplotlib.pyplot as plt
    return plt


def boxplot(ax, data, labels, **kw):
    """Matplotlib renamed `labels` to `tick_labels` in 3.9; support both."""
    try:
        return ax.boxplot(data, tick_labels=labels, **kw)
    except TypeError:
        return ax.boxplot(data, labels=labels, **kw)


def save(fig, path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path.with_suffix(".png"), dpi=150, bbox_inches="tight")
    fig.savefig(path.with_suffix(".svg"), bbox_inches="tight")
    _plt().close(fig)
    return path.with_suffix(".png")


def _screen_axes(ax, width: int, height: int, title: str):
    ax.set_xlim(0, width)
    ax.set_ylim(height, 0)                    # y grows downward, like the screen
    ax.set_aspect("equal")
    ax.add_patch(_plt().Rectangle((0, 0), width, height, fill=False, lw=1.5, color="black"))
    ax.axvline(width / 2, color="0.85", lw=0.8, zorder=0)
    ax.axhline(height / 2, color="0.85", lw=0.8, zorder=0)
    ax.set_xlabel("screen x (px) - left to right")
    ax.set_ylabel("screen y (px) - top to bottom")
    ax.set_title(title)


# ==========================================================================
# Learning dynamics (from history.csv / step_log.csv)
# ==========================================================================
def plot_learning_curves(history: pd.DataFrame, out_dir: Path, name: str = "") -> Dict[str, Path]:
    plt = _plt()
    out: Dict[str, Path] = {}
    if history.empty:
        raise ValueError("empty history")
    best = history.loc[history["val_mean_euclid_px_macro"].idxmin()]
    ep = history["epoch"] + 1

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(ep, history["train_loss"], "-o", ms=3, label="training loss")
    ax.plot(ep, history["val_loss"], "-o", ms=3, label="validation loss")
    ax.axvline(best["epoch"] + 1, ls="--", color="grey", label=f"best epoch {int(best['epoch']) + 1}")
    ax.set_xlabel("epoch"); ax.set_ylabel("Huber loss (screen-diagonal units)")
    ax.set_title(f"Loss {name}"); ax.legend()
    out["loss"] = save(fig, Path(out_dir) / "loss_vs_epoch")

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(ep, history["train_mean_euclid_px"], "-o", ms=3, label="training (sampled frames)")
    ax.plot(ep, history["val_mean_euclid_px_macro"], "-o", ms=3, label="validation (participant mean)")
    ax.axvline(best["epoch"] + 1, ls="--", color="grey")
    ax.set_xlabel("epoch"); ax.set_ylabel("mean Euclidean error (px)")
    ax.set_title(f"Coordinate error {name}"); ax.legend()
    out["error"] = save(fig, Path(out_dir) / "error_vs_epoch")

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(ep, history["val_mean_euclid_px_macro"] - history["train_mean_euclid_px"], "-o", ms=3)
    ax.axhline(0, color="black", lw=0.8)
    ax.set_xlabel("epoch"); ax.set_ylabel("validation - training error (px)")
    ax.set_title("Generalisation gap (grows when overfitting)")
    out["gap"] = save(fig, Path(out_dir) / "generalization_gap")

    fig, axes = plt.subplots(1, 2, figsize=(11, 3.5))
    axes[0].bar(ep, history["epoch_seconds"]); axes[0].set_xlabel("epoch"); axes[0].set_ylabel("seconds")
    axes[0].set_title("Epoch duration")
    if history["gpu_mem_gb"].notna().any():
        axes[1].plot(ep, history["gpu_mem_gb"], "-o", ms=3)
    axes[1].set_xlabel("epoch"); axes[1].set_ylabel("peak GPU memory (GB)"); axes[1].set_title("GPU memory")
    out["resources"] = save(fig, Path(out_dir) / "epoch_time_gpu_memory")
    return out


def plot_step_log(steps: pd.DataFrame, out_dir: Path) -> Dict[str, Path]:
    plt = _plt()
    out = {}
    lr_cols = [c for c in steps.columns if c.startswith("lr")]
    fig, ax = plt.subplots(figsize=(7, 3.5))
    for c in lr_cols:
        ax.plot(steps["step"], steps[c], label=c)
    ax.set_yscale("log"); ax.set_xlabel("optimizer step"); ax.set_ylabel("learning rate")
    ax.set_title("Learning-rate schedule"); ax.legend(fontsize=7)
    out["lr"] = save(fig, Path(out_dir) / "lr_vs_step")
    fig, ax = plt.subplots(figsize=(7, 3.5))
    ax.plot(steps["step"], steps["grad_norm"], lw=0.6, alpha=0.6, label="per step")
    ax.plot(steps["step"], steps["grad_norm"].rolling(50, min_periods=1).median(), lw=1.5,
            label="rolling median (50)")
    ax.set_yscale("log"); ax.set_xlabel("optimizer step"); ax.set_ylabel("gradient L2 norm (pre-clip)")
    ax.set_title("Gradient norm"); ax.legend()
    out["grad"] = save(fig, Path(out_dir) / "grad_norm_vs_step")
    return out


def plot_comparison(table: pd.DataFrame, x: str, y: str, out_path: Path, title: str,
                    ylabel: str = "validation mean Euclidean error (px)",
                    hue: Optional[str] = None, kind: str = "bar") -> Path:
    """Generic comparison figure: checkpoints, stages, unfrozen blocks,
    augmentation on/off, calibration k, training-set size ..."""
    plt = _plt()
    fig, ax = plt.subplots(figsize=(8, 4))
    if hue:
        for i, (h, g) in enumerate(table.groupby(hue)):
            if kind == "line":
                ax.plot(g[x], g[y], "-o", label=str(h), color=PALETTE[i % len(PALETTE)])
            else:
                pos = np.arange(len(g)) + i * 0.8 / table[hue].nunique()
                ax.bar(pos, g[y], width=0.8 / table[hue].nunique(), label=str(h),
                       color=PALETTE[i % len(PALETTE)])
                ax.set_xticks(np.arange(len(g)) + 0.4 - 0.4 / table[hue].nunique())
                ax.set_xticklabels(g[x].astype(str), rotation=30, ha="right")
        ax.legend()
    elif kind == "line":
        ax.plot(table[x], table[y], "-o")
    else:
        ax.bar(table[x].astype(str), table[y], color=PALETTE[0])
        ax.tick_params(axis="x", rotation=30)
    ax.set_xlabel(x); ax.set_ylabel(ylabel); ax.set_title(title)
    return save(fig, out_path)


# ==========================================================================
# Error analysis (from a prediction table)
# ==========================================================================
def plot_error_analysis(pred: pd.DataFrame, width: int, height: int, out_dir: Path,
                        tag: str = "validation", manifest: Optional[pd.DataFrame] = None
                        ) -> Dict[str, Path]:
    plt = _plt()
    out_dir = Path(out_dir)
    out: Dict[str, Path] = {}
    e = pred["euclid_px"]

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.hist(e, bins=60, color=PALETTE[0])
    ax.axvline(e.mean(), color="k", ls="--", label=f"mean {e.mean():.0f}px")
    ax.axvline(e.median(), color="r", ls=":", label=f"median {e.median():.0f}px")
    ax.set_xlabel("Euclidean error (px)"); ax.set_ylabel("frames"); ax.legend()
    ax.set_title(f"Error histogram ({tag})")
    out["hist"] = save(fig, out_dir / f"{tag}_error_histogram")

    fig, ax = plt.subplots(figsize=(7, 4))
    for i, (pid, g) in enumerate(pred.groupby("participant_id")):
        s = np.sort(g["euclid_px"]); ax.plot(s, np.arange(1, len(s) + 1) / len(s), label=pid,
                                             color=PALETTE[i % len(PALETTE)])
    s = np.sort(e); ax.plot(s, np.arange(1, len(s) + 1) / len(s), "k", lw=2, label="all")
    ax.set_xlabel("Euclidean error (px)"); ax.set_ylabel("fraction of frames with error <= x")
    ax.set_title(f"Cumulative error distribution ({tag})"); ax.legend(); ax.grid(alpha=0.3)
    out["cdf"] = save(fig, out_dir / f"{tag}_error_cdf")

    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    order = sorted(pred["participant_id"].unique())
    boxplot(axes[0], [pred.loc[pred.participant_id == p, "euclid_px"] for p in order], order,
            showfliers=False)
    axes[0].set_ylabel("Euclidean error (px)"); axes[0].set_title("By participant")
    ses = pred.groupby(["participant_id", "session_id"])
    boxplot(axes[1], [g["euclid_px"] for _, g in ses], [f"{a}\n{b}" for (a, b), _ in ses],
            showfliers=False)
    axes[1].set_title("By recording session"); axes[1].tick_params(axis="x", labelsize=7)
    out["box"] = save(fig, out_dir / f"{tag}_error_by_participant_session")

    fig, axes = plt.subplots(2, 2, figsize=(11, 8))
    axes[0, 0].scatter(pred["target_x_px"], pred["resid_x_px"], s=2, alpha=0.25)
    axes[0, 0].axhline(0, color="k"); axes[0, 0].set_xlabel("true x (px)"); axes[0, 0].set_ylabel("x residual (px)")
    axes[0, 1].scatter(pred["target_y_px"], pred["resid_y_px"], s=2, alpha=0.25, color=PALETTE[1])
    axes[0, 1].axhline(0, color="k"); axes[0, 1].set_xlabel("true y (px)"); axes[0, 1].set_ylabel("y residual (px)")
    axes[1, 0].scatter(pred["target_x_px"], pred["pred_x_px"], s=2, alpha=0.25)
    axes[1, 0].plot([0, width], [0, width], "k--"); axes[1, 0].set_xlabel("true x (px)"); axes[1, 0].set_ylabel("predicted x (px)")
    axes[1, 1].scatter(pred["target_y_px"], pred["pred_y_px"], s=2, alpha=0.25, color=PALETTE[1])
    axes[1, 1].plot([0, height], [0, height], "k--"); axes[1, 1].set_xlabel("true y (px)"); axes[1, 1].set_ylabel("predicted y (px)")
    fig.suptitle(f"Residuals and predicted vs actual ({tag})")
    out["resid"] = save(fig, out_dir / f"{tag}_residuals_pred_vs_true")

    reg = pred.groupby("region")["euclid_px"].agg(["mean", "median", "count"]).reindex(
        ["center", "middle", "edge", "corner"]).dropna()
    fig, ax = plt.subplots(figsize=(6, 3.5))
    ax.bar(reg.index, reg["mean"], color=PALETTE[2], label="mean")
    ax.scatter(reg.index, reg["median"], color="k", zorder=3, label="median")
    for i, n in enumerate(reg["count"]):
        ax.text(i, reg["mean"].iloc[i], f"n={int(n)}", ha="center", va="bottom", fontsize=8)
    ax.set_ylabel("Euclidean error (px)"); ax.set_title("Screen centre vs edge vs corner"); ax.legend()
    out["region"] = save(fig, out_dir / f"{tag}_error_by_region")

    if manifest is not None:
        m = pred.merge(manifest[["sample_id", "brightness", "sharpness", "left_eye_center",
                                 "right_eye_center"]], on="sample_id", how="left")
        fig, axes = plt.subplots(1, 3, figsize=(14, 3.8))
        axes[0].scatter(m["brightness"], m["euclid_px"], s=2, alpha=0.2)
        axes[0].set_xlabel("face brightness (0-255)"); axes[0].set_ylabel("error (px)")
        axes[1].scatter(m["sharpness"], m["euclid_px"], s=2, alpha=0.2); axes[1].set_xscale("log")
        axes[1].set_xlabel("sharpness (Laplacian variance)")
        iod = [abs(a[0] - b[0]) for a, b in zip(m["left_eye_center"], m["right_eye_center"])]
        axes[2].scatter(iod, m["euclid_px"], s=2, alpha=0.2)
        axes[2].set_xlabel("inter-ocular distance (px) - closer face = larger")
        fig.suptitle("Error vs image quality and head-position indicators")
        out["quality"] = save(fig, out_dir / f"{tag}_error_vs_quality_headpos")
    return out


# ==========================================================================
# Prediction maps
# ==========================================================================
def plot_prediction_map(pred: pd.DataFrame, width: int, height: int, out_path: Path,
                        title: str, color_by: str = "participant_id", trial_level: bool = True,
                        max_lines: int = 3000) -> Path:
    """Ground truth (x) and predictions (dots) joined by error lines."""
    plt = _plt()
    from .metrics import trial_average
    d = trial_average(pred) if trial_level else pred
    if "pred_x_px" not in d:
        d = d.assign(pred_x_px=d["pred_x_norm"] * width, pred_y_px=d["pred_y_norm"] * height,
                     target_x_px=d["target_x_norm"] * width, target_y_px=d["target_y_norm"] * height)
    fig, ax = plt.subplots(figsize=(13, 13 * height / width + 0.8))
    _screen_axes(ax, width, height, title)
    for i, (k, g) in enumerate(d.groupby(color_by)):
        c = PALETTE[i % len(PALETTE)]
        g = g.iloc[:max_lines]
        ax.plot(np.c_[g["target_x_px"], g["pred_x_px"]].T, np.c_[g["target_y_px"], g["pred_y_px"]].T,
                color=c, lw=0.5, alpha=0.5)
        ax.scatter(g["pred_x_px"], g["pred_y_px"], s=6, color=c, label=f"{k} prediction")
    ax.scatter(d["target_x_px"], d["target_y_px"], marker="x", s=18, color="black", lw=0.8,
               label="ground-truth target")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.08), ncol=6, fontsize=8, markerscale=2)
    return save(fig, out_path)


def plot_error_heatmap(pred: pd.DataFrame, width: int, height: int, out_path: Path,
                       bins=(16, 10), title: str = "Mean error by target location") -> Path:
    plt = _plt()
    xb = np.linspace(0, width, bins[0] + 1); yb = np.linspace(0, height, bins[1] + 1)
    s, _, _ = np.histogram2d(pred["target_x_px"], pred["target_y_px"], [xb, yb], weights=pred["euclid_px"])
    n, _, _ = np.histogram2d(pred["target_x_px"], pred["target_y_px"], [xb, yb])
    mean = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    fig, ax = plt.subplots(figsize=(11, 11 * height / width + 0.8))
    im = ax.imshow(mean.T, extent=(0, width, height, 0), origin="upper", cmap="magma_r", aspect="equal")
    _screen_axes(ax, width, height, title)
    fig.colorbar(im, ax=ax, label="mean Euclidean error (px)", shrink=0.8)
    return save(fig, out_path)


def plot_vector_field(pred: pd.DataFrame, width: int, height: int, out_path: Path,
                      title: str = "Residual vectors (trial means, true -> predicted)") -> Path:
    plt = _plt()
    from .metrics import trial_average
    d = trial_average(pred)
    tx, ty = d["target_x_norm"] * width, d["target_y_norm"] * height
    px, py = d["pred_x_norm"] * width, d["pred_y_norm"] * height
    e = np.hypot(px - tx, py - ty)
    fig, ax = plt.subplots(figsize=(12, 12 * height / width + 0.8))
    _screen_axes(ax, width, height, title)
    q = ax.quiver(tx, ty, px - tx, py - ty, e, angles="xy", scale_units="xy", scale=1, cmap="viridis",
                  width=0.0018)
    fig.colorbar(q, ax=ax, label="error (px)", shrink=0.8)
    return save(fig, out_path)


def plot_predicted_coverage(pred: pd.DataFrame, width: int, height: int, out_path: Path) -> Path:
    plt = _plt()
    fig, axes = plt.subplots(1, 2, figsize=(14, 4.8))
    for ax, (xc, yc, t) in zip(axes, [("target_x_px", "target_y_px", "Ground-truth targets"),
                                      ("pred_x_px", "pred_y_px", "Predictions")]):
        ax.hexbin(pred[xc], pred[yc], gridsize=30, extent=(0, width, 0, height), mincnt=1, cmap="Blues")
        _screen_axes(ax, width, height, t)
    fig.suptitle("Coverage: does the model use the whole screen?")
    return save(fig, out_path)


def interactive_prediction_map(pred: pd.DataFrame, width: int, height: int, out_html: Path,
                               title: str) -> Path:
    """Plotly map with hover info and a participant/session filter (legend)."""
    import plotly.graph_objects as go
    fig = go.Figure()
    for i, ((pid, sid), g) in enumerate(pred.groupby(["participant_id", "session_id"])):
        c = PALETTE[i % len(PALETTE)]
        xs, ys = [], []
        for a, b, cc, d in zip(g["target_x_px"], g["pred_x_px"], g["target_y_px"], g["pred_y_px"]):
            xs += [a, b, None]; ys += [cc, d, None]
        name = f"{pid} {sid}"
        fig.add_trace(go.Scattergl(x=xs, y=ys, mode="lines", line=dict(color=c, width=0.6),
                                   opacity=0.4, legendgroup=name, showlegend=False, hoverinfo="skip"))
        fig.add_trace(go.Scattergl(
            x=g["pred_x_px"], y=g["pred_y_px"], mode="markers", marker=dict(size=4, color=c),
            name=name, legendgroup=name,
            customdata=np.c_[g["sample_id"], g["target_x_px"], g["target_y_px"], g["euclid_px"]],
            hovertemplate="%{customdata[0]}<br>pred (%{x:.0f}, %{y:.0f})<br>"
                          "true (%{customdata[1]:.0f}, %{customdata[2]:.0f})<br>"
                          "error %{customdata[3]:.0f}px<extra></extra>"))
    t = pred.drop_duplicates("trial_id")
    fig.add_trace(go.Scattergl(x=t["target_x_px"], y=t["target_y_px"], mode="markers",
                               marker=dict(symbol="x", size=7, color="black"), name="targets"))
    fig.add_shape(type="rect", x0=0, y0=0, x1=width, y1=height, line=dict(color="black"))
    fig.update_xaxes(range=[-50, width + 50], title="screen x (px)", constrain="domain")
    fig.update_yaxes(range=[height + 50, -50], title="screen y (px, downward)", scaleanchor="x",
                     scaleratio=1)
    fig.update_layout(title=title, width=1300, height=int(1300 * height / width) + 120,
                      template="plotly_white")
    out_html = Path(out_html); out_html.parent.mkdir(parents=True, exist_ok=True)
    fig.write_html(out_html, include_plotlyjs="cdn")
    return out_html


def replay_animation(pred: pd.DataFrame, width: int, height: int, out_html: Path,
                     participant_id: str, session_id: str) -> Path:
    """Offline replay of one session's timestamped predictions (Plotly frames).
    Gaps between trials are real gaps in the recording."""
    import plotly.graph_objects as go
    g = pred[(pred.participant_id == participant_id) & (pred.session_id == session_id)
             ].sort_values("capture_time")
    if g.empty:
        raise ValueError("no rows for that participant/session")
    frames = [go.Frame(data=[go.Scatter(x=[r.target_x_px], y=[r.target_y_px], mode="markers",
                                        marker=dict(symbol="x", size=14, color="black")),
                             go.Scatter(x=[r.pred_x_px], y=[r.pred_y_px], mode="markers",
                                        marker=dict(size=12, color="red"))],
                       name=str(i)) for i, r in enumerate(g.itertuples())]
    fig = go.Figure(data=frames[0].data, frames=frames)
    fig.update_xaxes(range=[0, width]); fig.update_yaxes(range=[height, 0], scaleanchor="x")
    fig.update_layout(title=f"Replay {participant_id} {session_id} (black = target, red = prediction)",
                      updatemenus=[dict(type="buttons", buttons=[dict(label="Play", method="animate",
                                   args=[None, dict(frame=dict(duration=100), fromcurrent=True)])])],
                      width=1100, height=int(1100 * height / width) + 120, showlegend=False)
    fig.write_html(out_html, include_plotlyjs="cdn")
    return Path(out_html)


def inspect_sample(pred: pd.DataFrame, manifest: pd.DataFrame, dataset_root: Path, sample_id: str,
                   width: int, height: int):
    """Show one sample: its face crop, eye crops and its target vs prediction."""
    plt = _plt()
    from .preprocessing import read_bgr
    r = pred.set_index("sample_id").loc[sample_id]
    m = manifest.set_index("sample_id").loc[sample_id]
    fig = plt.figure(figsize=(13, 4.2))
    gs = fig.add_gridspec(2, 4)
    ax = fig.add_subplot(gs[:, 0]); ax.imshow(read_bgr(Path(dataset_root) / m["face_path"])[:, :, ::-1])
    ax.set_title(sample_id, fontsize=8); ax.axis("off")
    for k, (pos, kind) in enumerate([((0, 1), "right_eye"), ((1, 1), "left_eye")]):
        a = fig.add_subplot(gs[pos]); a.imshow(read_bgr(Path(dataset_root) / m[f"{kind}_path"])[:, :, ::-1])
        a.set_title(f"participant's {kind.replace('_', ' ')}", fontsize=8); a.axis("off")
    ax = fig.add_subplot(gs[:, 2:])
    _screen_axes(ax, width, height, f"error {r['euclid_px']:.0f}px")
    ax.scatter([r["target_x_px"]], [r["target_y_px"]], marker="x", s=80, color="k", label="target")
    ax.scatter([r["pred_x_px"]], [r["pred_y_px"]], s=60, color="r", label="prediction")
    ax.plot([r["target_x_px"], r["pred_x_px"]], [r["target_y_px"], r["pred_y_px"]], "r-")
    ax.legend()
    return fig
