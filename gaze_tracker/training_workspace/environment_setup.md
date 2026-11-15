# Environment setup (Windows 11, NVIDIA RTX 5060 Laptop GPU)

> Short version: the install steps in [../README.md](../README.md). This page has the full background.
> `requirements.txt` here now points to `../requirements.txt` (one list for the whole project, incl. MediaPipe).

Installing packages does **not** start any training. Every command below is copy-and-paste for **PowerShell**.

## 1. Why not the versions in the UniGaze README?

UniGaze's README installs `torch==2.0.1` (CUDA 11.8) and `timm==0.3.2`. Those builds contain no GPU kernels for
the RTX 50-series (Blackwell, compute capability 12.0 / `sm_120`), so CUDA would either be unavailable or fail at
the first kernel. RTX 50-series support arrived in PyTorch 2.7 with CUDA 12.8; current PyTorch (2.15, released
28 Oct 2026) ships CUDA 13.2 wheels by default for Windows. I checked that the official UniGaze model code loads and
runs unchanged with **timm 1.0.31**, so the old timm pin is not needed. The `unigaze` package is therefore installed
with `--no-deps`.

Tested combination (in a Linux sandbox; the GPU path still has to be confirmed on your laptop with step 6):
Python 3.12 · torch 2.15.0+cu132 · torchvision 0.29.2+cu132 · timm 1.0.31 · unigaze 0.1.3 · numpy 2.5 ·
pandas 3.1 · opencv-python 5.0.

## 2. Create a clean environment

Open PowerShell and go to the project:

```powershell
cd gaze_tracker\training_workspace
```

**Option A — Miniconda** (you already use it):

```powershell
conda create -n nasa-gaze python=3.12 -y
conda activate nasa-gaze
python -m pip install --upgrade pip
```

**Option B — plain venv** (needs Python 3.12 from python.org):

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
```

If PowerShell refuses to run `Activate.ps1`, run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## 3. Install PyTorch with Blackwell (sm_120) support

First make sure the NVIDIA driver is recent (NVIDIA App → Drivers, or `nvidia-smi`). CUDA 13.x wheels need an
R580-series driver or newer.

```powershell
nvidia-smi
pip install torch==2.15.0 torchvision==0.29.2 --index-url https://download.pytorch.org/whl/cu132
```

Before installing, compare this with the official selector at <https://pytorch.org/get-started/locally/>
(Stable · Windows · Pip · Python · CUDA). I could not open that page from my sandbox. If it lists a newer stable
version or a different CUDA option, use its command. Any CUDA 13.x build (`cu130`, `cu132`, `cu134`) supports the
RTX 5060. Do **not** use `cu126` or the old `cu118` builds: they have no `sm_120` kernels.

## 4. Install the remaining packages and UniGaze

```powershell
pip install -r requirements.txt
pip install unigaze==0.1.3 --no-deps
```

`--no-deps` is required: without it pip would downgrade timm to 0.3.2, which is incompatible with current PyTorch.

## 5. Register the Jupyter kernel

```powershell
python -m ipykernel install --user --name nasa-gaze --display-name "Python 3 (nasa-gaze)"
```

## 6. Verify the environment (prints versions + a real CUDA kernel test)

```powershell
python scripts\verify_environment.py
```

Or the minimal manual check:

```powershell
python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available()); print(torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0)); print(torch.cuda.get_arch_list())"
python -c "import torch; a=torch.randn(1024,1024,device='cuda'); print((a@a).relu().sum().item()); torch.cuda.synchronize(); print('CUDA kernels OK')"
```

Expected: capability `(12, 0)`, `sm_120` in the arch list, and `CUDA kernels OK`. `torch.cuda.is_available()`
alone does not prove that kernels for your GPU exist; the matrix multiply does.

## 7. Run the unit tests (no GPU, no dataset, no downloads)

```powershell
python -m pytest
```

These use synthetic fixtures only. `test_official_unigaze_architecture_and_strict_load` builds the real
86.6 M-parameter architecture with random weights (takes a few seconds; it is skipped if `unigaze` is missing).

## 8. Download the UniGaze checkpoint (≈350 MB, once, only when you decide)

Either run notebook 03, section 2, with `ALLOW_DOWNLOAD = True`, or:

```powershell
python -c "import sys; sys.path.insert(0,'.'); from src.config import load_config; from src.models import resolve_checkpoint; print(resolve_checkpoint(load_config(), allow_download=True))"
```

The file goes to `training_workspace\checkpoints\hf_cache\`. Check the licence first (`LICENSE_NOTICE_UNIGAZE.md`).

## 9. CPU-only environment for the dataset audit (optional)

Notebook 01 and `scripts\run_audit.py` do not need a GPU:

```powershell
conda create -n nasa-gaze-cpu python=3.12 -y
conda activate nasa-gaze-cpu
pip install torch==2.15.0 torchvision==0.29.2 --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
python scripts\run_audit.py --decode full
```

## Common problems

| Symptom | Cause / fix |
|---|---|
| `CUDA capability sm_120 is not compatible` or `no kernel image is available` | A cu118/cu126/old PyTorch is installed. Run `pip uninstall -y torch torchvision`, then repeat step 3. |
| `torch.cuda.is_available()` is False | CPU wheel installed, or the driver is too old. Check `pip show torch` (version must end in `+cu13x`) and `nvidia-smi`. |
| `ImportError: torch._six` or timm errors | timm 0.3.2 got installed. `pip install "timm>=1.0.9,<2"`, then reinstall unigaze with `--no-deps`. |
| DataLoader hangs or crashes in Jupyter on Windows | Set `hardware.num_workers: 0` in `training_config.yaml`, or use the scripts in `scripts\` (they have the `if __name__ == "__main__":` guard Windows needs). |
| `CUDA out of memory` in Stage B | Lower `stage_b.batch_size` (e.g. 16) and raise `stage_b.grad_accum_steps` (e.g. 4), or unfreeze fewer blocks. |
| `cv2.FaceDetectorYN` missing | `pip install --upgrade "opencv-python>=4.10"`. Uninstall `opencv-python-headless` if both are installed. |
