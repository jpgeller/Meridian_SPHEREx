"""Dataset discovery, manifests, split routing, the sealed test set, PyTorch
datasets and samplers.

Key facts about the data (checked against the real annotations.jsonl):

* One annotation row = ONE labelled camera frame = one observation. It points
  to four image files (raw, face, left_eye, right_eye) that are four views of
  the SAME frame, not four observations.
* Ten consecutive frames share one fixation target (a "trial"). They are
  strongly correlated, so statistics and sampling are organised by trial.
* `left_eye`/`right_eye` are the participant's own anatomical eyes.

Images are never copied: manifests store paths relative to the dataset root.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .config import Config

IMAGE_KINDS = ("raw", "face", "left_eye", "right_eye")
REQUIRED_FIELDS = (
    "sample_id", "participant_id", "session_id", "mode", "split", "target_index",
    "frame_index", "target_x_px", "target_y_px", "target_x_norm", "target_y_norm",
    "screen_width_px", "screen_height_px", "target_onset_time", "capture_time",
    "state_at_capture", "images", "raw_width", "raw_height", "raw_pixel_sha256",
    "face_box", "left_eye_box", "right_eye_box", "left_eye_center", "right_eye_center",
    "quality")


class TestSetSealed(PermissionError):
    """Raised whenever code tries to read test data outside the final gate."""


class LeakageError(AssertionError):
    pass


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------
def discover_sessions(dataset_root: Path) -> Tuple[List[Path], List[Path]]:
    """Find every session folder (one that has annotations.jsonl) at ANY depth.

    Returns (official_session_dirs, pilot_session_dirs). Pilot data is
    recognised by living under a top-level 'pilot' folder and is never routed
    into train/validation/test."""
    root = Path(dataset_root)
    if not root.is_dir():
        raise FileNotFoundError(f"Dataset root not found: {root}")
    official, pilot = [], []
    for ann in sorted(root.rglob("annotations.jsonl")):
        rel = ann.parent.relative_to(root)
        (pilot if rel.parts and rel.parts[0].lower() == "pilot" else official).append(ann.parent)
    return official, pilot


def _flatten(row: Dict, session_rel: str, line_no: int) -> Dict:
    imgs = row["images"]
    q = row.get("quality", {}) or {}
    out = {
        "sample_id": row["sample_id"],
        "participant_id": row["participant_id"],
        "session_id": row["session_id"],
        "recorded_split": row["split"],
        "mode": row["mode"],
        "target_index": int(row["target_index"]),
        "frame_index": int(row["frame_index"]),
        "trial_id": f"{row['participant_id']}_{row['session_id']}_T{int(row['target_index']):04d}",
        "target_x_px": float(row["target_x_px"]),
        "target_y_px": float(row["target_y_px"]),
        "target_x_norm": float(row["target_x_norm"]),
        "target_y_norm": float(row["target_y_norm"]),
        "screen_width_px": int(row["screen_width_px"]),
        "screen_height_px": int(row["screen_height_px"]),
        "target_onset_time": float(row["target_onset_time"]),
        "capture_time": float(row["capture_time"]),
        "latency_s": float(row["capture_time"]) - float(row["target_onset_time"]),
        "state_at_capture": row["state_at_capture"],
        "session_dir": session_rel,
        "raw_width": int(row["raw_width"]),
        "raw_height": int(row["raw_height"]),
        "raw_pixel_sha256": row["raw_pixel_sha256"],
        "face_box": list(row["face_box"]),
        "left_eye_box": list(row["left_eye_box"]),
        "right_eye_box": list(row["right_eye_box"]),
        "left_eye_center": [float(v) for v in row["left_eye_center"]],
        "right_eye_center": [float(v) for v in row["right_eye_center"]],
        "detector": row.get("detector"),
        "face_score": q.get("face_score"),
        "sharpness": q.get("sharpness"),
        "brightness": q.get("brightness"),
        "annotation_line": line_no,
    }
    for k in IMAGE_KINDS:
        out[f"{k}_path"] = f"{session_rel}/{imgs[k]}"
    return out


def read_session(session_dir: Path, dataset_root: Path) -> Tuple[List[Dict], List[Dict], Dict]:
    """Parse one session. Returns (rows, malformed_lines, session_info)."""
    session_rel = session_dir.relative_to(dataset_root).as_posix()
    rows, bad = [], []
    with open(session_dir / "annotations.jsonl", "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except ValueError as exc:
                bad.append({"session_dir": session_rel, "line": line_no, "reason": f"invalid_json:{exc}"})
                continue
            missing = [f for f in REQUIRED_FIELDS if f not in r]
            if missing:
                bad.append({"session_dir": session_rel, "line": line_no,
                            "sample_id": r.get("sample_id"), "reason": f"missing_fields:{missing}"})
                continue
            try:
                rows.append(_flatten(r, session_rel, line_no))
            except (TypeError, ValueError, KeyError) as exc:
                bad.append({"session_dir": session_rel, "line": line_no,
                            "sample_id": r.get("sample_id"), "reason": f"bad_value:{exc}"})
    info: Dict = {"session_dir": session_rel}
    for name in ("session_metadata.json", "targets.json", "quality_report.json"):
        p = session_dir / name
        try:
            info[name] = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            info[name] = None
            info.setdefault("errors", []).append(f"{name}: {exc}")
    return rows, bad, info


def build_master_manifest(cfg: Config) -> Tuple[pd.DataFrame, List[Dict], List[Dict], List[Path]]:
    """Index every official observation (no images are opened here).

    Returns (master_df, malformed_lines, session_infos, pilot_session_dirs)."""
    root = cfg.paths.dataset_root
    official, pilot = discover_sessions(root)
    all_rows, all_bad, infos = [], [], []
    for sdir in official:
        rows, bad, info = read_session(sdir, root)
        all_rows += rows
        all_bad += bad
        infos.append(info)
    df = pd.DataFrame(all_rows)
    if df.empty:
        raise RuntimeError(f"No annotation rows found under {root}")
    df["assigned_split"] = df["participant_id"].map(
        lambda p: cfg.split_of(p) if any(p in v for v in cfg.splits.values()) else "unassigned")
    df = df.sort_values(["participant_id", "session_id", "target_index", "frame_index"]
                        ).reset_index(drop=True)
    return df, all_bad, infos, pilot


def manifest_hash(df: pd.DataFrame) -> str:
    """Content hash of the identifying columns (recorded with every run)."""
    cols = ["sample_id", "participant_id", "session_id", "target_x_px", "target_y_px",
            "raw_path", "raw_pixel_sha256"]
    blob = df[cols].to_csv(index=False).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


# --------------------------------------------------------------------------
# Split routing and leakage checks
# --------------------------------------------------------------------------
def assert_no_leakage(splits: Dict[str, pd.DataFrame]) -> Dict[str, object]:
    """Hard assertions that the three splits are disjoint by subject, by
    sample ID, by trial and by exact raw-frame content."""
    names = list(splits)
    report: Dict[str, object] = {}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            da, db = splits[a], splits[b]
            for col, label in (("participant_id", "subjects"), ("sample_id", "sample_ids"),
                               ("trial_id", "trials"), ("raw_pixel_sha256", "raw_frame_hashes")):
                inter = set(da[col]) & set(db[col])
                report[f"{a}_x_{b}_{label}"] = len(inter)
                if inter:
                    raise LeakageError(f"{label} shared between {a} and {b}: "
                                       f"{sorted(inter)[:5]}{' ...' if len(inter) > 5 else ''}")
    for name, df in splits.items():
        if df["sample_id"].duplicated().any():
            raise LeakageError(f"Duplicate sample IDs inside {name}")
    return report


def write_split_manifests(cfg: Config, master: pd.DataFrame, exclusions: pd.DataFrame
                          ) -> Dict[str, Path]:
    """Write master + per-split parquet manifests (paths only, no images)."""
    out = cfg.paths.manifests
    out.mkdir(parents=True, exist_ok=True)
    excluded = set(exclusions["sample_id"]) if len(exclusions) else set()
    master = master.copy()
    master["excluded"] = master["sample_id"].isin(excluded)
    paths = {"master": out / "master_manifest.parquet"}
    master.to_parquet(paths["master"], index=False)
    usable = master[~master["excluded"]]
    parts = {}
    for split, members in cfg.splits.items():
        part = usable[usable["participant_id"].isin(members)].reset_index(drop=True)
        # Every row must agree three ways: config, folder it was recorded in, row label.
        bad = part[(part["assigned_split"] != split) | (part["recorded_split"] != split)]
        if len(bad):
            raise LeakageError(f"{len(bad)} rows of {split} were recorded under a different split")
        parts[split] = part
    leakage = assert_no_leakage(parts)
    for split, part in parts.items():
        paths[split] = out / f"{split}.parquet"
        part.to_parquet(paths[split], index=False)
    meta = {"manifest_hash": manifest_hash(usable), "rows": {k: len(v) for k, v in parts.items()},
            "participants": {k: sorted(v["participant_id"].unique()) for k, v in parts.items()},
            "trials": {k: int(v["trial_id"].nunique()) for k, v in parts.items()},
            "excluded_rows": int(master["excluded"].sum()), "leakage_checks": leakage,
            "dataset_root": str(cfg.paths.dataset_root)}
    (out / "manifest_info.json").write_text(json.dumps(meta, indent=2, default=str), encoding="utf-8")
    return paths


# --------------------------------------------------------------------------
# The sealed test set
# --------------------------------------------------------------------------
TEST_GATE_FILE = "test_gate_open.json"


def load_split(cfg: Config, split: str, test_unseal_token: Optional[str] = None) -> pd.DataFrame:
    """Load a split manifest. The test split needs the token issued by
    evaluation.open_test_gate() (only called from notebook 06)."""
    if split == "test":
        gate = cfg.paths.reports / TEST_GATE_FILE
        if not cfg["test_set"].get("sealed", True):
            pass
        elif test_unseal_token is None or not gate.is_file() or \
                json.loads(gate.read_text(encoding="utf-8")).get("token") != test_unseal_token:
            raise TestSetSealed(
                "The test set is sealed. It may only be loaded by 06_Final_Test_Evaluation.ipynb "
                "after the model is frozen and the confirmation gate is passed.")
    path = cfg.paths.manifests / f"{split}.parquet"
    if not path.is_file():
        raise FileNotFoundError(f"{path} not found - run notebook 01 first.")
    df = pd.read_parquet(path)
    if set(df["participant_id"]) - set(cfg.splits[split]):
        raise LeakageError(f"{path} contains participants outside {split}")
    return df


def require_audit_pass(cfg: Config) -> Dict:
    """Fail fast if the dataset audit has not passed."""
    p = cfg.paths.reports / "dataset_audit.json"
    if not p.is_file():
        raise RuntimeError("reports/dataset_audit.json not found - run 01_Dataset_Audit first.")
    audit = json.loads(p.read_text(encoding="utf-8"))
    if audit.get("decision") != "PASS":
        raise RuntimeError(f"Dataset audit decision is {audit.get('decision')!r}; training is "
                           f"blocked. Critical issues: {audit.get('critical', [])[:5]}")
    return audit


# --------------------------------------------------------------------------
# Image sources
# --------------------------------------------------------------------------
class NormalizedCacheSource:
    """Reads normalised faces from the uint8 memmap built by preprocessing.
    Opened lazily in each DataLoader worker (memmaps do not pickle)."""

    def __init__(self, images_path: Path, geometry_path: Path, sample_ids: Sequence[str]):
        self.images_path = Path(images_path)
        geo = pd.read_parquet(geometry_path)
        if list(geo["sample_id"]) != list(sample_ids):
            raise ValueError(f"Cache {geometry_path} is out of sync with the manifest - rebuild it.")
        self.ok = geo["norm_ok"].to_numpy(bool)
        self._arr = None

    def __call__(self, pos: int) -> np.ndarray:
        if self._arr is None:
            self._arr = np.load(self.images_path, mmap_mode="r")
        return np.array(self._arr[pos])          # writable copy (memmap rows are read-only)

    def __getstate__(self):
        s = self.__dict__.copy()
        s["_arr"] = None
        return s


class FaceCropSource:
    """The capture app's own 224x224 face crops (comparison input mode)."""

    def __init__(self, dataset_root: Path, face_paths: Sequence[str]):
        self.root = Path(dataset_root)
        self.paths = list(face_paths)
        self.ok = np.ones(len(self.paths), dtype=bool)

    def __call__(self, pos: int) -> np.ndarray:
        from .preprocessing import read_face_crop_rgb
        return read_face_crop_rgb(self.root / self.paths[pos])


