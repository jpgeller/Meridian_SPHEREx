"""Manifest loading, split routing, leakage prevention, audit and test seal."""
import json

import numpy as np
import pandas as pd
import pytest

from conftest import FRAMES, SPLIT_OF, TRIALS


def test_config_paths_and_split_validation(synth, tmp_path):
    from src.config import Config, ConfigError
    assert synth.paths.dataset_root.is_absolute()
    assert synth.split_of("P009") == "test" and synth.split_of("P007") == "validation"
    raw = synth.to_dict()
    raw["splits"]["train"] = raw["splits"]["train"] + ["P009"]
    with pytest.raises(ConfigError):
        Config(raw, synth.source)                  # overlap train/test
    raw = synth.to_dict()
    raw["splits"]["validation"] = ["P007"]; raw["splits"]["test"] = ["P008", "P009", "P010"]
    with pytest.raises(ConfigError):
        Config(raw, synth.source)                  # differs from protocol, no justification


def test_manifest_counts_and_paths(synth):
    from src.dataset import build_master_manifest
    df, bad, infos, pilot = build_master_manifest(synth)
    assert len(df) == 10 * TRIALS * FRAMES
    assert df["trial_id"].nunique() == 10 * TRIALS
    assert len(pilot) == 1 and not df["session_dir"].str.startswith("pilot").any()
    assert bad == []
    for col in ("raw_path", "face_path", "left_eye_path", "right_eye_path"):
        assert not df[col].str.contains(r"\\").any()
        assert all((synth.paths.dataset_root / p).is_file() for p in df[col].head(20))
    # four image files per observation, grouped under ONE sample id
    assert df["sample_id"].is_unique


def test_malformed_lines_are_reported(synth):
    from src.dataset import build_master_manifest
    ann = synth.paths.dataset_root / "train" / "P001" / "S01" / "annotations.jsonl"
    ann.write_text(ann.read_text() + '{"sample_id": "broken"\n{"sample_id": "x"}\n')
    df, bad, _, _ = build_master_manifest(synth)
    assert len(bad) == 2
    assert {b["reason"].split(":")[0] for b in bad} == {"invalid_json", "missing_fields"}


def test_audit_passes_and_routes_splits(synth):
    from src.audit import run_audit, write_reports
    from src.dataset import load_split
    res = run_audit(synth, decode_mode="full", progress=False, max_threads=2)
    assert res.decision == "PASS", [f for f in res.findings if f["level"] == "CRITICAL"]
    write_reports(res, synth)
    tr = load_split(synth, "train"); va = load_split(synth, "validation")
    assert set(tr["participant_id"]) == {f"P00{i}" for i in range(1, 7)}
    assert set(va["participant_id"]) == {"P007", "P008"}
    assert "P009" not in set(tr["participant_id"]) | set(va["participant_id"])
    assert "P007" not in set(tr["participant_id"])
    test = pd.read_parquet(synth.paths.manifests / "test.parquet")
    assert set(test["participant_id"]) == {"P009", "P010"}
    assert "P007" not in set(test["participant_id"])
    audit = json.loads((synth.paths.reports / "dataset_audit.json").read_text())
    assert audit["decision"] == "PASS"
    assert (synth.paths.reports / "dataset_audit.html").is_file()


def test_test_split_is_sealed_and_gated(synth):
    from src.audit import run_audit, write_reports
    from src.dataset import TestSetSealed, load_split
    from src.evaluation import CONFIRMATION_PHRASE, close_test_gate, open_test_gate
    write_reports(run_audit(synth, decode_mode="none", progress=False), synth)
    with pytest.raises(TestSetSealed):
        load_split(synth, "test")
    with pytest.raises(TestSetSealed):
        load_split(synth, "test", test_unseal_token="guess")
    ckpt = synth.paths.checkpoints / "final.pt"
    ckpt.parent.mkdir(parents=True, exist_ok=True); ckpt.write_bytes(b"x")
    with pytest.raises(PermissionError):
        open_test_gate(synth, ckpt, "yes", {"run": "r"})
    token = open_test_gate(synth, ckpt, CONFIRMATION_PHRASE, {"run": "r"})
    assert set(load_split(synth, "test", token)["participant_id"]) == {"P009", "P010"}
    close_test_gate(synth, synth.paths.reports / "x.json")
    with pytest.raises(TestSetSealed):
        load_split(synth, "test", token)           # gate closed again
    with pytest.raises(PermissionError):
        open_test_gate(synth, ckpt, CONFIRMATION_PHRASE, {"run": "r"})   # second evaluation


