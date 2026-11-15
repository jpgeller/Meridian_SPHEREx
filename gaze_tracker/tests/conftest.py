"""Shared test helpers: fake clock, fake detector, synthetic camera frames.

The tests drive the real controller, storage and integrity code headlessly;
only the camera and the face detector are replaced.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eyetrack import config as cfg                      # noqa: E402
from eyetrack.layout import DatasetLayout               # noqa: E402
from eyetrack.session import CollectionController, SessionConfig  # noqa: E402
from eyetrack.state_machine import State                # noqa: E402
from eyetrack.vision import Detection                   # noqa: E402

MONITOR = {"index": 0, "x": 0, "y": 0, "width_px": 1920, "height_px": 1080}


class FakeClock:
    def __init__(self, start=1_000_000.0):
        self.t = start

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class FakeDetector:
    name = "fake-detector"

    def __init__(self):
        self.face_visible = True

    def detect(self, frame):
        if not self.face_visible:
            return None
        return Detection(face_box=(200, 100, 240, 240), right_eye=(270.0, 190.0),
                         left_eye=(370.0, 190.0), score=0.99, detector=self.name)


class FrameSource:
    """Deterministic, textured 3-channel frames (every frame is different)."""
    def __init__(self):
        self.rng = np.random.default_rng(7)

    def next(self):
        return self.rng.integers(0, 256, size=(480, 640, 3), dtype=np.uint8)


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def detector():
    return FakeDetector()


@pytest.fixture
def frames():
    return FrameSource()


@pytest.fixture
def layout(tmp_path):
    return DatasetLayout(tmp_path / "NASA_EyeTracking_Dataset")


@pytest.fixture
def make_controller(layout, detector, clock):
    def _make(mode=cfg.MODE_PILOT, pid="PILOT01", sid="S01", n=5, resume=False,
              monitor=MONITOR, use_layout=None):
        c = CollectionController(use_layout or layout, detector, clock=clock)
        c.configure(SessionConfig(mode=mode, participant_id=pid, session_id=sid,
                                  n_targets=n, monitor=dict(monitor),
                                  camera={"index": 0, "width": 640, "height": 480},
                                  resume=resume))
        return c
    return _make


def step(controller, clock, frames, n=1, dt=0.06):
    """Simulate n GUI loop iterations: draw target, grab frame, process."""
    for _ in range(n):
        target = controller.current_target
        if target is not None:
            controller.confirm_target_drawn(target["target_index"], clock())
        controller.process_frame(frames.next(), clock())
        clock.advance(dt)


def run_until(controller, clock, frames, predicate, max_steps=20000):
    for _ in range(max_steps):
        if predicate():
            return True
        step(controller, clock, frames)
    return predicate()


def run_to_complete(controller, clock, frames):
    assert run_until(controller, clock, frames,
                     lambda: controller.state is State.COMPLETE)
    return controller.run_validation()


def image_files(root):
    return sorted(p for p in Path(root).rglob("*.png"))
