"""UniGaze adapter and screen-coordinate regression heads.

Verified against the official code (ut-vision/UniGaze @ 9c240fb, pip package
`unigaze` 0.1.3, unigaze_easy/src/unigaze/models/mae_gaze.py):

* `MAE_Gaze(model_type='vit_b_16')` = timm VisionTransformer, patch 16,
  embed_dim 768, depth 12, 12 heads, qkv_bias, LayerNorm eps 1e-6,
  `global_pool=False`, drop_path_rate 0.1, + `gaze_fc = Linear(768, 2)`.
* 86,569,194 parameters in total (incl. an unused 1000-class `vit.head`,
  769,000 parameters, kept only so the checkpoint loads with strict=True).
* `vit.forward_features(x)` returns the final-LayerNorm CLS token (B, 768).
* `forward(x)` returns {'pred_gaze': (B, 2)} = (pitch, yaw) in radians in the
  normalised camera frame. It is a DIRECTION, not a screen position.
* Input: (B, 3, 224, 224), RGB, ImageNet mean/std normalised.
* Checkpoint: Hugging Face UniGaze/UniGaze-models, unigaze_b16_joint.safetensors,
  loaded with `load_unigaze_weights` (strict=True).
* The official code loads under timm 1.x (checked with timm 1.0.31); the pip
  package's `timm==0.3.2` pin is unnecessary and incompatible with current
  PyTorch, so it is installed with --no-deps (see environment_setup.md).

Licence: UniGaze weights are under the ModelGo Attribution-NonCommercial-
ResponsibleAI License 2.0 (MG-NC-RAI-2.0). Fine-tuned weights produced here are
derivative materials under the same terms. See LICENSE_NOTICE_UNIGAZE.md.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import torch
import torch.nn as nn

from .utils import sha256_file


# --------------------------------------------------------------------------
# Loading the pretrained checkpoint
# --------------------------------------------------------------------------
def _import_mae_gaze():
    try:
        from unigaze.models.mae_gaze import MAE_Gaze  # official implementation
    except ImportError as exc:
        raise ImportError(
            "The official 'unigaze' package is not installed. Install it with\n"
            "    pip install unigaze --no-deps\n"
            "(see environment_setup.md for why --no-deps is required).") from exc
    return MAE_Gaze


def resolve_checkpoint(cfg, allow_download: bool = False, local_path: Optional[Path] = None
                       ) -> Path:
    """Return the path of the UniGaze checkpoint.

    Never downloads unless `allow_download=True` (the notebooks set this only
    in an explicit, clearly marked cell)."""
    if local_path is None and cfg["model"].get("local_checkpoint_path"):
        local_path = cfg.paths.workspace / cfg["model"]["local_checkpoint_path"]
    if local_path is not None:
        p = Path(local_path)
        if not p.is_file():
            raise FileNotFoundError(p)
        return p
    from huggingface_hub import hf_hub_download
    mcfg = cfg["model"]
    kwargs = dict(repo_id=mcfg["hf_repo_id"], filename=mcfg["hf_filename"],
                  cache_dir=str(cfg.paths.hf_cache))
    try:
        return Path(hf_hub_download(local_files_only=True, **kwargs))
    except Exception:
        if not allow_download:
            raise FileNotFoundError(
                f"{mcfg['hf_filename']} is not in {cfg.paths.hf_cache}. Run the download cell "
                "in notebook 03 (about 350 MB) or pass local_path=...") from None
    return Path(hf_hub_download(**kwargs))


def load_unigaze(cfg, allow_download: bool = False, local_path: Optional[Path] = None,
                 compute_hash: bool = True) -> Tuple[nn.Module, Dict]:
    """Build MAE_Gaze('vit_b_16') and load the pretrained gaze checkpoint
    (strict). Returns (model, checkpoint_info)."""
    MAE_Gaze = _import_mae_gaze()
    path = resolve_checkpoint(cfg, allow_download, local_path)
    model = MAE_Gaze(model_type="vit_b_16",
                     drop_path_rate=float(cfg["model"].get("drop_path_rate", 0.1)))
    model.load_unigaze_weights(str(path))       # strict=True inside
    info = {"checkpoint_name": cfg["model"]["checkpoint_name"], "path": str(path),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path) if compute_hash else None,
            "parameters": count_parameters(model)["total"]}
    return model, info


# --------------------------------------------------------------------------
# Regression heads
# --------------------------------------------------------------------------
class CoordinateHead(nn.Module):
    """Small head predicting normalised screen (x, y).

    The output is LINEAR (no sigmoid/tanh): bounded activations saturate near
    the screen edges and starve edge targets of gradient. Predictions outside
    [0, 1] are clamped only at deployment. The last layer is initialised to
    predict the screen centre."""

    def __init__(self, in_dim: int, kind: str = "mlp", hidden: int = 256, dropout: float = 0.0):
        super().__init__()
        if kind == "linear":
            self.net = nn.Sequential(nn.LayerNorm(in_dim), nn.Linear(in_dim, 2))
        elif kind == "mlp":
            self.net = nn.Sequential(nn.LayerNorm(in_dim), nn.Linear(in_dim, hidden), nn.GELU(),
                                     nn.Dropout(dropout), nn.Linear(hidden, 2))
        else:
            raise ValueError(f"unknown head kind {kind}")
        last = self.net[-1]
        nn.init.normal_(last.weight, std=1e-3)
        nn.init.constant_(last.bias, 0.5)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def head_input(features: torch.Tensor, gaze_pitchyaw: Optional[torch.Tensor],
               use_gaze_angles: bool) -> torch.Tensor:
    """CLS feature, optionally with UniGaze's (pitch, yaw) appended (scaled to
    a range similar to the LayerNorm'd features)."""
    if use_gaze_angles and gaze_pitchyaw is not None:
        return torch.cat([features, gaze_pitchyaw * 2.0], dim=1)
    return features


