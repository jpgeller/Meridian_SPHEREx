"""Participant assignment, pilot isolation, file paths and integrity reports."""
import json
import os
from pathlib import Path

import cv2
import pytest

from conftest import MONITOR, image_files, run_to_complete, run_until
from eyetrack import config as cfg
from eyetrack import integrity
from eyetrack.integrity import FAIL, PASS
from eyetrack.layout import DatasetLayout, SplitViolation, split_for
from eyetrack.state_machine import State
from eyetrack.storage import read_jsonl
from eyetrack.targets import generate_targets

N = cfg.FRAMES_PER_TARGET


def collect(make_controller, clock, frames, **kw):
    c = make_controller(**kw)
    assert c.handle_space() == "start", c.message
    return c, run_to_complete(c, clock, frames)


# ----------------------------------------------------------------- assignment
def test_official_split_assignment():
    expected = {**{f"P{i:03d}": "train" for i in range(1, 7)},
                "P007": "validation", "P008": "validation",
                "P009": "test", "P010": "test"}
    assert cfg.OFFICIAL_SPLIT_ASSIGNMENT == expected
    for pid, split in expected.items():
        assert split_for(cfg.MODE_OFFICIAL, pid) == split
    with pytest.raises(ValueError):
        split_for(cfg.MODE_OFFICIAL, "P011")


@pytest.mark.parametrize("pid,split,forbidden", [
    ("P009", "test", ("train", "validation")),
    ("P007", "validation", ("train", "test")),
    ("P003", "train", ("validation", "test")),
])
def test_participant_images_only_enter_their_split(
        make_controller, clock, frames, layout, pid, split, forbidden):
    c, summary = collect(make_controller, clock, frames,
                         mode=cfg.MODE_OFFICIAL, pid=pid, n=2)
    assert summary["split"] == split
    files = image_files(layout.root)
    assert len(files) == 2 * N * 4
    for f in files:
        assert f.relative_to(layout.root).parts[:2] == (split, pid)
    for other in forbidden:
        assert image_files(layout.root / other) == []
        assert read_jsonl(layout.manifests_dir / f"{other}.jsonl") == []
    rows = read_jsonl(layout.manifests_dir / f"{split}.jsonl")
    assert len(rows) == 2 * N and {r["participant_id"] for r in rows} == {pid}
    for r in rows:                                    # manifest paths resolve
        for rel in r["images"].values():
            assert (layout.root / rel).is_file()


@pytest.mark.parametrize("pid,wrong", [("P009", "train"), ("P009", "validation"),
                                       ("P007", "train"), ("P007", "test")])
def test_writes_outside_assigned_split_are_refused(layout, pid, wrong):
    with pytest.raises(SplitViolation):
        layout.assert_session_path(layout.root / wrong / pid / "S01",
                                   cfg.MODE_OFFICIAL, pid)
    with pytest.raises(SplitViolation):
        layout.assert_session_path(layout.root / "pilot" / pid / "S01",
                                   cfg.MODE_OFFICIAL, pid)


def test_participant_cannot_exist_in_two_splits(make_controller, clock, frames, layout):
    (layout.root / "train" / "P009" / "S01").mkdir(parents=True)     # planted leak
    c = make_controller(mode=cfg.MODE_OFFICIAL, pid="P009", n=2)
    assert c.handle_space() is None
    assert c.state is State.READY and "P009" in c.message
    assert image_files(layout.root) == []


def test_participant_cannot_change_split_via_registry(layout):
    layout.ensure_structure()
    assert layout.lock_participant_split("P007") == "validation"
    layout.registry_file.write_text(json.dumps({"P007": "train"}), encoding="utf-8")
    with pytest.raises(SplitViolation):
        layout.lock_participant_split("P007")


