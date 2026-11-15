"""Geometry: gaze-angle conventions, screen coordinates and the UniGaze data
normalisation transform.

Gaze-angle convention (verified against UniGaze gazelib/gaze/gaze_utils.py):

    vector = (cos(pitch) * sin(yaw),  sin(pitch),  cos(pitch) * cos(yaw))
    pitch  = arcsin(v_y),  yaw = arctan2(v_x, v_z)

UniGaze's `pred_gaze` is (pitch, yaw) in radians, expressed in the
*normalised camera* frame produced by `normalize()` below. It is a direction,
never a screen position; this project never treats it as one.

Screen convention: origin at the top-left pixel of the participant monitor,
x to the right, y DOWNWARD, units = monitor pixels. Normalised screen
coordinates are x/width and y/height.
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple

import cv2
import numpy as np


# --------------------------------------------------------------------------
# Gaze angles <-> 3D unit vectors (UniGaze convention)
# --------------------------------------------------------------------------
def pitchyaw_to_vector(pitchyaw: np.ndarray) -> np.ndarray:
    pitchyaw = np.atleast_2d(np.asarray(pitchyaw, dtype=np.float64))
    pitch, yaw = pitchyaw[:, 0], pitchyaw[:, 1]
    return np.stack([np.cos(pitch) * np.sin(yaw), np.sin(pitch),
                     np.cos(pitch) * np.cos(yaw)], axis=1)


def vector_to_pitchyaw(vectors: np.ndarray) -> np.ndarray:
    v = np.atleast_2d(np.asarray(vectors, dtype=np.float64))
    v = v / np.linalg.norm(v, axis=1, keepdims=True)
    return np.stack([np.arcsin(np.clip(v[:, 1], -1, 1)), np.arctan2(v[:, 0], v[:, 2])], axis=1)


def angular_error_deg(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Angle between gaze vectors (only meaningful with REAL 3D labels)."""
    a = np.atleast_2d(a) / np.linalg.norm(np.atleast_2d(a), axis=1, keepdims=True)
    b = np.atleast_2d(b) / np.linalg.norm(np.atleast_2d(b), axis=1, keepdims=True)
    return np.degrees(np.arccos(np.clip((a * b).sum(axis=1), -1.0, 1.0)))


# --------------------------------------------------------------------------
# Screen coordinates
# --------------------------------------------------------------------------
def norm_to_px(xy_norm: np.ndarray, width: int, height: int) -> np.ndarray:
    xy = np.asarray(xy_norm, dtype=np.float64)
    return xy * np.array([width, height], dtype=np.float64)


def px_to_norm(xy_px: np.ndarray, width: int, height: int) -> np.ndarray:
    xy = np.asarray(xy_px, dtype=np.float64)
    return xy / np.array([width, height], dtype=np.float64)


def isotropic_scale(width: int, height: int) -> np.ndarray:
    """Multiply normalised (x, y) residuals by this to get residuals in units of
    the screen diagonal. Normalised x and y have different pixel sizes on a
    16:10 screen; this scaling makes a loss on them proportional to the real
    Euclidean pixel distance."""
    d = float(np.hypot(width, height))
    return np.array([width / d, height / d], dtype=np.float64)


def euclidean_px(pred_norm: np.ndarray, true_norm: np.ndarray, width: int, height: int) -> np.ndarray:
    diff = (np.asarray(pred_norm) - np.asarray(true_norm)) * np.array([width, height])
    return np.sqrt((diff ** 2).sum(axis=1))


def clamp_to_screen(xy_px: np.ndarray, width: int, height: int) -> np.ndarray:
    """Deployment-time clamp. Never used inside the loss (would kill gradients
    at the screen edge)."""
    xy = np.asarray(xy_px, dtype=np.float64).copy()
    xy[..., 0] = np.clip(xy[..., 0], 0, width - 1)
    xy[..., 1] = np.clip(xy[..., 1], 0, height - 1)
    return xy


# --------------------------------------------------------------------------
# 3D face model.
# Nine points of the 50-point generic face model shipped with UniGaze
# (unigaze/data/face_model.txt, from the ETH-XGaze toolchain), in millimetres,
# copied with attribution. Indices refer to that file.
#   20, 23: participant's RIGHT eye corners  (image LEFT in an unmirrored frame)
#   26, 29: participant's LEFT eye corners
#   15, 19: nose wings (used by UniGaze for the face centre)
#   13    : nose tip
#   32, 38: mouth corners (right, left)
# --------------------------------------------------------------------------
FACE_MODEL_MM: Dict[int, np.ndarray] = {
    13: np.array([1.16903996, -5.50272942, 6.93375969]),
    15: np.array([-10.61166477, 12.95834923, 21.62276459]),
    19: np.array([11.28962994, 13.86424446, 21.83790016]),
    20: np.array([-46.5094986, -38.32709503, 36.41600418]),
    23: np.array([-17.76072121, -32.58519745, 29.07615662]),
    26: np.array([18.04391098, -30.95682335, 29.0629673]),
    29: np.array([44.73758698, -34.10787201, 36.73243713]),
    32: np.array([-20.00109673, 35.87311935, 24.6794014]),
    38: np.array([21.46691895, 37.12250137, 24.39267731]),
}


