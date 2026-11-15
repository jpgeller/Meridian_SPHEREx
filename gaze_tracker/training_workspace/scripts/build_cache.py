"""Build the normalised-face cache for train/validation (CPU, resumable).
    python scripts/build_cache.py --split train --workers 6
The test split is cached only inside notebook 06, after the test gate opens."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> int:
    from src.config import load_config
    from src.dataset import require_audit_pass
    from src.pipeline import build_cache_for_split
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, choices=["train", "validation"])
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--limit", type=int, default=None, help="only the first N rows (pipeline check)")
    a = ap.parse_args()
    cfg = load_config()
    require_audit_pass(cfg)
    info = build_cache_for_split(cfg, a.split, a.workers, a.limit)
    print(info)
    return 0


if __name__ == "__main__":   # required on Windows: worker processes are spawned
    sys.exit(main())