def test_leakage_detection():
    from src.dataset import LeakageError, assert_no_leakage
    a = pd.DataFrame({"participant_id": ["P001"], "sample_id": ["s1"], "trial_id": ["t1"],
                      "raw_pixel_sha256": ["h1"]})
    b = pd.DataFrame({"participant_id": ["P009"], "sample_id": ["s2"], "trial_id": ["t2"],
                      "raw_pixel_sha256": ["h1"]})                 # same frame content!
    with pytest.raises(LeakageError):
        assert_no_leakage({"train": a, "test": b})
    b2 = b.assign(raw_pixel_sha256="h2", participant_id="P001")
    with pytest.raises(LeakageError):
        assert_no_leakage({"train": a, "test": b2})                 # same subject


def test_misfiled_participant_is_critical(synth):
    """P009 data placed under train/ must fail the audit."""
    import shutil
    from src.audit import run_audit
    src_dir = synth.paths.dataset_root / "test" / "P009"
    dst = synth.paths.dataset_root / "train" / "P009"
    shutil.copytree(src_dir, dst)
    res = run_audit(synth, decode_mode="none", progress=False)
    assert res.decision == "FAIL"
    assert any(f["check"] == "duplicates" and f["level"] == "CRITICAL" for f in res.findings) or \
           any(f["check"] == "split_mismatch" for f in res.findings)


def test_audit_excludes_bad_rows_with_reasons(synth):
    from src.audit import run_audit
    root = synth.paths.dataset_root
    (root / "train" / "P002" / "S01" / "left_eye" / "P002_S01_T0001_F03.png").unlink()
    ann = root / "train" / "P003" / "S01" / "annotations.jsonl"
    rows = [json.loads(l) for l in ann.read_text().splitlines()]
    rows[0]["capture_time"] = rows[0]["target_onset_time"] + 0.2          # before settle
    rows[11]["target_x_px"] = 99999                                        # off-screen
    ann.write_text("".join(json.dumps(r) + "\n" for r in rows))
    log = root / "logs" / "official_P004_S01_events.jsonl"
    r4 = [json.loads(l) for l in (root / "train/P004/S01/annotations.jsonl").read_text().splitlines()]
    t = r4[25]["capture_time"]
    log.write_text(log.read_text() + json.dumps({"time": t - 0.01, "event": "state", "from": "CAPTURING",
                                                 "to": "PAUSED"}) + "\n"
                   + json.dumps({"time": t + 0.01, "event": "state", "from": "PAUSED",
                                 "to": "CAPTURING"}) + "\n")
    res = run_audit(synth, decode_mode="none", progress=False)
    reasons = set(res.exclusions["reason"])
    assert "missing_file:left_eye" in reasons
    assert "captured_before_target_settle_time" in reasons
    assert "target_outside_screen_or_non_finite" in reasons
    assert "captured_while_paused" in reasons
    assert "same_trial_as_excluded_frame" in reasons     # whole trial excluded
    trial = res.exclusions[res.exclusions["sample_id"] == "P002_S01_T0001_F00"]
    assert len(trial)


def test_dataset_item_and_balanced_sampler(synth):
    from src.dataset import (FaceCropSource, GazeFrameDataset, ParticipantTrialBalancedSampler,
                             build_master_manifest, collate)
    df, *_ = build_master_manifest(synth)
    tr = df[df["assigned_split"] == "train"].reset_index(drop=True)
    ds = GazeFrameDataset(tr, FaceCropSource(synth.paths.dataset_root, tr["face_path"]))
    item = ds[5]
    assert item["image"].shape == (3, 224, 224) and str(item["image"].dtype) == "torch.uint8"
    assert np.allclose(item["target"].numpy(), tr.loc[5, ["target_x_norm", "target_y_norm"]].astype(float))
    with pytest.raises(ValueError):
        collate([])
    usable = np.ones(len(tr), bool); usable[:10] = False
    s = ParticipantTrialBalancedSampler(tr, usable, trials_per_participant=2, frames_per_trial=3, seed=1)
    idx = list(iter(s))
    picked = tr.iloc[idx]
    assert not set(idx) & set(range(10))
    assert picked.groupby("participant_id").size().nunique() == 1          # balanced
    assert picked.groupby("trial_id").size().max() <= 3
    s.set_epoch(1)
    assert list(iter(s)) != idx                                            # new draw each epoch
