"""Check the Python/PyTorch/GPU setup. Run:  python scripts/verify_environment.py

Prints versions, confirms this PyTorch build has kernels for your GPU
(sm_120 for the RTX 5060) and runs a few real CUDA operations. It does not
train, download or touch the dataset."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _check_runtime_packages() -> bool:
    """Packages the live demo needs, independent of the GPU."""
    ok = True
    try:
        import cv2
        assert hasattr(cv2, "FaceDetectorYN"), "this OpenCV has no FaceDetectorYN (YuNet)"
        print("opencv", cv2.__version__, "with YuNet: OK")
    except Exception as exc:
        print("FAIL: opencv:", repr(exc)); ok = False
    try:
        import mediapipe
        from mediapipe.tasks.python import vision  # noqa: F401
        print("mediapipe", mediapipe.__version__, ": OK")
    except Exception as exc:
        print("FAIL: mediapipe (pip install -r ../requirements.txt):", repr(exc)); ok = False
    try:
        from unigaze.models.mae_gaze import MAE_Gaze  # noqa: F401
        print("unigaze import: OK")
    except Exception as exc:
        print("FAIL: unigaze (pip install --no-deps -r ../requirements-nodeps.txt):", repr(exc)); ok = False
    return ok


def main() -> int:
    import torch
    from src.utils import DeviceError, cuda_kernel_smoke_test, environment_report
    print(json.dumps(environment_report(), indent=2, default=str))
    print("torch", torch.__version__, "| CUDA build", torch.version.cuda,
          "| cuda available", torch.cuda.is_available())
    if not _check_runtime_packages():
        return 1
    if not torch.cuda.is_available():
        print("WARNING: no CUDA GPU in this PyTorch. The live demo runs on the CPU (slowly); training needs a GPU -\n"
              "         see ../README.md (Install, step 2) and environment_setup.md, section 3.")
        print("OK - environment ready for the live demo (CPU).")
        return 0
    cap = torch.cuda.get_device_capability(0)
    print("GPU", torch.cuda.get_device_name(0), "capability", cap)
    print("kernels compiled for", torch.cuda.get_arch_list())
    if f"sm_{cap[0]}{cap[1]}" not in torch.cuda.get_arch_list():
        print(f"FAIL: this PyTorch has no sm_{cap[0]}{cap[1]} kernels. Install a CUDA 13.x build.")
        return 1
    try:
        cuda_kernel_smoke_test()
    except Exception as exc:
        print("FAIL: CUDA smoke test:", repr(exc))
        return 1
    print("bf16 supported:", torch.cuda.is_bf16_supported())
    try:
        import unigaze  # noqa: F401
        from unigaze.models.mae_gaze import MAE_Gaze
        n = sum(p.numel() for p in MAE_Gaze(model_type="vit_b_16").parameters())
        print("unigaze import OK; UniGaze-B/16 parameters:", n)
    except Exception as exc:
        print("FAIL: unigaze:", repr(exc))
        return 1
    print("OK - environment ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
