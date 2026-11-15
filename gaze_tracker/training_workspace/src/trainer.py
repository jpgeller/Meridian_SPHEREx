"""Training loops, schedulers, early stopping and checkpoints.

Two stages, both selected on VALIDATION error (never training loss, never test):

Stage A  frozen UniGaze backbone. The backbone output for each frame is
         computed once (models.extract_features) and the head is trained on
         those cached features. With augmentation off and the backbone in eval
         mode this is mathematically identical to training the head on images,
         and ~100x faster.
Stage B  last N transformer blocks unfrozen, differential learning rates,
         mixed precision, gradient accumulation, gradient clipping.

Every run writes to its own experiments/<name>_<NNN>/ folder:
    config.yaml, environment.json, run_info.json, history.csv, step_log.csv,
    best.pt (only replaced on improvement), last.pt (full resume state),
    val_predictions.parquet, figures/
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import yaml

from .dataset import ParticipantTrialBalancedSampler
from .losses import ScreenCoordinateLoss, euclidean_px
from .metrics import macro_mean_euclid_px
from .utils import environment_report, now_iso, read_json, write_json


# --------------------------------------------------------------------------
# Scheduling and early stopping
# --------------------------------------------------------------------------
def build_scheduler(optimizer, kind: str, total_steps: int, warmup_steps: int):
    """Returns (scheduler, step_unit) with step_unit in {"step", "epoch"}.

    cosine   : linear warmup then cosine decay to 1% - stepped every optimizer step
    onecycle : PyTorch OneCycleLR (what UniGaze used upstream) - every step
    plateau  : ReduceLROnPlateau on the validation metric - once per epoch
    """
    if kind == "cosine":
        def f(step):
            if step < warmup_steps:
                return (step + 1) / max(1, warmup_steps)
            prog = (step - warmup_steps) / max(1, total_steps - warmup_steps)
            return 0.01 + 0.99 * 0.5 * (1 + math.cos(math.pi * min(1.0, prog)))
        return torch.optim.lr_scheduler.LambdaLR(optimizer, f), "step"
    if kind == "onecycle":
        return torch.optim.lr_scheduler.OneCycleLR(
            optimizer, max_lr=[g["lr"] for g in optimizer.param_groups], total_steps=total_steps,
            pct_start=max(0.05, warmup_steps / max(1, total_steps))), "step"
    if kind == "plateau":
        return torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="min", factor=0.5,
                                                          patience=2), "epoch"
    raise ValueError(f"unknown scheduler {kind}")


class EarlyStopping:
    def __init__(self, patience: int, min_delta: float = 0.0):
        self.patience = int(patience)
        self.min_delta = float(min_delta)
        self.best = float("inf")
        self.best_epoch = -1
        self.bad_epochs = 0

    def step(self, value: float, epoch: int) -> bool:
        """Record a validation value. Returns True if it is a new best."""
        if not np.isfinite(value):
            self.bad_epochs += 1
            return False
        if value < self.best - self.min_delta:
            self.best, self.best_epoch, self.bad_epochs = value, epoch, 0
            return True
        self.bad_epochs += 1
        return False

    @property
    def should_stop(self) -> bool:
        return self.bad_epochs >= self.patience

    def state_dict(self):
        return dict(best=self.best, best_epoch=self.best_epoch, bad_epochs=self.bad_epochs)

    def load_state_dict(self, s):
        self.best, self.best_epoch, self.bad_epochs = s["best"], s["best_epoch"], s["bad_epochs"]


def autocast_ctx(device: str, precision: str):
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}.get(precision)
    return torch.autocast(device_type="cuda" if device == "cuda" else "cpu", dtype=dtype,
                          enabled=dtype is not None)


def grad_norm(params) -> float:
    norms = [p.grad.detach().float().norm() for p in params if p.grad is not None]
    return float(torch.norm(torch.stack(norms))) if norms else 0.0


def gpu_memory_gb() -> Optional[float]:
    if torch.cuda.is_available():
        return round(torch.cuda.max_memory_allocated() / 1024 ** 3, 3)
    return None


def rng_state() -> Dict:
    s = {"python": random.getstate(), "numpy": np.random.get_state(), "torch": torch.get_rng_state()}
    if torch.cuda.is_available():
        s["cuda"] = torch.cuda.get_rng_state_all()
    return s


def set_rng_state(s: Dict) -> None:
    random.setstate(s["python"]); np.random.set_state(s["numpy"]); torch.set_rng_state(s["torch"])
    if "cuda" in s and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(s["cuda"])


# --------------------------------------------------------------------------
# Run bookkeeping
# --------------------------------------------------------------------------
@dataclass
class RunRecorder:
    run_dir: Path
    history: List[Dict] = field(default_factory=list)
    steps: List[Dict] = field(default_factory=list)

    def start(self, cfg, info: Dict) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / "figures").mkdir(exist_ok=True)
        (self.run_dir / "config.yaml").write_text(yaml.safe_dump(cfg.to_dict(), sort_keys=False),
                                                  encoding="utf-8")
        write_json(self.run_dir / "environment.json", environment_report())
        write_json(self.run_dir / "run_info.json", {"started": now_iso(), **info})

    def update_info(self, **kw) -> None:
        info = read_json(self.run_dir / "run_info.json")
        info.update(kw)
        write_json(self.run_dir / "run_info.json", info)

    def log_epoch(self, row: Dict) -> None:
        self.history.append(row)
        pd.DataFrame(self.history).to_csv(self.run_dir / "history.csv", index=False)

    def log_step(self, row: Dict) -> None:
        self.steps.append(row)
        if len(self.steps) % 50 == 0:
            self.flush_steps()

    def flush_steps(self) -> None:
        if self.steps:
            pd.DataFrame(self.steps).to_csv(self.run_dir / "step_log.csv", index=False)


def save_best(run_dir: Path, payload: Dict) -> Path:
    """best.pt is written atomically and only when validation improved."""
    path = run_dir / "best.pt"
    tmp = run_dir / "best.pt.tmp"
    torch.save(payload, tmp)
    tmp.replace(path)
    return path


# --------------------------------------------------------------------------
# Stage A: head on cached features
# --------------------------------------------------------------------------
def train_head_on_features(cfg, head: nn.Module, train_x: torch.Tensor, train_df: pd.DataFrame,
                           val_x: torch.Tensor, val_df: pd.DataFrame, run_dir: Path,
                           device: str = "cuda", stage_key: str = "stage_a",
                           extra_info: Optional[Dict] = None) -> Dict:
    """Train a CoordinateHead on precomputed (frozen) backbone features.

    train_x / val_x: (N, D) float tensors aligned row-by-row with the
    manifests. Selection: participant-macro validation mean Euclidean px."""
    sc = cfg[stage_key]
    W, H = cfg.screen_px
    rec = RunRecorder(Path(run_dir))
    rec.start(cfg, {"stage": stage_key, "mode": "frozen_backbone_cached_features",
                    "selection_metric": cfg["selection_metric"],
                    "trainable_parameters": sum(p.numel() for p in head.parameters()),
                    **(extra_info or {})})
    head = head.to(device)
    loss_fn = ScreenCoordinateLoss(W, H, cfg["loss"]["type"], cfg["loss"]["huber_delta"]).to(device)
    opt = torch.optim.AdamW(head.parameters(), lr=float(sc["head_lr"]),
                            weight_decay=float(sc["weight_decay"]))
    samp = ParticipantTrialBalancedSampler(train_df, np.ones(len(train_df), bool),
                                           cfg["sampler"]["trials_per_participant_per_epoch"],
                                           cfg["sampler"]["frames_per_trial_per_epoch"],
                                           seed=int(cfg["reproducibility"]["seed"]))
    bs = int(sc["batch_size"])
    steps_per_epoch = math.ceil(len(samp) / bs)
    total = steps_per_epoch * int(sc["epochs"])
    sched, unit = build_scheduler(opt, sc["scheduler"], total, steps_per_epoch * int(sc["warmup_epochs"]))
    stopper = EarlyStopping(int(sc["early_stopping_patience"]))
    ty = torch.tensor(train_df[["target_x_norm", "target_y_norm"]].to_numpy(np.float32))
    vx, vy = val_x.to(device), torch.as_tensor(val_df[["target_x_norm", "target_y_norm"]]
                                               .to_numpy(np.float32), device=device)
    step = 0
    for epoch in range(int(sc["epochs"])):
        t0 = time.time()
        samp.set_epoch(epoch)
        order = torch.as_tensor(list(iter(samp)))
        head.train()
        tl, te, gn = [], [], []
        for k in range(0, len(order), bs):
            b = order[k:k + bs]
            x, y = train_x[b].to(device), ty[b].to(device)
            pred = head(x)
            loss = loss_fn(pred, y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            g = grad_norm(head.parameters())
            if sc.get("grad_clip_norm"):
                torch.nn.utils.clip_grad_norm_(head.parameters(), float(sc["grad_clip_norm"]))
            opt.step()
            if unit == "step":
                sched.step()
            tl.append(loss.item()); gn.append(g)
            te.append(euclidean_px(pred.detach(), y, W, H).mean().item())
            rec.log_step({"step": step, "epoch": epoch, "lr": opt.param_groups[0]["lr"],
                          "loss": tl[-1], "grad_norm": g})
            step += 1
        head.eval()
        with torch.no_grad():
            vp = torch.cat([head(vx[i:i + 4096]) for i in range(0, len(vx), 4096)])
            vloss = loss_fn(vp, vy).item()
        pdf = val_df[["sample_id", "participant_id", "session_id", "trial_id",
                      "target_x_norm", "target_y_norm"]].copy()
        pdf["pred_x_norm"], pdf["pred_y_norm"] = vp[:, 0].cpu().numpy(), vp[:, 1].cpu().numpy()
        val_metric = macro_mean_euclid_px(pdf, W, H)
        if unit == "epoch":
            sched.step(val_metric)
        improved = stopper.step(val_metric, epoch)
        rec.log_epoch({"epoch": epoch, "train_loss": float(np.mean(tl)),
                       "train_mean_euclid_px": float(np.mean(te)), "val_loss": vloss,
                       "val_mean_euclid_px_macro": val_metric, "lr_end": opt.param_groups[0]["lr"],
                       "grad_norm_mean": float(np.mean(gn)), "epoch_seconds": time.time() - t0,
                       "gpu_mem_gb": gpu_memory_gb(), "is_best": improved})
        if improved:
            save_best(rec.run_dir, {"stage": stage_key, "epoch": epoch, "head_state": head.state_dict(),
                                    "val_metric": val_metric, "config": cfg.to_dict()})
            pdf.to_parquet(rec.run_dir / "val_predictions.parquet", index=False)
        if stopper.should_stop:
            break
    rec.flush_steps()
    rec.update_info(finished=now_iso(), best_epoch=stopper.best_epoch, best_val_metric=stopper.best,
                    epochs_run=epoch + 1)
    best = torch.load(rec.run_dir / "best.pt", map_location="cpu", weights_only=False)
    head.load_state_dict(best["head_state"])           # restore the BEST, not the last
    return {"run_dir": str(rec.run_dir), "best_epoch": stopper.best_epoch,
            "best_val_mean_euclid_px_macro": stopper.best, "history": pd.DataFrame(rec.history)}


# --------------------------------------------------------------------------
# Prediction on image loaders
# --------------------------------------------------------------------------
@torch.no_grad()
def predict_loader(model, loader, device: str, precision: str) -> Dict[str, np.ndarray]:
    from .preprocessing import normalize_tensor_inplace
    model.eval()
    xy, gz, idx = [], [], []
    for batch in loader:
        x = normalize_tensor_inplace(batch["image"].to(device, non_blocking=True))
        with autocast_ctx(device, precision):
            out = model(x)
        xy.append(out["screen_xy"].float().cpu()); gz.append(out["gaze_pitchyaw"].float().cpu())
        idx.append(batch["index"])
    return {"screen_xy": torch.cat(xy).numpy(), "gaze_pitchyaw": torch.cat(gz).numpy(),
            "index": torch.cat(idx).numpy()}


# --------------------------------------------------------------------------
# Stage B: partial fine-tuning on images
# --------------------------------------------------------------------------
def finetune(cfg, model, train_loader_fn: Callable[[int], object], val_loader, val_df: pd.DataFrame,
             run_dir: Path, device: str, precision: str, stage_key: str = "stage_b",
             extra_info: Optional[Dict] = None, resume_from: Optional[Path] = None) -> Dict:
    """Fine-tune the unfrozen blocks + head.

    train_loader_fn(epoch) must return a DataLoader for that epoch (the
    balanced sampler draws a new subset of trials/frames each epoch).
    val_df must be row-aligned with the val_loader's dataset."""
    from .models import count_parameters, param_groups
    from .preprocessing import normalize_tensor_inplace
    sc = cfg[stage_key]
    W, H = cfg.screen_px
    rec = RunRecorder(Path(run_dir))
    counts = count_parameters(model)
    rec.start(cfg, {"stage": stage_key, "mode": "partial_finetune",
                    "selection_metric": cfg["selection_metric"],
                    "trainable_parameters": counts["trainable"], "total_parameters": counts["total"],
                    "unfrozen_blocks": int(sc["unfreeze_last_blocks"]), "precision": precision,
                    **(extra_info or {})})
    model.to(device)
    groups = param_groups(model, float(sc["head_lr"]), float(sc["backbone_lr"]),
                          float(sc["weight_decay"]), float(sc.get("layer_lr_decay", 1.0)))
    opt = torch.optim.AdamW([{k: v for k, v in g.items() if k != "names"} for g in groups])
    loss_fn = ScreenCoordinateLoss(W, H, cfg["loss"]["type"], cfg["loss"]["huber_delta"]).to(device)
    accum = max(1, int(sc.get("grad_accum_steps", 1)))
    first_loader = train_loader_fn(0)
    steps_per_epoch = math.ceil(len(first_loader) / accum)
    total = steps_per_epoch * int(sc["epochs"])
    sched, unit = build_scheduler(opt, sc["scheduler"], total, steps_per_epoch * int(sc["warmup_epochs"]))
    scaler = torch.amp.GradScaler("cuda", enabled=(precision == "fp16" and device == "cuda"))
    stopper = EarlyStopping(int(sc["early_stopping_patience"]))
    trainable = [p for p in model.parameters() if p.requires_grad]
    start_epoch, step = 0, 0
    if resume_from is not None:
        st = torch.load(resume_from, map_location="cpu", weights_only=False)
        model.load_state_dict(st["model_state"]); opt.load_state_dict(st["optimizer"])
        sched.load_state_dict(st["scheduler"]); scaler.load_state_dict(st["scaler"])
        stopper.load_state_dict(st["early_stopping"]); set_rng_state(st["rng"])
        start_epoch, step = st["epoch"] + 1, st["step"]
        rec.history = st.get("history", [])

    epoch = start_epoch
    for epoch in range(start_epoch, int(sc["epochs"])):
        t0 = time.time()
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        loader = first_loader if epoch == 0 and resume_from is None else train_loader_fn(epoch)
        model.train_mode()
        tl, te, gn = [], [], []
        opt.zero_grad(set_to_none=True)
        try:
            for k, batch in enumerate(loader):
                x = normalize_tensor_inplace(batch["image"].to(device, non_blocking=True))
                y = batch["target"].to(device, non_blocking=True)
                with autocast_ctx(device, precision):
                    out = model(x)
                loss = loss_fn(out["screen_xy"].float(), y)
                scaler.scale(loss / accum).backward()
                tl.append(loss.item())
                te.append(euclidean_px(out["screen_xy"].detach(), y, W, H).mean().item())
                if (k + 1) % accum == 0 or (k + 1) == len(loader):
                    scaler.unscale_(opt)
                    g = grad_norm(trainable)
                    if sc.get("grad_clip_norm"):
                        torch.nn.utils.clip_grad_norm_(trainable, float(sc["grad_clip_norm"]))
                    scaler.step(opt); scaler.update()
                    opt.zero_grad(set_to_none=True)
                    if unit == "step":
                        sched.step()
                    gn.append(g)
                    rec.log_step({"step": step, "epoch": epoch, "loss": tl[-1], "grad_norm": g,
                                  **{f"lr_g{i}": pg["lr"] for i, pg in enumerate(opt.param_groups)}})
                    step += 1
        except torch.cuda.OutOfMemoryError as exc:
            rec.flush_steps()
            raise RuntimeError(
                f"GPU out of memory at batch size {loader.batch_size}. Lower "
                f"{stage_key}.batch_size (and raise grad_accum_steps to keep the effective batch), "
                f"or unfreeze fewer blocks. Original error: {exc}") from exc

        pred = predict_loader(model, val_loader, device, precision)
        pdf = val_df.iloc[pred["index"]][["sample_id", "participant_id", "session_id", "trial_id",
                                         "target_x_norm", "target_y_norm"]].copy()
        pdf["pred_x_norm"], pdf["pred_y_norm"] = pred["screen_xy"][:, 0], pred["screen_xy"][:, 1]
        with torch.no_grad():
            # the loss module (and its scale buffer) lives on `device`
            vloss = loss_fn(torch.tensor(pred["screen_xy"], device=device),
                            torch.tensor(pdf[["target_x_norm", "target_y_norm"]].to_numpy(np.float32),
                                         device=device)).item()
        val_metric = macro_mean_euclid_px(pdf, W, H)
        if unit == "epoch":
            sched.step(val_metric)
        improved = stopper.step(val_metric, epoch)
        rec.log_epoch({"epoch": epoch, "train_loss": float(np.mean(tl)),
                       "train_mean_euclid_px": float(np.mean(te)), "val_loss": vloss,
                       "val_mean_euclid_px_macro": val_metric,
                       "lr_head_end": opt.param_groups[0]["lr"],
                       "grad_norm_mean": float(np.mean(gn)) if gn else float("nan"),
                       "epoch_seconds": time.time() - t0, "gpu_mem_gb": gpu_memory_gb(),
                       "is_best": improved})
        if improved:
            save_best(rec.run_dir, {"stage": stage_key, "epoch": epoch,
                                    "model_state": model.state_dict(), "val_metric": val_metric,
                                    "config": cfg.to_dict()})
            pdf.to_parquet(rec.run_dir / "val_predictions.parquet", index=False)
        torch.save({"epoch": epoch, "step": step, "model_state": model.state_dict(),
                    "optimizer": opt.state_dict(), "scheduler": sched.state_dict(),
                    "scaler": scaler.state_dict(), "early_stopping": stopper.state_dict(),
                    "rng": rng_state(), "history": rec.history}, rec.run_dir / "last.pt")
        if stopper.should_stop:
            break
    rec.flush_steps()
    rec.update_info(finished=now_iso(), best_epoch=stopper.best_epoch, best_val_metric=stopper.best,
                    epochs_run=epoch + 1)
    best = torch.load(rec.run_dir / "best.pt", map_location="cpu", weights_only=False)
    model.load_state_dict(best["model_state"])
    return {"run_dir": str(rec.run_dir), "best_epoch": stopper.best_epoch,
            "best_val_mean_euclid_px_macro": stopper.best, "history": pd.DataFrame(rec.history)}
