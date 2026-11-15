"""Loss functions for screen-coordinate regression.

The model predicts normalised screen coordinates (x/W, y/H). On a 2560x1600
screen one normalised unit of x is 2560 px but one unit of y is only 1600 px,
so a loss on raw normalised residuals would weight vertical errors 1.6x too
little. Every loss here first rescales the residual to *screen-diagonal units*:

    r = ((x_hat - x) * W / D,  (y_hat - y) * H / D),   D = sqrt(W^2 + H^2)

so ||r|| x D is exactly the Euclidean error in pixels.

Optimised loss (default): Huber on r, delta = 0.02 diagonal (~60 px), summed
over x and y and averaged over the batch. Huber behaves like MSE for small
residuals (smooth, well-conditioned) and like L1 for large ones, which limits
the influence of frames whose instructed-fixation label is wrong (blinks,
participant looking elsewhere).

Checkpoint-selection metric (NOT the loss): participant-averaged mean Euclidean
pixel error on the validation participants (see metrics.py).
"""
from __future__ import annotations

import torch
import torch.nn as nn


class ScreenCoordinateLoss(nn.Module):
    def __init__(self, width: int, height: int, kind: str = "huber", delta: float = 0.02):
        super().__init__()
        d = (width ** 2 + height ** 2) ** 0.5
        self.register_buffer("scale", torch.tensor([width / d, height / d], dtype=torch.float32))
        self.kind = kind
        self.delta = float(delta)
        if kind not in ("huber", "mse", "euclidean"):
            raise ValueError(f"unknown loss {kind}")

    def forward(self, pred_norm: torch.Tensor, target_norm: torch.Tensor) -> torch.Tensor:
        if pred_norm.shape != target_norm.shape or pred_norm.shape[-1] != 2:
            raise ValueError(f"shape mismatch {tuple(pred_norm.shape)} vs {tuple(target_norm.shape)}")
        if pred_norm.numel() == 0:
            raise ValueError("empty batch")
        r = (pred_norm.float() - target_norm.float()) * self.scale
        if self.kind == "huber":
            a = r.abs()
            per = torch.where(a < self.delta, 0.5 * r ** 2 / self.delta, a - 0.5 * self.delta)
            loss = per.sum(dim=-1)
        elif self.kind == "mse":
            loss = (r ** 2).sum(dim=-1)
        else:  # euclidean; eps keeps the gradient finite at zero error
            loss = torch.sqrt((r ** 2).sum(dim=-1) + 1e-12)
        out = loss.mean()
        if not torch.isfinite(out):
            raise FloatingPointError("Non-finite loss - check inputs/learning rate")
        return out


def euclidean_px(pred_norm: torch.Tensor, target_norm: torch.Tensor, width: int, height: int
                 ) -> torch.Tensor:
    s = torch.tensor([width, height], dtype=torch.float32, device=pred_norm.device)
    return torch.linalg.norm((pred_norm.float() - target_norm.float()) * s, dim=-1)
