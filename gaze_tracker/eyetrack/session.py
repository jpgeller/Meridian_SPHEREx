"""Collection controller: ties the state machine, targets, vision pipeline and
storage together.  It has no GUI code, so the whole experiment flow can be
driven headlessly (and is, in the automated tests).

Pilot and Official mode run through exactly the same code path; only the
storage folder, the sample-ID prefix and the number of targets differ.
"""
from __future__ import annotations

import time
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional

from . import config as cfg
from . import integrity
from .layout import DatasetLayout, SplitViolation, split_for
from .state_machine import ExperimentStateMachine, SpaceKeyController, State, Transition
from .storage import RecordingNotAllowed, SessionWriter, now_iso
from .targets import generate_targets, targets_document
from .vision import FrameSample, evaluate_frame

APP_VERSION = "2.0.0"


class StartRefused(Exception):
    """SPACE was pressed in READY but the session may not start."""


class SettingsLocked(Exception):
    """Participant/session/mode/root cannot change while a recording is active."""


@dataclass
class SessionConfig:
    mode: str
    participant_id: str
    session_id: str
    n_targets: int
    monitor: Dict                     # index, x, y, width_px, height_px, ...
    camera: Dict = field(default_factory=dict)
    resume: bool = False              # operator explicitly chose to resume

    @property
    def split(self) -> str:
        return split_for(self.mode, self.participant_id)


