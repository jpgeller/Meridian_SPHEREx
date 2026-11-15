"""Session storage.

A fixation trial is written atomically from the dataset's point of view:
images first, then all annotation lines for the target in one append.  A target
counts as complete only when annotations.jsonl holds exactly FRAMES_PER_TARGET
lines for it.  Anything else on disk (orphan images, a truncated last line,
a half-written trial) is removed by recover() before a session is resumed, so
partial samples and duplicate files are never counted.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Callable, Dict, List, Optional, Set

import cv2

from . import config as cfg
from .layout import SESSION_SUBDIRS, DatasetLayout, sample_id, split_for
from .vision import FrameSample


class DuplicateTrialError(Exception):
    pass


class RecordingNotAllowed(Exception):
    """Raised if anything tries to save while not CAPTURING."""


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def pixel_sha256(image) -> str:
    return hashlib.sha256(image.tobytes()).hexdigest()


def read_jsonl(path: Path) -> List[Dict]:
    """Read a .jsonl file, silently dropping a truncated/corrupt trailing line."""
    rows: List[Dict] = []
    if not Path(path).is_file():
        return rows
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def write_json(path: Path, data) -> None:
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


class EventLog:
    """Append-only event log (logs/<mode>_<pid>_<sid>_events.jsonl)."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def write(self, event: str, time: float, **fields) -> None:
        row = {"time": round(time, 4), "event": event}
        row.update(fields)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")

    def read(self) -> List[Dict]:
        return read_jsonl(self.path)


