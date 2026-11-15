"""Metrics, calibration, smoothing, interaction metrics and plot orientation."""
import numpy as np
import pandas as pd
import pytest

W, H = 2560, 1600


def _pred_df(n_part=2, sessions=("S01", "S02", "S03"), trials=30, frames=3, noise=20.0, seed=0,
             distort=None):
    rng = np.random.default_rng(seed)
    rows = []
    for p in range(n_part):
        for s in sessions:
            for t in range(trials):
                tx, ty = rng.uniform(0.05, 0.95, 2)
                for f in range(frames):
                    px, py = tx, ty
                    if distort is not None:
                        px, py = distort(px, py)
                    rows.append({"sample_id": f"P{p}_{s}_T{t}_F{f}", "participant_id": f"P{p}",
                                 "session_id": s, "trial_id": f"P{p}_{s}_T{t}", "capture_time": t + f * 0.1,
                                 "target_x_norm": tx, "target_y_norm": ty,
                                 "pred_x_norm": px + rng.normal(0, noise / W),
                                 "pred_y_norm": py + rng.normal(0, noise / H)})
    df = pd.DataFrame(rows)
    df["target_x_px"], df["target_y_px"] = df.target_x_norm * W, df.target_y_norm * H
    df["pred_x_px"], df["pred_y_px"] = df.pred_x_norm * W, df.pred_y_norm * H
    df["resid_x_px"], df["resid_y_px"] = df.pred_x_px - df.target_x_px, df.pred_y_px - df.target_y_px
    df["euclid_px"] = np.hypot(df.resid_x_px, df.resid_y_px)
    from src.metrics import screen_region
    df["region"] = screen_region(df.target_x_norm, df.target_y_norm)
    return df


def test_regression_metrics_known_values():
    from src.metrics import regression_metrics
    t = np.array([[0.5, 0.5], [0.5, 0.5]])
    p = t + np.array([[30 / W, 40 / H], [-30 / W, -40 / H]])          # 50 px each, opposite
    m = regression_metrics(p, t, W, H, pixel_thresholds=(49, 51))
    assert m["mean_euclid_px"] == pytest.approx(50) and m["median_euclid_px"] == pytest.approx(50)
    assert m["mean_abs_x_px"] == pytest.approx(30) and m["mean_abs_y_px"] == pytest.approx(40)
    assert m["bias_x_px"] == pytest.approx(0) and m["rmse_px"] == pytest.approx(50)
    assert m["within_49px"] == 0 and m["within_51px"] == 1
    assert m["mean_euclid_pct_diag"] == pytest.approx(100 * 50 / np.hypot(W, H))
    assert "mean_euclid_mm" not in m                                   # no invented mm
    m2 = regression_metrics(p, t, W, H, monitor_mm=(345.0, 215.6))
    assert "mean_euclid_mm" in m2
    with pytest.raises(ValueError):
        regression_metrics(np.array([[np.nan, 0.5]]), np.array([[0.5, 0.5]]), W, H)
    with pytest.raises(ValueError):
        regression_metrics(np.zeros((0, 2)), np.zeros((0, 2)), W, H)


def test_r2_and_region_labels():
    from src.metrics import regression_metrics, screen_region
    t = np.random.default_rng(0).uniform(0, 1, (200, 2))
    assert regression_metrics(t, t, W, H)["r2_x"] == pytest.approx(1.0)
    lab = screen_region(np.array([0.02, 0.5, 0.02, 0.7]), np.array([0.02, 0.5, 0.5, 0.3]))
    assert list(lab) == ["corner", "center", "edge", "middle"]


def test_trial_average_and_bootstrap():
    from src.metrics import hierarchical_bootstrap, macro_mean_euclid_px, trial_average
    df = _pred_df()
    tr = trial_average(df)
    assert len(tr) == df["trial_id"].nunique() and (tr["frames"] == 3).all()
    b = hierarchical_bootstrap(df, W, H, iterations=200)
    assert b["ci95_low_px"] <= b["point_trial_level_px"] <= b["ci95_high_px"]
    assert b["resample_participants"] is False
    macro = macro_mean_euclid_px(df, W, H)
    assert macro == pytest.approx(df.groupby("participant_id")["euclid_px"].mean().mean())