# -------------------------------------------------------------- pilot isolation
def test_pilot_images_remain_separate(make_controller, clock, frames, layout):
    # Even when a pilot run uses an official-looking participant ID.
    c, summary = collect(make_controller, clock, frames,
                         mode=cfg.MODE_PILOT, pid="P009", n=5)
    assert summary["split"] == "pilot" and summary["remaining_to_5000"] is None
    files = image_files(layout.root)
    assert len(files) == 5 * N * 4
    assert all(f.relative_to(layout.root).parts[0] == "pilot" for f in files)
    for split in cfg.PRIMARY_SPLITS:
        assert image_files(layout.root / split) == []
    assert all(r["sample_id"].startswith("PILOT-") and r["mode"] == "pilot"
               for r in c.writer.annotations())

    # Official collection afterwards: manifests contain no pilot sample.
    collect(make_controller, clock, frames, mode=cfg.MODE_OFFICIAL, pid="P009", n=2)
    report = integrity.validate_dataset(layout)
    assert report["overall"] == PASS
    for split in cfg.PRIMARY_SPLITS:
        for r in read_jsonl(layout.manifests_dir / f"{split}.jsonl"):
            assert not r["sample_id"].startswith("PILOT-")
            assert not any(p.startswith("pilot/") for p in r["images"].values())
    assert report["participants"]["P009"]["valid_images"] == 2 * N   # pilot not counted


def test_pilot_uses_same_pipeline_as_official(make_controller, clock, frames):
    cp, _ = collect(make_controller, clock, frames, mode=cfg.MODE_PILOT, pid="PILOT01", n=2)
    co, _ = collect(make_controller, clock, frames, mode=cfg.MODE_OFFICIAL, pid="P001", n=2)
    rp, ro = cp.writer.annotations()[0], co.writer.annotations()[0]
    assert set(rp) == set(ro)
    assert cp.writer.read_metadata()["protocol"] == co.writer.read_metadata()["protocol"]
    assert {p.name for p in cp.writer.dir.iterdir()} == {p.name for p in co.writer.dir.iterdir()}


# ----------------------------------------------------------------------- paths
def test_default_root_is_project_relative_not_cwd(tmp_path, monkeypatch):
    project = Path(cfg.__file__).resolve().parent.parent
    monkeypatch.chdir(tmp_path)
    assert cfg.DEFAULT_DATASET_ROOT == project / "NASA_EyeTracking_Dataset"
    assert cfg.DEFAULT_DATASET_ROOT.is_absolute()
    assert cfg.load_dataset_root(tmp_path / "missing.json") == cfg.DEFAULT_DATASET_ROOT
    assert Path(os.getcwd()) not in cfg.DEFAULT_DATASET_ROOT.parents


def test_dataset_root_must_be_absolute_and_is_persisted(tmp_path):
    with pytest.raises(ValueError):
        DatasetLayout(Path("relative/dir"))
    settings = tmp_path / "settings.json"
    with pytest.raises(ValueError):
        cfg.save_dataset_root(Path("relative"), settings)
    saved = cfg.save_dataset_root(tmp_path / "custom_root", settings)
    assert cfg.load_dataset_root(settings) == saved == (tmp_path / "custom_root").resolve()


def test_displayed_directory_matches_saved_files(make_controller, clock, frames, layout):
    c, summary = collect(make_controller, clock, frames,
                         mode=cfg.MODE_OFFICIAL, pid="P002", n=2)
    shown_root = Path(summary["dataset_root"])
    assert shown_root.is_absolute() and shown_root == layout.root
    assert Path(summary["session_dir"]) == layout.root / "train" / "P002" / "S01"
    assert Path(summary["participant_dir"]) == layout.root / "train" / "P002"
    sdir = Path(summary["session_dir"])
    for r in c.writer.annotations():
        for rel in r["images"].values():
            assert not Path(rel).is_absolute() and ".." not in rel and "\\" not in rel
            assert shown_root in (sdir / rel).resolve().parents
            assert (sdir / rel).is_file()
    assert Path(c.writer.read_metadata()["dataset_root_at_creation"]) == shown_root
    assert Path(summary["report_path"]).parent == shown_root / "reports"


