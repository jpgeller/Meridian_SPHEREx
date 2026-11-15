"""End-to-end GUI test: real Tk windows, real key events, fake camera.

Skipped automatically when no display / tkinter is available.
"""
import time
from pathlib import Path

import numpy as np
import pytest

from conftest import FakeDetector, image_files
from eyetrack import config as cfg
from eyetrack.layout import DatasetLayout
from eyetrack.session import CollectionController
from eyetrack.state_machine import State

tk = pytest.importorskip("tkinter")


class FakeCamera:
    ok = True
    error = None

    def __init__(self):
        self.rng = np.random.default_rng(3)
        self.seq = 0

    def latest(self):
        self.seq += 1
        return self.seq, self.rng.integers(0, 256, (480, 640, 3), dtype=np.uint8), time.time()

    def info(self):
        return {"index": 0, "opened": True, "width": 640, "height": 480, "fps": 30.0}

    def seconds_since_frame(self):
        return 0.0

    def stop(self):
        pass


@pytest.fixture
def app(tmp_path, monkeypatch):
    try:
        root = tk.Tk()
    except tk.TclError:
        pytest.skip("no display available")
    monkeypatch.setattr(cfg, "STABILIZATION_SECONDS", 0.4)
    monkeypatch.setattr(cfg, "TARGET_SETTLE_SECONDS", 0.05)
    monkeypatch.setattr(cfg, "SETTINGS_FILE", tmp_path / "settings.json")
    from eyetrack.app import App
    layout = DatasetLayout(tmp_path / "NASA_EyeTracking_Dataset")
    controller = CollectionController(layout, FakeDetector())
    application = App(root, controller, FakeCamera())
    yield application
    application._closing = True
    try:
        root.destroy()
    except tk.TclError:
        pass


def pump(app, seconds=0.0, until=None, timeout=30.0):
    end = time.time() + (timeout if until else seconds)
    while time.time() < end:
        app.root.update()
        if until and until():
            return True
        time.sleep(0.005)
    return until() if until else True


def press(app, widget, keysym="space"):
    widget.focus_force()
    app.root.update()
    widget.event_generate(f"<KeyPress-{keysym}>")
    app.root.update()
    widget.event_generate(f"<KeyRelease-{keysym}>")
    app.root.update()
    time.sleep(0.3)                      # longer than the debounce interval


def test_full_pilot_session_through_the_gui(app):
    c, root_dir = app.c, app.c.layout.root

    # Both windows exist, state READY, nothing recorded.
    assert app.root.winfo_exists() and app.target_win.winfo_exists()
    pump(app, 0.6)
    assert c.state is State.READY
    assert app.state_banner.cget("text") == "READY"
    assert image_files(root_dir) == []
    assert app.root_path_var.get() == str(root_dir) and Path(app.root_path_var.get()).is_absolute()
    assert "PILOT" in app.id_banner.cget("text")

    # Mode switch: Official shows the fixed split and only official target counts.
    app.mode_var.set(cfg.MODE_OFFICIAL); app._on_mode_change()
    app.participant_var.set("P009"); app._apply_config()
    assert "P009" in app.id_banner.cget("text") and "TEST" in app.id_banner.cget("text")
    assert app.targets_var.get() == str(cfg.OFFICIAL_TARGETS_PER_SESSION_DEFAULT)
    assert app.participant_path_var.get() == str(root_dir / "test" / "P009")
    app.mode_var.set(cfg.MODE_PILOT); app._on_mode_change()
    assert c.config.mode == cfg.MODE_PILOT and c.config.n_targets == 5

    # P does nothing.
    press(app, app.root, "p")
    assert c.state is State.READY

    # SPACE inside an editable field is typed, not intercepted.
    app.targets_var.set("Custom"); app._on_targets_change()
    app.custom_var.set("")
    app.custom_entry.focus_force(); app.root.update()
    app.custom_entry.event_generate("<KeyPress-space>"); app.root.update()
    app.custom_entry.event_generate("<KeyRelease-space>"); app.root.update()
    assert c.state is State.READY
    assert app.custom_var.get() == " "               # the field received the space
    app.custom_var.set("4")
    app.root.focus_force(); app.root.update()
    assert app._apply_config() is None and c.config.n_targets == 4

    # SPACE on the dashboard starts.
    time.sleep(0.3)
    press(app, app.root)
    assert c.state in (State.STABILIZING, State.CAPTURING)
    with pytest.raises(Exception):
        from eyetrack.session import SessionConfig
        c.configure(SessionConfig(cfg.MODE_OFFICIAL, "P001", "S01", 5, c.config.monitor))
    pump(app, 0.1)
    assert str(app.participant_box.cget("state")) == "disabled"      # selectors locked
    assert pump(app, until=lambda: c.completed_count >= 1)

    # SPACE on the target-map window pauses.
    press(app, app.target_win)
    assert c.state is State.PAUSED
    files = image_files(root_dir)
    done = c.completed_count
    pump(app, 1.0)
    assert image_files(root_dir) == files and c.completed_count == done

    # SPACE resumes with a new countdown, then the session completes.
    press(app, app.target_win)
    assert c.state in (State.STABILIZING, State.CAPTURING)
    assert pump(app, until=lambda: c.state is State.COMPLETE and c.summary is not None
                and app._summary_win is not None)
    s = c.summary
    assert s["integrity_overall"] == "PASS", s["integrity_checks"]
    assert s["valid_images_session"] == 4 * cfg.FRAMES_PER_TARGET
    assert s["dataset_root"] == app.root_path_var.get()
    saved = image_files(root_dir)
    assert len(saved) == 4 * cfg.FRAMES_PER_TARGET * 4
    assert all(f.relative_to(root_dir).parts[0] == "pilot" for f in saved)

    # SPACE when COMPLETE does nothing.
    press(app, app.root)
    assert c.state is State.COMPLETE
    assert image_files(root_dir) == saved

    # Return to participant selection -> READY again.
    app._return_to_selection()
    pump(app, 0.2)
    assert c.state is State.READY and app._summary_win is None
