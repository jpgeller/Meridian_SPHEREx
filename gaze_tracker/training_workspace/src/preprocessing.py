"""Image preprocessing shared by training, validation, test AND deployment.

There is exactly one implementation of each step, so the live cursor sees the
same pixels the model was trained on:

    raw RGB frame -> YuNet landmarks -> head pose (solvePnP, approximate
    camera) -> UniGaze data normalisation (crop + perspective warp to 224x224)
    -> ImageNet normalisation -> tensor

Why normalise at all? UniGaze was trained on *normalised* faces (Zhang et al.,
ETRA 2018): a virtual camera looks straight at the face centre from a fixed
distance with the head's roll removed. The capture app's 224x224 face crops are
plain bounding-box crops, so they differ in scale, roll and perspective from
what the network expects. `input_mode: existing_face_crop` keeps them available
as a comparison.

The camera is NOT calibrated. Following UniGaze's own in-the-wild video script
(predict_gaze_video.py), intrinsics are approximated (focal = 4 x crop width,
no distortion). This approximation is recorded in every cache/experiment and
affects the absolute meaning of the head-pose and gaze angles, which is why
those angles are used only as learned *features*, never as labels.

Colour handling: OpenCV decodes PNG to BGR. Every function documents which
order it takes/returns. Model inputs are RGB, as in UniGaze
(`img_normalized[:, :, [2, 1, 0]]`).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from . import geometry as geo

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


# --------------------------------------------------------------------------
# Landmarks
# --------------------------------------------------------------------------
@dataclass
class Landmarks5:
    """YuNet output in full-frame pixel coordinates.
    points order: right eye, left eye, nose tip, right mouth, left mouth
    ("right"/"left" = the participant's own side)."""
    face_box: Tuple[float, float, float, float]
    points: np.ndarray            # (5, 2)
    score: float


class YuNetLandmarker:
    """OpenCV YuNet, the same detector the capture app used."""

    def __init__(self, model_path: Path, score_threshold: float = 0.6, max_side: int = 640):
        model_path = Path(model_path)
        if not model_path.is_file():
            raise FileNotFoundError(f"YuNet model not found: {model_path}")
        self._det = cv2.FaceDetectorYN.create(str(model_path), "", (320, 320),
                                              score_threshold=score_threshold)
        self._size = None
        self.max_side = max_side

    def detect(self, frame_bgr: np.ndarray,
               expected_eyes: Optional[Tuple[Sequence[float], Sequence[float]]] = None
               ) -> Optional[Landmarks5]:
        """Detect faces; return the one matching `expected_eyes` (the eye centres
        recorded by the capture app: (left_eye_center, right_eye_center)) when
        given, otherwise the largest face."""
        h, w = frame_bgr.shape[:2]
        scale = min(1.0, self.max_side / max(h, w))
        small = frame_bgr if scale == 1.0 else cv2.resize(
            frame_bgr, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
        size = (small.shape[1], small.shape[0])
        if size != self._size:
            self._det.setInputSize(size)
            self._size = size
        _, faces = self._det.detect(small)
        if faces is None or len(faces) == 0:
            return None
        cands = []
        for f in faces:
            score = float(f[14])
            f = f[:14] / scale
            pts = f[4:14].reshape(5, 2)
            cands.append(Landmarks5(tuple(float(v) for v in f[:4]), pts, score))
        if expected_eyes is not None:
            le, re = np.asarray(expected_eyes[0]), np.asarray(expected_eyes[1])
            return min(cands, key=lambda c: np.linalg.norm(c.points[0] - re)
                       + np.linalg.norm(c.points[1] - le))
        return max(cands, key=lambda c: c.face_box[2] * c.face_box[3])


# --------------------------------------------------------------------------
# UniGaze data normalisation
# --------------------------------------------------------------------------
@dataclass
class NormalizedFace:
    ok: bool
    reason: str = ""
    image_rgb: Optional[np.ndarray] = None          # (224, 224, 3) uint8, RGB
    crop_box: Tuple[int, int, int, int] = (0, 0, 0, 0)   # x0, y0, x1, y1 in the frame
    W: Optional[np.ndarray] = None                  # crop -> normalised image homography
    R: Optional[np.ndarray] = None                  # camera -> normalised rotation
    head_pitchyaw_norm: Optional[np.ndarray] = None
    face_center_cam: Optional[np.ndarray] = None    # approximate, millimetres
    landmarks: Optional[np.ndarray] = None
    extras: Dict[str, float] = field(default_factory=dict)


def normalize_face(frame_bgr: np.ndarray, lm: Landmarks5, prep_cfg: Dict) -> NormalizedFace:
    """Crop + head pose + perspective normalisation of ONE face.

    Mirrors UniGaze predict_gaze_video.py: crop `crop_scale` x the face box
    (clipped to the frame), dummy camera on the crop, solvePnP, normalise to
    `roi_size` with focal_norm / distance_norm."""
    H, W_img = frame_bgr.shape[:2]
    x, y, bw, bh = lm.face_box
    cx, cy = x + bw / 2.0, y + bh / 2.0
    s = float(prep_cfg.get("crop_scale", 2.0))
    x0 = int(max(0, cx - bw * s / 2)); x1 = int(min(W_img, cx + bw * s / 2))
    y0 = int(max(0, cy - bh * s / 2)); y1 = int(min(H, cy + bh * s / 2))
    if x1 - x0 < 32 or y1 - y0 < 32:
        return NormalizedFace(False, "crop_too_small")
    crop = frame_bgr[y0:y1, x0:x1]
    pts = lm.points - np.array([x0, y0], dtype=np.float64)

    if prep_cfg.get("camera_model", "upstream_dummy") != "upstream_dummy":
        raise ValueError("Only the documented 'upstream_dummy' camera model is implemented; "
                         "add real calibration before using another model.")
    K, dist = geo.dummy_camera(crop.shape[1], crop.shape[0])
    try:
        hr, ht = geo.estimate_head_pose(pts, geo.yunet_model_points(), K, dist)
    except (ValueError, cv2.error) as exc:
        return NormalizedFace(False, f"pnp_failed:{exc}")
    hR = cv2.Rodrigues(hr)[0]
    center = geo.face_center_by_nose(hR, ht)
    if not np.isfinite(center).all() or center[2, 0] <= 0:
        return NormalizedFace(False, "face_behind_camera")
    roi = int(prep_cfg.get("roi_size", 224))
    mats = geo.normalization_matrices(center, hr, K, float(prep_cfg.get("focal_norm", 960)),
                                      float(prep_cfg.get("distance_norm", 600)), (roi, roi))
    head_py = geo.head_pitchyaw_from_rotation(mats["hR_norm"])
    if np.degrees(np.linalg.norm(head_py)) > float(prep_cfg.get("max_normalized_head_angle_deg", 80)):
        return NormalizedFace(False, "head_angle_too_large")
    warped_bgr = cv2.warpPerspective(crop, mats["W"], (roi, roi))
    return NormalizedFace(
        True, "", np.ascontiguousarray(warped_bgr[:, :, ::-1]), (x0, y0, x1, y1), mats["W"],
        mats["R"], head_py, center.reshape(3), lm.points.copy(),
        {"landmark_score": lm.score, "face_w_px": float(bw),
         "iod_px": float(np.linalg.norm(lm.points[0] - lm.points[1]))})


def warp_with_stored_geometry(frame_bgr: np.ndarray, crop_box: Sequence[int], W: np.ndarray,
                              roi: int = 224) -> np.ndarray:
    """Re-apply a stored normalisation (no detection) -> RGB uint8. Gives the
    same pixels as normalize_face for the same frame."""
    x0, y0, x1, y1 = [int(v) for v in crop_box]
    warped = cv2.warpPerspective(frame_bgr[y0:y1, x0:x1], np.asarray(W).reshape(3, 3), (roi, roi))
    return np.ascontiguousarray(warped[:, :, ::-1])


# --------------------------------------------------------------------------
# Reading images
# --------------------------------------------------------------------------
def read_bgr(path: Path) -> np.ndarray:
    """Decode an image file. Raises (never returns None) so failures are visible.
    cv2.imread cannot open non-ASCII Windows paths, hence imdecode."""
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise IOError(f"Could not decode image: {path}")
    return img


def read_face_crop_rgb(path: Path, size: int = 224) -> np.ndarray:
    img = read_bgr(path)
    if img.shape[:2] != (size, size):
        img = cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA)
    return np.ascontiguousarray(img[:, :, ::-1])


# --------------------------------------------------------------------------
# Tensor conversion (ImageNet normalisation, as UniGaze 'basic_imagenet')
# --------------------------------------------------------------------------
def to_model_tensor(images_rgb_uint8: np.ndarray):
    """(N,H,W,3) or (H,W,3) uint8 RGB -> float tensor (N,3,H,W), ImageNet-normalised."""
    import torch
    arr = np.asarray(images_rgb_uint8)
    if arr.ndim == 3:
        arr = arr[None]
    if arr.dtype != np.uint8 or arr.shape[-1] != 3:
        raise ValueError(f"Expected uint8 RGB (N,H,W,3), got {arr.dtype} {arr.shape}")
    t = torch.from_numpy(np.ascontiguousarray(arr)).permute(0, 3, 1, 2).float().div_(255.0)
    mean = torch.as_tensor(IMAGENET_MEAN).view(1, 3, 1, 1)
    std = torch.as_tensor(IMAGENET_STD).view(1, 3, 1, 1)
    return (t - mean) / std


def normalize_tensor_inplace(t_uint8_nchw):
    """GPU-side version used by the training loop: uint8 NCHW -> float, ImageNet."""
    import torch
    t = t_uint8_nchw.float().div_(255.0)
    mean = torch.as_tensor(IMAGENET_MEAN, device=t.device).view(1, 3, 1, 1)
    std = torch.as_tensor(IMAGENET_STD, device=t.device).view(1, 3, 1, 1)
    return (t - mean) / std


# --------------------------------------------------------------------------
# Optional photometric augmentation (TRAINING ONLY, disabled by default)
# --------------------------------------------------------------------------
def photometric_augment(img_rgb: np.ndarray, aug_cfg: Dict, rng: np.random.Generator) -> np.ndarray:
    """Label-preserving changes only: brightness, contrast, sensor noise,
    optional very mild blur. No flips, rotations, crops or perspective."""
    img = img_rgb.astype(np.float32)
    b = float(aug_cfg.get("brightness", 0.0))
    c = float(aug_cfg.get("contrast", 0.0))
    if b > 0:
        img = img * (1.0 + rng.uniform(-b, b))
    if c > 0:
        m = img.mean()
        img = (img - m) * (1.0 + rng.uniform(-c, c)) + m
    n = float(aug_cfg.get("gaussian_noise_std", 0.0))
    if n > 0:
        img = img + rng.normal(0.0, n * 255.0, img.shape)
    out = np.clip(img, 0, 255).astype(np.uint8)
    if rng.random() < float(aug_cfg.get("blur_probability", 0.0)):
        out = cv2.GaussianBlur(out, (3, 3), 0.6)
    return out


# --------------------------------------------------------------------------
# Normalised-face cache (optional, reproducible, lives in processed_cache/)
# --------------------------------------------------------------------------
GEOMETRY_COLUMNS = (["sample_id", "norm_ok", "norm_reason", "crop_x0", "crop_y0", "crop_x1",
                     "crop_y1", "head_pitch_norm", "head_yaw_norm", "face_cx_mm", "face_cy_mm",
                     "face_cz_mm", "landmark_score", "iod_px"]
                    + [f"W{i}" for i in range(9)] + [f"R{i}" for i in range(9)]
                    + [f"lm{i}" for i in range(10)])

_WORKER_STATE: Dict = {}


def _worker_init(yunet_path: str, prep_cfg: Dict, dataset_root: str) -> None:
    cv2.setNumThreads(1)
    _WORKER_STATE["det"] = YuNetLandmarker(Path(yunet_path))
    _WORKER_STATE["prep"] = prep_cfg
    _WORKER_STATE["root"] = Path(dataset_root)


def process_one(job: Tuple[int, str, str, list, list]) -> Tuple[int, Dict, Optional[np.ndarray]]:
    """Top-level (picklable) worker: one manifest row -> geometry + image."""
    pos, sample_id, raw_rel, left_c, right_c = job
    det: YuNetLandmarker = _WORKER_STATE["det"]
    row = {"sample_id": sample_id}
    try:
        frame = read_bgr(_WORKER_STATE["root"] / raw_rel)
    except Exception as exc:
        row.update(norm_ok=False, norm_reason=f"decode_failed:{exc}")
        return pos, row, None
    lm = det.detect(frame, expected_eyes=(left_c, right_c))
    if lm is None:
        row.update(norm_ok=False, norm_reason="no_face_detected")
        return pos, row, None
    res = normalize_face(frame, lm, _WORKER_STATE["prep"])
    if not res.ok:
        row.update(norm_ok=False, norm_reason=res.reason)
        return pos, row, None
    row.update(norm_ok=True, norm_reason="",
               crop_x0=res.crop_box[0], crop_y0=res.crop_box[1],
               crop_x1=res.crop_box[2], crop_y1=res.crop_box[3],
               head_pitch_norm=float(res.head_pitchyaw_norm[0]),
               head_yaw_norm=float(res.head_pitchyaw_norm[1]),
               face_cx_mm=float(res.face_center_cam[0]), face_cy_mm=float(res.face_center_cam[1]),
               face_cz_mm=float(res.face_center_cam[2]),
               landmark_score=res.extras["landmark_score"], iod_px=res.extras["iod_px"])
    for i, v in enumerate(res.W.reshape(-1)):
        row[f"W{i}"] = float(v)
    for i, v in enumerate(res.R.reshape(-1)):
        row[f"R{i}"] = float(v)
    for i, v in enumerate(res.landmarks.reshape(-1)):
        row[f"lm{i}"] = float(v)
    return pos, row, res.image_rgb


def cache_paths(cache_dir: Path, version: str, split: str) -> Dict[str, Path]:
    d = Path(cache_dir) / version
    return {"dir": d, "images": d / f"{split}_faces_uint8.npy",
            "geometry": d / f"{split}_geometry.parquet", "done": d / f"{split}_done.npy",
            "info": d / f"{split}_cache_info.json"}


def build_normalized_cache(manifest, dataset_root: Path, yunet_path: Path, prep_cfg: Dict,
                           cache_dir: Path, split: str, num_workers: int = 4,
                           chunk: int = 512, limit: Optional[int] = None,
                           progress: bool = True) -> Dict:
    """Write normalised 224x224 RGB faces for one split to a uint8 memmap.

    Resumable: a `done` mask is saved after every chunk; rerunning skips
    finished rows. Images that cannot be normalised stay all-zero and are
    marked norm_ok=False in the geometry table (reported, never silently used).
    MUST be called under `if __name__ == "__main__":` in scripts on Windows.
    """
    import multiprocessing as mp
    import pandas as pd
    from .utils import now_iso, write_json

    rows = manifest.reset_index(drop=True)
    if limit is not None:
        rows = rows.iloc[:limit]
    n = len(rows)
    roi = int(prep_cfg.get("roi_size", 224))
    p = cache_paths(cache_dir, prep_cfg.get("version", "norm-v1"), split)
    p["dir"].mkdir(parents=True, exist_ok=True)
    mode = "r+" if p["images"].exists() else "w+"
    images = np.lib.format.open_memmap(p["images"], mode=mode, dtype=np.uint8, shape=(n, roi, roi, 3))
    if images.shape[0] != n:
        raise RuntimeError(f"Existing cache {p['images']} has {images.shape[0]} rows, manifest "
                           f"has {n}. Delete the cache folder and rebuild.")
    done = np.load(p["done"]) if p["done"].exists() else np.zeros(n, dtype=bool)
    geom = (pd.read_parquet(p["geometry"]).to_dict("records") if p["geometry"].exists()
            else [None] * n)
    if len(geom) != n:
        geom = [None] * n
        done[:] = False

    todo = [i for i in range(n) if not done[i]]
    jobs = [(i, rows.at[i, "sample_id"], rows.at[i, "raw_path"],
             list(rows.at[i, "left_eye_center"]), list(rows.at[i, "right_eye_center"]))
            for i in todo]
    try:
        from tqdm.auto import tqdm
    except ImportError:  # pragma: no cover
        tqdm = None
    bar = tqdm(total=len(jobs), desc=f"normalising {split}") if (progress and tqdm) else None

    def handle(result):
        pos, row, img = result
        if img is not None:
            images[pos] = img
        geom[pos] = row
        done[pos] = True
        if bar:
            bar.update(1)

    def flush():
        images.flush()
        np.save(p["done"], done)
        df = pd.DataFrame([g if g is not None else {"sample_id": rows.at[i, "sample_id"],
                                                    "norm_ok": False, "norm_reason": "not_processed"}
                           for i, g in enumerate(geom)])
        df.to_parquet(p["geometry"], index=False)

    if num_workers and num_workers > 0:
        ctx = mp.get_context("spawn")
        with ctx.Pool(num_workers, initializer=_worker_init,
                      initargs=(str(yunet_path), dict(prep_cfg), str(dataset_root))) as pool:
            for k, result in enumerate(pool.imap_unordered(process_one, jobs, chunksize=16)):
                handle(result)
                if (k + 1) % chunk == 0:
                    flush()
    else:
        _worker_init(str(yunet_path), dict(prep_cfg), str(dataset_root))
        for k, job in enumerate(jobs):
            handle(process_one(job))
            if (k + 1) % chunk == 0:
                flush()
    flush()
    if bar:
        bar.close()
    gdf = pd.read_parquet(p["geometry"])
    info = {"split": split, "rows": n, "normalized_ok": int(gdf["norm_ok"].sum()),
            "failures": gdf.loc[~gdf["norm_ok"], "norm_reason"].value_counts().to_dict(),
            "preprocessing": dict(prep_cfg), "built": now_iso(),
            "note": "camera intrinsics are APPROXIMATE (UniGaze upstream dummy camera)"}
    write_json(p["info"], info)
    return info