class UniGazeScreenRegressor(nn.Module):
    """UniGaze backbone + coordinate head.

    forward(x) -> {"features": (B,768), "gaze_pitchyaw": (B,2), "screen_xy": (B,2)}
    `screen_xy` is in normalised screen units (0..1, top-left origin)."""

    def __init__(self, unigaze: nn.Module, head: CoordinateHead, use_gaze_angles: bool = True):
        super().__init__()
        self.unigaze = unigaze
        self.head = head
        self.use_gaze_angles = use_gaze_angles

    @property
    def blocks(self):
        return self.unigaze.vit.blocks

    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        feats = self.unigaze.vit.forward_features(x)
        gaze = self.unigaze.gaze_fc(feats)
        xy = self.head(head_input(feats, gaze, self.use_gaze_angles).float())
        return {"features": feats, "gaze_pitchyaw": gaze, "screen_xy": xy}

    def train_mode(self) -> "UniGazeScreenRegressor":
        """train() that keeps FROZEN parts in eval mode, so stochastic depth
        (drop_path) and dropout only act on parameters that are being trained."""
        super().train(True)
        self.unigaze.eval()
        for blk in self.blocks:
            if any(p.requires_grad for p in blk.parameters()):
                blk.train()
        if any(p.requires_grad for p in self.unigaze.vit.norm.parameters()):
            self.unigaze.vit.norm.train()
        self.head.train()
        return self


def build_regressor(unigaze: nn.Module, cfg) -> UniGazeScreenRegressor:
    h = cfg["model"]["head"]
    use_angles = bool(h.get("use_gaze_angles", True))
    in_dim = int(cfg["model"]["embed_dim"]) + (2 if use_angles else 0)
    head = CoordinateHead(in_dim, h.get("type", "mlp"), int(h.get("hidden_dim", 256)),
                          float(h.get("dropout", 0.0)))
    return UniGazeScreenRegressor(unigaze, head, use_angles)


