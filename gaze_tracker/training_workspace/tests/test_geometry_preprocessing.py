"""Gaze conventions, coordinate conversions, head pose and normalisation."""
import cv2
import numpy as np
import pytest

from src import geometry as geo


def test_pitchyaw_roundtrip_and_convention():
    py = np.array([[0.1, -0.3], [-0.2, 0.4], [0.0, 0.0]])
    v = geo.pitchyaw_to_vector(py)
    assert np.allclose(np.linalg.norm(v, axis=1), 1)
    assert np.allclose(geo.vector_to_pitchyaw(v), py)
    assert np.allclose(geo.pitchyaw_to_vector([[0, 0]]), [[0, 0, 1]])       # straight ahead = +z


def test_screen_conversions_and_isotropic_scale():
    W, H = 2560, 1600
    p = np.array([[0.5, 0.5], [0.0, 1.0]])
    assert np.allclose(geo.norm_to_px(p, W, H), [[1280, 800], [0, 1600]])
    assert np.allclose(geo.px_to_norm(geo.norm_to_px(p, W, H), W, H), p)
    s = geo.isotropic_scale(W, H)
    r = np.array([0.01, 0.02])
    assert np.isclose(np.linalg.norm(r * s) * np.hypot(W, H), np.hypot(0.01 * W, 0.02 * H))
    assert np.allclose(geo.clamp_to_screen([[-5, 2000]], W, H), [[0, H - 1]])


def _project(hr, ht, K, pts3):
    out, _ = cv2.projectPoints(pts3, hr, ht, K, np.zeros(5))
    return out.reshape(-1, 2)


def test_head_pose_recovery_and_normalisation():
    K, dist = geo.dummy_camera(640, 480)
    hr_true = np.array([[0.05], [0.25], [0.02]])
    ht_true = np.array([[10.0], [-5.0], [650.0]])
    pts3 = geo.yunet_model_points()
    lm2 = _project(hr_true, ht_true, K, pts3)
    hr, ht = geo.estimate_head_pose(lm2, pts3, K, dist)
    assert np.allclose(_project(hr, ht, K, pts3), lm2, atol=0.5)       # reprojection
    hR = cv2.Rodrigues(hr)[0]
    center = geo.face_center_by_nose(hR, ht)
    mats = geo.normalization_matrices(center, hr, K, 960, 600, (224, 224))
    R = mats["R"]
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-9)                 # rotation
    c_img = K @ center
    c_img = c_img[:2] / c_img[2]
    w = mats["W"] @ np.array([c_img[0, 0], c_img[1, 0], 1.0])
    assert np.allclose(w[:2] / w[2], [112, 112], atol=1e-6)            # face centre -> image centre
    g = np.array([[0.1, -0.2]])
    back = geo.vector_to_pitchyaw((R @ geo.denormalize_gaze(g, R).T).T)
    assert np.allclose(back, g)


def test_face_model_eye_sides():
    """The participant's right eye must be at negative model-x (image left)."""
    pts = geo.yunet_model_points()
    assert pts[0, 0] < 0 < pts[1, 0]


def test_tensor_conversion_and_augmentation():
    import torch
    from src.preprocessing import (IMAGENET_MEAN, IMAGENET_STD, normalize_tensor_inplace,
                                   photometric_augment, to_model_tensor)
    img = np.zeros((224, 224, 3), np.uint8); img[..., 0] = 255           # pure red RGB
    t = to_model_tensor(img)
    assert t.shape == (1, 3, 224, 224)
    assert np.isclose(float(t[0, 0, 0, 0]), (1 - IMAGENET_MEAN[0]) / IMAGENET_STD[0], atol=1e-5)
    assert np.isclose(float(t[0, 1, 0, 0]), -IMAGENET_MEAN[1] / IMAGENET_STD[1], atol=1e-5)
    t2 = normalize_tensor_inplace(torch.from_numpy(img).permute(2, 0, 1)[None])
    assert torch.allclose(t, t2, atol=1e-6)
    with pytest.raises(ValueError):
        to_model_tensor(img.astype(np.float32))
    grad = np.zeros((224, 224, 3), np.uint8); grad[:, :, :] = np.arange(224)[None, :, None]
    aug = photometric_augment(grad, {"brightness": 0.1, "contrast": 0.1, "gaussian_noise_std": 0.0},
                              np.random.default_rng(0))
    assert aug.shape == grad.shape
    assert aug[:, 200].mean() > aug[:, 20].mean()                      # not flipped


def test_read_bgr_raises(tmp_path):
    from src.preprocessing import read_bgr
    with pytest.raises(Exception):
        read_bgr(tmp_path / "missing.png")
    (tmp_path / "bad.png").write_bytes(b"not an image")
    with pytest.raises(IOError):
        read_bgr(tmp_path / "bad.png")


def test_normalize_face_on_synthetic_frame():
    """End to end on a synthetic frame with landmarks from a known pose."""
    from src.preprocessing import Landmarks5, normalize_face, warp_with_stored_geometry
    frame = np.random.default_rng(0).integers(0, 255, (720, 1280, 3), dtype=np.uint8)
    box = (540.0, 260.0, 200.0, 200.0)
    crop_w = crop_h = 400
    K, _ = geo.dummy_camera(crop_w, crop_h)
    pts3 = geo.yunet_model_points()
    lm_crop = _project(np.array([[0.0], [0.1], [0.0]]), np.array([[0.0], [0.0], [1600.0]]), K, pts3)
    lm = Landmarks5(box, lm_crop + np.array([440, 160]), 0.99)
    prep = {"crop_scale": 2.0, "focal_norm": 960, "distance_norm": 600, "roi_size": 224,
            "camera_model": "upstream_dummy", "max_normalized_head_angle_deg": 80}
    res = normalize_face(frame, lm, prep)
    assert res.ok, res.reason
    assert res.image_rgb.shape == (224, 224, 3) and res.image_rgb.dtype == np.uint8
    again = warp_with_stored_geometry(frame, res.crop_box, res.W)
    assert np.array_equal(again, res.image_rgb)                       # cache == live path
    with pytest.raises(ValueError):
        normalize_face(frame, lm, {**prep, "camera_model": "guessed"})
