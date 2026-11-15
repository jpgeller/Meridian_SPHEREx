"""Configuration loading.

One YAML file (training_config.yaml) drives everything. This module:

* finds the workspace folder from THIS file's location, so paths never depend
  on the terminal's current working directory;
* resolves every relative path in the YAML against the workspace;
* validates the participant split (subject-disjoint, documented assignment);
* gives the rest of the code typed, read-only access.

Nothing here touches the dataset or the GPU.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

#: training_workspace/ (this file lives in training_workspace/src/)
WORKSPACE_ROOT: Path = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH: Path = WORKSPACE_ROOT / "training_config.yaml"

#: The assignment fixed by the collection protocol. The YAML must match it
#: unless a justification is written into `splits_override_justification`.
PROTOCOL_SPLITS: Dict[str, List[str]] = {
    "train": ["P001", "P002", "P003", "P004", "P005", "P006"],
    "validation": ["P007", "P008"],
    "test": ["P009", "P010"],
}


class ConfigError(Exception):
    """Raised for an invalid or unsafe configuration."""


@dataclass(frozen=True)
class Paths:
    workspace: Path
    dataset_root: Path
    manifests: Path
    cache: Path
    checkpoints: Path
    experiments: Path
    reports: Path
    figures: Path
    predictions: Path
    yunet_model: Path
    hf_cache: Path

    def ensure_output_dirs(self) -> None:
        """Create the workspace output folders (never the dataset)."""
        for p in (self.manifests, self.cache, self.checkpoints, self.experiments,
                  self.reports, self.figures, self.predictions):
            p.mkdir(parents=True, exist_ok=True)


class Config:
    """Thin wrapper around the parsed YAML with resolved paths."""

    def __init__(self, raw: Dict[str, Any], source: Optional[Path] = None):
        self.raw: Dict[str, Any] = raw
        self.source = source
        base = WORKSPACE_ROOT if source is None else Path(source).resolve().parent
        p = raw["paths"]

        def resolve(value: str) -> Path:
            path = Path(value).expanduser()
            return path if path.is_absolute() else (base / path).resolve()

        self.paths = Paths(
            workspace=base,
            dataset_root=resolve(p["dataset_root"]),
            manifests=resolve(p["manifests_dir"]),
            cache=resolve(p["cache_dir"]),
            checkpoints=resolve(p["checkpoints_dir"]),
            experiments=resolve(p["experiments_dir"]),
            reports=resolve(p["reports_dir"]),
            figures=resolve(p["figures_dir"]),
            predictions=resolve(p["predictions_dir"]),
            yunet_model=resolve(p["yunet_model"]),
            hf_cache=resolve(p["hf_cache_dir"]),
        )
        self._validate()

    # ------------------------------------------------------------------ access
    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)

    @property
    def splits(self) -> Dict[str, List[str]]:
        return {k: list(v) for k, v in self.raw["splits"].items()}

    def split_of(self, participant_id: str) -> str:
        for split, members in self.splits.items():
            if participant_id in members:
                return split
        raise KeyError(f"{participant_id} is not assigned to any split")

    @property
    def screen_px(self) -> tuple:
        w, h = self.raw["dataset"]["expected_screen_px"]
        return int(w), int(h)

    @property
    def screen_diagonal_px(self) -> float:
        w, h = self.screen_px
        return float((w ** 2 + h ** 2) ** 0.5)

    @property
    def monitor_mm(self) -> Optional[tuple]:
        """Physical monitor size, only if the user has measured and entered it."""
        d = self.raw["dataset"]
        if d.get("monitor_width_mm") and d.get("monitor_height_mm"):
            return float(d["monitor_width_mm"]), float(d["monitor_height_mm"])
        return None

    def to_dict(self) -> Dict[str, Any]:
        return copy.deepcopy(self.raw)

    def fingerprint(self) -> str:
        """Short hash of the full configuration (recorded with every run)."""
        blob = json.dumps(self.raw, sort_keys=True, default=str).encode()
        return hashlib.sha256(blob).hexdigest()[:12]

    def with_overrides(self, overrides: Dict[str, Any]) -> "Config":
        """Return a copy with nested keys replaced, e.g. {"stage_a.head_lr": 1e-4}."""
        raw = copy.deepcopy(self.raw)
        for dotted, value in overrides.items():
            node = raw
            keys = dotted.split(".")
            for k in keys[:-1]:
                node = node.setdefault(k, {})
            node[keys[-1]] = value
        return Config(raw, self.source)

    # -------------------------------------------------------------- validation
    def _validate(self) -> None:
        splits = self.splits
        missing = {"train", "validation", "test"} - set(splits)
        if missing:
            raise ConfigError(f"splits is missing {sorted(missing)}")
        names = list(splits)
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                overlap = set(splits[a]) & set(splits[b])
                if overlap:
                    raise ConfigError(f"Participants {sorted(overlap)} appear in both "
                                      f"'{a}' and '{b}' - splits must be subject-disjoint.")
        if splits != PROTOCOL_SPLITS and not self.raw.get("splits_override_justification"):
            raise ConfigError(
                "The split differs from the collection protocol "
                f"({PROTOCOL_SPLITS}). Add 'splits_override_justification: <reason>' "
                "to the YAML if this is intentional.")
        if self.raw["hardware"]["device"] not in ("auto", "cuda", "cpu"):
            raise ConfigError("hardware.device must be auto, cuda or cpu")
        if self.raw["preprocessing"]["input_mode"] not in ("unigaze_normalized",
                                                          "existing_face_crop"):
            raise ConfigError("preprocessing.input_mode must be unigaze_normalized "
                              "or existing_face_crop")


def load_config(path: Optional[Path] = None) -> Config:
    path = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    return Config(raw, path)
