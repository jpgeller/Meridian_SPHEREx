"""Command-line training (same code as notebook 04). Nothing runs without --run.

    python scripts/train.py --stage a --run
    python scripts/train.py --stage b --run --set stage_b.unfreeze_last_blocks=2 --set stage_b.backbone_lr=5e-6
    python scripts/train.py --stage b --run --resume experiments/unigaze_b16_partial_ft_001/last.pt

Uses the GPU. Selection is by validation error; the test set is never loaded."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def parse_value(v: str):
    import yaml
    return yaml.safe_load(v)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=["a", "b"])
    ap.add_argument("--run", action="store_true", help="actually start training")
    ap.add_argument("--set", action="append", default=[], help="override, e.g. stage_a.head_lr=1e-4")
    ap.add_argument("--name", default=None)
    ap.add_argument("--resume", default=None)
    ap.add_argument("--init-head-from", default=None, help="Stage A best.pt to initialise the head")
    a = ap.parse_args()
    if not a.run:
        print("Dry run. Add --run to train (GPU-intensive).")
        return 0

    import numpy as np
    import torch
    from src.config import load_config
    from src.dataset import require_audit_pass
    from src.models import build_regressor, freeze_all_backbone, load_unigaze, unfreeze_last_blocks
    from src.pipeline import extract_split_features, head_inputs, split_source, stage_b_loaders
    from src.trainer import finetune, train_head_on_features
    from src.utils import new_run_dir, seed_everything, select_device

    cfg = load_config().with_overrides({k: parse_value(v) for k, v in (s.split("=", 1) for s in a.set)})
    require_audit_pass(cfg)
    seed_everything(int(cfg["reproducibility"]["seed"]), bool(cfg["reproducibility"]["deterministic"]))
    hw = cfg["hardware"]
    dev = select_device(hw["device"], bool(hw["allow_cpu_training"]), hw["precision"])
    print("device:", dev)
    unigaze, ck = load_unigaze(cfg, allow_download=False)
    from src.dataset import manifest_hash
    tr_df, _, _ = split_source(cfg, "train")
    info = {"unigaze_checkpoint": ck, "train_manifest_hash": manifest_hash(tr_df),
            "config_fingerprint": cfg.fingerprint(), "seed": cfg["reproducibility"]["seed"],
            "device": dev.__dict__}
    model = build_regressor(unigaze, cfg)

    if a.stage == "a":
        freeze_all_backbone(model)
        tr = extract_split_features(cfg, unigaze, ck["sha256"], "train", dev.device, dev.precision)
        va = extract_split_features(cfg, unigaze, ck["sha256"], "validation", dev.device, dev.precision)
        va_df, _, _ = split_source(cfg, "validation")
        use = cfg["model"]["head"]["use_gaze_angles"]
        tu, vu = np.asarray(tr["usable"]), np.asarray(va["usable"])
        run = new_run_dir(cfg.paths.experiments, a.name or "unigaze_b16_frozen_head")
        res = train_head_on_features(cfg, model.head, head_inputs(tr, use)[tu],
                                     tr_df[tu].reset_index(drop=True), head_inputs(va, use)[vu],
                                     va_df[vu].reset_index(drop=True), run, dev.device, "stage_a", info)
    else:
        if a.init_head_from:
            model.head.load_state_dict(torch.load(a.init_head_from, weights_only=False)["head_state"])
        unfreeze_last_blocks(model, int(cfg["stage_b"]["unfreeze_last_blocks"]))
        loader_fn, val_loader, va_df, _ = stage_b_loaders(cfg, dev.device)
        run = Path(a.resume).parent if a.resume else new_run_dir(cfg.paths.experiments,
                                                                 a.name or "unigaze_b16_partial_ft")
        res = finetune(cfg, model, loader_fn, val_loader, va_df, run, dev.device, dev.precision,
                       "stage_b", info, resume_from=Path(a.resume) if a.resume else None)
    print({k: v for k, v in res.items() if k != "history"})
    return 0


if __name__ == "__main__":   # required on Windows (spawned DataLoader workers)
    sys.exit(main())