def test_folder_structure(make_controller, clock, frames, layout):
    c, _ = collect(make_controller, clock, frames, mode=cfg.MODE_OFFICIAL, pid="P001", n=2)
    for name in ("pilot", "train", "validation", "test", "manifests", "reports", "logs"):
        assert (layout.root / name).is_dir()
    for pid, split in cfg.OFFICIAL_SPLIT_ASSIGNMENT.items():
        assert (layout.root / split / pid).is_dir()
    assert {p.name for p in c.writer.dir.iterdir()} == {
        "raw", "face", "left_eye", "right_eye", "annotations.jsonl",
        "targets.json", "session_metadata.json", "quality_report.json"}
    assert any(layout.logs_dir.iterdir()) and any(layout.reports_dir.iterdir())


def test_existing_session_is_never_overwritten(make_controller, clock, frames, layout):
    collect(make_controller, clock, frames, n=2)
    before = {f: f.stat().st_mtime_ns for f in image_files(layout.root)}
    c = make_controller(n=2)                          # same participant + session
    assert c.handle_space() is None
    c = make_controller(n=2, resume=True)             # complete -> still refused
    assert c.handle_space() is None and "already complete" in c.message
    assert {f: f.stat().st_mtime_ns for f in image_files(layout.root)} == before


# --------------------------------------------------------------------- targets
def test_targets_are_deterministic_and_on_screen():
    a = generate_targets(25, 1920, 1080, "P001", "S01")
    assert a == generate_targets(25, 1920, 1080, "P001", "S01")
    assert a != generate_targets(25, 1920, 1080, "P001", "S02")
    assert [t["target_index"] for t in a] == list(range(25))
    assert len({(t["x_px"], t["y_px"]) for t in a}) == 25
    for t in a:
        assert 0 <= t["x_px"] < 1920 and 0 <= t["y_px"] < 1080
        assert t["x_norm"] == pytest.approx(t["x_px"] / 1920, abs=1e-6)
        assert t["y_norm"] == pytest.approx(t["y_px"] / 1080, abs=1e-6)


def test_resume_refused_on_different_monitor(make_controller, clock, frames):
    c = make_controller(n=3)
    c.handle_space()
    run_until(c, clock, frames, lambda: c.completed_count == 1)
    c.shutdown()
    other = dict(MONITOR, width_px=2560, height_px=1440)
    c2 = make_controller(n=3, resume=True, monitor=other)
    assert c2.handle_space() is None and "monitor" in c2.message


# ------------------------------------------------------------------- integrity
def checks_by_name(report):
    return {c["check"]: c["status"] for c in report["checks"]}


def test_pilot_integrity_report_all_pass(make_controller, clock, frames, layout):
    c = make_controller(n=5)
    c.handle_space()
    run_until(c, clock, frames, lambda: c.completed_count == 2)
    c.handle_space(); clock.advance(4); c.handle_space()         # pause + resume
    summary = run_to_complete(c, clock, frames)
    status = {x["check"]: x["status"] for x in summary["integrity_checks"]}
    assert status == {
        "images_saved": PASS,
        "both_eye_crops_created": PASS,
        "rgb_images_preserved": PASS,
        "fixation_targets_labeled_correctly": PASS,
        "space_shortcut_worked": PASS,
        "no_frames_recorded_while_paused": PASS,
        "target_map_matches_participant_monitor": PASS,
        "sample_ids_and_file_references_valid": PASS,
        "stored_in_assigned_split": PASS,
    }
    assert summary["integrity_overall"] == PASS
    assert Path(summary["report_path"]).is_file()
    assert "OVERALL: PASS" in Path(summary["report_path"]).read_text(encoding="utf-8")
    q = json.loads((c.writer.dir / "quality_report.json").read_text(encoding="utf-8"))
    assert q["pauses"] == 1 and q["resumes"] == 1 and q["valid_images"] == 5 * N