class CollectionController:
    def __init__(self, layout: DatasetLayout, detector,
                 clock: Callable[[], float] = time.time):
        self.layout = layout
        self.detector = detector
        self.clock = clock
        self.sm = ExperimentStateMachine(on_transition=self._on_transition)
        self.keys = SpaceKeyController(on_space=self.handle_space)
        self.config: Optional[SessionConfig] = None
        self.writer: Optional[SessionWriter] = None
        self.message = "Press SPACE to start."
        self.summary: Optional[Dict] = None
        #: optional callable returning a reason why recording cannot start
        self.start_guard: Optional[Callable[[], Optional[str]]] = None
        self.integrity_report: Optional[Dict] = None
        self._reset_run_state()

    # ------------------------------------------------------------------ setup
    def _reset_run_state(self) -> None:
        self.targets: List[Dict] = []
        self.screen: Dict = {}
        self.queue: Deque[int] = deque()
        self.failed: List[int] = []
        self.retries: Dict[int, int] = {}
        self.buffer: List[FrameSample] = []
        self.trial_onset: Optional[float] = None
        self.last_accept = -1e9
        self.countdown_end = 0.0
        self.completed_count = 0
        self.stats = {"rejected_frames": 0, "rejected_reasons": Counter(),
                      "discarded_partial_frames": 0, "interrupted_trials": 0,
                      "trial_timeouts": 0, "pauses": 0, "resumes": 0,
                      "blocked_save_attempts": 0}
        self.recovery: Dict = {}
        self.needs_validation = False

    def set_layout(self, layout: DatasetLayout) -> None:
        if self.sm.settings_locked:
            raise SettingsLocked("Dataset root cannot change while recording is active.")
        self.layout = layout

    def configure(self, config: SessionConfig) -> None:
        """Select mode / participant / session. Refused while recording is active."""
        if self.sm.settings_locked:
            raise SettingsLocked(
                "Participant and session settings cannot change while recording is active.")
        split_for(config.mode, config.participant_id)       # validates the ID
        if config.n_targets < 1:
            raise ValueError("Number of targets must be at least 1")
        self.config = config
        if self.sm.state is State.COMPLETE:
            self.sm.reset_to_ready(self.clock(), "operator:new_session")
            self.writer = None
        self.message = "Press SPACE to start."

    def existing_session_status(self) -> Optional[Dict]:
        """What is already on disk for the configured participant/session."""
        if self.config is None:
            return None
        c = self.config
        w = SessionWriter(self.layout, c.mode, c.participant_id, c.session_id)
        if not w.exists():
            return None
        try:
            total = w.read_targets()["count"]
        except Exception:
            total = 0
        done = len(w.completed_targets())
        return {"completed_targets": done, "total_targets": total,
                "complete": total > 0 and done >= total}

    # ------------------------------------------------------------------ events
    def _on_transition(self, tr: Transition) -> None:
        if self.writer is not None:
            self.writer.events.write("state", tr.time, **{
                "from": tr.source.value, "to": tr.target.value, "cause": tr.cause})

    def handle_space(self, now: Optional[float] = None) -> Optional[str]:
        """The single entry point for the SPACE shortcut."""
        now = self.clock() if now is None else now
        state = self.sm.state
        if state is State.READY:
            try:
                reason = self.start_guard() if self.start_guard else None
                if reason:
                    raise StartRefused(reason)
                self._begin(now)
            except StartRefused as exc:
                self.message = str(exc)
                self.writer = None
                return None
            action = self.sm.space(now)
            self.countdown_end = now + cfg.STABILIZATION_SECONDS
            self.message = "Starting - hold still."
        elif state in (State.STABILIZING, State.CAPTURING):
            action = self.sm.space(now)
            self._discard_buffer("paused", now)
            self.stats["pauses"] += 1
            self._write_quality_report("paused")
            self.message = "PAUSED - press SPACE to resume."
        elif state is State.PAUSED:
            action = self.sm.space(now)
            self.stats["resumes"] += 1
            self.countdown_end = now + cfg.STABILIZATION_SECONDS
            self.message = "Resuming - hold still."
        else:                                   # COMPLETE
            return None
        if self.writer is not None and action:
            self.writer.events.write("space", now, action=action)
        return action

    def _begin(self, now: float) -> None:
        if self.config is None:
            raise StartRefused("Select a participant and session first.")
        c = self.config
        mon_w, mon_h = int(c.monitor["width_px"]), int(c.monitor["height_px"])
        writer = SessionWriter(self.layout, c.mode, c.participant_id, c.session_id,
                               recording_allowed=lambda: self.sm.is_recording_allowed)
        self._reset_run_state()
        try:
            if c.mode == cfg.MODE_OFFICIAL:
                self.layout.lock_participant_split(c.participant_id)
        except SplitViolation as exc:
            raise StartRefused(str(exc)) from None

        if writer.exists():
            done, total = len(writer.completed_targets()), writer.read_targets()["count"]
            if not c.resume:
                raise StartRefused(
                    f"{c.participant_id} {c.session_id} already exists ({done}/{total} targets). "
                    f"Tick 'Resume incomplete session' or choose a new session.")
            tdoc = writer.read_targets()
            if (tdoc["screen_width_px"], tdoc["screen_height_px"]) != (mon_w, mon_h):
                raise StartRefused(
                    f"This session was recorded on a {tdoc['screen_width_px']}x"
                    f"{tdoc['screen_height_px']} monitor; the selected monitor is "
                    f"{mon_w}x{mon_h}. Use the same monitor or start a new session.")
            self.recovery = writer.recover()
            completed = writer.completed_targets()
            pending = [t["target_index"] for t in tdoc["targets"]
                       if t["target_index"] not in completed]
            if not pending:
                raise StartRefused(
                    f"{c.participant_id} {c.session_id} is already complete. "
                    f"Choose the next session.")
            previous = {}
            try:
                import json
                previous = json.loads(writer.quality_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            for key in ("rejected_frames", "discarded_partial_frames", "interrupted_trials",
                        "trial_timeouts", "pauses", "resumes"):
                self.stats[key] = int(previous.get(key, 0))
            self.stats["rejected_reasons"] = Counter(previous.get("rejected_reasons", {}))
            self.completed_count = len(completed)
            event = "session_resume"
        else:
            targets = generate_targets(c.n_targets, mon_w, mon_h,
                                       c.participant_id, c.session_id)
            tdoc = targets_document(targets, mon_w, mon_h)
            metadata = {
                "app_version": APP_VERSION,
                "created": now_iso(),
                "mode": c.mode,
                "participant_id": c.participant_id,
                "session_id": c.session_id,
                "split": c.split,
                "status": "in_progress",
                "dataset_root_at_creation": str(self.layout.root),
                "session_dir": str(writer.dir),
                "events_log": self.layout.relative(writer.events.path),
                "targets_total": len(targets),
                "monitor": c.monitor,
                "camera": c.camera,
                "detector": getattr(self.detector, "name", type(self.detector).__name__),
                "protocol": cfg.protocol_snapshot(),
                "runs": [],
            }
            try:
                writer.create(tdoc, metadata)
            except SplitViolation as exc:
                raise StartRefused(str(exc)) from None
            pending = [t["target_index"] for t in targets]
            event = "session_start"

        self.writer = writer
        self.targets = tdoc["targets"]
        self.screen = {"width_px": mon_w, "height_px": mon_h}
        self.queue = deque(pending)
        writer.append_run({"started": now_iso(), "event": event, "camera": c.camera,
                           "monitor": c.monitor, "recovery": self.recovery})
        writer.events.write(event, now, pending_targets=len(pending),
                            recovery=self.recovery)

    # ------------------------------------------------------------------ trials
    @property
    def state(self) -> State:
        return self.sm.state

    @property
    def current_target(self) -> Optional[Dict]:
        """The target that must be on screen right now (None = draw no target)."""
        if self.sm.state is State.CAPTURING and self.queue:
            return self.targets[self.queue[0]]
        return None

    def countdown_remaining(self, now: Optional[float] = None) -> float:
        now = self.clock() if now is None else now
        if self.sm.state is not State.STABILIZING:
            return 0.0
        return max(0.0, self.countdown_end - now)

    def confirm_target_drawn(self, target_index: int, now: Optional[float] = None) -> None:
        """Called by the target map right after the target is actually on screen.
        Frames are only collected for a target after this confirmation, which
        keeps images and fixation labels synchronised."""
        now = self.clock() if now is None else now
        if (self.sm.state is State.CAPTURING and self.queue
                and self.queue[0] == target_index and self.trial_onset is None):
            self.trial_onset = now
            self.last_accept = -1e9
            self.writer.events.write("trial_start", now, target_index=target_index)

    def tick(self, now: Optional[float] = None) -> None:
        now = self.clock() if now is None else now
        if self.sm.state is State.STABILIZING and now >= self.countdown_end:
            self.sm.stabilization_done(now)
            self.trial_onset = None
            self.message = "Recording - press SPACE to pause."

    def _discard_buffer(self, reason: str, now: float) -> None:
        if self.buffer or self.trial_onset is not None:
            if self.buffer:
                self.stats["discarded_partial_frames"] += len(self.buffer)
                self.stats["interrupted_trials"] += 1
            if self.writer is not None and self.queue:
                self.writer.events.write("trial_discard", now, reason=reason,
                                         target_index=self.queue[0],
                                         frames_discarded=len(self.buffer))
        self.buffer = []
        self.trial_onset = None

    def process_frame(self, frame, now: Optional[float] = None) -> Dict:
        """Feed one camera frame. Returns info for the operator preview."""
        now = self.clock() if now is None else now
        self.tick(now)
        info = {"detection": None, "valid": False, "reasons": [], "collecting": False}

        collecting = (self.sm.state is State.CAPTURING and self.queue
                      and self.trial_onset is not None
                      and now - self.trial_onset >= cfg.TARGET_SETTLE_SECONDS)
        if not collecting:
            # Preview only: detection may run, nothing is buffered or saved.
            try:
                info["detection"] = self.detector.detect(frame)
            except Exception:
                info["detection"] = None
            return info

        info["collecting"] = True
        verdict = evaluate_frame(frame, self.detector, now)
        info.update(detection=verdict.detection, valid=verdict.valid, reasons=verdict.reasons)
        if verdict.valid:
            if now - self.last_accept >= cfg.MIN_FRAME_INTERVAL_SECONDS:
                verdict.sample.state_at_capture = self.sm.state.value
                self.buffer.append(verdict.sample)
                self.last_accept = now
        else:
            self.stats["rejected_frames"] += 1
            self.stats["rejected_reasons"].update(verdict.reasons)

        if len(self.buffer) >= cfg.FRAMES_PER_TARGET:
            self._commit_trial(now)
        elif now - self.trial_onset > cfg.TRIAL_TIMEOUT_SECONDS:
            self._timeout_trial(now)
        return info

    def _commit_trial(self, now: float) -> None:
        index = self.queue[0]
        try:
            self.writer.commit_trial(self.targets[index],
                                     self.buffer[:cfg.FRAMES_PER_TARGET],
                                     self.screen, self.trial_onset)
        except RecordingNotAllowed:
            self.stats["blocked_save_attempts"] += 1
            self.writer.events.write("blocked_save", now, target_index=index)
            self.buffer, self.trial_onset = [], None
            return
        self.writer.events.write("trial_commit", now, target_index=index,
                                 frames=cfg.FRAMES_PER_TARGET)
        self.queue.popleft()
        self.completed_count += 1
        self.buffer, self.trial_onset = [], None
        if not self.queue:
            self._finish(now)

    def _timeout_trial(self, now: float) -> None:
        index = self.queue[0]
        self.stats["trial_timeouts"] += 1
        self._discard_buffer("timeout", now)
        self.retries[index] = self.retries.get(index, 0) + 1
        self.queue.popleft()
        if self.retries[index] > cfg.MAX_TRIAL_RETRIES:
            self.failed.append(index)
        else:
            self.queue.append(index)            # retry later
        if not self.queue:
            self._finish(now)

    def _finish(self, now: float) -> None:
        self.sm.complete(now)
        status = "complete" if not self.failed else "incomplete"
        self._write_quality_report(status)
        self.writer.update_metadata(status=status, finished=now_iso())
        self.needs_validation = True
        self.message = "Session finished - validating data..."

    # ------------------------------------------------------------------ reports
    def incomplete_targets(self) -> List[int]:
        if self.writer is None:
            return []
        done = self.writer.completed_targets()
        return [t["target_index"] for t in self.targets if t["target_index"] not in done]

    def _write_quality_report(self, status: str) -> Dict:
        if self.writer is None:
            return {}
        rows = self.writer.annotations()
        def mean(key):
            vals = [r["quality"][key] for r in rows if key in r.get("quality", {})]
            return round(sum(vals) / len(vals), 3) if vals else None
        incomplete = self.incomplete_targets()
        report = {
            "updated": now_iso(),
            "status": status,
            "mode": self.writer.mode,
            "participant_id": self.writer.participant_id,
            "session_id": self.writer.session_id,
            "split": self.writer.split,
            "targets_total": len(self.targets),
            "targets_completed": len(self.targets) - len(incomplete),
            "targets_incomplete": incomplete,
            "targets_failed_after_retries": sorted(self.failed),
            "valid_images": len(rows),
            "rejected_frames": self.stats["rejected_frames"],
            "rejected_reasons": dict(self.stats["rejected_reasons"]),
            "discarded_partial_frames": self.stats["discarded_partial_frames"],
            "interrupted_trials": self.stats["interrupted_trials"],
            "trial_timeouts": self.stats["trial_timeouts"],
            "pauses": self.stats["pauses"],
            "resumes": self.stats["resumes"],
            "blocked_save_attempts": self.stats["blocked_save_attempts"],
            "mean_face_score": mean("face_score"),
            "mean_sharpness": mean("sharpness"),
            "mean_brightness": mean("brightness"),
            "last_recovery": self.recovery,
            "integrity_overall": (self.integrity_report or {}).get("overall"),
            "note": "Capture-quality figures only; not a measure of gaze-model accuracy.",
        }
        self.writer.write_quality_report(report)
        return report

    def run_validation(self, deep: bool = True) -> Dict:
        """Integrity report + manifests + completion summary (may take a while
        for large sessions; the GUI runs it in a worker thread)."""
        w = self.writer
        report = integrity.validate_session(self.layout, w.mode, w.participant_id,
                                            w.session_id, deep=deep)
        report_path = integrity.save_session_report(self.layout, report)
        dataset_report = None
        if w.mode == cfg.MODE_OFFICIAL:
            integrity.rebuild_manifests(self.layout)
            dataset_report = integrity.validate_dataset(self.layout)
            if dataset_report["overall"] == integrity.FAIL:
                report["overall"] = integrity.FAIL
        self.integrity_report = report
        quality = self._write_quality_report(
            "complete" if not self.incomplete_targets() else "incomplete")
        self.needs_validation = False
        self.summary = self.build_summary(quality, report, str(report_path), dataset_report)
        self.message = "Session finished."
        return self.summary

    def build_summary(self, quality: Dict, report: Dict, report_path: str,
                      dataset_report: Optional[Dict] = None) -> Dict:
        w = self.writer
        official = w.mode == cfg.MODE_OFFICIAL
        total = integrity.participant_valid_images(self.layout, w.mode, w.participant_id)
        return {
            "mode": w.mode,
            "participant_id": w.participant_id,
            "session_id": w.session_id,
            "split": w.split,
            "valid_images_session": quality["valid_images"],
            "valid_images_participant": total,
            "rejected_frames": quality["rejected_frames"],
            "completed_targets": quality["targets_completed"],
            "total_targets": quality["targets_total"],
            "incomplete_targets": quality["targets_incomplete"],
            "remaining_to_5000": (max(0, cfg.TARGET_VALID_IMAGES_PER_PARTICIPANT - total)
                                  if official else None),
            "dataset_root": str(self.layout.root),
            "participant_dir": str(self.layout.participant_dir(w.mode, w.participant_id)),
            "session_dir": str(w.dir),
            "integrity_overall": report["overall"],
            "integrity_checks": report["checks"],
            "dataset_checks": (dataset_report or {}).get("checks", []),
            "report_path": report_path,
        }

    # ------------------------------------------------------------------ leaving
    def return_to_selection(self, now: Optional[float] = None) -> bool:
        """Back to READY for a new participant/session. Refused while active."""
        now = self.clock() if now is None else now
        if self.sm.state in (State.STABILIZING, State.CAPTURING):
            return False
        if self.sm.state is State.PAUSED:
            self._write_quality_report("incomplete")
            if self.writer is not None:
                self.writer.update_metadata(status="incomplete")
        self.sm.reset_to_ready(now)
        self.writer = None
        self.message = "Press SPACE to start."
        return True

    def system_pause(self, reason: str, now: Optional[float] = None) -> bool:
        """Pause for a non-keyboard reason (e.g. the camera stopped delivering)."""
        now = self.clock() if now is None else now
        if self.sm.force_pause(now, f"system:{reason}"):
            self._discard_buffer(reason, now)
            self.stats["pauses"] += 1
            self._write_quality_report("paused")
            self.message = f"PAUSED ({reason}) - press SPACE to resume."
            return True
        return False

    def shutdown(self, now: Optional[float] = None) -> None:
        """Application is closing: stop safely, never leave partial samples."""
        now = self.clock() if now is None else now
        if self.sm.force_pause(now, "system:app_closing"):
            self._discard_buffer("app_closing", now)
        if self.writer is not None and self.sm.state is State.PAUSED:
            self._write_quality_report("incomplete")
            self.writer.update_metadata(status="incomplete")