def yunet_model_points() -> np.ndarray:
    """3D points matching YuNet's 5 landmarks, in YuNet's order:
    right-eye centre, left-eye centre, nose tip, right mouth corner, left mouth corner."""
    m = FACE_MODEL_MM
    return np.stack([(m[20] + m[23]) / 2, (m[26] + m[29]) / 2, m[13], m[32], m[38]]
                    ).astype(np.float64)


def face_center_by_nose(hR: np.ndarray, ht: np.ndarray) -> np.ndarray:
    """UniGaze's get_face_center_by_nose: mean of (eye-corner centre,
    nose-wing centre) after applying the head pose."""
    m = FACE_MODEL_MM
    pts = np.stack([m[20], m[23], m[26], m[29], m[15], m[19]]).T      # 3x6
    fc = hR @ pts + ht.reshape(3, 1)
    eyes = fc[:, 0:4].mean(axis=1)
    nose = fc[:, 4:6].mean(axis=1)
    return ((eyes + nose) / 2.0).reshape(3, 1)


# --------------------------------------------------------------------------
# Camera model and head pose
# --------------------------------------------------------------------------
def dummy_camera(width: int, height: int) -> Tuple[np.ndarray, np.ndarray]:
    """UniGaze predict_gaze_video.set_dummy_camera_model: focal = 4 x width,
    principal point at the centre, no distortion. AN APPROXIMATION."""
    f = 4.0 * width
    K = np.array([[f, 0, width // 2], [0, f, height // 2], [0, 0, 1]], dtype=np.float64)
    return K, np.zeros((1, 5), dtype=np.float64)


def estimate_head_pose(landmarks_2d: np.ndarray, model_points: np.ndarray,
                       K: np.ndarray, dist: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """EPnP followed by iterative refinement (as UniGaze estimateHeadPose)."""
    lm = landmarks_2d.astype(np.float64).reshape(-1, 1, 2)
    mp = model_points.astype(np.float64).reshape(-1, 1, 3)
    ok, rvec, tvec = cv2.solvePnP(mp, lm, K, dist, flags=cv2.SOLVEPNP_EPNP)
    if not ok:
        raise ValueError("solvePnP (EPnP) failed")
    ok, rvec, tvec = cv2.solvePnP(mp, lm, K, dist, rvec, tvec, True)
    if not ok:
        raise ValueError("solvePnP refinement failed")
    return rvec, tvec


def normalization_matrices(center: np.ndarray, hr: np.ndarray, K: np.ndarray,
                           focal_norm: float, distance_norm: float,
                           roi_size: Tuple[int, int]) -> Dict[str, np.ndarray]:
    """Port of UniGaze gazelib/gaze/normalize.normalize() without the image warp.

    Returns
      R       rotation camera -> normalised camera (applied to gaze directions)
      W       3x3 homography, camera image -> normalised image
      hR_norm head rotation in the normalised frame
    """
    center = np.asarray(center, dtype=np.float64).reshape(3, 1)
    hR = cv2.Rodrigues(hr)[0]
    distance = float(np.linalg.norm(center))
    z_scale = distance_norm / distance
    cam_norm = np.array([[focal_norm, 0, roi_size[0] / 2],
                         [0, focal_norm, roi_size[1] / 2],
                         [0, 0, 1.0]])
    S = np.diag([1.0, 1.0, z_scale])
    forward = (center / distance).reshape(3)
    down = np.cross(forward, hR[:, 0])
    down /= np.linalg.norm(down)
    right = np.cross(down, forward)
    right /= np.linalg.norm(right)
    R = np.c_[right, down, forward].T
    W = cam_norm @ S @ R @ np.linalg.inv(K)
    return {"R": R, "W": W, "hR_norm": R @ hR}


def head_pitchyaw_from_rotation(hR_norm: np.ndarray) -> np.ndarray:
    """UniGaze's normalised head angle (used for the 80 degree rejection)."""
    return np.array([np.arcsin(hR_norm[1, 2]), np.arctan2(hR_norm[0, 2], hR_norm[2, 2])])


def denormalize_gaze(pitchyaw_norm: np.ndarray, R: np.ndarray) -> np.ndarray:
    """Normalised-frame gaze (pitch, yaw) -> unit vector in the (approximate)
    camera frame, as UniGaze denormalize_predicted_gaze."""
    v = pitchyaw_to_vector(pitchyaw_norm)                      # Nx3
    if R.ndim == 2:
        out = (np.linalg.inv(R) @ v.T).T
    else:                                                        # batch of R
        out = np.einsum("nij,nj->ni", np.linalg.inv(R), v)
    return out / np.linalg.norm(out, axis=1, keepdims=True)


def crop_translation(x0: float, y0: float) -> np.ndarray:
    """Homography that maps full-frame pixels into a crop starting at (x0, y0)."""
    return np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], dtype=np.float64)
