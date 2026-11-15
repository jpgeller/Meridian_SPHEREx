"""Face / eye detection, crop extraction and frame quality gates.

This is image-capture preprocessing only.  There is no gaze estimation and no
model training anywhere in this project.

Frames are BGR numpy arrays in memory (OpenCV convention) and are written as
ordinary 3-channel RGB PNG files by cv2.imwrite.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from . import config as cfg

Box = Tuple[int, int, int, int]  # x, y, w, h


@dataclass
class Detection:
    face_box: Box
    left_eye: Tuple[float, float]    # participant's LEFT eye centre (image px)
    right_eye: Tuple[float, float]   # participant's RIGHT eye centre (image px)
    score: float
    detector: str


@dataclass
class FrameSample:
    """One accepted frame, held in memory until its trial is committed."""
    raw: np.ndarray
    face: np.ndarray
    left_eye: np.ndarray
    right_eye: np.ndarray
    detection: Detection
    boxes: Dict[str, Box]
    quality: Dict[str, float]
    capture_time: float
    state_at_capture: str = "CAPTURING"


@dataclass
class FrameVerdict:
    valid: bool
    reasons: List[str] = field(default_factory=list)
    detection: Optional[Detection] = None
    sample: Optional[FrameSample] = None


# --------------------------------------------------------------------------
# Detectors
# --------------------------------------------------------------------------
class YuNetDetector:
    """OpenCV YuNet face detector (face box + eye landmarks)."""
    name = "opencv-yunet-2023mar"
    _MAX_SIDE = 640

    def __init__(self, model_path=cfg.MODEL_PATH):
        self._det = cv2.FaceDetectorYN.create(str(model_path), "", (320, 320),
                                              score_threshold=0.6)
        self._size = None

    def detect(self, frame: np.ndarray) -> Optional[Detection]:
        h, w = frame.shape[:2]
        scale = min(1.0, self._MAX_SIDE / max(h, w))
        small = frame if scale == 1.0 else cv2.resize(
            frame, (int(round(w * scale)), int(round(h * scale))))
        size = (small.shape[1], small.shape[0])
        if size != self._size:
            self._det.setInputSize(size)
            self._size = size
        _, faces = self._det.detect(small)
        if faces is None or len(faces) == 0:
            return None
        f = max(faces, key=lambda r: r[2] * r[3]) / scale   # largest face
        f[14] *= scale                                       # score is not a coordinate
        # YuNet landmark order: right eye, left eye (subject's perspective).
        return Detection(
            face_box=(int(f[0]), int(f[1]), int(f[2]), int(f[3])),
            right_eye=(float(f[4]), float(f[5])),
            left_eye=(float(f[6]), float(f[7])),
            score=float(f[14]), detector=self.name)


class HaarDetector:
    """Fallback when the YuNet model is unavailable (needs cv2.data cascades)."""
    name = "opencv-haar"

    def __init__(self):
        base = cv2.data.haarcascades
        self._face = cv2.CascadeClassifier(base + "haarcascade_frontalface_default.xml")
        self._eye = cv2.CascadeClassifier(base + "haarcascade_eye.xml")
        if self._face.empty() or self._eye.empty():
            raise RuntimeError("Haar cascade files not available")

    def detect(self, frame: np.ndarray) -> Optional[Detection]:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = self._face.detectMultiScale(gray, 1.1, 5, minSize=(80, 80))
        if len(faces) == 0:
            return None
        x, y, w, h = max(faces, key=lambda r: r[2] * r[3])
        eyes = self._eye.detectMultiScale(gray[y:y + int(h * 0.6), x:x + w], 1.1, 6)
        if len(eyes) < 2:
            return None
        eyes = sorted(eyes, key=lambda r: r[2] * r[3], reverse=True)[:2]
        centres = sorted((x + ex + ew / 2.0, y + ey + eh / 2.0) for ex, ey, ew, eh in eyes)
        # Unmirrored camera image: the participant's right eye is at smaller x.
        return Detection(face_box=(int(x), int(y), int(w), int(h)),
                         right_eye=centres[0], left_eye=centres[1],
                         score=1.0, detector=self.name)


def create_detector():
    try:
        if cfg.MODEL_PATH.is_file():
            return YuNetDetector()
    except Exception:
        pass
    return HaarDetector()


# --------------------------------------------------------------------------
# Crops
# --------------------------------------------------------------------------
def _square_box(cx: float, cy: float, side: float) -> Box:
    side = int(round(side))
    return int(round(cx - side / 2.0)), int(round(cy - side / 2.0)), side, side


def _inside(box: Box, shape) -> bool:
    x, y, w, h = box
    return x >= 0 and y >= 0 and w > 0 and h > 0 and x + w <= shape[1] and y + h <= shape[0]


def _clip(box: Box, shape) -> Box:
    x, y, w, h = box
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(shape[1], x + w), min(shape[0], y + h)
    return x0, y0, max(0, x1 - x0), max(0, y1 - y0)


def _crop(frame: np.ndarray, box: Box, size: int) -> np.ndarray:
    x, y, w, h = box
    interp = cv2.INTER_AREA if w > size else cv2.INTER_CUBIC
    return cv2.resize(frame[y:y + h, x:x + w], (size, size), interpolation=interp)


def crop_boxes(det: Detection, shape) -> Dict[str, Box]:
    fx, fy, fw, fh = det.face_box
    face_side = max(fw, fh) * cfg.FACE_BOX_EXPAND
    eye_side = fw * cfg.EYE_BOX_FRACTION
    return {
        "face": _clip(_square_box(fx + fw / 2.0, fy + fh / 2.0, face_side), shape),
        "left_eye": _square_box(det.left_eye[0], det.left_eye[1], eye_side),
        "right_eye": _square_box(det.right_eye[0], det.right_eye[1], eye_side),
    }


# --------------------------------------------------------------------------
# Quality gates
# --------------------------------------------------------------------------
def evaluate_frame(frame: np.ndarray, detector, capture_time: float) -> FrameVerdict:
    """Detect, crop and quality-check one frame. Never modifies `frame`."""
    if frame is None or frame.ndim != 3 or frame.shape[2] != 3:
        return FrameVerdict(False, ["not_a_3_channel_frame"])
    det = detector.detect(frame)
    if det is None:
        return FrameVerdict(False, ["no_face_or_eyes"])
    reasons: List[str] = []
    if det.score < cfg.MIN_FACE_SCORE:
        reasons.append("low_face_confidence")
    if det.face_box[2] < cfg.MIN_FACE_WIDTH_FRACTION * frame.shape[1]:
        reasons.append("face_too_small")
    boxes = crop_boxes(det, frame.shape)
    if boxes["face"][2] < 20 or boxes["face"][3] < 20:
        reasons.append("face_out_of_frame")
    for eye in ("left_eye", "right_eye"):
        if not _inside(boxes[eye], frame.shape):
            reasons.append(f"{eye}_out_of_frame")
    if reasons:
        return FrameVerdict(False, reasons, det)

    face = _crop(frame, boxes["face"], cfg.FACE_CROP_SIZE)
    gray = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    brightness = float(gray.mean())
    if sharpness < cfg.MIN_SHARPNESS:
        reasons.append("blurry")
    if brightness < cfg.MIN_BRIGHTNESS:
        reasons.append("too_dark")
    if brightness > cfg.MAX_BRIGHTNESS:
        reasons.append("too_bright")
    if reasons:
        return FrameVerdict(False, reasons, det)

    sample = FrameSample(
        raw=frame.copy(),
        face=face,
        left_eye=_crop(frame, boxes["left_eye"], cfg.EYE_CROP_SIZE),
        right_eye=_crop(frame, boxes["right_eye"], cfg.EYE_CROP_SIZE),
        detection=det, boxes=boxes,
        quality={"face_score": round(det.score, 4),
                 "sharpness": round(sharpness, 2),
                 "brightness": round(brightness, 2)},
        capture_time=capture_time)
    return FrameVerdict(True, [], det, sample)
