"""Fixation target generation.

Targets are spread evenly over the participant monitor (stratified grid with
jitter), then shuffled.  Generation is deterministic for a given participant,
session, screen size and count, and the result is stored in targets.json -
a resumed session always reloads the stored targets instead of regenerating.
"""
from __future__ import annotations

import hashlib
import math
import random
from typing import Dict, List

from . import config as cfg


def _seed(participant_id: str, session_id: str, width: int, height: int, n: int) -> int:
    key = f"{participant_id}|{session_id}|{width}x{height}|{n}".encode()
    return int.from_bytes(hashlib.sha256(key).digest()[:8], "big")


def normalise(x_px: int, y_px: int, width: int, height: int) -> tuple:
    """Pixel -> normalised [0, 1] screen coordinates (origin top-left)."""
    return round(x_px / width, 6), round(y_px / height, 6)


def generate_targets(n: int, width: int, height: int,
                     participant_id: str = "", session_id: str = "") -> List[Dict]:
    if n < 1:
        raise ValueError("Number of targets must be at least 1")
    if width < 100 or height < 100:
        raise ValueError(f"Implausible screen size: {width}x{height}")
    rng = random.Random(_seed(participant_id, session_id, width, height, n))
    mx = int(round(width * cfg.TARGET_MARGIN_FRACTION))
    my = int(round(height * cfg.TARGET_MARGIN_FRACTION))
    usable_w, usable_h = width - 2 * mx, height - 2 * my

    cols = max(1, int(math.ceil(math.sqrt(n * usable_w / usable_h))))
    rows = max(1, int(math.ceil(n / cols)))
    cells = [(c, r) for r in range(rows) for c in range(cols)]
    rng.shuffle(cells)
    cells = cells[:n]
    cell_w, cell_h = usable_w / cols, usable_h / rows

    targets = []
    for index, (c, r) in enumerate(cells):
        x = mx + (c + rng.uniform(0.15, 0.85)) * cell_w
        y = my + (r + rng.uniform(0.15, 0.85)) * cell_h
        x_px = min(max(int(round(x)), mx), width - mx - 1)
        y_px = min(max(int(round(y)), my), height - my - 1)
        x_norm, y_norm = normalise(x_px, y_px, width, height)
        targets.append({"target_index": index, "x_px": x_px, "y_px": y_px,
                        "x_norm": x_norm, "y_norm": y_norm})
    return targets


def targets_document(targets: List[Dict], width: int, height: int) -> Dict:
    return {
        "screen_width_px": width,
        "screen_height_px": height,
        "origin": "top-left of participant monitor",
        "units": "x_px/y_px in monitor pixels; x_norm/y_norm = px / screen size",
        "count": len(targets),
        "targets": targets,
    }
