"""Dataset folder layout and participant -> split rules.

NASA_EyeTracking_Dataset/
    pilot/<participant>/<session>/
    train/P001..P006/<session>/
    validation/P007..P008/<session>/
    test/P009..P010/<session>/
    manifests/  reports/  logs/
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Optional

from . import config as cfg

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
SESSION_SUBDIRS = ("raw", "face", "left_eye", "right_eye")


class SplitViolation(Exception):
    """A participant would end up in the wrong split or in more than one."""


def split_for(mode: str, participant_id: str) -> str:
    """Return the storage split for a participant in the given mode."""
    if mode == cfg.MODE_PILOT:
        if not _ID_RE.match(participant_id or ""):
            raise ValueError(f"Invalid pilot participant ID: {participant_id!r}")
        return cfg.SPLIT_PILOT
    if mode == cfg.MODE_OFFICIAL:
        try:
            return cfg.OFFICIAL_SPLIT_ASSIGNMENT[participant_id]
        except KeyError:
            raise ValueError(
                f"{participant_id!r} is not an official participant "
                f"(expected one of {', '.join(cfg.OFFICIAL_PARTICIPANTS)})") from None
    raise ValueError(f"Unknown collection mode: {mode!r}")


def sample_id(mode: str, participant_id: str, session_id: str,
              target_index: int, frame_index: int) -> str:
    """Unique, sortable sample ID. Pilot IDs carry an unmistakable prefix."""
    prefix = "PILOT-" if mode == cfg.MODE_PILOT else ""
    return f"{prefix}{participant_id}_{session_id}_T{target_index:04d}_F{frame_index:02d}"


class DatasetLayout:
    def __init__(self, root: Path):
        root = Path(root).expanduser()
        if not root.is_absolute():
            raise ValueError(f"Dataset root must be absolute, got: {root}")
        self.root = root.resolve()

    # -- fixed folders -----------------------------------------------------
    @property
    def pilot_dir(self) -> Path: return self.root / cfg.SPLIT_PILOT
    @property
    def manifests_dir(self) -> Path: return self.root / "manifests"
    @property
    def reports_dir(self) -> Path: return self.root / "reports"
    @property
    def logs_dir(self) -> Path: return self.root / "logs"
    @property
    def registry_file(self) -> Path: return self.manifests_dir / "participant_registry.json"

    def ensure_structure(self) -> None:
        for d in (self.pilot_dir, self.manifests_dir, self.reports_dir, self.logs_dir):
            d.mkdir(parents=True, exist_ok=True)
        for pid, split in cfg.OFFICIAL_SPLIT_ASSIGNMENT.items():
            (self.root / split / pid).mkdir(parents=True, exist_ok=True)

    # -- participant / session folders ---------------------------------------
    def participant_dir(self, mode: str, participant_id: str) -> Path:
        return self.root / split_for(mode, participant_id) / participant_id

    def session_dir(self, mode: str, participant_id: str, session_id: str) -> Path:
        if not _ID_RE.match(session_id or ""):
            raise ValueError(f"Invalid session ID: {session_id!r}")
        return self.participant_dir(mode, participant_id) / session_id

    def events_log(self, mode: str, participant_id: str, session_id: str) -> Path:
        return self.logs_dir / f"{mode}_{participant_id}_{session_id}_events.jsonl"

    def list_sessions(self, mode: str, participant_id: str) -> List[Path]:
        pdir = self.participant_dir(mode, participant_id)
        if not pdir.is_dir():
            return []
        return sorted(p for p in pdir.iterdir()
                      if p.is_dir() and (p / "session_metadata.json").is_file())

    # -- split locking -------------------------------------------------------
    def _read_registry(self) -> Dict[str, str]:
        try:
            return json.loads(self.registry_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def splits_containing(self, participant_id: str) -> List[str]:
        """Primary splits whose folder for this participant holds any session."""
        found = []
        for split in cfg.PRIMARY_SPLITS:
            pdir = self.root / split / participant_id
            if pdir.is_dir() and any(c.is_dir() for c in pdir.iterdir()):
                found.append(split)
        return found

    def lock_participant_split(self, participant_id: str) -> str:
        """Record (once) and enforce the official split of a participant.

        Raises SplitViolation if the registry or the folders on disk disagree
        with the fixed assignment - a participant can never change split or
        appear in more than one primary split.
        """
        split = split_for(cfg.MODE_OFFICIAL, participant_id)
        registry = self._read_registry()
        recorded = registry.get(participant_id)
        if recorded is not None and recorded != split:
            raise SplitViolation(
                f"{participant_id} is registered in '{recorded}' but assigned to '{split}'.")
        elsewhere = [s for s in self.splits_containing(participant_id) if s != split]
        if elsewhere:
            raise SplitViolation(
                f"{participant_id} already has data in {elsewhere}; "
                f"it may only exist in '{split}'.")
        if recorded is None:
            registry[participant_id] = split
            self.manifests_dir.mkdir(parents=True, exist_ok=True)
            self.registry_file.write_text(
                json.dumps(dict(sorted(registry.items())), indent=2), encoding="utf-8")
        return split

    def assert_session_path(self, path: Path, mode: str, participant_id: str) -> None:
        """Guard used before every write: the path must be inside the one folder
        this participant is allowed to write to."""
        allowed = self.participant_dir(mode, participant_id).resolve()
        resolved = Path(path).resolve()
        if allowed != resolved and allowed not in resolved.parents:
            raise SplitViolation(
                f"Refusing to write {resolved}: outside {allowed} "
                f"({mode} / {participant_id}).")

    def relative(self, path: Path) -> str:
        return Path(path).resolve().relative_to(self.root).as_posix()


def open_in_file_explorer(path: Path) -> Optional[str]:
    """Open a folder in Windows File Explorer (or the platform equivalent).
    Returns an error message, or None on success."""
    import os
    import subprocess
    import sys
    path = Path(path)
    try:
        path.mkdir(parents=True, exist_ok=True)
        if sys.platform.startswith("win"):
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return None
    except Exception as exc:  # pragma: no cover - platform dependent
        return f"Could not open {path}: {exc}"
