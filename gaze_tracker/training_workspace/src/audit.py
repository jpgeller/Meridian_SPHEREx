"""Dataset audit: integrity, timing, image quality, label coverage and a
PASS/FAIL training-readiness decision.

Nothing is removed silently. Every excluded observation appears in
reports/exclusion_report.csv with a precise reason, and only CRITICAL
problems (unusable or untrustworthy rows) cause exclusion. Everything else is
a warning column that later analyses can use.

Image decoding is the slow part (4 PNGs per observation, ~200,000 files).
`decode_mode` controls it:
    "none"   - metadata, file existence and sizes only (seconds)
    "sample" - decode a stratified sample of trials from every session (minutes)
    "full"   - decode everything (tens of minutes; recommended once before training)
"""
from __future__ import annotations

import base64
import io
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .config import Config
from .dataset import IMAGE_KINDS, build_master_manifest, write_split_manifests
from .utils import now_iso, write_json

CRITICAL, WARNING, OK = "CRITICAL", "WARNING", "ACCEPTABLE"


@dataclass
class AuditResult:
    master: pd.DataFrame
    exclusions: pd.DataFrame
    findings: List[Dict] = field(default_factory=list)
    counts: Dict = field(default_factory=dict)
    quality: Dict = field(default_factory=dict)
    coverage: Dict = field(default_factory=dict)
    figures: Dict[str, Path] = field(default_factory=dict)
    decision: str = "FAIL"

    def add(self, level: str, check: str, detail: str, action: str = "") -> None:
        self.findings.append({"level": level, "check": check, "detail": detail, "action": action})


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _events_pause_intervals(events_path: Path) -> List[Tuple[float, float]]:
    """Intervals in which the capture app was NOT capturing (from its event log)."""
    spans, since = [], None
    if not events_path.is_file():
        return spans
    for line in events_path.read_text(encoding="utf-8").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("event") != "state":
            continue
        t, to = float(e["time"]), e.get("to")
        if to == "CAPTURING":
            if since is not None:
                spans.append((since, t))
                since = None
        elif since is None:
            since = t
    if since is not None:
        spans.append((since, float("inf")))
    return spans


def _dhash(gray: np.ndarray, size: int = 8) -> int:
    import cv2
    small = cv2.resize(gray, (size + 1, size), interpolation=cv2.INTER_AREA)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    return int(sum(1 << i for i, b in enumerate(bits) if b))


