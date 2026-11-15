"""Model adapter, freezing, optimizer groups, losses, schedulers, early stopping
and checkpointing. Uses a tiny stand-in ViT (same interface as UniGaze) so no
pretrained weights are downloaded and no real training is run."""
import numpy as np
import pandas as pd
import pytest
import torch

from conftest import TinyViT


def _regressor(depth=4, use_angles=True):
    from src.models import CoordinateHead, UniGazeScreenRegressor
    base = TinyViT(depth=depth)
    return UniGazeScreenRegressor(base, CoordinateHead(32 + (2 if use_angles else 0), "mlp", 16), use_angles)


def test_official_unigaze_architecture_and_strict_load(tmp_path):
    """Only runs where the official `unigaze` package is installed."""
    mg = pytest.importorskip("unigaze.models.mae_gaze")
    from safetensors.torch import save_file
    m = mg.MAE_Gaze(model_type="vit_b_16")
    assert sum(p.numel() for p in m.parameters()) == 86_569_194
    assert m.vit.embed_dim == 768 and len(m.vit.blocks) == 12
    with torch.no_grad():
        out = m(torch.zeros(2, 3, 224, 224))
    assert out["pred_gaze"].shape == (2, 2)
    p = tmp_path / "w.safetensors"
    save_file({k: v.contiguous() for k, v in m.state_dict().items()}, str(p))
    m2 = mg.MAE_Gaze(model_type="vit_b_16")
    m2.load_unigaze_weights(str(p))                                    # strict=True
    from src.models import CoordinateHead, UniGazeScreenRegressor, unfreeze_last_blocks, count_parameters
    reg = UniGazeScreenRegressor(m2, CoordinateHead(770, "mlp", 256))
    with torch.no_grad():
        o = reg(torch.zeros(1, 3, 224, 224))
    assert o["features"].shape == (1, 768) and o["screen_xy"].shape == (1, 2)
    unfreeze_last_blocks(reg, 4)
    c = count_parameters(reg)
    assert 0 < c["trainable"] < c["total"]


def test_forward_shapes_and_center_init():
    reg = _regressor()
    with torch.no_grad():
        out = reg(torch.randn(3, 3, 32, 32))
    assert out["screen_xy"].shape == (3, 2)
    assert torch.allclose(out["screen_xy"], torch.full((3, 2), 0.5), atol=0.05)


def test_freezing_and_param_groups():
    from src.models import count_parameters, freeze_all_backbone, param_groups, unfreeze_last_blocks
    reg = _regressor(depth=4)
    freeze_all_backbone(reg)
    assert all(not p.requires_grad for p in reg.unigaze.parameters())
    assert all(p.requires_grad for p in reg.head.parameters())
    idx = unfreeze_last_blocks(reg, 2)
    assert idx == [2, 3]
    assert all(p.requires_grad for p in reg.blocks[3].parameters())
    assert all(not p.requires_grad for p in reg.blocks[1].parameters())
    assert not reg.unigaze.vit.pos_embed.requires_grad and not reg.unigaze.gaze_fc.weight.requires_grad
    groups = param_groups(reg, head_lr=1e-4, backbone_lr=1e-5, weight_decay=0.05, layer_decay=0.5)
    n_in_groups = sum(sum(p.numel() for p in g["params"]) for g in groups)
    assert n_in_groups == count_parameters(reg)["trainable"]
    lrs = {n: g["lr"] for g in groups for n in g["names"]}
    assert lrs["head.net.1.weight"] == 1e-4
    assert np.isclose(lrs["unigaze.vit.blocks.3.attn.qkv.weight"], 1e-5)
    assert np.isclose(lrs["unigaze.vit.blocks.2.attn.qkv.weight"], 0.5e-5)
    wd = {n: g["weight_decay"] for g in groups for n in g["names"]}
    assert wd["unigaze.vit.blocks.3.norm1.weight"] == 0.0 and wd["unigaze.vit.blocks.3.attn.qkv.weight"] == 0.05
    with pytest.raises(ValueError):
        unfreeze_last_blocks(reg, 9)


def test_train_mode_keeps_frozen_blocks_in_eval():
    from src.models import unfreeze_last_blocks
    reg = _regressor(depth=4)
    unfreeze_last_blocks(reg, 1)
    reg.train_mode()
    assert reg.head.training and reg.blocks[3].training
    assert not reg.blocks[0].training


def test_losses():
    from src.losses import ScreenCoordinateLoss, euclidean_px
    W, H = 2560, 1600
    t = torch.tensor([[0.5, 0.5]])
    p = torch.tensor([[0.5 + 300 / W, 0.5 + 400 / H]])                 # 500 px away
    assert torch.isclose(euclidean_px(p, t, W, H), torch.tensor([500.0]))
    eu = ScreenCoordinateLoss(W, H, "euclidean")(p, t)
    assert torch.isclose(eu * (W ** 2 + H ** 2) ** 0.5, torch.tensor(500.0), rtol=1e-4)
    hub = ScreenCoordinateLoss(W, H, "huber", 0.02)
    assert hub(t, t).item() == 0.0
    small = torch.tensor([[0.5 + 1e-4, 0.5]])
    assert hub(small, t).item() < ScreenCoordinateLoss(W, H, "euclidean")(small, t).item()
    with pytest.raises(FloatingPointError):
        hub(torch.tensor([[float("nan"), 0.5]]), t)
    with pytest.raises(ValueError):
        hub(torch.zeros(0, 2), torch.zeros(0, 2))
    with pytest.raises(ValueError):
        hub(torch.zeros(2, 2), torch.zeros(3, 2))