# --------------------------------------------------------------------------
# Freezing and parameter groups
# --------------------------------------------------------------------------
def freeze_all_backbone(model: UniGazeScreenRegressor) -> None:
    for p in model.unigaze.parameters():
        p.requires_grad_(False)
    for p in model.head.parameters():
        p.requires_grad_(True)


def unfreeze_last_blocks(model: UniGazeScreenRegressor, n_blocks: int) -> List[int]:
    """Unfreeze the last `n_blocks` transformer blocks and the final LayerNorm.
    Patch embedding, position embedding, CLS token, earlier blocks and the
    pretrained gaze_fc stay frozen. Returns the unfrozen block indices."""
    freeze_all_backbone(model)
    depth = len(model.blocks)
    if not 0 <= n_blocks <= depth:
        raise ValueError(f"n_blocks must be in [0, {depth}]")
    idx = list(range(depth - n_blocks, depth))
    for i in idx:
        for p in model.blocks[i].parameters():
            p.requires_grad_(True)
    if n_blocks > 0:
        for p in model.unigaze.vit.norm.parameters():
            p.requires_grad_(True)
    return idx


def count_parameters(model: nn.Module) -> Dict[str, int]:
    total = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    return {"total": total, "trainable": trainable, "frozen": total - trainable}


def _no_decay(name: str, p: torch.nn.Parameter) -> bool:
    return p.ndim <= 1 or name.endswith(".bias") or "norm" in name or "pos_embed" in name \
        or "cls_token" in name


def param_groups(model: UniGazeScreenRegressor, head_lr: float, backbone_lr: float,
                 weight_decay: float, layer_decay: float = 1.0) -> List[Dict]:
    """AdamW groups: head vs backbone (differential LR), layer-wise LR decay
    inside the unfrozen blocks (deeper = larger LR), no weight decay on biases
    and norms. Only parameters with requires_grad are included."""
    depth = len(model.blocks)
    groups: Dict[Tuple[str, float, float], Dict] = {}

    def add(name, p, lr):
        wd = 0.0 if _no_decay(name, p) else weight_decay
        key = (name.split(".")[0], lr, wd)
        g = groups.setdefault(key, {"params": [], "lr": lr, "weight_decay": wd, "names": []})
        g["params"].append(p)
        g["names"].append(name)

    for name, p in model.named_parameters():
        if not p.requires_grad:
            continue
        if name.startswith("head."):
            add(name, p, head_lr)
        elif ".blocks." in name:
            i = int(name.split(".blocks.")[1].split(".")[0])
            add(name, p, backbone_lr * layer_decay ** (depth - 1 - i))
        else:
            add(name, p, backbone_lr)
    out = []
    for g in groups.values():
        g["initial_lr"] = g["lr"]
        out.append(g)
    return out


# --------------------------------------------------------------------------
# Feature extraction (frozen backbone)
# --------------------------------------------------------------------------
@torch.no_grad()
def extract_features(unigaze: nn.Module, loader, device: str, precision: str = "fp32"
                     ) -> Dict[str, "torch.Tensor"]:
    """Run the frozen backbone once over a split. Returns CPU float32 tensors:
    features (N,768), gaze_pitchyaw (N,2), and the dataset positions."""
    from .preprocessing import normalize_tensor_inplace
    unigaze.eval().to(device)
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}.get(precision)
    feats, gazes, idx = [], [], []
    for batch in loader:
        x = normalize_tensor_inplace(batch["image"].to(device, non_blocking=True))
        with torch.autocast(device_type="cuda" if device == "cuda" else "cpu",
                            dtype=dtype, enabled=dtype is not None):
            f = unigaze.vit.forward_features(x)
            g = unigaze.gaze_fc(f)
        feats.append(f.float().cpu())
        gazes.append(g.float().cpu())
        idx.append(batch["index"].cpu())
    return {"features": torch.cat(feats), "gaze_pitchyaw": torch.cat(gazes),
            "index": torch.cat(idx)}