def test_raw_frames_are_stored_losslessly_in_colour(make_controller, clock, frames):
    c, _ = collect(make_controller, clock, frames, n=1)
    row = c.writer.annotations()[0]
    raw = cv2.imread(str(c.writer.dir / row["images"]["raw"]), cv2.IMREAD_UNCHANGED)
    assert raw.shape == (480, 640, 3)
    assert integrity.pixel_sha256(raw) == row["raw_pixel_sha256"]
    for key, size in (("face", cfg.FACE_CROP_SIZE), ("left_eye", cfg.EYE_CROP_SIZE),
                      ("right_eye", cfg.EYE_CROP_SIZE)):
        img = cv2.imread(str(c.writer.dir / row["images"][key]), cv2.IMREAD_UNCHANGED)
        assert img.shape == (size, size, 3)


def _validate(c, layout):
    return checks_by_name(integrity.validate_session(
        layout, c.writer.mode, c.writer.participant_id, c.writer.session_id))


def test_integrity_detects_missing_eye_crop(make_controller, clock, frames, layout):
    c, _ = collect(make_controller, clock, frames, n=2)
    row = c.writer.annotations()[3]
    (c.writer.dir / row["images"]["left_eye"]).unlink()
    status = _validate(c, layout)
    assert status["both_eye_crops_created"] == FAIL
    assert status["images_saved"] == FAIL
    assert status["sample_ids_and_file_references_valid"] == FAIL


def test_integrity_detects_altered_raw_frame(make_controller, clock, frames, layout):
    c, _ = collect(make_controller, clock, frames, n=1)
    path = c.writer.dir / c.writer.annotations()[0]["images"]["raw"]
    gray = cv2.cvtColor(cv2.imread(str(path)), cv2.COLOR_BGR2GRAY)
    cv2.imwrite(str(path), gray)
    assert _validate(c, layout)["rgb_images_preserved"] == FAIL


def test_integrity_detects_wrong_label_and_paused_frame(make_controller, clock, frames, layout):
    c, _ = collect(make_controller, clock, frames, n=2)
    rows = c.writer.annotations()
    rows[0]["target_x_px"] += 5
    rows[1]["capture_time"] += 10_000                 # after the session ended
    c.writer.annotations_file.write_text(
        "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    status = _validate(c, layout)
    assert status["fixation_targets_labeled_correctly"] == FAIL
    assert status["no_frames_recorded_while_paused"] == FAIL


def test_integrity_detects_monitor_mismatch(make_controller, clock, frames, layout):
    c, _ = collect(make_controller, clock, frames, n=1)
    c.writer.update_metadata(monitor=dict(MONITOR, width_px=1280, height_px=720))
    assert _validate(c, layout)["target_map_matches_participant_monitor"] == FAIL


def test_dataset_validation_detects_leak(make_controller, clock, frames, layout):
    collect(make_controller, clock, frames, mode=cfg.MODE_OFFICIAL, pid="P009", n=1)
    test_rows = (layout.manifests_dir / "test.jsonl").read_text(encoding="utf-8")
    (layout.manifests_dir / "train.jsonl").write_text(test_rows, encoding="utf-8")
    report = integrity.validate_dataset(layout)
    assert report["overall"] == FAIL
    assert checks_by_name(report)["manifests_respect_splits"] == FAIL
    integrity.rebuild_manifests(layout)               # rebuilding repairs it
    assert integrity.validate_dataset(layout)["overall"] == PASS


def test_remaining_to_5000_accumulates_over_sessions(make_controller, clock, frames):
    _, s1 = collect(make_controller, clock, frames, mode=cfg.MODE_OFFICIAL, pid="P004", n=3)
    assert s1["remaining_to_5000"] == 5000 - 3 * N
    _, s2 = collect(make_controller, clock, frames, mode=cfg.MODE_OFFICIAL,
                    pid="P004", sid="S02", n=2)
    assert s2["valid_images_participant"] == 5 * N
    assert s2["remaining_to_5000"] == 5000 - 5 * N
