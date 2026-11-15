"""NASA Eye-Tracking dataset collection.

    python main.py                 open the operator dashboard + fixation map
    python main.py --camera 1      use another webcam
    python main.py --validate      re-run the dataset integrity check and exit

The application always starts in READY. Nothing is recorded until SPACE.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eyetrack import config as cfg  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="NASA Eye-Tracking dataset collector")
    parser.add_argument("--camera", type=int, default=cfg.CAMERA_INDEX,
                        help="webcam index (default: %(default)s)")
    parser.add_argument("--validate", action="store_true",
                        help="rebuild manifests, validate the whole dataset and exit")
    args = parser.parse_args()

    if args.validate:
        from eyetrack import integrity
        from eyetrack.layout import DatasetLayout
        layout = DatasetLayout(cfg.load_dataset_root())
        layout.ensure_structure()
        integrity.rebuild_manifests(layout)
        report = integrity.validate_dataset(layout)
        print(f"Dataset root: {layout.root}")
        for check in report["checks"]:
            print(f"[{check['status']:>4}] {check['check']}: {check['detail']}")
        print(json.dumps(report["participants"], indent=2))
        print(f"OVERALL: {report['overall']}")
        print(f"Report : {layout.reports_dir / 'dataset_integrity.json'}")
        return 0 if report["overall"] == "PASS" else 1

    from eyetrack.app import run
    run(camera_index=args.camera)
    return 0


if __name__ == "__main__":
    sys.exit(main())
