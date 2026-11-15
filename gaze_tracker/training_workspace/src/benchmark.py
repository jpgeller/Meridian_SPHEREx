"""Inference latency benchmark (run manually; it uses the GPU).

Measures, with torch.cuda.synchronize() around every timed region:
  * preprocessing (YuNet + head pose + normalisation) per frame (CPU)
  * model forward at batch size 1 (the live-cursor case)
  * model throughput at larger batch sizes (offline evaluation; NOT live speed)
  * end-to-end per-frame latency and the implied frames per second
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, List, Sequence

import numpy as np
import torch


def _summary(ms: List[float]) -> Dict[str, float]:
    a = np.asarray(ms)
    return {"mean_ms": float(a.mean()), "median_ms": float(np.median(a)),
            "p95_ms": float(np.percentile(a, 95)), "fps_from_mean": float(1000 / a.mean())}


@torch.no_grad()
def benchmark_model(model, device: str = "cuda", precision: str = "fp16", warmup: int = 20,
                    iters: int = 200, batch_sizes: Sequence[int] = (1, 8, 32)) -> Dict:
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}.get(precision)
    model.eval().to(device)
    out = {}
    for bs in batch_sizes:
        x = torch.randn(bs, 3, 224, 224, device=device)
        for _ in range(warmup):
            with torch.autocast(device_type=device, dtype=dtype, enabled=dtype is not None):
                model(x)
        if device == "cuda":
            torch.cuda.synchronize(); torch.cuda.reset_peak_memory_stats()
        times = []
        for _ in range(iters):
            t0 = time.perf_counter()
            with torch.autocast(device_type=device, dtype=dtype, enabled=dtype is not None):
                model(x)
            if device == "cuda":
                torch.cuda.synchronize()
            times.append((time.perf_counter() - t0) * 1e3)
        s = _summary(times)
        s["images_per_second"] = bs * 1000 / s["mean_ms"]
        if device == "cuda":
            s["peak_gpu_mem_gb"] = torch.cuda.max_memory_allocated() / 1024 ** 3
        out[f"batch_{bs}"] = s
    return out


def benchmark_end_to_end(predictor, frames_bgr: List[np.ndarray], warmup: int = 5) -> Dict:
    """Full live path on real frames (e.g. a few raw frames from the dataset)."""
    for f in frames_bgr[:warmup]:
        predictor.predict_frame(f)
    pre, mod, tot = [], [], []
    for f in frames_bgr:
        t0 = time.perf_counter()
        r = predictor.predict_frame(f)
        tot.append((time.perf_counter() - t0) * 1e3)
        if r["ok"]:
            pre.append(r["preprocess_ms"]); mod.append(r["model_ms"])
    return {"preprocessing": _summary(pre) if pre else None,
            "model_plus_postprocess": _summary(mod) if mod else None,
            "end_to_end": _summary(tot), "frames": len(frames_bgr),
            "note": "batch size 1, synchronised timing; excludes camera capture time"}
