"""Automated dataset-integrity validation and manifests.

This validates IMAGE CAPTURE (files, labels, synchronisation, split hygiene).
It says nothing about the accuracy of any gaze model - none exists here.
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional

import cv2

from . import config as cfg
from .layout import SESSION_SUBDIRS, DatasetLayout, sample_id, split_for
from .storage import now_iso, pixel_sha256, read_jsonl, write_json

PASS, FAIL, NA = "PASS", "FAIL", "N/A"


def _check(name: str, ok: Optional[bool], detail: str) -> Dict:
    status = NA if ok is None else (PASS if ok else FAIL)
    return {"check": name, "status": status, "detail": detail}


def pause_intervals(events: List[Dict]) -> List[List[float]]:
    """Time spans during which recording was NOT allowed, from the event log.
    Open spans (no later CAPTURING) extend to +infinity."""
    spans: List[List[float]] = []
    blocked_since: Optional[float] = None
    seen_any = False
    for e in events:
        if e.get("event") != "state":
            continue
        seen_any = True
        t, to = float(e["time"]), e.get("to")
        if to == "CAPTURING":
            if blocked_since is not None:
                spans.append([blocked_since, t])
                blocked_since = None
        elif blocked_since is None:
            blocked_since = t
    if blocked_since is not None:
        spans.append([blocked_since, float("inf")])
    if not seen_any:
        spans.append([float("-inf"), float("inf")])
    return spans


def validate_session(layout: DatasetLayout, mode: str, participant_id: str,
                     session_id: str, deep: bool = True) -> Dict:
    """Run every integrity check on one session and return the report."""
    sdir = layout.session_dir(mode, participant_id, session_id)
    checks: List[Dict] = []
    report = {"generated": now_iso(), "mode": mode, "participant_id": participant_id,
              "session_id": session_id, "split": split_for(mode, participant_id),
              "session_dir": str(sdir), "dataset_root": str(layout.root),
              "scope": "image-capture validation only (not gaze-model accuracy)",
              "checks": checks}

    try:
        meta = json.loads((sdir / "session_metadata.json").read_text(encoding="utf-8"))
        tdoc = json.loads((sdir / "targets.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        checks.append(_check("session_files_present", False, f"Cannot read session: {exc}"))
        report["overall"] = FAIL
        return report
    rows = read_jsonl(sdir / "annotations.jsonl")
    events = read_jsonl(layout.events_log(mode, participant_id, session_id))
    targets = {t["target_index"]: t for t in tdoc["targets"]}
    n_rows = len(rows)

    # 1-3. one streaming pass over the image files (nothing kept in memory)
    missing, undecodable = [], []
    bad_eyes = not_rgb = hash_mismatch = size_mismatch = 0
    for r in rows:
        for sub in SESSION_SUBDIRS:
            p = sdir / r["images"][sub]
            if not p.is_file() or p.stat().st_size == 0:
                missing.append(r["images"][sub])
                if sub in ("left_eye", "right_eye"):
                    bad_eyes += 1
                continue
            if not deep:
                continue
            img = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
            if img is None:
                undecodable.append(r["images"][sub])
                if sub in ("left_eye", "right_eye"):
                    bad_eyes += 1
                continue
            if img.ndim != 3 or img.shape[2] != 3:
                not_rgb += 1
            if sub in ("left_eye", "right_eye") and img.shape[:2] != (
                    cfg.EYE_CROP_SIZE, cfg.EYE_CROP_SIZE):
                bad_eyes += 1
            if sub == "raw":
                if img.shape[1] != r["raw_width"] or img.shape[0] != r["raw_height"]:
                    size_mismatch += 1
                if pixel_sha256(img) != r["raw_pixel_sha256"]:
                    hash_mismatch += 1
    checks.append(_check(
        "images_saved", n_rows > 0 and not missing and not undecodable,
        f"{n_rows} samples, {n_rows * 4 - len(missing)} of {n_rows * 4} image files present"
        + (f"; {len(undecodable)} unreadable" if undecodable else "")))
    checks.append(_check("both_eye_crops_created", n_rows > 0 and bad_eyes == 0,
                         f"{n_rows * 2 - bad_eyes} of {n_rows * 2} eye crops valid "
                         f"({cfg.EYE_CROP_SIZE}x{cfg.EYE_CROP_SIZE})"))
    if deep:
        checks.append(_check(
            "rgb_images_preserved",
            n_rows > 0 and not_rgb == 0 and hash_mismatch == 0 and size_mismatch == 0
            and not undecodable and not missing,
            f"{not_rgb} non-3-channel files, {hash_mismatch} raw frames differ from the "
            f"captured pixels, {size_mismatch} raw size mismatches"))
    else:
        checks.append(_check("rgb_images_preserved", None, "skipped (quick mode)"))

    # 4. fixation labels
    bad_labels = 0
    for r in rows:
        t = targets.get(r["target_index"])
        if (t is None or t["x_px"] != r["target_x_px"] or t["y_px"] != r["target_y_px"]
                or t["x_norm"] != r["target_x_norm"] or t["y_norm"] != r["target_y_norm"]
                or r["participant_id"] != participant_id or r["session_id"] != session_id
                or r["mode"] != mode or r["split"] != report["split"]
                or r["capture_time"] < r["target_onset_time"]):
            bad_labels += 1
    per_target = Counter(r["target_index"] for r in rows)
    wrong_count = [t for t, n in per_target.items() if n != cfg.FRAMES_PER_TARGET]
    checks.append(_check(
        "fixation_targets_labeled_correctly",
        n_rows > 0 and bad_labels == 0 and not wrong_count,
        f"{bad_labels} rows disagree with targets.json; "
        f"{len(wrong_count)} targets without exactly {cfg.FRAMES_PER_TARGET} frames"))

    # 5. SPACE shortcut
    space = [e for e in events if e.get("event") == "space"]
    actions = Counter(e.get("action") for e in space)
    checks.append(_check(
        "space_shortcut_worked", actions.get("start", 0) >= 1,
        f"start x{actions.get('start', 0)}, pause x{actions.get('pause', 0)}, "
        f"resume x{actions.get('resume', 0)}"
        + ("" if actions.get("pause") else " (pause/resume not exercised in this session)")))

    # 6. nothing recorded while paused
    spans = pause_intervals(events)
    in_pause = sum(1 for r in rows
                   if any(a < r["capture_time"] < b for a, b in spans))
    wrong_state = sum(1 for r in rows if r.get("state_at_capture") != "CAPTURING")
    blocked = sum(1 for e in events if e.get("event") == "blocked_save")
    checks.append(_check(
        "no_frames_recorded_while_paused",
        in_pause == 0 and wrong_state == 0 and blocked == 0,
        f"{in_pause} frames inside non-capturing intervals, {wrong_state} frames with a "
        f"non-CAPTURING state, {blocked} blocked save attempts"))

    # 7. target map vs participant monitor
    mon = meta.get("monitor", {})
    w, h = tdoc.get("screen_width_px"), tdoc.get("screen_height_px")
    out_of_bounds = [t["target_index"] for t in tdoc["targets"]
                     if not (0 <= t["x_px"] < w and 0 <= t["y_px"] < h)]
    bad_norm = [t["target_index"] for t in tdoc["targets"]
                if abs(t["x_norm"] - t["x_px"] / w) > 1e-5 or abs(t["y_norm"] - t["y_px"] / h) > 1e-5]
    row_screen = all(r["screen_width_px"] == w and r["screen_height_px"] == h for r in rows)
    monitor_ok = (mon.get("width_px") == w and mon.get("height_px") == h)
    checks.append(_check(
        "target_map_matches_participant_monitor",
        monitor_ok and not out_of_bounds and not bad_norm and row_screen,
        f"targets.json {w}x{h} vs monitor {mon.get('width_px')}x{mon.get('height_px')}; "
        f"{len(out_of_bounds)} targets off-screen, {len(bad_norm)} inconsistent "
        f"normalised coordinates"))

    # 8. sample IDs and file references
    ids = [r["sample_id"] for r in rows]
    dup_ids = [i for i, n in Counter(ids).items() if n > 1]
    bad_ids = sum(1 for r in rows if r["sample_id"] != sample_id(
        mode, participant_id, session_id, r["target_index"], r["frame_index"]))
    bad_paths = 0
    referenced = set()
    for r in rows:
        for sub in SESSION_SUBDIRS:
            rel = r["images"][sub]
            referenced.add(rel)
            if (Path(rel).is_absolute() or ".." in Path(rel).parts or "\\" in rel
                    or rel != f"{sub}/{r['sample_id']}{cfg.IMAGE_EXT}"):
                bad_paths += 1
    orphans = [f"{sub}/{f.name}" for sub in SESSION_SUBDIRS if (sdir / sub).is_dir()
               for f in (sdir / sub).iterdir() if f"{sub}/{f.name}" not in referenced]
    checks.append(_check(
        "sample_ids_and_file_references_valid",
        n_rows > 0 and not dup_ids and bad_ids == 0 and bad_paths == 0
        and not missing and not orphans,
        f"{len(dup_ids)} duplicate IDs, {bad_ids} malformed IDs, {bad_paths} invalid "
        f"relative paths, {len(missing)} dangling references, {len(orphans)} "
        f"unreferenced files"))

    # 9. storage location / split hygiene
    expected = layout.participant_dir(mode, participant_id).resolve()
    in_place = expected in sdir.resolve().parents
    other_splits = [s for s in layout.splits_containing(participant_id)
                    if s != report["split"]] if mode == cfg.MODE_OFFICIAL else []
    checks.append(_check(
        "stored_in_assigned_split", in_place and not other_splits,
        f"session is under {layout.relative(expected)}"
        + (f"; participant ALSO found in {other_splits}" if other_splits else "")))

    report["summary"] = {
        "valid_images": n_rows,
        "completed_targets": sorted(t for t, n in per_target.items()
                                    if n == cfg.FRAMES_PER_TARGET),
        "total_targets": len(targets),
    }
    report["overall"] = FAIL if any(c["status"] == FAIL for c in checks) else PASS
    return report


def save_session_report(layout: DatasetLayout, report: Dict) -> Path:
    layout.reports_dir.mkdir(parents=True, exist_ok=True)
    name = f"{report['mode']}_{report['participant_id']}_{report['session_id']}_integrity"
    write_json(layout.reports_dir / f"{name}.json", report)
    lines = [
        "NASA Eye-Tracking dataset - session integrity report",
        f"Generated      : {report['generated']}",
        f"Mode           : {report['mode']}",
        f"Participant    : {report['participant_id']}    Split: {report['split']}",
        f"Session        : {report['session_id']}",
        f"Session folder : {report['session_dir']}",
        f"Scope          : {report['scope']}",
        "",
    ]
    for c in report["checks"]:
        lines.append(f"[{c['status']:>4}] {c['check']}")
        lines.append(f"       {c['detail']}")
    lines += ["", f"OVERALL: {report.get('overall', FAIL)}", ""]
    txt = layout.reports_dir / f"{name}.txt"
    txt.write_text("\n".join(lines), encoding="utf-8")
    return txt


# --------------------------------------------------------------------------
# Dataset-level: manifests and split-leak checks (official data only)
# --------------------------------------------------------------------------
def participant_valid_images(layout: DatasetLayout, mode: str, participant_id: str) -> int:
    total = 0
    for sdir in layout.list_sessions(mode, participant_id):
        per_target = Counter(r["target_index"] for r in read_jsonl(sdir / "annotations.jsonl"))
        total += sum(n for n in per_target.values() if n == cfg.FRAMES_PER_TARGET)
    return total


def rebuild_manifests(layout: DatasetLayout) -> Dict:
    """Rebuild manifests/{train,validation,test}.jsonl from official sessions.
    Pilot data is never read here, so it can never enter a manifest."""
    layout.manifests_dir.mkdir(parents=True, exist_ok=True)
    summary = {"generated": now_iso(), "dataset_root": str(layout.root), "splits": {}}
    for split in cfg.PRIMARY_SPLITS:
        rows_out: List[str] = []
        per_participant: Dict[str, int] = defaultdict(int)
        for pid, assigned in cfg.OFFICIAL_SPLIT_ASSIGNMENT.items():
            if assigned != split:
                continue
            for sdir in layout.list_sessions(cfg.MODE_OFFICIAL, pid):
                rel = layout.relative(sdir)
                rows = read_jsonl(sdir / "annotations.jsonl")
                per_target = Counter(r["target_index"] for r in rows)
                for r in rows:
                    if per_target[r["target_index"]] != cfg.FRAMES_PER_TARGET:
                        continue
                    if r["mode"] != cfg.MODE_OFFICIAL or r["participant_id"] != pid:
                        continue
                    entry = {k: r[k] for k in (
                        "sample_id", "participant_id", "session_id", "split",
                        "target_index", "frame_index", "target_x_px", "target_y_px",
                        "target_x_norm", "target_y_norm",
                        "screen_width_px", "screen_height_px")}
                    entry["images"] = {k: f"{rel}/{v}" for k, v in r["images"].items()}
                    rows_out.append(json.dumps(entry))
                    per_participant[pid] += 1
        (layout.manifests_dir / f"{split}.jsonl").write_text(
            "".join(line + "\n" for line in rows_out), encoding="utf-8")
        summary["splits"][split] = {"samples": len(rows_out),
                                    "participants": dict(sorted(per_participant.items()))}
    write_json(layout.manifests_dir / "summary.json", summary)
    return summary


def validate_dataset(layout: DatasetLayout) -> Dict:
    """Split-leak and pilot-isolation checks across the whole dataset root."""
    checks: List[Dict] = []

    misplaced = []
    for split in cfg.PRIMARY_SPLITS:
        sroot = layout.root / split
        if not sroot.is_dir():
            continue
        for pdir in sroot.iterdir():
            if not pdir.is_dir():
                continue
            has_data = any(c.is_dir() for c in pdir.iterdir())
            if cfg.OFFICIAL_SPLIT_ASSIGNMENT.get(pdir.name) != split and (
                    has_data or pdir.name not in cfg.OFFICIAL_SPLIT_ASSIGNMENT):
                misplaced.append(f"{split}/{pdir.name}")
    checks.append(_check("participants_in_assigned_split_only", not misplaced,
                         "all participant folders match the fixed assignment"
                         if not misplaced else f"misplaced: {misplaced}"))

    multi = {pid: layout.splits_containing(pid) for pid in cfg.OFFICIAL_PARTICIPANTS}
    multi = {p: s for p, s in multi.items() if len(s) > 1}
    checks.append(_check("no_participant_in_multiple_splits", not multi,
                         "subject-disjoint" if not multi else f"violations: {multi}"))

    leaks, pilot_rows, dup = [], 0, 0
    seen = set()
    for split in cfg.PRIMARY_SPLITS:
        for row in read_jsonl(layout.manifests_dir / f"{split}.jsonl"):
            pid = row.get("participant_id")
            if cfg.OFFICIAL_SPLIT_ASSIGNMENT.get(pid) != split or row.get("split") != split:
                leaks.append(f"{row.get('sample_id')} in {split}.jsonl")
            paths = list(row.get("images", {}).values())
            if (str(row.get("sample_id", "")).startswith("PILOT-")
                    or any(p.startswith("pilot/") for p in paths)):
                pilot_rows += 1
            if any(not p.startswith(f"{split}/{pid}/") for p in paths):
                leaks.append(f"{row.get('sample_id')} path outside {split}/{pid}")
            if row.get("sample_id") in seen:
                dup += 1
            seen.add(row.get("sample_id"))
    checks.append(_check("manifests_respect_splits", not leaks and dup == 0,
                         f"{len(leaks)} leaked rows, {dup} duplicate sample IDs across manifests"))
    checks.append(_check("pilot_data_not_in_manifests", pilot_rows == 0,
                         f"{pilot_rows} pilot rows found in official manifests"))

    official_in_pilot = []
    if layout.pilot_dir.is_dir():
        for ann in layout.pilot_dir.glob("*/*/annotations.jsonl"):
            if any(r.get("mode") != cfg.MODE_PILOT or r.get("split") != cfg.SPLIT_PILOT
                   for r in read_jsonl(ann)):
                official_in_pilot.append(layout.relative(ann))
    pilot_in_official = []
    for split in cfg.PRIMARY_SPLITS:
        for ann in (layout.root / split).glob("*/*/annotations.jsonl"):
            if any(r.get("mode") != cfg.MODE_OFFICIAL for r in read_jsonl(ann)):
                pilot_in_official.append(layout.relative(ann))
    checks.append(_check("pilot_and_official_storage_separate",
                         not official_in_pilot and not pilot_in_official,
                         f"{len(pilot_in_official)} official folders contain pilot rows, "
                         f"{len(official_in_pilot)} pilot folders contain official rows"))

    report = {"generated": now_iso(), "dataset_root": str(layout.root), "checks": checks,
              "participants": {pid: {
                  "split": cfg.OFFICIAL_SPLIT_ASSIGNMENT[pid],
                  "valid_images": participant_valid_images(layout, cfg.MODE_OFFICIAL, pid),
                  "target": cfg.TARGET_VALID_IMAGES_PER_PARTICIPANT}
                  for pid in cfg.OFFICIAL_PARTICIPANTS},
              "overall": FAIL if any(c["status"] == FAIL for c in checks) else PASS}
    layout.reports_dir.mkdir(parents=True, exist_ok=True)
    write_json(layout.reports_dir / "dataset_integrity.json", report)
    return report