# --------------------------------------------------------------------------
# PyTorch dataset
# --------------------------------------------------------------------------
class GazeFrameDataset:
    """Returns uint8 CHW images (normalised on the GPU, which is faster) plus
    normalised targets. Augmentation, if enabled, is applied here and only
    when `train=True`."""

    def __init__(self, manifest: pd.DataFrame, source, train: bool = False,
                 aug_cfg: Optional[Dict] = None, seed: int = 0):
        self.m = manifest.reset_index(drop=True)
        self.source = source
        self.train = train
        self.aug = aug_cfg if (train and aug_cfg and aug_cfg.get("enabled")) else None
        self.seed = seed
        self.targets = self.m[["target_x_norm", "target_y_norm"]].to_numpy(np.float32)
        if not np.isfinite(self.targets).all():
            raise ValueError("Non-finite targets in manifest")
        self.usable = np.asarray(source.ok, dtype=bool)

    def __len__(self) -> int:
        return len(self.m)

    def __getitem__(self, pos: int):
        import torch
        img = self.source(pos)
        if self.aug is not None:
            from .preprocessing import photometric_augment
            rng = np.random.default_rng((self.seed, pos, np.random.randint(1 << 30)))
            img = photometric_augment(img, self.aug, rng)
        return {"image": torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1),
                "target": torch.tensor(self.targets[pos]),
                "index": pos}


