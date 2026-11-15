"""Pausing, interrupted trials, relaunch and crash recovery."""
import json

from conftest import image_files, run_to_complete, run_until, step
from eyetrack import config as cfg
from eyetrack.integrity import PASS
from eyetrack.state_machine import State
from eyetrack.storage import SessionWriter, read_jsonl

N = cfg.FRAMES_PER_TARGET


def start_capturing(c, clock, frames):
    c.handle_space()
    assert run_until(c, clock, frames, lambda: c.state is State.CAPTURING)


def test_nothing_saved_and_counter_frozen_while_paused(make_controller, clock, frames, layout):
    c = make_controller(n=5)
    start_capturing(c, clock, frames)
    run_until(c, clock, frames, lambda: c.completed_count == 2)
    c.handle_space()                                     # pause
    files_before = image_files(layout.root)
    rows_before = len(c.writer.annotations())
    step(c, clock, frames, n=500)                        # 30 s paused, camera running
    assert c.state is State.PAUSED
    assert c.completed_count == 2
    assert c.current_target is None
    assert image_files(layout.root) == files_before
    assert len(c.writer.annotations()) == rows_before
    assert c.buffer == []


def test_interrupted_trial_is_restarted_without_partial_or_duplicate_samples(
        make_controller, clock, frames):
    c = make_controller(n=4)
    start_capturing(c, clock, frames)
    run_until(c, clock, frames, lambda: c.completed_count == 1)
    interrupted = c.current_target["target_index"]
    assert run_until(c, clock, frames, lambda: len(c.buffer) >= 4)   # mid-trial
    c.handle_space()                                     # pause mid-capture
    assert c.buffer == [] and c.stats["discarded_partial_frames"] >= 4
    assert interrupted not in c.writer.completed_targets()
    assert len(c.writer.annotations()) == 1 * N          # completed target preserved

    c.handle_space()                                     # resume
    run_until(c, clock, frames, lambda: c.state is State.CAPTURING)
    assert c.current_target["target_index"] == interrupted   # same trial restarts
    summary = run_to_complete(c, clock, frames)

    rows = c.writer.annotations()
    ids = [r["sample_id"] for r in rows]
    assert len(ids) == len(set(ids)) == 4 * N
    assert sum(r["target_index"] == interrupted for r in rows) == N
    assert len(image_files(c.writer.dir)) == 4 * N * 4
    assert summary["integrity_overall"] == PASS
    assert summary["incomplete_targets"] == []


def test_relaunch_starts_ready_and_resume_must_be_intentional(
        make_controller, clock, frames, layout):
    c1 = make_controller(mode=cfg.MODE_OFFICIAL, pid="P001", n=6)
    start_capturing(c1, clock, frames)
    run_until(c1, clock, frames, lambda: c1.completed_count == 3)
    run_until(c1, clock, frames, lambda: len(c1.buffer) >= 3)
    c1.shutdown()                                        # app closed mid-trial
    done_before = set(c1.writer.completed_targets())
    files_before = image_files(layout.root)
    assert len(done_before) == 3

    # --- relaunch -------------------------------------------------------
    c2 = make_controller(mode=cfg.MODE_OFFICIAL, pid="P001", n=6)
    assert c2.state is State.READY                       # never auto-resumes
    step(c2, clock, frames, n=200)
    assert image_files(layout.root) == files_before      # nothing recorded
    status = c2.existing_session_status()
    assert status == {"completed_targets": 3, "total_targets": 6, "complete": False}

    assert c2.handle_space() is None                     # no resume flag -> refused
    assert c2.state is State.READY
    assert "already exists" in c2.message
    assert image_files(layout.root) == files_before

    c3 = make_controller(mode=cfg.MODE_OFFICIAL, pid="P001", n=6, resume=True)
    assert c3.handle_space() == "start"
    assert set(c3.queue).isdisjoint(done_before) and len(c3.queue) == 3
    summary = run_to_complete(c3, clock, frames)
    assert summary["completed_targets"] == 6
    assert summary["valid_images_session"] == 6 * N
    assert summary["integrity_overall"] == PASS
    ids = [r["sample_id"] for r in c3.writer.annotations()]
    assert len(ids) == len(set(ids))


def test_crash_recovery_removes_partial_samples_and_orphans(
        make_controller, clock, frames, layout):
    c1 = make_controller(n=4)
    start_capturing(c1, clock, frames)
    run_until(c1, clock, frames, lambda: c1.completed_count == 2)
    sdir = c1.writer.dir
    rows = read_jsonl(sdir / "annotations.jsonl")

    # Simulate a hard crash in the middle of writing target 99 / the next trial:
    (sdir / "raw" / "PILOT-PILOT01_S01_T0099_F00.png").write_bytes(b"partial")
    (sdir / "left_eye" / "PILOT-PILOT01_S01_T0099_F00.png").write_bytes(b"partial")
    with open(sdir / "annotations.jsonl", "a", encoding="utf-8") as fh:
        partial = dict(rows[0], target_index=3, frame_index=0,
                       sample_id="PILOT-PILOT01_S01_T0003_F00")
        fh.write(json.dumps(partial) + "\n")             # 1 of 10 rows for target 3
        fh.write(json.dumps(rows[0]) + "\n")             # duplicated row
        fh.write('{"sample_id": "PILOT-PILOT01_S01_T0003_F01", "target_ind')  # truncated

    w = SessionWriter(layout, cfg.MODE_PILOT, "PILOT01", "S01")
    assert len(w.completed_targets()) == 2               # partial target not counted
    result = w.recover()
    assert result["orphan_files_removed"] == 2
    assert result["duplicate_rows_removed"] == 1
    assert result["corrupt_lines_removed"] == 1
    assert 3 in result["partial_targets_removed"]
    assert len(w.annotations()) == 2 * N
    assert len(image_files(sdir)) == 2 * N * 4

    c2 = make_controller(n=4, resume=True)
    assert c2.handle_space() == "start"
    summary = run_to_complete(c2, clock, frames)
    assert summary["valid_images_session"] == 4 * N
    assert summary["integrity_overall"] == PASS


def test_unusable_frames_are_rejected_and_target_left_incomplete(
        make_controller, clock, frames, detector):
    c = make_controller(n=2)
    start_capturing(c, clock, frames)
    run_until(c, clock, frames, lambda: c.completed_count == 1)
    detector.face_visible = False                        # participant looks away
    assert run_until(c, clock, frames, lambda: c.state is State.COMPLETE)
    summary = c.run_validation()
    assert summary["rejected_frames"] > 0
    assert summary["completed_targets"] == 1
    assert len(summary["incomplete_targets"]) == 1
    assert summary["valid_images_session"] == N          # nothing partial counted

    # "Continue incomplete collection": explicit resume of the same session
    detector.face_visible = True
    c2 = make_controller(n=2, resume=True)
    assert c2.handle_space() == "start"
    summary = run_to_complete(c2, clock, frames)
    assert summary["incomplete_targets"] == [] and summary["valid_images_session"] == 2 * N


def test_camera_loss_pauses_safely(make_controller, clock, frames):
    c = make_controller(n=3)
    start_capturing(c, clock, frames)
    run_until(c, clock, frames, lambda: len(c.buffer) >= 2)
    assert c.system_pause("camera_lost")
    assert c.state is State.PAUSED and c.buffer == []
