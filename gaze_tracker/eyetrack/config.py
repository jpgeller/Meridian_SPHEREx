"""Central configuration for the NASA Eye-Tracking dataset collector.

Everything that affects labels, preprocessing or storage lives here so that it
is changed in exactly one place and recorded in every session_metadata.json.
"""
from __future__ import annotations

import json
from pathlib import Path

# --------------------------------------------------------------------------
# Locations.  The default dataset root is anchored to the project folder,
# never to the terminal's current working directory.
# --------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATASET_ROOT = PROJECT_ROOT / "NASA_EyeTracking_Dataset"
SETTINGS_FILE = PROJECT_ROOT / "app_settings.json"
MODEL_PATH = PROJECT_ROOT / "models" / "face_detection_yunet_2023mar.onnx"

# --------------------------------------------------------------------------
# Collection modes and subject-disjoint split assignment.
# --------------------------------------------------------------------------
MODE_PILOT = "pilot"
MODE_OFFICIAL = "official"
MODES = (MODE_PILOT, MODE_OFFICIAL)

SPLIT_TRAIN = "train"
SPLIT_VALIDATION = "validation"
SPLIT_TEST = "test"
SPLIT_PILOT = "pilot"
PRIMARY_SPLITS = (SPLIT_TRAIN, SPLIT_VALIDATION, SPLIT_TEST)

OFFICIAL_SPLIT_ASSIGNMENT = {
    "P001": SPLIT_TRAIN, "P002": SPLIT_TRAIN, "P003": SPLIT_TRAIN,
    "P004": SPLIT_TRAIN, "P005": SPLIT_TRAIN, "P006": SPLIT_TRAIN,
    "P007": SPLIT_VALIDATION, "P008": SPLIT_VALIDATION,
    "P009": SPLIT_TEST, "P010": SPLIT_TEST,
}
OFFICIAL_PARTICIPANTS = tuple(sorted(OFFICIAL_SPLIT_ASSIGNMENT))
SESSION_IDS = tuple(f"S{i:02d}" for i in range(1, 21))

TARGET_VALID_IMAGES_PER_PARTICIPANT = 5000

# --------------------------------------------------------------------------
# Trial protocol.
# --------------------------------------------------------------------------
FRAMES_PER_TARGET = 10            # valid frames saved per fixation target
STABILIZATION_SECONDS = 3.0       # countdown after start and after every resume
TARGET_SETTLE_SECONDS = 0.8       # time for the eye to land on a new target
MIN_FRAME_INTERVAL_SECONDS = 0.05 # minimum spacing between saved frames
TRIAL_TIMEOUT_SECONDS = 12.0      # give up on a trial that cannot get valid frames
MAX_TRIAL_RETRIES = 2             # a timed-out target is retried this many times
TARGET_MARGIN_FRACTION = 0.05     # targets stay this far from the screen edge

PILOT_TARGET_CHOICES = (5, 10, 25)
OFFICIAL_TARGETS_PER_SESSION_CHOICES = (50, 100, 250, 500)
OFFICIAL_TARGETS_PER_SESSION_DEFAULT = 100   # 100 targets x 10 frames = 1,000 images

# --------------------------------------------------------------------------
# Preprocessing (identical in Pilot and Official mode).
# Raw frames are stored untouched; crops are derived from them.
# "left"/"right" always mean the PARTICIPANT's anatomical left/right eye.
# --------------------------------------------------------------------------
FACE_CROP_SIZE = 224              # square, pixels
EYE_CROP_SIZE = 112               # square, pixels
FACE_BOX_EXPAND = 1.15            # enlarge detected face box before cropping
EYE_BOX_FRACTION = 0.36           # eye crop side as a fraction of face width
IMAGE_EXT = ".png"                # lossless, 3-channel
PNG_COMPRESSION = 1

# --------------------------------------------------------------------------
# Frame quality gates.  A frame failing any gate is rejected (never saved).
# --------------------------------------------------------------------------
MIN_FACE_SCORE = 0.80
MIN_FACE_WIDTH_FRACTION = 0.12    # face must span at least this share of frame width
MIN_SHARPNESS = 15.0              # variance of Laplacian on the face crop
MIN_BRIGHTNESS = 35.0
MAX_BRIGHTNESS = 225.0

# --------------------------------------------------------------------------
# Camera request (the values actually delivered are recorded in metadata).
# --------------------------------------------------------------------------
CAMERA_INDEX = 0
CAMERA_WIDTH = 1280
CAMERA_HEIGHT = 720
CAMERA_FPS = 30


# --------------------------------------------------------------------------
# Optional physical setup, recorded in session_metadata.json when filled in.
# --------------------------------------------------------------------------
MONITOR_WIDTH_MM = None
MONITOR_HEIGHT_MM = None
VIEWING_DISTANCE_MM = None

PILOT_PARTICIPANTS = tuple(f"PILOT{i:02d}" for i in range(1, 6))


def protocol_snapshot() -> dict:
    """Protocol/preprocessing parameters written into session_metadata.json."""
    return {
        "frames_per_target": FRAMES_PER_TARGET,
        "stabilization_seconds": STABILIZATION_SECONDS,
        "target_settle_seconds": TARGET_SETTLE_SECONDS,
        "min_frame_interval_seconds": MIN_FRAME_INTERVAL_SECONDS,
        "trial_timeout_seconds": TRIAL_TIMEOUT_SECONDS,
        "max_trial_retries": MAX_TRIAL_RETRIES,
        "target_margin_fraction": TARGET_MARGIN_FRACTION,
        "face_crop_size": FACE_CROP_SIZE,
        "eye_crop_size": EYE_CROP_SIZE,
        "face_box_expand": FACE_BOX_EXPAND,
        "eye_box_fraction": EYE_BOX_FRACTION,
        "image_ext": IMAGE_EXT,
        "color": "RGB, 8-bit, 3 channels (stored as standard PNG)",
        "eye_naming": "left_eye/right_eye = participant's anatomical left/right",
        "raw_frames": "unmirrored, unmodified camera frames",
        "quality_gates": {
            "min_face_score": MIN_FACE_SCORE,
            "min_face_width_fraction": MIN_FACE_WIDTH_FRACTION,
            "min_sharpness": MIN_SHARPNESS,
            "min_brightness": MIN_BRIGHTNESS,
            "max_brightness": MAX_BRIGHTNESS,
        },
    }


# --------------------------------------------------------------------------
# Persisted operator settings (dataset root only).  The root is changed only
# by an explicit operator action in the dashboard - never silently.
# --------------------------------------------------------------------------
def load_dataset_root(settings_file: Path = SETTINGS_FILE) -> Path:
    try:
        data = json.loads(Path(settings_file).read_text(encoding="utf-8"))
        root = Path(data["dataset_root"])
        if root.is_absolute():
            return root
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return DEFAULT_DATASET_ROOT


def save_dataset_root(root: Path, settings_file: Path = SETTINGS_FILE) -> Path:
    root = Path(root).expanduser()
    if not root.is_absolute():
        raise ValueError(f"Dataset root must be an absolute path, got: {root}")
    root = root.resolve()
    Path(settings_file).write_text(
        json.dumps({"dataset_root": str(root)}, indent=2), encoding="utf-8")
    return root