def collate(batch: List[Dict]):
    import torch
    if len(batch) == 0:
        raise ValueError("Empty batch")
    return {"image": torch.stack([b["image"] for b in batch]),
            "target": torch.stack([b["target"] for b in batch]),
            "index": torch.as_tensor([b["index"] for b in batch])}


# --------------------------------------------------------------------------
# Samplers
# --------------------------------------------------------------------------
class ParticipantTrialBalancedSampler:
    """Each epoch: for every participant draw `trials_per_participant` trials
    (sessions balanced), then `frames_per_trial` frames of each trial. Every
    participant contributes equally and no session dominates; the 10
    near-duplicate frames of a trial are never all used at once.

    Only rows marked usable (normalisation succeeded) are drawn."""

    def __init__(self, manifest: pd.DataFrame, usable: np.ndarray, trials_per_participant: int,
                 frames_per_trial: int, seed: int = 0):
        self.frames_per_trial = int(frames_per_trial)
        self.trials_per_participant = int(trials_per_participant)
        self.seed = seed
        self.epoch = 0
        m = manifest.reset_index(drop=True)
        idx = np.arange(len(m))[np.asarray(usable, bool)]
        sub = m.iloc[idx]
        self.structure: Dict[str, Dict[str, List[np.ndarray]]] = {}
        for (pid, sid, _tid), g in sub.groupby(["participant_id", "session_id", "trial_id"]):
            self.structure.setdefault(pid, {}).setdefault(sid, []).append(g.index.to_numpy())
        if not self.structure:
            raise ValueError("No usable rows for the sampler")

    def set_epoch(self, epoch: int) -> None:
        self.epoch = epoch

    def _draw(self) -> List[int]:
        rng = np.random.default_rng((self.seed, self.epoch))
        out: List[int] = []
        for pid in sorted(self.structure):
            sessions = self.structure[pid]
            sids = sorted(sessions)
            per = np.full(len(sids), self.trials_per_participant // len(sids))
            per[: self.trials_per_participant % len(sids)] += 1
            for sid, k in zip(sids, per):
                trials = sessions[sid]
                chosen = rng.choice(len(trials), size=min(k, len(trials)), replace=False)
                for t in chosen:
                    frames = trials[t]
                    take = rng.choice(frames, size=min(self.frames_per_trial, len(frames)),
                                      replace=False)
                    out.extend(int(x) for x in take)
        rng.shuffle(out)
        return out

    def __iter__(self) -> Iterator[int]:
        return iter(self._draw())

    def __len__(self) -> int:
        return len(self._draw())


def effective_sample_report(df: pd.DataFrame) -> pd.DataFrame:
    """Frames vs trials vs sessions per participant (the honest sample sizes)."""
    return (df.groupby("participant_id")
              .agg(frames=("sample_id", "size"), trials=("trial_id", "nunique"),
                   sessions=("session_id", "nunique"))
              .reset_index())
