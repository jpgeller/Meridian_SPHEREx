"""Experiment state machine and SPACE-key handling.

States
------
READY        windows open, preview running, nothing is saved
STABILIZING  countdown after start / resume, nothing is saved
CAPTURING    fixation trials running, valid frames are collected
PAUSED       nothing is saved, target counter frozen
COMPLETE     session finished; SPACE is ignored until a new session is configured

SPACE is the only recording shortcut.  P is intentionally not handled.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, List, Optional


class State(str, Enum):
    READY = "READY"
    STABILIZING = "STABILIZING"
    CAPTURING = "CAPTURING"
    PAUSED = "PAUSED"
    COMPLETE = "COMPLETE"


#: States in which SPACE means "pause now".
ACTIVE_STATES = (State.STABILIZING, State.CAPTURING)


@dataclass
class Transition:
    time: float
    source: State
    target: State
    cause: str


class ExperimentStateMachine:
    """Pure state logic - no GUI, no camera, fully unit-testable."""

    def __init__(self, on_transition: Optional[Callable[[Transition], None]] = None):
        self.state = State.READY
        self.history: List[Transition] = []
        self._on_transition = on_transition

    # -- helpers -----------------------------------------------------------
    def _go(self, target: State, cause: str, now: float) -> None:
        tr = Transition(now, self.state, target, cause)
        self.state = target
        self.history.append(tr)
        if self._on_transition:
            self._on_transition(tr)

    @property
    def is_recording_allowed(self) -> bool:
        """True only while frames may be collected."""
        return self.state is State.CAPTURING

    @property
    def settings_locked(self) -> bool:
        """Participant / session / mode / root cannot change in these states."""
        return self.state in (State.STABILIZING, State.CAPTURING, State.PAUSED)

    # -- events ------------------------------------------------------------
    def space(self, now: float) -> Optional[str]:
        """Handle one SPACE press. Returns the action taken, or None if ignored."""
        if self.state is State.READY:
            self._go(State.STABILIZING, "space:start", now)
            return "start"
        if self.state in ACTIVE_STATES:
            self._go(State.PAUSED, "space:pause", now)
            return "pause"
        if self.state is State.PAUSED:
            self._go(State.STABILIZING, "space:resume", now)
            return "resume"
        return None  # COMPLETE: do nothing

    def stabilization_done(self, now: float) -> bool:
        if self.state is State.STABILIZING:
            self._go(State.CAPTURING, "countdown:done", now)
            return True
        return False

    def force_pause(self, now: float, cause: str = "system:pause") -> bool:
        """Pause for a non-keyboard reason (camera loss, window closing)."""
        if self.state in ACTIVE_STATES:
            self._go(State.PAUSED, cause, now)
            return True
        return False

    def complete(self, now: float) -> bool:
        if self.state is State.CAPTURING:
            self._go(State.COMPLETE, "session:complete", now)
            return True
        return False

    def reset_to_ready(self, now: float, cause: str = "operator:new_session") -> bool:
        """Explicitly configure a new session. Not allowed while recording."""
        if self.state in ACTIVE_STATES:
            return False
        if self.state is not State.READY:
            self._go(State.READY, cause, now)
        return True


@dataclass
class SpaceKeyController:
    """Turns raw key events into single, debounced SPACE actions.

    * Auto-repeat is ignored: a press only counts if the key was released
      since the previous accepted press (Windows repeats KeyPress only; X11
      repeats Release+Press pairs, which the debounce interval absorbs).
    * SPACE typed into an editable field is left to that field.
    * Every other key - including P - never reaches the state machine.
    """

    on_space: Callable[[float], Optional[str]]
    debounce_seconds: float = 0.25
    _held: bool = False
    _last_accept: float = field(default=-1e9)
    _last_release: float = field(default=-1e9)
    repeat_gap_seconds: float = 0.03
    accepted: int = 0
    ignored_repeat: int = 0
    ignored_editing: int = 0

    @staticmethod
    def is_space(key: str) -> bool:
        return key in ("space", " ", "Space", "SPACE")

    def key_press(self, key: str, now: float, focus_is_editable: bool = False) -> Optional[str]:
        if not self.is_space(key):
            return None                       # P and everything else: no effect
        if focus_is_editable:
            self.ignored_editing += 1
            return None                       # let the text field have its space
        x11_repeat = (now - self._last_release) < self.repeat_gap_seconds
        if self._held or x11_repeat or (now - self._last_accept) < self.debounce_seconds:
            self._held = True
            self.ignored_repeat += 1
            return None                       # auto-repeat / key still down
        self._held = True
        self._last_accept = now
        self.accepted += 1
        return self.on_space(now)

    def key_release(self, key: str, now: float) -> None:
        if self.is_space(key):
            self._held = False
            self._last_release = now