def test_scheduler_and_early_stopping():
    from src.trainer import EarlyStopping, build_scheduler
    opt = torch.optim.AdamW([torch.nn.Parameter(torch.zeros(1))], lr=1.0)
    sched, unit = build_scheduler(opt, "cosine", total_steps=100, warmup_steps=10)
    lrs = []
    for _ in range(100):
        lrs.append(opt.param_groups[0]["lr"]); opt.step(); sched.step()
    assert unit == "step" and lrs[0] == pytest.approx(0.1) and max(lrs) == pytest.approx(1.0, abs=1e-6)
    assert lrs[-1] < 0.05 and np.argmax(lrs) == 9
    _, unit = build_scheduler(opt, "plateau", 10, 0)
    assert unit == "epoch"
    es = EarlyStopping(patience=2)
    assert es.step(10, 0) and not es.step(11, 1) and not es.should_stop
    assert not es.step(12, 2) and es.should_stop and es.best_epoch == 0
    assert not EarlyStopping(1).step(float("nan"), 0)


def _synthetic_feature_problem(n_part=3, trials=20, frames=4, dim=8, seed=0):
    rng = np.random.default_rng(seed)
    rows, X = [], []
    Wm = rng.normal(size=(dim, 2))
    for p in range(n_part):
        for t in range(trials):
            tgt = rng.uniform(0.1, 0.9, 2)
            f = np.linalg.lstsq(Wm.T, tgt - 0.5, rcond=None)[0]
            for k in range(frames):
                X.append(f + rng.normal(scale=0.01, size=dim))
                rows.append({"sample_id": f"P{p}_T{t}_F{k}", "participant_id": f"P{p}", "session_id": "S01",
                             "trial_id": f"P{p}_T{t}", "target_x_norm": tgt[0], "target_y_norm": tgt[1]})
    return torch.tensor(np.array(X), dtype=torch.float32), pd.DataFrame(rows)


def test_head_training_loop_restores_best(synth, tmp_path):
    """Loop smoke test on synthetic vectors (not model training)."""
    from src.models import CoordinateHead
    from src.trainer import train_head_on_features
    cfg = synth.with_overrides({"stage_a.epochs": 4, "stage_a.batch_size": 32,
                                "stage_a.early_stopping_patience": 10,
                                "sampler.trials_per_participant_per_epoch": 10})
    Xtr, dtr = _synthetic_feature_problem(seed=0)
    Xva, dva = _synthetic_feature_problem(n_part=2, seed=1)
    head = CoordinateHead(Xtr.shape[1], "linear")
    res = train_head_on_features(cfg, head, Xtr, dtr, Xva, dva, tmp_path / "run", device="cpu")
    h = res["history"]
    assert len(h) == 4 and (tmp_path / "run" / "best.pt").is_file()
    best = torch.load(tmp_path / "run" / "best.pt", weights_only=False)
    assert best["epoch"] == int(h["val_mean_euclid_px_macro"].idxmin())
    for k, v in head.state_dict().items():                          # best restored, not last
        assert torch.equal(v.cpu(), best["head_state"][k])
    for f in ("history.csv", "step_log.csv", "config.yaml", "environment.json", "run_info.json",
              "val_predictions.parquet"):
        assert (tmp_path / "run" / f).is_file()


def test_finetune_checkpoint_and_resume(synth, tmp_path):
    from src.models import unfreeze_last_blocks
    from src.trainer import finetune

    class DS(torch.utils.data.Dataset):
        def __init__(self, n):
            g = torch.Generator().manual_seed(0)
            self.x = torch.randint(0, 255, (n, 3, 32, 32), dtype=torch.uint8, generator=g)
            self.y = torch.rand(n, 2, generator=g)
        def __len__(self): return len(self.x)
        def __getitem__(self, i): return {"image": self.x[i], "target": self.y[i], "index": i}

    from src.dataset import collate
    tr, va = DS(16), DS(8)
    val_df = pd.DataFrame({"sample_id": [f"s{i}" for i in range(8)], "participant_id": ["A"] * 4 + ["B"] * 4,
                           "session_id": "S01", "trial_id": [f"t{i // 2}" for i in range(8)],
                           "target_x_norm": va.y[:, 0].numpy(), "target_y_norm": va.y[:, 1].numpy()})
    loader_fn = lambda e: torch.utils.data.DataLoader(tr, batch_size=4, shuffle=True, collate_fn=collate)
    vl = torch.utils.data.DataLoader(va, batch_size=4, collate_fn=collate)
    cfg = synth.with_overrides({"stage_b.epochs": 2, "stage_b.grad_accum_steps": 2,
                                "stage_b.unfreeze_last_blocks": 1})
    reg = _regressor(depth=2); unfreeze_last_blocks(reg, 1)
    r1 = finetune(cfg, reg, loader_fn, vl, val_df, tmp_path / "ft", "cpu", "fp32")
    assert (tmp_path / "ft" / "last.pt").is_file() and (tmp_path / "ft" / "best.pt").is_file()
    cfg3 = cfg.with_overrides({"stage_b.epochs": 3})
    reg2 = _regressor(depth=2); unfreeze_last_blocks(reg2, 1)
    r2 = finetune(cfg3, reg2, loader_fn, vl, val_df, tmp_path / "ft2", "cpu", "fp32",
                  resume_from=tmp_path / "ft" / "last.pt")
    assert list(r2["history"]["epoch"]) == [0, 1, 2]                  # continued at epoch 2
