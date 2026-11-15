"""Dataset audit + manifests.  python scripts/run_audit.py --decode sample|full|none

Reads the dataset only; writes reports/ and manifests/ in the training workspace."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> int:
    from src.audit import make_audit_figures, run_audit, write_reports
    from src.config import load_config
    ap = argparse.ArgumentParser()
    ap.add_argument("--decode", default="sample", choices=["none", "sample", "full"])
    ap.add_argument("--verify-raw-hash", action="store_true")
    ap.add_argument("--threads", type=int, default=8)
    a = ap.parse_args()
    cfg = load_config()
    cfg.paths.ensure_output_dirs()
    res = run_audit(cfg, decode_mode=a.decode, verify_raw_hash=a.verify_raw_hash, max_threads=a.threads)
    make_audit_figures(res, cfg, cfg.paths.figures / "audit")
    out = write_reports(res, cfg)
    print("DECISION:", res.decision)
    for f in res.findings:
        print(f"[{f['level']}] {f['check']}: {f['detail']}")
    print("Report:", out["html"])
    return 0 if res.decision == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