def _decode_row(args) -> Dict:
    """Decode the four images of one observation and measure them."""
    import cv2
    root, row, face_px, eye_px, verify_hash = args
    out = {"sample_id": row["sample_id"], "decode_error": ""}
    try:
        for kind in IMAGE_KINDS:
            data = np.fromfile(str(root / row[f"{kind}_path"]), dtype=np.uint8)
            img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
            if img is None:
                out["decode_error"] += f"{kind}:undecodable;"
                continue
            ch = 1 if img.ndim == 2 else img.shape[2]
            out[f"{kind}_channels"] = ch
            out[f"{kind}_h"], out[f"{kind}_w"] = img.shape[:2]
            if kind == "face" and ch == 3:
                g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                out["face_brightness"] = float(g.mean())
                out["face_contrast"] = float(g.std())
                out["face_blur_laplacian"] = float(cv2.Laplacian(g, cv2.CV_64F).var())
                out["face_overexposed_frac"] = float((g >= 250).mean())
                out["face_underexposed_frac"] = float((g <= 5).mean())
                out["face_dhash"] = _dhash(g)
                out["face_thumb"] = cv2.resize(g, (32, 32), interpolation=cv2.INTER_AREA
                                               ).astype(np.float32).ravel()
            if kind in ("left_eye", "right_eye") and ch == 3:
                g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                band = g[g.shape[0] // 3: 2 * g.shape[0] // 3]
                out[f"{kind}_mean"] = float(g.mean())
                out[f"{kind}_band_dark_frac"] = float((band < np.percentile(g, 15)).mean())
            if kind == "raw" and ch == 3 and verify_hash:
                import hashlib
                out["raw_sha_check"] = (hashlib.sha256(img.tobytes()).hexdigest()
                                        == row["raw_pixel_sha256"])
        if out.get("face_h") not in (None, face_px) or out.get("face_w") not in (None, face_px):
            out["decode_error"] += "face:wrong_size;"
        for e in ("left_eye", "right_eye"):
            if out.get(f"{e}_h") not in (None, eye_px) or out.get(f"{e}_w") not in (None, eye_px):
                out["decode_error"] += f"{e}:wrong_size;"
        if out.get("raw_h") not in (None, row["raw_height"]) or out.get("raw_w") not in (None, row["raw_width"]):
            out["decode_error"] += "raw:size_mismatch;"
        for kind in IMAGE_KINDS:
            if out.get(f"{kind}_channels") not in (None, 3):
                out["decode_error"] += f"{kind}:not_3_channel;"
    except Exception as exc:  # recorded per row, never swallowed
        out["decode_error"] += f"exception:{exc!r};"
    return out


def _fig_to_png(fig, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130, bbox_inches="tight")
    fig.savefig(path.with_suffix(".svg"), bbox_inches="tight")
    import matplotlib.pyplot as plt
    plt.close(fig)
    return path


# --------------------------------------------------------------------------
# main audit
# --------------------------------------------------------------------------
def run_audit(cfg: Config, decode_mode: str = "sample", sample_trials_per_session: int = 10,
              verify_raw_hash: bool = False, max_threads: int = 8, progress: bool = True
              ) -> AuditResult:
    """Run every check and return an AuditResult (call `write_reports` to save)."""
    if decode_mode not in ("none", "sample", "full"):
        raise ValueError("decode_mode must be none, sample or full")
    dcfg = cfg["dataset"]
    root = cfg.paths.dataset_root
    master, malformed, infos, pilot_dirs = build_master_manifest(cfg)
    res = AuditResult(master=master, exclusions=pd.DataFrame(columns=["sample_id", "reason"]))
    excl: List[Dict] = []

    def exclude(ids, reason):
        for s in ids:
            excl.append({"sample_id": s, "reason": reason})

    # ---------------------------------------------------------------- A counts
    W, H = dcfg["expected_screen_px"]
    res.counts = {
        "dataset_root": str(root),
        "participants": int(master["participant_id"].nunique()),
        "sessions": int(master["session_dir"].nunique()),
        "observations": int(len(master)),
        "fixation_trials": int(master["trial_id"].nunique()),
        "image_files_referenced": int(len(master) * 4),
        "malformed_annotation_lines": len(malformed),
        "pilot_sessions_ignored": len(pilot_dirs),
        "per_participant": master.groupby("participant_id").agg(
            sessions=("session_id", "nunique"), observations=("sample_id", "size"),
            trials=("trial_id", "nunique"), assigned_split=("assigned_split", "first")
        ).reset_index().to_dict("records"),
        "per_session": master.groupby(["participant_id", "session_id"]).agg(
            observations=("sample_id", "size"), trials=("trial_id", "nunique")
        ).reset_index().to_dict("records"),
        "per_split": master.groupby("assigned_split").agg(
            participants=("participant_id", "nunique"), observations=("sample_id", "size"),
            trials=("trial_id", "nunique")).reset_index().to_dict("records"),
        "note": ("One observation = one labelled camera frame with 4 image files (raw, face, "
                 "left_eye, right_eye). Ten frames share one fixation target (a trial). "
                 "Independent gaze positions per participant = number of trials, not frames."),
    }
    if malformed:
        res.add(WARNING if len(malformed) < 0.01 * len(master) else CRITICAL,
                "malformed_annotations", f"{len(malformed)} unreadable annotation lines",
                "Inspect the listed lines; they are not indexed.")
    if pilot_dirs:
        res.add(OK, "pilot_isolation", f"{len(pilot_dirs)} pilot session(s) found and ignored")

    # ---------------------------------------------------- B integrity (metadata)
    unassigned = master[master["assigned_split"] == "unassigned"]
    if len(unassigned):
        exclude(unassigned["sample_id"], "participant_not_in_documented_split")
        res.add(CRITICAL, "unassigned_participants",
                f"{sorted(unassigned['participant_id'].unique())} not in the split table")
    mism = master[(master["assigned_split"] != master["recorded_split"])
                  & (master["assigned_split"] != "unassigned")]
    if len(mism):
        res.add(CRITICAL, "split_mismatch",
                f"{len(mism)} rows were recorded under a different split folder than assigned "
                f"({sorted(mism['participant_id'].unique())}) - possible subject leakage.")
        exclude(mism["sample_id"], "recorded_split_differs_from_assigned_split")

    path_parts = master["session_dir"].str.split("/")
    pid_ok = [pid in parts for pid, parts in zip(master["participant_id"], path_parts)]
    sid_ok = [sid == parts[-1] for sid, parts in zip(master["session_id"], path_parts)]
    bad_pid = master.loc[~np.array(pid_ok), "sample_id"]
    bad_sid = master.loc[~np.array(sid_ok), "sample_id"]
    exclude(bad_pid, "participant_id_does_not_match_directory")
    exclude(bad_sid, "session_id_does_not_match_directory")
    res.add(OK if not len(bad_pid) and not len(bad_sid) else CRITICAL, "ids_match_directories",
            f"{len(bad_pid)} participant and {len(bad_sid)} session mismatches")

    meta_missing = []
    for info in infos:
        meta = info.get("session_metadata.json")
        tgt = info.get("targets.json")
        if not meta or not tgt:
            meta_missing.append(info["session_dir"])
            continue
        for key in ("camera", "monitor", "protocol", "participant_id", "session_id"):
            if key not in meta:
                meta_missing.append(f"{info['session_dir']}:{key}")
        sd = master[master["session_dir"] == info["session_dir"]]
        if len(sd) and meta.get("session_id") != sd["session_id"].iloc[0]:
            meta_missing.append(f"{info['session_dir']}:session_id_mismatch")
        mon = meta.get("monitor", {})
        if (mon.get("width_px"), mon.get("height_px")) != (tgt.get("screen_width_px"),
                                                           tgt.get("screen_height_px")):
            res.add(CRITICAL, "target_map_vs_monitor",
                    f"{info['session_dir']}: targets.json screen size differs from the monitor")
        # every annotated target must match targets.json
        tmap = {t["target_index"]: (t["x_px"], t["y_px"]) for t in tgt.get("targets", [])}
        bad = sd[[tmap.get(ti) != (x, y) for ti, x, y in
                  zip(sd["target_index"], sd["target_x_px"], sd["target_y_px"])]]
        exclude(bad["sample_id"], "label_disagrees_with_targets_json")
    res.add(OK if not meta_missing else WARNING, "session_metadata_fields",
            f"{len(meta_missing)} missing/inconsistent metadata items" +
            (f": {meta_missing[:5]}" if meta_missing else ""))

    screens = master.groupby(["screen_width_px", "screen_height_px"]).size()
    if len(screens) != 1 or tuple(screens.index[0]) != (W, H):
        res.add(CRITICAL, "screen_geometry", f"screen sizes found: {screens.to_dict()} "
                f"(expected {W}x{H})")
    else:
        res.add(OK, "screen_geometry", f"all observations on one {W}x{H} participant monitor")
    raws = master.groupby(["raw_width", "raw_height"]).size()
    res.add(OK if len(raws) == 1 else WARNING, "camera_resolution", f"{raws.to_dict()}")

    xy = master[["target_x_px", "target_y_px"]].to_numpy(float)
    bad_xy = (~np.isfinite(xy).all(1)) | (xy[:, 0] < 0) | (xy[:, 0] >= W) | (xy[:, 1] < 0) | (xy[:, 1] >= H)
    nrm = master[["target_x_norm", "target_y_norm"]].to_numpy(float)
    bad_norm = np.abs(nrm - xy / np.array([W, H])).max(1) > 1e-4
    exclude(master.loc[bad_xy, "sample_id"], "target_outside_screen_or_non_finite")
    exclude(master.loc[bad_norm & ~bad_xy, "sample_id"], "normalised_target_inconsistent")
    res.add(OK if not bad_xy.any() and not bad_norm.any() else CRITICAL, "target_coordinates",
            f"{int(bad_xy.sum())} out of range, {int(bad_norm.sum())} px/norm inconsistent")

    times_ok = np.isfinite(master[["target_onset_time", "capture_time"]].to_numpy(float)).all(1)
    exclude(master.loc[~times_ok, "sample_id"], "non_finite_timestamp")
    lat = master["latency_s"].to_numpy(float)
    early = lat < float(dcfg["min_latency_after_onset_s"]) - 1e-3
    late = lat > float(dcfg["max_latency_after_onset_s"])
    exclude(master.loc[early, "sample_id"], "captured_before_target_settle_time")
    master["flag_late_after_onset"] = late
    res.add(OK if not early.any() else CRITICAL, "capture_after_target_settle",
            f"{int(early.sum())} frames earlier than {dcfg['min_latency_after_onset_s']} s after "
            f"target onset (latency range {lat.min():.2f}-{lat.max():.2f} s)")
    if late.any():
        res.add(WARNING, "slow_trials", f"{int(late.sum())} frames more than "
                f"{dcfg['max_latency_after_onset_s']} s after onset in "
                f"{master.loc[late, 'session_dir'].nunique()} session(s); kept and flagged",
                "Usually a trial that was retried; check if a session mixes two sittings.")

    not_cap = master["state_at_capture"] != "CAPTURING"
    exclude(master.loc[not_cap, "sample_id"], "state_not_CAPTURING")
    in_pause = np.zeros(len(master), dtype=bool)
    logs = root / "logs"
    for sd, g in master.groupby("session_dir"):
        pid, sid = g["participant_id"].iloc[0], g["session_id"].iloc[0]
        spans = _events_pause_intervals(logs / f"official_{pid}_{sid}_events.jsonl")
        ct = g["capture_time"].to_numpy(float)
        hit = np.zeros(len(g), bool)
        for a, b in spans:
            hit |= (ct > a) & (ct < b)
        in_pause[g.index] = hit
    exclude(master.loc[in_pause, "sample_id"], "captured_while_paused")
    res.add(OK if not in_pause.any() and not not_cap.any() else CRITICAL, "no_capture_while_paused",
            f"{int(in_pause.sum())} frames inside paused intervals, {int(not_cap.sum())} with a "
            f"non-CAPTURING state")

    dup_id = master["sample_id"].duplicated(keep="first")
    dup_raw = master["raw_pixel_sha256"].duplicated(keep="first")
    exclude(master.loc[dup_id, "sample_id"], "duplicate_sample_id")
    exclude(master.loc[dup_raw & ~dup_id, "sample_id"], "duplicate_raw_frame_content")
    res.add(OK if not dup_id.any() and not dup_raw.any() else CRITICAL, "duplicates",
            f"{int(dup_id.sum())} duplicate IDs, {int(dup_raw.sum())} identical raw frames")

    per_trial = master.groupby("trial_id")["sample_id"].transform("size")
    bad_trial = per_trial != int(dcfg["frames_per_trial"])
    exclude(master.loc[bad_trial, "sample_id"], "trial_without_expected_frame_count")
    res.add(OK if not bad_trial.any() else WARNING, "complete_trials",
            f"{int(master.loc[bad_trial, 'trial_id'].nunique())} trials without "
            f"{dcfg['frames_per_trial']} frames")

    # file existence (cheap) for every referenced image
    paths = [(i, k, root / master.at[i, f"{k}_path"]) for i in master.index for k in IMAGE_KINDS]

    def _exists(item):
        i, k, p = item
        try:
            return i, k, p.stat().st_size > 0
        except OSError:
            return i, k, False

    with ThreadPoolExecutor(max_threads) as ex:
        missing = [(i, k) for i, k, ok in ex.map(_exists, paths, chunksize=256) if not ok]
    for i, k in missing:
        excl.append({"sample_id": master.at[i, "sample_id"], "reason": f"missing_file:{k}"})
    res.add(OK if not missing else CRITICAL, "files_exist",
            f"{len(paths) - len(missing)} of {len(paths)} referenced image files present")

    lr_swap = np.array([l[0] < r[0] for l, r in zip(master["left_eye_center"], master["right_eye_center"])])
    master["flag_possible_lr_swap"] = lr_swap
    res.add(OK if not lr_swap.any() else WARNING, "left_right_eye_labels",
            f"{int(lr_swap.sum())} frames where the participant's left eye is not on the image "
            "right (unmirrored camera)")

    # ------------------------------------------------------- C decoded quality
    decoded = pd.DataFrame()
    if decode_mode != "none":
        if decode_mode == "full":
            chosen = master
        else:
            rng = np.random.default_rng(int(cfg["reproducibility"]["seed"]))
            keep = []
            for _, g in master.groupby("session_dir"):
                trials = g["trial_id"].unique()
                pick = rng.choice(trials, size=min(sample_trials_per_session, len(trials)), replace=False)
                keep.append(g[g["trial_id"].isin(pick)])
            chosen = pd.concat(keep)
        jobs = [(root, r, int(dcfg["face_crop_px"]), int(dcfg["eye_crop_px"]), verify_raw_hash)
                for r in chosen.to_dict("records")]
        try:
            from tqdm.auto import tqdm
        except ImportError:  # pragma: no cover
            tqdm = None
        with ThreadPoolExecutor(max_threads) as ex:
            it = ex.map(_decode_row, jobs, chunksize=32)
            if progress and tqdm:
                it = tqdm(it, total=len(jobs), desc=f"decoding ({decode_mode})")
            decoded = pd.DataFrame(list(it))
        bad = decoded[decoded["decode_error"] != ""]
        for sid, err in zip(bad["sample_id"], bad["decode_error"]):
            excl.append({"sample_id": sid, "reason": f"image_check_failed:{err}"})
        if "raw_sha_check" in decoded and decoded["raw_sha_check"].notna().any():
            mism_h = decoded[decoded["raw_sha_check"] == False]  # noqa: E712
            exclude(mism_h["sample_id"], "raw_pixels_differ_from_recorded_hash")
        res.add(OK if bad.empty else CRITICAL, "images_decode_and_dimensions",
                f"{len(decoded)} observations decoded ({decode_mode}); {len(bad)} failed "
                f"(undecodable, wrong size or not 3-channel)")
        res.add(OK, "color_order", "PNG files decode as 3-channel BGR in OpenCV; the pipeline "
                "converts to RGB exactly once (preprocessing.py)")
        res.quality = _quality_summary(master, decoded)
        if res.quality.get("possible_blink_frames", 0):
            res.add(WARNING, "possible_blinks",
                    f"~{res.quality['possible_blink_frames']} decoded frames look like blinks/"
                    "closed eyes (heuristic, kept and flagged)",
                    "Inspect contact sheets; consider excluding after review.")
    else:
        res.add(WARNING, "images_decode_and_dimensions", "skipped (decode_mode='none')",
                "Run once with decode_mode='full' before training.")
        res.quality = _quality_summary(master, decoded)

    # ---------------------------------------------------------- D label coverage
    res.coverage = _coverage(master, W, H)
    if res.coverage["corner_fraction"] < 0.02:
        res.add(WARNING, "corner_coverage", f"only {res.coverage['corner_fraction']:.1%} of trials "
                "within 10% of a screen corner; corner accuracy will be weakly constrained")

    # ------------------------------------------------------------- E decision
    ex_df = pd.DataFrame(excl).drop_duplicates() if excl else pd.DataFrame(columns=["sample_id", "reason"])
    if len(ex_df):
        # a trial with any critically excluded frame is excluded as a whole
        bad_trials = set(master.loc[master["sample_id"].isin(ex_df["sample_id"]), "trial_id"])
        extra = master[master["trial_id"].isin(bad_trials) & ~master["sample_id"].isin(ex_df["sample_id"])]
        ex_df = pd.concat([ex_df, pd.DataFrame({"sample_id": extra["sample_id"],
                                                "reason": "same_trial_as_excluded_frame"})])
    res.exclusions = ex_df.merge(master[["sample_id", "participant_id", "session_id", "trial_id",
                                         "assigned_split", "raw_path"]], on="sample_id", how="left")
    rate = res.exclusions["sample_id"].nunique() / max(1, len(master))
    if rate > 0.02:
        res.add(CRITICAL, "exclusion_rate", f"{rate:.2%} of observations excluded (>2%)",
                "Investigate the exclusion report before training.")
    else:
        res.add(OK, "exclusion_rate", f"{rate:.2%} of observations excluded")
    for split, members in cfg.splits.items():
        have = set(master["participant_id"]) & set(members)
        if have != set(members):
            res.add(CRITICAL if not have else WARNING, f"{split}_participants",
                    f"missing: {sorted(set(members) - have)}")
    res.decision = "FAIL" if any(f["level"] == CRITICAL for f in res.findings) else "PASS"
    if "possible_blink" in decoded.columns:
        res.master = master.merge(decoded[["sample_id", "possible_blink"]], on="sample_id", how="left")
    else:
        res.master = master
    return res


def _quality_summary(master: pd.DataFrame, decoded: pd.DataFrame) -> Dict:
    q: Dict = {
        "brightness_capture_app": master["brightness"].describe().round(2).to_dict(),
        "sharpness_capture_app": master["sharpness"].describe().round(2).to_dict(),
        "face_score": master["face_score"].describe().round(4).to_dict(),
        "face_width_px": pd.Series([b[2] for b in master["face_box"]]).describe().round(1).to_dict(),
        "eye_box_px": pd.Series([b[2] for b in master["left_eye_box"]]).describe().round(1).to_dict(),
        "brightness_by_participant": master.groupby("participant_id")["brightness"].mean().round(1).to_dict(),
    }
    mid = np.array([[(l[0] + r[0]) / 2, (l[1] + r[1]) / 2] for l, r in
                    zip(master["left_eye_center"], master["right_eye_center"])])
    iod = np.array([abs(l[0] - r[0]) for l, r in zip(master["left_eye_center"], master["right_eye_center"])])
    q["head_position"] = {"eye_midpoint_x_px": pd.Series(mid[:, 0]).describe().round(1).to_dict(),
                          "eye_midpoint_y_px": pd.Series(mid[:, 1]).describe().round(1).to_dict(),
                          "interocular_px_(distance_proxy)": pd.Series(iod).describe().round(1).to_dict()}
    if len(decoded) and "face_contrast" in decoded:
        d = decoded.merge(master[["sample_id", "trial_id", "frame_index", "participant_id"]], on="sample_id")
        q["decoded_face_contrast"] = d["face_contrast"].describe().round(2).to_dict()
        q["decoded_blur_laplacian"] = d["face_blur_laplacian"].describe().round(2).to_dict()
        q["overexposed_frames(>5% saturated)"] = int((d["face_overexposed_frac"] > 0.05).sum())
        q["underexposed_frames(>5% black)"] = int((d["face_underexposed_frac"] > 0.05).sum())
        # near-duplicates: Hamming distance between consecutive frames' dHash within a trial
        d = d.sort_values(["trial_id", "frame_index"])
        hd, corr = [], []
        for _, g in d.groupby("trial_id"):
            hs = g["face_dhash"].tolist()
            th = np.stack(g["face_thumb"].to_numpy())
            for a, b in zip(range(len(hs) - 1), range(1, len(hs))):
                hd.append(bin(int(hs[a]) ^ int(hs[b])).count("1"))
                corr.append(float(np.corrcoef(th[a], th[b])[0, 1]))
        if hd:
            q["adjacent_frame_dhash_hamming"] = pd.Series(hd).describe().round(2).to_dict()
            q["near_duplicate_rate_(hamming<=2)"] = round(float(np.mean(np.array(hd) <= 2)), 4)
            q["adjacent_frame_pixel_correlation"] = pd.Series(corr).describe().round(4).to_dict()
        # blink heuristic: eye crops much brighter than the trial median (lid covers iris)
        e = (d["left_eye_mean"] + d["right_eye_mean"]) / 2
        z = (e - d.groupby("trial_id")["left_eye_mean"].transform("median")) / \
            (d.groupby("participant_id")["left_eye_mean"].transform("std") + 1e-6)
        decoded.loc[:, "possible_blink"] = decoded["sample_id"].map(
            dict(zip(d["sample_id"], (z > 1.5).to_numpy())))
        q["possible_blink_frames"] = int((z > 1.5).sum())
        q["blink_heuristic"] = ("eye-crop mean intensity > 1.5 participant SD above the trial "
                                "median; a screening aid, not a validated blink detector")
    return q


def _coverage(master: pd.DataFrame, W: int, H: int) -> Dict:
    trials = master.drop_duplicates("trial_id")
    x = trials["target_x_norm"].to_numpy()
    y = trials["target_y_norm"].to_numpy()
    edge = (x < 0.1) | (x > 0.9) | (y < 0.1) | (y > 0.9)
    corner = ((x < 0.1) | (x > 0.9)) & ((y < 0.1) | (y > 0.9))
    center = (np.abs(x - 0.5) < 1 / 6) & (np.abs(y - 0.5) < 1 / 6)
    grid, _, _ = np.histogram2d(y, x, bins=[8, 8], range=[[0, 1], [0, 1]])
    loc = trials.groupby(["target_x_px", "target_y_px"]).size()
    return {"distinct_trials": int(len(trials)),
            "distinct_target_locations": int(len(loc)),
            "repeated_locations": int((loc > 1).sum()),
            "center_fraction": round(float(center.mean()), 4),
            "edge_fraction_(within_10%)": round(float(edge.mean()), 4),
            "corner_fraction": round(float(corner.mean()), 4),
            "x_range_norm": [round(float(x.min()), 4), round(float(x.max()), 4)],
            "y_range_norm": [round(float(y.min()), 4), round(float(y.max()), 4)],
            "trials_per_8x8_cell_min_max": [int(grid.min()), int(grid.max())],
            "imbalance_ratio_8x8": round(float(grid.max() / max(grid.min(), 1)), 2)}


# --------------------------------------------------------------------------
# figures and reports
# --------------------------------------------------------------------------
def make_audit_figures(res: AuditResult, cfg: Config, out_dir: Path) -> Dict[str, Path]:
    import matplotlib
    matplotlib.use("Agg", force=False)
    import matplotlib.pyplot as plt
    from .preprocessing import read_bgr
    from .visualization import boxplot
    W, H = cfg.screen_px
    m = res.master
    figs: Dict[str, Path] = {}
    trials = m.drop_duplicates("trial_id")

    fig, ax = plt.subplots(figsize=(9, 9 * H / W))
    hb = ax.hexbin(trials["target_x_px"], trials["target_y_px"], gridsize=24, extent=(0, W, 0, H),
                   cmap="viridis", mincnt=1)
    ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.set_aspect("equal")
    ax.set_title("Fixation-target coverage (one point per trial)")
    ax.set_xlabel("screen x (px, left to right)"); ax.set_ylabel("screen y (px, top to bottom)")
    fig.colorbar(hb, ax=ax, label="trials per cell")
    figs["target_heatmap"] = _fig_to_png(fig, out_dir / "audit_target_heatmap.png")

    fig, axes = plt.subplots(1, 2, figsize=(11, 3.5))
    axes[0].hist(trials["target_x_px"], bins=32, color="#4477aa"); axes[0].set_xlabel("target x (px)")
    axes[1].hist(trials["target_y_px"], bins=20, color="#cc6677"); axes[1].set_xlabel("target y (px)")
    for a in axes:
        a.set_ylabel("trials")
    fig.suptitle("Target coordinate histograms")
    figs["target_histograms"] = _fig_to_png(fig, out_dir / "audit_target_histograms.png")

    fig, axes = plt.subplots(1, 3, figsize=(14, 3.8))
    order = sorted(m["participant_id"].unique())
    boxplot(axes[0], [m.loc[m.participant_id == p, "brightness"] for p in order], order)
    axes[0].set_title("Face brightness (capture app)"); axes[0].set_ylabel("mean grey level (0-255)")
    boxplot(axes[1], [m.loc[m.participant_id == p, "sharpness"] for p in order], order)
    axes[1].set_title("Sharpness (variance of Laplacian)"); axes[1].set_yscale("log")
    axes[2].hist(m["latency_s"], bins=60, color="#228833")
    axes[2].set_title("Capture latency after target onset"); axes[2].set_xlabel("seconds")
    for a in axes[:2]:
        a.tick_params(axis="x", rotation=45)
    figs["quality_boxplots"] = _fig_to_png(fig, out_dir / "audit_quality.png")

    mid = np.array([[(l[0] + r[0]) / 2, (l[1] + r[1]) / 2] for l, r in
                    zip(m["left_eye_center"], m["right_eye_center"])])
    fig, ax = plt.subplots(figsize=(8, 4.5))
    for p in order:
        sel = (m["participant_id"] == p).to_numpy()
        ax.scatter(mid[sel, 0], mid[sel, 1], s=2, alpha=0.3, label=p)
    ax.set_xlim(0, int(m["raw_width"].iloc[0])); ax.set_ylim(int(m["raw_height"].iloc[0]), 0)
    ax.set_aspect("equal"); ax.legend(markerscale=6, fontsize=7, ncol=2)
    ax.set_title("Head-position coverage: eye midpoint in the camera image")
    ax.set_xlabel("camera x (px)"); ax.set_ylabel("camera y (px)")
    figs["head_position"] = _fig_to_png(fig, out_dir / "audit_head_position.png")

    # contact sheet: one random trial frame per participant-session (face crops)
    pick = (m.groupby(["participant_id", "session_id"]).sample(1, random_state=0)
             .sort_values(["participant_id", "session_id"]))
    sessions = sorted(pick["session_id"].unique())
    fig, axes = plt.subplots(len(order), len(sessions), squeeze=False,
                             figsize=(max(4.0, 1.6 * len(sessions)), 1.7 * len(order)))
    for i, p in enumerate(order):
        for j, s in enumerate(sessions):
            ax = axes[i, j]
            ax.axis("off")
            r = pick[(pick.participant_id == p) & (pick.session_id == s)]
            if len(r):
                try:
                    img = read_bgr(cfg.paths.dataset_root / r["face_path"].iloc[0])[:, :, ::-1]
                    ax.imshow(img)
                except IOError:
                    ax.text(0.5, 0.5, "unreadable", ha="center")
            if j == 0:
                ax.set_title(p, fontsize=8, loc="left")
    fig.suptitle("Face-crop contact sheet (rows: participants, columns: sessions)")
    figs["contact_sheet"] = _fig_to_png(fig, out_dir / "audit_contact_sheet.png")
    res.figures = figs
    return figs


def write_reports(res: AuditResult, cfg: Config) -> Dict[str, Path]:
    """Write dataset_audit.json/.html, exclusion_report.csv and the manifests."""
    cfg.paths.ensure_output_dirs()
    rep = cfg.paths.reports
    out: Dict[str, Path] = {}
    res.exclusions.to_csv(rep / "exclusion_report.csv", index=False)
    out["exclusions"] = rep / "exclusion_report.csv"
    manifests = write_split_manifests(cfg, res.master, res.exclusions)
    out.update({f"manifest_{k}": v for k, v in manifests.items()})
    summary = {
        "generated": now_iso(), "decision": res.decision,
        "critical": [f for f in res.findings if f["level"] == CRITICAL],
        "warnings": [f for f in res.findings if f["level"] == WARNING],
        "acceptable": [f for f in res.findings if f["level"] == OK],
        "counts": res.counts, "quality": res.quality, "coverage": res.coverage,
        "excluded_observations": int(res.exclusions["sample_id"].nunique()) if len(res.exclusions) else 0,
        "exclusion_reasons": res.exclusions["reason"].value_counts().to_dict() if len(res.exclusions) else {},
        "manifest_info": json.loads((cfg.paths.manifests / "manifest_info.json").read_text()),
        "geometry_available": {
            "camera_intrinsics": False, "lens_distortion": False,
            "camera_position_relative_to_monitor": False,
            "monitor_physical_size": cfg.monitor_mm is not None,
            "head_pose": "estimable only approximately (uncalibrated camera)",
            "face_landmarks": "eye centres stored; 5-point landmarks re-detected from raw frames",
            "target_screen_coordinates": True},
    }
    write_json(rep / "dataset_audit.json", summary)
    out["json"] = rep / "dataset_audit.json"
    out["html"] = _write_html(summary, res.figures, rep / "dataset_audit.html")
    return out


def _write_html(summary: Dict, figures: Dict[str, Path], path: Path) -> Path:
    def table(rows: List[Dict]) -> str:
        if not rows:
            return "<p>none</p>"
        cols = list(rows[0])
        head = "".join(f"<th>{c}</th>" for c in cols)
        body = "".join("<tr>" + "".join(f"<td>{r.get(c, '')}</td>" for c in cols) + "</tr>" for r in rows)
        return f"<table><tr>{head}</tr>{body}</table>"

    imgs = ""
    for name, p in figures.items():
        data = base64.b64encode(Path(p).read_bytes()).decode()
        imgs += f"<h3>{name.replace('_', ' ')}</h3><img src='data:image/png;base64,{data}'/>"
    color = "#2e7d32" if summary["decision"] == "PASS" else "#c62828"
    html = f"""<!doctype html><html><head><meta charset='utf-8'><title>Dataset audit</title>
<style>body{{font-family:Segoe UI,Arial,sans-serif;max-width:1150px;margin:24px auto;color:#222}}
table{{border-collapse:collapse;margin:8px 0;font-size:13px}}td,th{{border:1px solid #ccc;padding:4px 8px;text-align:left}}
th{{background:#f3f3f3}}.d{{background:{color};color:#fff;padding:14px;font-size:22px;font-weight:bold}}
img{{max-width:100%}}pre{{background:#f7f7f7;padding:8px;overflow:auto;font-size:12px}}</style></head><body>
<div class='d'>Training readiness: {summary['decision']}</div>
<p>Generated {summary['generated']}. Excluded observations: {summary['excluded_observations']}.</p>
<h2>Critical errors (training unsafe)</h2>{table(summary['critical'])}
<h2>Warnings (may affect accuracy)</h2>{table(summary['warnings'])}
<h2>Acceptable</h2>{table(summary['acceptable'])}
<h2>Counts</h2><p>{summary['counts']['note']}</p>
{table(summary['counts']['per_participant'])}{table(summary['counts']['per_split'])}
<h2>Exclusion reasons</h2><pre>{json.dumps(summary['exclusion_reasons'], indent=2)}</pre>
<h2>Label coverage</h2><pre>{json.dumps(summary['coverage'], indent=2)}</pre>
<h2>Image quality</h2><pre>{json.dumps(summary['quality'], indent=2, default=str)}</pre>
<h2>Geometry available for gaze-angle labels</h2><pre>{json.dumps(summary['geometry_available'], indent=2)}</pre>
<h2>Figures</h2>{imgs}</body></html>"""
    path.write_text(html, encoding="utf-8")
    return path