class SessionWriter:
    def __init__(self, layout: DatasetLayout, mode: str, participant_id: str,
                 session_id: str,
                 recording_allowed: Optional[Callable[[], bool]] = None):
        self.layout = layout
        self.mode = mode
        self.participant_id = participant_id
        self.session_id = session_id
        self.split = split_for(mode, participant_id)
        self.dir = layout.session_dir(mode, participant_id, session_id)
        layout.assert_session_path(self.dir, mode, participant_id)
        self.annotations_file = self.dir / "annotations.jsonl"
        self.targets_file = self.dir / "targets.json"
        self.metadata_file = self.dir / "session_metadata.json"
        self.quality_file = self.dir / "quality_report.json"
        self.events = EventLog(layout.events_log(mode, participant_id, session_id))
        self._recording_allowed = recording_allowed or (lambda: True)
        self.blocked_save_attempts = 0

    # -- existence / progress ------------------------------------------------
    def exists(self) -> bool:
        return self.metadata_file.is_file()

    def read_metadata(self) -> Dict:
        return json.loads(self.metadata_file.read_text(encoding="utf-8"))

    def read_targets(self) -> Dict:
        return json.loads(self.targets_file.read_text(encoding="utf-8"))

    def annotations(self) -> List[Dict]:
        return read_jsonl(self.annotations_file)

    def completed_targets(self) -> Set[int]:
        counts: Dict[int, int] = defaultdict(int)
        seen: Set[str] = set()
        for row in self.annotations():
            if row.get("sample_id") in seen:
                continue                      # a duplicated row is never counted twice
            seen.add(row.get("sample_id"))
            counts[int(row["target_index"])] += 1
        return {t for t, n in counts.items() if n == cfg.FRAMES_PER_TARGET}

    def valid_image_count(self) -> int:
        return len(self.completed_targets()) * cfg.FRAMES_PER_TARGET

    # -- creation ------------------------------------------------------------
    def create(self, targets_doc: Dict, metadata: Dict) -> None:
        """Create a brand-new session. Never overwrites an existing one."""
        if self.exists() or self.annotations_file.exists():
            raise FileExistsError(f"Session already exists: {self.dir}")
        if self.mode == cfg.MODE_OFFICIAL:
            self.layout.lock_participant_split(self.participant_id)
        self.layout.ensure_structure()
        for sub in SESSION_SUBDIRS:
            (self.dir / sub).mkdir(parents=True, exist_ok=True)
        write_json(self.targets_file, targets_doc)
        self.annotations_file.touch()
        write_json(self.metadata_file, metadata)

    def update_metadata(self, **changes) -> Dict:
        meta = self.read_metadata()
        meta.update(changes)
        write_json(self.metadata_file, meta)
        return meta

    def append_run(self, run: Dict) -> None:
        meta = self.read_metadata()
        meta.setdefault("runs", []).append(run)
        write_json(self.metadata_file, meta)

    # -- recovery ------------------------------------------------------------
    def recover(self) -> Dict:
        """Remove every trace of trials that did not complete.

        Keeps only annotation rows of targets with exactly FRAMES_PER_TARGET
        unique rows whose four image files all exist; deletes image files that
        no kept row references.
        """
        rows = self.annotations()
        by_target: Dict[int, List[Dict]] = defaultdict(list)
        seen_ids: Set[str] = set()
        duplicates = 0
        for row in rows:
            if row.get("sample_id") in seen_ids:
                duplicates += 1
                continue
            seen_ids.add(row.get("sample_id"))
            by_target[int(row["target_index"])].append(row)

        kept: List[Dict] = []
        dropped_targets: List[int] = []
        for target, trows in sorted(by_target.items()):
            files_ok = all((self.dir / r["images"][k]).is_file()
                           for r in trows for k in SESSION_SUBDIRS)
            if len(trows) == cfg.FRAMES_PER_TARGET and files_ok:
                kept.extend(trows)
            else:
                dropped_targets.append(target)

        referenced = {r["images"][k] for r in kept for k in SESSION_SUBDIRS}
        orphan_files = 0
        for sub in SESSION_SUBDIRS:
            folder = self.dir / sub
            if not folder.is_dir():
                folder.mkdir(parents=True, exist_ok=True)
                continue
            for f in folder.iterdir():
                if f.is_file() and f"{sub}/{f.name}" not in referenced:
                    f.unlink()
                    orphan_files += 1

        raw_line_count = 0
        if self.annotations_file.is_file():
            with open(self.annotations_file, "r", encoding="utf-8") as fh:
                raw_line_count = sum(1 for line in fh if line.strip())
        if raw_line_count != len(kept):
            tmp = Path(str(self.annotations_file) + ".tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                for r in kept:
                    fh.write(json.dumps(r) + "\n")
            os.replace(tmp, self.annotations_file)

        return {"partial_targets_removed": dropped_targets,
                "orphan_files_removed": orphan_files,
                "duplicate_rows_removed": duplicates,
                "corrupt_lines_removed": raw_line_count - len(rows),
                "annotation_rows_kept": len(kept)}

    # -- writing -------------------------------------------------------------
    def commit_trial(self, target: Dict, samples: List[FrameSample],
                     screen: Dict, target_onset_time: float) -> List[Dict]:
        """Write one complete fixation trial (all frames for one target)."""
        if not self._recording_allowed():
            self.blocked_save_attempts += 1
            raise RecordingNotAllowed("Attempt to save while not CAPTURING")
        if len(samples) != cfg.FRAMES_PER_TARGET:
            raise ValueError(
                f"A trial needs exactly {cfg.FRAMES_PER_TARGET} frames, got {len(samples)}")
        t_index = int(target["target_index"])
        if t_index in self.completed_targets():
            raise DuplicateTrialError(f"Target {t_index} is already complete")
        self.layout.assert_session_path(self.dir, self.mode, self.participant_id)

        rows: List[Dict] = []
        params = [cv2.IMWRITE_PNG_COMPRESSION, cfg.PNG_COMPRESSION]
        for f_index, s in enumerate(samples):
            sid = sample_id(self.mode, self.participant_id, self.session_id, t_index, f_index)
            images = {sub: f"{sub}/{sid}{cfg.IMAGE_EXT}" for sub in SESSION_SUBDIRS}
            for sub, img in (("raw", s.raw), ("face", s.face),
                             ("left_eye", s.left_eye), ("right_eye", s.right_eye)):
                path = self.dir / images[sub]
                if path.exists():
                    path.unlink()          # leftover of an interrupted trial
                if not cv2.imwrite(str(path), img, params):
                    raise OSError(f"Could not write {path}")
            rows.append({
                "sample_id": sid,
                "participant_id": self.participant_id,
                "session_id": self.session_id,
                "mode": self.mode,
                "split": self.split,
                "target_index": t_index,
                "frame_index": f_index,
                "target_x_px": target["x_px"], "target_y_px": target["y_px"],
                "target_x_norm": target["x_norm"], "target_y_norm": target["y_norm"],
                "screen_width_px": screen["width_px"],
                "screen_height_px": screen["height_px"],
                "target_onset_time": round(target_onset_time, 4),
                "capture_time": round(s.capture_time, 4),
                "state_at_capture": s.state_at_capture,
                "images": images,
                "raw_width": int(s.raw.shape[1]), "raw_height": int(s.raw.shape[0]),
                "raw_pixel_sha256": pixel_sha256(s.raw),
                "face_box": list(s.boxes["face"]),
                "left_eye_box": list(s.boxes["left_eye"]),
                "right_eye_box": list(s.boxes["right_eye"]),
                "left_eye_center": [round(v, 2) for v in s.detection.left_eye],
                "right_eye_center": [round(v, 2) for v in s.detection.right_eye],
                "detector": s.detection.detector,
                "quality": s.quality,
            })
        with open(self.annotations_file, "a", encoding="utf-8") as fh:
            fh.write("".join(json.dumps(r) + "\n" for r in rows))
            fh.flush()
            os.fsync(fh.fileno())
        return rows

    def write_quality_report(self, report: Dict) -> None:
        write_json(self.quality_file, report)