def test_calibration_recovers_affine_and_never_overlaps(synth):
    from src.calibration import PersonalCalibration, canonical_layout, evaluate_calibration
    distort = lambda x, y: (0.9 * x + 0.05, 1.1 * y - 0.03)
    df = _pred_df(distort=distort, noise=2.0)
    res = evaluate_calibration(df, synth, point_counts=(5, 9, 16))
    for pid, g in res.groupby("participant_id"):
        base = g.loc[g.k_points == 0, "mean_euclid_px"].item()
        cal9 = g.loc[g.k_points == 9, "mean_euclid_px"].item()
        assert cal9 < base * 0.3
    c = PersonalCalibration("ridge_affine", alpha=1e6).fit(np.random.rand(5, 2), np.random.rand(5, 2))
    pts = np.array([[0.2, 0.3]])
    assert np.allclose(c.apply(pts) - c.coef[0], pts, atol=1e-3)       # strong ridge -> identity
    assert canonical_layout(9).shape == (9, 2) and canonical_layout(16).shape == (16, 2)
    with pytest.raises(ValueError):
        canonical_layout(7)


def test_smoothing_stays_inside_trials_and_reduces_jitter():
    from src.smoothing import EMAFilter, OneEuroFilter, TrackingGuard, fixation_jitter, smooth_predictions
    df = _pred_df(trials=10, frames=10, noise=40)
    raw = fixation_jitter(df, W, H)["rms_jitter_px"]
    sm = smooth_predictions(df, lambda: EMAFilter(0.3))
    assert fixation_jitter(sm, W, H)["rms_jitter_px"] < raw
    first = sm.sort_values("capture_time").groupby("trial_id").head(1)
    orig = df.set_index("sample_id").loc[first["sample_id"]]
    assert np.allclose(first["pred_x_norm"].to_numpy(), orig["pred_x_norm"].to_numpy())  # reset per trial
    f = OneEuroFilter()
    out = [f(i * 0.033, np.array([0.5, 0.5])) for i in range(5)]
    assert np.allclose(out[-1], [0.5, 0.5])
    g = TrackingGuard(0.25)
    assert g.update(0.0, np.array([0.1, 0.2])) is not None
    assert g.update(0.2, None) is not None and g.update(0.6, None) is None


def test_interaction_metrics_require_negatives():
    from src.interaction import selection_metrics
    pos_only = pd.DataFrame({"intended_target": ["a", "b"], "selected_target": ["a", "c"]})
    with pytest.raises(ValueError):
        selection_metrics(pos_only)
    ev = pd.DataFrame({"intended_target": ["a", "b", "none", "none", "c"],
                       "selected_target": ["a", "c", "none", "d", "none"]})
    m = selection_metrics(ev)
    assert (m["tp"], m["fp"], m["fn"], m["tn"]) == (1, 2, 2, 1)
    assert m["false_activation_rate"] == pytest.approx(0.5)


def test_prediction_table_and_map_orientation(tmp_path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from src.evaluation import prediction_table
    from src.visualization import (_screen_axes, plot_error_analysis, plot_error_heatmap,
                                   plot_prediction_map, plot_vector_field)
    df = _pred_df()
    man = df[["sample_id", "participant_id", "session_id", "trial_id", "capture_time",
              "target_x_norm", "target_y_norm", "target_x_px", "target_y_px"]].assign(
        target_index=0, frame_index=0)
    pt = prediction_table(man, df[["pred_x_norm", "pred_y_norm"]].to_numpy(), W, H, "ck", "norm-v1", "m")
    assert np.allclose(pt["euclid_px"], df["euclid_px"])
    with pytest.raises(ValueError):
        prediction_table(man.iloc[:3], df[["pred_x_norm", "pred_y_norm"]].to_numpy(), W, H, "c", "v", "m")
    fig, ax = plt.subplots()
    _screen_axes(ax, W, H, "t")
    y0, y1 = ax.get_ylim()
    assert y0 == H and y1 == 0                                         # y increases downward
    ax.scatter([0], [0])
    disp = ax.transData.transform((0, 0)); disp_bottom = ax.transData.transform((0, H))
    assert disp[1] > disp_bottom[1]                                    # (0,0) drawn at the TOP
    plt.close(fig)
    for f in (plot_prediction_map(pt, W, H, tmp_path / "map", "t"),
              plot_error_heatmap(pt, W, H, tmp_path / "heat"),
              plot_vector_field(pt, W, H, tmp_path / "vec")):
        assert f.is_file() and f.with_suffix(".svg").is_file()
    assert len(plot_error_analysis(pt, W, H, tmp_path / "ea")) >= 5
