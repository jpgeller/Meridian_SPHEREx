"""Tiny on-disk cache under api/cache/ (gitignored). JSON documents with a TTL, plus
plain file paths for binary data (FITS cutouts, PNGs)."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("MERIDIAN_CACHE", Path(__file__).parent / "cache"))


def path_for(kind: str, key: str, suffix: str = "") -> Path:
    """Stable file path for (kind, key). Keys are hashed so any string is safe."""
    h = hashlib.sha1(key.encode()).hexdigest()[:20]
    p = ROOT / kind / h[:2] / f"{h}{suffix}"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def write_atomic(path: Path, data: bytes) -> None:
    """Write via a temp file + rename so readers never see half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def get_json(kind: str, key: str, ttl_s: float | None = None) -> Any | None:
    p = path_for(kind, key, ".json")
    if not p.exists():
        return None
    if ttl_s is not None and time.time() - p.stat().st_mtime > ttl_s:
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def put_json(kind: str, key: str, value: Any) -> None:
    write_atomic(path_for(kind, key, ".json"), json.dumps(value, separators=(",", ":")).encode())
