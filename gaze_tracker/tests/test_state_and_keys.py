"""State machine and keyboard-shortcut behaviour."""
import pytest

from conftest import image_files, run_to_complete, run_until, step
from eyetrack import config as cfg
from eyetrack.session import SessionConfig, SettingsLocked
from eyetrack.state_machine import ExperimentStateMachine, SpaceKeyController, State


def test_application_starts_in_ready(make_controller):
    assert make_controller().state is State.READY


def test_no_collection_before_space(make_controller, clock, frames, layout):
    c = make_controller()
    step(c, clock, frames, n=300)                    # ~18 s of preview
    assert c.state is State.READY
    assert c.current_target is None
    assert image_files(layout.root) == []
    assert not layout.root.exists() or not any(layout.root.rglob("annotations.jsonl"))


def test_space_starts_with_stabilization_countdown(make_controller, clock, frames, layout):
    c = make_controller()
    assert c.keys.key_press("space", clock()) == "start"
    assert c.state is State.STABILIZING
    assert c.countdown_remaining() == pytest.approx(cfg.STABILIZATION_SECONDS)
    step(c, clock, frames, n=20)                     # 1.2 s < countdown
    assert c.state is State.STABILIZING
    assert image_files(layout.root) == []            # nothing saved during countdown
    assert run_until(c, clock, frames, lambda: c.state is State.CAPTURING)


def test_space_toggles_capture_pause_resume(make_controller, clock, frames):
    c = make_controller()
    c.keys.key_press("space", clock()); c.keys.key_release("space", clock())
    run_until(c, clock, frames, lambda: c.state is State.CAPTURING)
    clock.advance(1)
    assert c.keys.key_press("space", clock()) == "pause"
    c.keys.key_release("space", clock())
    assert c.state is State.PAUSED
    clock.advance(1)
    assert c.keys.key_press("space", clock()) == "resume"
    c.keys.key_release("space", clock())
    assert c.state is State.STABILIZING              # new countdown, not instant capture
    assert c.countdown_remaining() == pytest.approx(cfg.STABILIZATION_SECONDS)
    assert run_until(c, clock, frames, lambda: c.state is State.CAPTURING)


def test_space_during_countdown_pauses(make_controller, clock):
    c = make_controller()
    c.handle_space()
    clock.advance(1)
    assert c.handle_space() == "pause"
    assert c.state is State.PAUSED


def test_space_when_complete_does_nothing(make_controller, clock, frames, layout):
    c = make_controller(n=2)
    c.handle_space()
    run_to_complete(c, clock, frames)
    before = image_files(layout.root)
    clock.advance(5)
    assert c.keys.key_press("space", clock()) is None
    assert c.state is State.COMPLETE
    step(c, clock, frames, n=100)
    assert image_files(layout.root) == before


def test_new_session_after_complete_requires_explicit_configuration(
        make_controller, clock, frames):
    c = make_controller(n=2)
    c.handle_space()
    run_to_complete(c, clock, frames)
    c.configure(SessionConfig(cfg.MODE_PILOT, "PILOT01", "S02", 2, c.config.monitor))
    assert c.state is State.READY
    assert c.handle_space() == "start"


@pytest.mark.parametrize("key", ["p", "P", "Return", "Escape", "r", "s"])
def test_p_and_other_keys_do_not_control_recording(make_controller, clock, frames, key):
    c = make_controller()
    assert c.keys.key_press(key, clock()) is None            # READY: no start
    assert c.state is State.READY
    c.handle_space()
    run_until(c, clock, frames, lambda: c.state is State.CAPTURING)
    assert c.keys.key_press(key, clock()) is None            # CAPTURING: no pause
    assert c.state is State.CAPTURING
    c.handle_space()
    assert c.keys.key_press(key, clock()) is None            # PAUSED: no resume
    assert c.state is State.PAUSED


def test_holding_space_does_not_toggle_repeatedly_windows_style(make_controller, clock):
    c = make_controller()
    actions = []
    for _ in range(40):                              # KeyPress repeats, no release
        actions.append(c.keys.key_press("space", clock()))
        clock.advance(0.03)
    assert actions.count("start") == 1
    assert [a for a in actions if a] == ["start"]
    assert c.state is State.STABILIZING


def test_holding_space_does_not_toggle_repeatedly_x11_style(make_controller, clock):
    c = make_controller()
    actions = [c.keys.key_press("space", clock())]
    clock.advance(0.5)                               # repeat delay
    for _ in range(40):                              # Release+Press pairs
        c.keys.key_release("space", clock())
        actions.append(c.keys.key_press("space", clock()))
        clock.advance(0.03)
    assert [a for a in actions if a] == ["start"]


def test_space_is_not_intercepted_in_editable_field(make_controller, clock):
    c = make_controller()
    assert c.keys.key_press("space", clock(), focus_is_editable=True) is None
    assert c.state is State.READY
    assert c.keys.ignored_editing == 1
    c.keys.key_release("space", clock())
    clock.advance(1)
    assert c.keys.key_press("space", clock(), focus_is_editable=False) == "start"


def test_settings_cannot_change_while_recording_or_paused(make_controller, clock, frames, layout):
    c = make_controller()
    other = SessionConfig(cfg.MODE_OFFICIAL, "P001", "S01", 5, c.config.monitor)
    c.handle_space()
    with pytest.raises(SettingsLocked):
        c.configure(other)                           # STABILIZING
    run_until(c, clock, frames, lambda: c.state is State.CAPTURING)
    with pytest.raises(SettingsLocked):
        c.configure(other)                           # CAPTURING
    with pytest.raises(SettingsLocked):
        c.set_layout(layout)
    c.handle_space()
    with pytest.raises(SettingsLocked):
        c.configure(other)                           # PAUSED
    assert c.config.participant_id == "PILOT01"
    assert c.return_to_selection()                   # explicit way out
    c.configure(other)
    assert c.config.participant_id == "P001"


def test_pure_state_machine_transitions():
    sm = ExperimentStateMachine()
    assert sm.state is State.READY and not sm.is_recording_allowed
    assert sm.space(0) == "start" and sm.state is State.STABILIZING
    assert not sm.is_recording_allowed
    assert sm.stabilization_done(3) and sm.is_recording_allowed
    assert sm.space(4) == "pause" and not sm.is_recording_allowed
    assert not sm.complete(5)                        # cannot complete while paused
    assert sm.space(6) == "resume" and sm.state is State.STABILIZING
    sm.stabilization_done(9)
    assert sm.complete(10) and sm.state is State.COMPLETE
    assert sm.space(11) is None and sm.state is State.COMPLETE
    assert sm.reset_to_ready(12) and sm.state is State.READY


def test_space_controller_counts(clock):
    hits = []
    k = SpaceKeyController(on_space=lambda now: hits.append(now) or "x")
    k.key_press("space", 0.0); k.key_press("space", 0.05); k.key_release("space", 0.3)
    k.key_press("space", 1.0)
    assert len(hits) == 2 and k.ignored_repeat == 1
