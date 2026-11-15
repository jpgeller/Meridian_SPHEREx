"""Shared helpers: seeding, device selection, environment capture, hashing,
run directories and JSON I/O.

The device helper is deliberately strict: if CUDA is unavailable or the
installed PyTorch build cannot run kernels on the GPU, it stops with a
diagnostic instead of silently falling back to a very slow CPU run.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import platform
import random
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np


# --------------------------------------------------------------------------
# JSON / hashing
# --------------------------------------------------------------------------
def _json_default(o: Any):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, Path):
        return str(o)
    if isinstance(o, (_dt.datetime, _dt.date)):
        return o.isoformat()
    raise TypeError(f"Not JSON serialisable: {type(o)}")


def write_json(path: Path, data: Any) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=_json_default), encoding="utf-8")
    os.replace(tmp, path)
    return path


def read_json(path: Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Reproducibility
# --------------------------------------------------------------------------
def seed_everything(seed: int, deterministic: bool = False) -> None:
    """Seed Python, NumPy and (if installed) PyTorch.

    deterministic=True also asks cuDNN for deterministic kernels; this makes
    reruns bit-identical at some speed cost."""
    random.seed(seed)
    np.random.seed(seed)
    os.environ["PYTHONHASHSEED"] = str(seed)
    try:
        import torch
    except ImportError:
        return
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    if deterministic:
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        torch.use_deterministic_algorithms(True, warn_only=True)
    else:
        torch.backends.cudnn.benchmark = True


def worker_init_fn(worker_id: int) -> None:
    """DataLoader worker seeding (top-level function so Windows 'spawn' can
    pickle it)."""
    import torch
    seed = torch.initial_seed() % 2 ** 32
    np.random.seed(seed + worker_id)
    random.seed(seed + worker_id)


# --------------------------------------------------------------------------
# Device / precision
# --------------------------------------------------------------------------
class DeviceError(RuntimeError):
    pass


@dataclass
class DeviceInfo:
    device: str
    name: str
    capability: Optional[tuple]
    total_vram_gb: Optional[float]
    precision: str          # "bf16", "fp16" or "fp32"
    arch_list: Optional[list]


def cuda_kernel_smoke_test() -> None:
    """Run a few real kernels on the GPU. `torch.cuda.is_available()` alone
    does not prove that this PyTorch build contains kernels for the GPU's
    architecture (e.g. sm_120 on RTX 50-series)."""
    import torch
    a = torch.randn(512, 512, device="cuda")
    b = torch.randn(512, 512, device="cuda")
    c = (a @ b).relu().sum()
    conv = torch.nn.Conv2d(3, 8, 3).cuda()
    y = conv(torch.randn(2, 3, 32, 32, device="cuda"))
    ln = torch.nn.LayerNorm(64).cuda()
    z = ln(torch.randn(4, 64, device="cuda"))
    attn = torch.nn.functional.scaled_dot_product_attention(
        torch.randn(1, 2, 8, 16, device="cuda"), torch.randn(1, 2, 8, 16, device="cuda"),
        torch.randn(1, 2, 8, 16, device="cuda"))
    torch.cuda.synchronize()
    for t in (c, y, z, attn):
        if not torch.isfinite(t).all():
            raise DeviceError("CUDA smoke test produced non-finite values")


def select_device(device: str = "auto", allow_cpu: bool = False,
                  precision: str = "auto", run_smoke_test: bool = True) -> DeviceInfo:
    """Choose the training device. Refuses CPU unless explicitly allowed."""
    import torch
    if device in ("auto", "cuda"):
        if not torch.cuda.is_available():
            msg = ("CUDA is not available to this PyTorch installation.\n"
                   f"  torch {torch.__version__}, built for CUDA {torch.version.cuda}\n"
                   "  Fixes: install the CUDA build from environment_setup.md, update the "
                   "NVIDIA driver, and restart the kernel.\n"
                   "  To deliberately use the CPU set hardware.device: cpu and "
                   "hardware.allow_cpu_training: true.")
            if device == "cuda" or not allow_cpu:
                raise DeviceError(msg)
        else:
            cap = torch.cuda.get_device_capability(0)
            arch = torch.cuda.get_arch_list()
            needed = f"sm_{cap[0]}{cap[1]}"
            if arch and needed not in arch and not any(a.startswith("compute_") for a in arch):
                raise DeviceError(
                    f"This PyTorch build has no kernels for {needed} "
                    f"({torch.cuda.get_device_name(0)}). Built for: {arch}. "
                    "Install a CUDA 13.x build (see environment_setup.md).")
            if run_smoke_test:
                try:
                    cuda_kernel_smoke_test()
                except Exception as exc:  # report, never hide
                    raise DeviceError(f"CUDA kernel smoke test failed: {exc!r}") from exc
            props = torch.cuda.get_device_properties(0)
            if precision == "auto":
                prec = "bf16" if torch.cuda.is_bf16_supported() else "fp16"
            else:
                prec = precision
            return DeviceInfo("cuda", torch.cuda.get_device_name(0), cap,
                              round(props.total_memory / 1024 ** 3, 2), prec, arch)
    if not allow_cpu:
        raise DeviceError("CPU training was not explicitly allowed "
                          "(hardware.allow_cpu_training: false).")
    return DeviceInfo("cpu", platform.processor() or "cpu", None, None,
                      "fp32" if precision == "auto" else precision, None)


def suggest_batch_size(total_vram_gb: Optional[float], stage: str) -> int:
    """Conservative starting batch size for ViT-B/16 at 224x224.

    stage 'features' = frozen forward only; 'finetune' = backward through the
    last blocks. These are starting points; OOM handling halves them."""
    if total_vram_gb is None:
        return 8
    if stage == "features":
        return 128 if total_vram_gb >= 7 else 64
    return 48 if total_vram_gb >= 11 else 32 if total_vram_gb >= 7 else 16


# --------------------------------------------------------------------------
# Environment capture
# --------------------------------------------------------------------------
def environment_report() -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "executable": sys.executable,
        "time": now_iso(),
    }
    for mod in ("numpy", "pandas", "torch", "torchvision", "timm", "cv2", "sklearn",
                "safetensors", "huggingface_hub", "unigaze", "pyarrow", "matplotlib",
                "plotly"):
        try:
            m = __import__(mod)
            info[mod] = getattr(m, "__version__", "installed")
        except Exception as exc:
            info[mod] = f"not available ({type(exc).__name__})"
    try:
        import torch
        info["torch_cuda"] = torch.version.cuda
        info["cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
            info["gpu_capability"] = list(torch.cuda.get_device_capability(0))
            info["gpu_vram_gb"] = round(torch.cuda.get_device_properties(0).total_memory
                                        / 1024 ** 3, 2)
            info["torch_arch_list"] = torch.cuda.get_arch_list()
            info["bf16_supported"] = torch.cuda.is_bf16_supported()
    except Exception:
        pass
    return info


# --------------------------------------------------------------------------
# Run directories
# --------------------------------------------------------------------------
def new_run_dir(experiments_dir: Path, name: str) -> Path:
    """experiments/<name>_<NNN>/ - never reuses an existing directory."""
    experiments_dir = Path(experiments_dir)
    experiments_dir.mkdir(parents=True, exist_ok=True)
    n = 1
    while True:
        d = experiments_dir / f"{name}_{n:03d}"
        try:
            d.mkdir()
            (d / "figures").mkdir()
            return d
        except FileExistsError:
            n += 1
