"""Tk user interface: operator dashboard (window 1) and full-screen gaze
fixation map (window 2).

All experiment logic lives in session.CollectionController; this file only
draws, forwards the SPACE key and passes camera frames along.
"""
from __future__ import annotations

import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Dict, List, Optional

import cv2

from . import config as cfg
from .devices import Camera, list_monitors
from .layout import DatasetLayout, open_in_file_explorer, split_for
from .session import CollectionController, SessionConfig, SettingsLocked
from .state_machine import State
from .vision import crop_boxes

EDITABLE_CLASSES = ("Entry", "TEntry", "Text", "Spinbox", "TSpinbox")
STATE_COLORS = {State.READY: "#1565c0", State.STABILIZING: "#ef6c00",
                State.CAPTURING: "#2e7d32", State.PAUSED: "#c62828",
                State.COMPLETE: "#6a1b9a"}
SPLIT_COLORS = {"train": "#2e7d32", "validation": "#ef6c00", "test": "#c62828",
                "pilot": "#546e7a"}
PREVIEW_W, PREVIEW_H = 640, 360
MODE_LABELS = {cfg.MODE_PILOT: "Pilot (testing)", cfg.MODE_OFFICIAL: "Official dataset"}


class App:
    def __init__(self, root: tk.Tk, controller: CollectionController, camera,
                 clock=time.time):
        self.root = root
        self.c = controller
        self.camera = camera
        self.clock = clock
        self.monitors: List[Dict] = list_monitors(root)
        self._last_seq = -1
        self._last_preview = 0.0
        self._preview_img = None
        self._target_key = None
        self._validating = False
        self._validation_error: Optional[str] = None
        self._summary_win: Optional[tk.Toplevel] = None
        self._last_state: Optional[State] = None
        self._closing = False

        self.c.start_guard = self._start_guard
        self.c.layout.ensure_structure()

        self._build_dashboard()
        self._build_target_window()
        self._install_space_handling(self.root)
        self._install_space_handling(self.target_win)
        self._apply_config()
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(15, self._loop)

    # ================================================================ dashboard
    def _build_dashboard(self) -> None:
        r = self.root
        r.title("NASA Eye-Tracking - Operator Dashboard")
        r.geometry("1180x800+40+40")
        r.minsize(1080, 740)
        style = ttk.Style(r)
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("TLabel", font=("Segoe UI", 10))
        style.configure("Head.TLabel", font=("Segoe UI", 10, "bold"))
        style.configure("Path.TLabel", font=("Consolas", 10, "bold"))

        self.state_banner = tk.Label(r, text="READY", fg="white", bg=STATE_COLORS[State.READY],
                                     font=("Segoe UI", 22, "bold"), pady=6)
        self.state_banner.pack(fill="x")
        self.message_var = tk.StringVar(value=self.c.message)
        tk.Label(r, textvariable=self.message_var, font=("Segoe UI", 11),
                 anchor="w", padx=10, pady=4).pack(fill="x")

        body = ttk.Frame(r, padding=8)
        body.pack(fill="both", expand=True)
        left = ttk.Frame(body)
        left.pack(side="left", fill="y")
        right = ttk.Frame(body, padding=(12, 0, 0, 0))
        right.pack(side="left", fill="both", expand=True)

        # ---- camera preview ------------------------------------------------
        self._preview_img = tk.PhotoImage(width=PREVIEW_W, height=PREVIEW_H)
        self.preview = tk.Label(left, bg="black", image=self._preview_img,
                                text="Waiting for camera...", fg="white",
                                compound="center", font=("Segoe UI", 14))
        self.preview.pack()
        self.detect_var = tk.StringVar(value="")
        ttk.Label(left, textvariable=self.detect_var).pack(anchor="w", pady=(4, 0))
        ttk.Label(left, text="Preview is mirrored for the operator only; "
                             "saved frames are unmirrored originals.",
                  foreground="#666").pack(anchor="w")

        self.id_banner = tk.Label(left, text="", fg="white", bg="#546e7a",
                                  font=("Segoe UI", 20, "bold"), pady=8)
        self.id_banner.pack(fill="x", pady=(10, 4))

        prog = ttk.LabelFrame(left, text="Progress", padding=8)
        prog.pack(fill="x", pady=4)
        self.progress_var = tk.StringVar(value="-")
        ttk.Label(prog, textvariable=self.progress_var, justify="left").pack(anchor="w")
        self.progressbar = ttk.Progressbar(prog, maximum=1, value=0)
        self.progressbar.pack(fill="x", pady=(6, 0))

        tk.Label(left, text="SPACE = start / pause / resume",
                 font=("Segoe UI", 13, "bold"), fg="#1565c0").pack(anchor="w", pady=(8, 0))

        # ---- session settings ----------------------------------------------
        box = ttk.LabelFrame(right, text="Session settings (locked while recording)",
                             padding=10)
        box.pack(fill="x")
        box.columnconfigure(1, weight=1)
        self.lockable: List[tk.Widget] = []

        ttk.Label(box, text="Collection mode", style="Head.TLabel").grid(
            row=0, column=0, sticky="w", pady=3)
        self.mode_var = tk.StringVar(value=cfg.MODE_PILOT)
        mode_row = ttk.Frame(box)
        mode_row.grid(row=0, column=1, sticky="w")
        for mode in cfg.MODES:
            rb = ttk.Radiobutton(mode_row, text=MODE_LABELS[mode], value=mode,
                                 variable=self.mode_var, command=self._on_mode_change,
                                 takefocus=False)
            rb.pack(side="left", padx=(0, 14))
            self.lockable.append(rb)

        ttk.Label(box, text="Participant", style="Head.TLabel").grid(
            row=1, column=0, sticky="w", pady=3)
        self.participant_var = tk.StringVar(value=cfg.PILOT_PARTICIPANTS[0])
        self.participant_box = ttk.Combobox(box, textvariable=self.participant_var,
                                            state="readonly", width=14, takefocus=False,
                                            values=cfg.PILOT_PARTICIPANTS)
        self.participant_box.grid(row=1, column=1, sticky="w")
        self.participant_box.bind("<<ComboboxSelected>>", lambda e: self._apply_config())
        self.lockable.append(self.participant_box)

        ttk.Label(box, text="Session", style="Head.TLabel").grid(
            row=2, column=0, sticky="w", pady=3)
        ses_row = ttk.Frame(box)
        ses_row.grid(row=2, column=1, sticky="w")
        self.session_var = tk.StringVar(value=cfg.SESSION_IDS[0])
        self.session_box = ttk.Combobox(ses_row, textvariable=self.session_var,
                                        state="readonly", width=8, takefocus=False,
                                        values=cfg.SESSION_IDS)
        self.session_box.pack(side="left")
        self.session_box.bind("<<ComboboxSelected>>", lambda e: self._on_session_change())
        self.lockable.append(self.session_box)
        self.resume_var = tk.BooleanVar(value=False)
        self.resume_check = ttk.Checkbutton(ses_row, text="Resume incomplete session",
                                            variable=self.resume_var, takefocus=False,
                                            command=self._apply_config)
        self.resume_check.pack(side="left", padx=12)
        self.lockable.append(self.resume_check)
        self.existing_var = tk.StringVar(value="")
        ttk.Label(box, textvariable=self.existing_var, foreground="#b71c1c",
                  wraplength=430, justify="left").grid(row=3, column=1, sticky="w")

        ttk.Label(box, text="Targets", style="Head.TLabel").grid(
            row=4, column=0, sticky="w", pady=3)
        tgt_row = ttk.Frame(box)
        tgt_row.grid(row=4, column=1, sticky="w")
        self.targets_var = tk.StringVar(value=str(cfg.PILOT_TARGET_CHOICES[0]))
        self.targets_box = ttk.Combobox(tgt_row, textvariable=self.targets_var,
                                        state="readonly", width=10, takefocus=False)
        self.targets_box.pack(side="left")
        self.targets_box.bind("<<ComboboxSelected>>", lambda e: self._on_targets_change())
        self.lockable.append(self.targets_box)
        self.custom_var = tk.StringVar(value="15")
        self.custom_entry = ttk.Entry(tgt_row, textvariable=self.custom_var, width=7)
        self.custom_entry.pack(side="left", padx=8)
        ttk.Label(tgt_row, text="(Custom: type a number, then Enter)",
                  foreground="#666").pack(side="left")
        self.custom_entry.bind(
            "<FocusOut>",
            lambda e: self._apply_config() if self.c.state is State.READY else None)
        self.custom_entry.bind("<Return>", lambda e: (self._apply_config(), self.root.focus_set()))
        self.lockable.append(self.custom_entry)
        self.targets_info = tk.StringVar(value="")
        ttk.Label(box, textvariable=self.targets_info, foreground="#666").grid(
            row=5, column=1, sticky="w")

        ttk.Label(box, text="Participant monitor", style="Head.TLabel").grid(
            row=6, column=0, sticky="w", pady=3)
        labels = [self._monitor_label(m) for m in self.monitors]
        default_monitor = 1 if len(self.monitors) > 1 else 0
        self.monitor_var = tk.StringVar(value=labels[default_monitor])
        self.monitor_box = ttk.Combobox(box, textvariable=self.monitor_var, values=labels,
                                        state="readonly", width=44, takefocus=False)
        self.monitor_box.grid(row=6, column=1, sticky="w")
        self.monitor_box.bind("<<ComboboxSelected>>", lambda e: self._on_monitor_change())
        self.lockable.append(self.monitor_box)

        # ---- storage ---------------------------------------------------------
        store = ttk.LabelFrame(right, text="Where data is saved", padding=10)
        store.pack(fill="x", pady=10)
        ttk.Label(store, text="Dataset root (absolute path in use):",
                  style="Head.TLabel").pack(anchor="w")
        self.root_path_var = tk.StringVar(value=str(self.c.layout.root))
        ttk.Label(store, textvariable=self.root_path_var, style="Path.TLabel",
                  foreground="#0d47a1", wraplength=470, justify="left").pack(anchor="w", pady=2)
        ttk.Label(store, text="Current participant folder:",
                  style="Head.TLabel").pack(anchor="w", pady=(6, 0))
        self.participant_path_var = tk.StringVar(value="")
        ttk.Label(store, textvariable=self.participant_path_var, style="Path.TLabel",
                  wraplength=470, justify="left").pack(anchor="w", pady=2)

        change = ttk.Frame(store)
        change.pack(fill="x", pady=(8, 2))
        self.root_entry_var = tk.StringVar(value=str(self.c.layout.root))
        self.root_entry = ttk.Entry(change, textvariable=self.root_entry_var)
        self.root_entry.pack(side="left", fill="x", expand=True)
        self.browse_btn = ttk.Button(change, text="Browse...", command=self._browse_root,
                                     takefocus=False)
        self.browse_btn.pack(side="left", padx=4)
        self.apply_btn = ttk.Button(change, text="Apply new root", command=self._apply_root,
                                    takefocus=False)
        self.apply_btn.pack(side="left")
        self.lockable += [self.root_entry, self.browse_btn, self.apply_btn]

        open_row = ttk.Frame(store)
        open_row.pack(fill="x", pady=(8, 0))
        ttk.Button(open_row, text="Open Dataset Folder", takefocus=False,
                   command=self.open_dataset_folder).pack(side="left")
        ttk.Button(open_row, text="Open Current Participant Folder", takefocus=False,
                   command=self.open_participant_folder).pack(side="left", padx=8)

        self.summary_btn = ttk.Button(right, text="Show last session summary",
                                      takefocus=False, command=self._show_summary,
                                      state="disabled")
        self.summary_btn.pack(anchor="w")
        self._on_mode_change(apply=False)
        # Clicking anywhere outside a text field takes the cursor out of it,
        # so SPACE controls recording again.
        r.bind_all("<Button-1>", self._defocus_text_fields, add="+")

    def _defocus_text_fields(self, event) -> None:
        try:
            cls = event.widget.winfo_class()
        except Exception:
            return
        if cls not in EDITABLE_CLASSES and cls != "TCombobox":
            if self._focus_is_editable():
                event.widget.winfo_toplevel().focus_set()

    @staticmethod
    def _monitor_label(m: Dict) -> str:
        return (f"Monitor {m['index'] + 1}: {m['width_px']}x{m['height_px']} at "
                f"({m['x']},{m['y']}){' - primary' if m.get('primary') else ''}")

    # ============================================================ target window
    def _build_target_window(self) -> None:
        self.target_win = tk.Toplevel(self.root)
        self.target_win.title("NASA Eye-Tracking - Gaze Fixation Map")
        self.target_win.configure(bg="black")
        self.target_win.overrideredirect(True)
        self.canvas = tk.Canvas(self.target_win, bg="black", highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Button-1>", lambda e: self.target_win.focus_force())
        self._place_target_window()

    def _selected_monitor(self) -> Dict:
        for m in self.monitors:
            if self._monitor_label(m) == self.monitor_var.get():
                return m
        return self.monitors[0]

    def _place_target_window(self) -> None:
        m = self._selected_monitor()
        self.target_win.geometry(f"{m['width_px']}x{m['height_px']}+{m['x']}+{m['y']}")
        self.canvas.configure(width=m["width_px"], height=m["height_px"])
        self._target_key = None

    def _same_monitor(self) -> bool:
        """True when the dashboard sits on the participant monitor."""
        m = self._selected_monitor()
        cx = self.root.winfo_rootx() + self.root.winfo_width() // 2
        cy = self.root.winfo_rooty() + self.root.winfo_height() // 2
        return (m["x"] <= cx < m["x"] + m["width_px"]
                and m["y"] <= cy < m["y"] + m["height_px"])

    def _arrange_windows(self) -> None:
        """Single-monitor setups: the map is in front while recording, the
        dashboard is in front otherwise. Two monitors: nothing is moved."""
        active = self.c.state in (State.STABILIZING, State.CAPTURING)
        if not self._same_monitor():
            self.target_win.attributes("-topmost", True)
            return
        self.target_win.attributes("-topmost", active)
        if active:
            self.target_win.lift()
            self.target_win.focus_force()
        else:
            self.root.lift()
            self.root.focus_force()
            if self._summary_win is not None and self._summary_win.winfo_exists():
                self._summary_win.lift()

    def _draw_target_window(self, now: float) -> None:
        state = self.c.state
        target = self.c.current_target
        countdown = int(self.c.countdown_remaining(now)) + 1 if state is State.STABILIZING else 0
        key = (state, target["target_index"] if target else None, countdown,
               self.c.config.participant_id if self.c.config else None)
        awaiting_confirm = target is not None and self.c.trial_onset is None
        if key == self._target_key and not awaiting_confirm:
            return
        self._target_key = key
        m = self._selected_monitor()
        w, h = m["width_px"], m["height_px"]
        cv = self.canvas
        cv.delete("all")
        if state is State.CAPTURING and target is not None:
            x, y = target["x_px"], target["y_px"]
            cv.create_oval(x - 20, y - 20, x + 20, y + 20, outline="white", width=3)
            cv.create_oval(x - 5, y - 5, x + 5, y + 5, fill="#ff1744", outline="")
            cv.update_idletasks()                       # make sure it is on screen
            self.c.confirm_target_drawn(target["target_index"], self.clock())
            return
        if state is State.READY:
            text, sub = "Press SPACE to start", "Look at each dot until it moves."
        elif state is State.STABILIZING:
            text, sub = str(countdown), "Hold still - starting"
        elif state is State.PAUSED:
            text, sub = "PAUSED", "Press SPACE to resume"
        elif state is State.COMPLETE:
            text, sub = "Session complete", "Thank you."
        else:
            text, sub = "", ""
        cv.create_text(w // 2, h // 2 - 30, text=text, fill="white",
                       font=("Segoe UI", 64, "bold"))
        cv.create_text(w // 2, h // 2 + 60, text=sub, fill="#bbbbbb", font=("Segoe UI", 22))

    # ============================================================ SPACE handling
    def _install_space_handling(self, widget: tk.Misc) -> None:
        """Put our key handler in front of every non-editable widget so SPACE
        works whichever window has focus and never 'clicks' a focused control.
        Editable fields keep normal typing (SPACE is not intercepted there)."""
        if not getattr(self, "_space_class_bound", False):
            self.root.bind_class("SpaceFirst", "<KeyPress>", self._on_key_press)
            self.root.bind_class("SpaceFirst", "<KeyRelease>", self._on_key_release)
            self._space_class_bound = True
        if widget.winfo_class() not in EDITABLE_CLASSES:
            tags = widget.bindtags()
            if "SpaceFirst" not in tags:
                widget.bindtags(("SpaceFirst",) + tags)
        for child in widget.winfo_children():
            if not isinstance(child, tk.Toplevel):
                self._install_space_handling(child)

    def _focus_is_editable(self) -> bool:
        try:
            w = self.root.focus_get()
        except (KeyError, tk.TclError):
            return False
        if w is None:
            return False
        cls = w.winfo_class()
        if cls in EDITABLE_CLASSES:
            return True
        if cls == "TCombobox":
            return "readonly" not in w.state()
        return False

    def _on_key_press(self, event):
        action_or_none = self.c.keys.key_press(event.keysym, self.clock(),
                                               self._focus_is_editable())
        if self.c.keys.is_space(event.keysym):
            if action_or_none is None:
                self.message_var.set(self.c.message)
            return "break"                   # SPACE never activates a focused control
        return None

    def _on_key_release(self, event):
        self.c.keys.key_release(event.keysym, self.clock())
        if self.c.keys.is_space(event.keysym):
            return "break"
        return None

    def _start_guard(self) -> Optional[str]:
        if not self.camera.ok:
            return "Camera is not available - recording cannot start."
        if self.camera.seconds_since_frame() > 2.0:
            return "Camera is not delivering frames - recording cannot start."
        if self._validating:
            return "Still validating the previous session - please wait."
        problem = self._apply_config()
        return problem

    # ============================================================= configuration
    def _target_count(self) -> int:
        value = self.targets_var.get()
        if value == "Custom":
            n = int(self.custom_var.get().strip())
            if not 1 <= n <= 1000:
                raise ValueError("Custom target count must be between 1 and 1000.")
            return n
        return int(value)

    def _on_mode_change(self, apply: bool = True) -> None:
        if self.mode_var.get() == cfg.MODE_PILOT:
            self.participant_box.configure(values=cfg.PILOT_PARTICIPANTS)
            if self.participant_var.get() not in cfg.PILOT_PARTICIPANTS:
                self.participant_var.set(cfg.PILOT_PARTICIPANTS[0])
            choices = [str(n) for n in cfg.PILOT_TARGET_CHOICES] + ["Custom"]
            self.targets_box.configure(values=choices)
            if self.targets_var.get() not in choices:
                self.targets_var.set(str(cfg.PILOT_TARGET_CHOICES[0]))
        else:
            self.participant_box.configure(values=cfg.OFFICIAL_PARTICIPANTS)
            if self.participant_var.get() not in cfg.OFFICIAL_PARTICIPANTS:
                self.participant_var.set(cfg.OFFICIAL_PARTICIPANTS[0])
            choices = [str(n) for n in cfg.OFFICIAL_TARGETS_PER_SESSION_CHOICES]
            self.targets_box.configure(values=choices)
            if self.targets_var.get() not in choices:
                self.targets_var.set(str(cfg.OFFICIAL_TARGETS_PER_SESSION_DEFAULT))
        self.resume_var.set(False)
        self._on_targets_change(apply=apply)

    def _on_targets_change(self, apply: bool = True) -> None:
        custom = self.targets_var.get() == "Custom"
        self.custom_entry.configure(state="normal" if custom else "disabled")
        if apply:
            self._apply_config()

    def _on_session_change(self) -> None:
        self.resume_var.set(False)
        self._apply_config()

    def _on_monitor_change(self) -> None:
        self._place_target_window()
        self._apply_config()

    def _apply_config(self) -> Optional[str]:
        """Push the dashboard selections into the controller.
        Returns a problem description, or None when the configuration is valid."""
        if self.c.sm.settings_locked:
            return None
        if self._validating:
            return "Still validating the previous session - please wait."
        try:
            n = self._target_count()
            m = self._selected_monitor()
            config = SessionConfig(
                mode=self.mode_var.get(), participant_id=self.participant_var.get(),
                session_id=self.session_var.get(), n_targets=n, monitor=dict(m),
                camera=self.camera.info(), resume=bool(self.resume_var.get()))
            self.c.configure(config)
        except (ValueError, SettingsLocked) as exc:
            problem = f"Invalid settings: {exc}"
            self.c.message = problem
            self.message_var.set(problem)
            return problem
        self.targets_info.set(f"x {cfg.FRAMES_PER_TARGET} frames = "
                              f"{n * cfg.FRAMES_PER_TARGET} images")
        self._refresh_identity()
        return None

    def _refresh_identity(self) -> None:
        c = self.c.config
        if c is None:
            return
        split = split_for(c.mode, c.participant_id)
        label = (f"{c.participant_id}  ->  {split.upper()}" if c.mode == cfg.MODE_OFFICIAL
                 else f"{c.participant_id}  ->  PILOT (not part of the dataset)")
        self.id_banner.configure(text=f"{label}   |   {c.session_id}",
                                 bg=SPLIT_COLORS.get(split, "#546e7a"))
        self.root_path_var.set(str(self.c.layout.root))
        self.participant_path_var.set(
            str(self.c.layout.participant_dir(c.mode, c.participant_id)))
        status = self.c.existing_session_status()
        if status is None:
            self.existing_var.set("")
        elif status["complete"]:
            self.existing_var.set(f"{c.session_id} is already complete "
                                  f"({status['total_targets']} targets). Choose another session.")
        else:
            self.existing_var.set(
                f"Incomplete session found: {status['completed_targets']}/"
                f"{status['total_targets']} targets done. Tick 'Resume incomplete session' "
                f"to continue it, or choose another session.")
        self._target_key = None

    # ================================================================== storage
    def _browse_root(self) -> None:
        chosen = filedialog.askdirectory(parent=self.root, title="Choose dataset root folder",
                                         initialdir=str(self.c.layout.root.parent))
        if chosen:
            self.root_entry_var.set(str(Path(chosen)))
            self._apply_root()

    def _apply_root(self) -> None:
        if self.c.sm.settings_locked:
            messagebox.showwarning("Locked", "The dataset root cannot change while "
                                             "recording is active.", parent=self.root)
            return
        text = self.root_entry_var.get().strip().strip('"')
        try:
            new_root = Path(text).expanduser()
            if not text or not new_root.is_absolute():
                raise ValueError("Enter a complete absolute path, e.g. D:\\Data\\NASA_EyeTracking_Dataset")
            new_root = new_root.resolve()
            if new_root == self.c.layout.root:
                return
            if not messagebox.askyesno(
                    "Change dataset root",
                    f"All new recordings will be saved under:\n\n{new_root}\n\n"
                    f"(previously: {self.c.layout.root})\n\nChange the dataset root?",
                    parent=self.root):
                self.root_entry_var.set(str(self.c.layout.root))
                return
            layout = DatasetLayout(new_root)
            layout.ensure_structure()
            self.c.set_layout(layout)
            cfg.save_dataset_root(new_root)
        except (ValueError, OSError, SettingsLocked) as exc:
            messagebox.showerror("Dataset root", str(exc), parent=self.root)
            self.root_entry_var.set(str(self.c.layout.root))
            return
        self.root_entry_var.set(str(self.c.layout.root))
        self.root.focus_set()
        self._apply_config()

    def open_dataset_folder(self) -> None:
        err = open_in_file_explorer(self.c.layout.root)
        if err:
            messagebox.showerror("Open folder", err, parent=self.root)

    def open_participant_folder(self) -> None:
        c = self.c.config
        if c is None:
            return
        err = open_in_file_explorer(self.c.layout.participant_dir(c.mode, c.participant_id))
        if err:
            messagebox.showerror("Open folder", err, parent=self.root)

    # ================================================================ main loop
    def _loop(self) -> None:
        if self._closing:
            return
        try:
            self._loop_once()
        except Exception:
            import traceback
            try:
                log = self.c.layout.logs_dir / "app_errors.log"
                log.parent.mkdir(parents=True, exist_ok=True)
                with open(log, "a", encoding="utf-8") as fh:
                    fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + traceback.format_exc() + "\n")
            except OSError:
                pass
            self.c.system_pause("internal_error")
            self.c.message = "Internal error - recording paused. See logs/app_errors.log."
        self.root.after(15, self._loop)

    def _loop_once(self) -> None:
        now = self.clock()
        seq, frame, t_frame = self.camera.latest()
        info = None
        if frame is not None and seq != self._last_seq:
            self._last_seq = seq
            info = self.c.process_frame(frame, t_frame)
            if now - self._last_preview > 0.066:
                self._last_preview = now
                self._update_preview(frame, info)
        else:
            self.c.tick(now)
            if (self.c.state in (State.STABILIZING, State.CAPTURING)
                    and self.camera.seconds_since_frame() > 2.0):
                self.c.system_pause("camera_lost")

        self._draw_target_window(now)
        self._update_dashboard()

        if self.c.needs_validation and not self._validating:
            self._start_validation()

    def _update_preview(self, frame, info: Dict) -> None:
        view = frame.copy()
        det = info.get("detection") if info else None
        if det is not None:
            ok = (0, 200, 0) if (info.get("valid") or not info.get("collecting")) else (0, 0, 255)
            boxes = crop_boxes(det, frame.shape)
            for name in ("face", "left_eye", "right_eye"):
                x, y, w, h = boxes[name]
                cv2.rectangle(view, (x, y), (x + w, y + h), ok, 2)
        view = cv2.flip(cv2.resize(view, (PREVIEW_W, PREVIEW_H)), 1)
        okay, png = cv2.imencode(".png", view, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        if okay:
            self._preview_img = tk.PhotoImage(data=png.tobytes(), format="png")
            self.preview.configure(image=self._preview_img, text="")
        if det is None:
            self.detect_var.set("Face / eyes: NOT detected")
        elif info.get("collecting") and not info.get("valid"):
            self.detect_var.set("Frame rejected: " + ", ".join(info.get("reasons", [])))
        else:
            self.detect_var.set("Face and both eyes detected")

    def _update_dashboard(self) -> None:
        state = self.c.state
        if state is not self._last_state:
            self._last_state = state
            self.state_banner.configure(text=state.value, bg=STATE_COLORS[state])
            locked = self.c.sm.settings_locked
            for w in self.lockable:
                try:
                    if isinstance(w, ttk.Combobox):
                        w.configure(state="disabled" if locked else "readonly")
                    else:
                        w.configure(state="disabled" if locked else "normal")
                except tk.TclError:
                    pass
            if not locked:
                self._on_targets_change(apply=False)
            self._arrange_windows()
        self.message_var.set(self.c.message)

        c = self.c.config
        if state is State.READY or self.c.writer is None or c is None:
            n = c.n_targets if c else 0
            self.progress_var.set(
                f"Not recording. Nothing is being saved.\n"
                f"Planned: {n} targets = {n * cfg.FRAMES_PER_TARGET} images")
            self.progressbar.configure(maximum=1, value=0)
            return
        total = len(self.c.targets)
        done = self.c.completed_count
        lines = [f"Targets completed : {done} / {total}",
                 f"Valid images saved: {done * cfg.FRAMES_PER_TARGET}",
                 f"Rejected frames   : {self.c.stats['rejected_frames']}",
                 f"Current trial     : {len(self.c.buffer)} / {cfg.FRAMES_PER_TARGET} frames"]
        if c.mode == cfg.MODE_OFFICIAL and self.c.summary and state is State.COMPLETE:
            lines.append(f"Participant total : {self.c.summary['valid_images_participant']}"
                         f" / {cfg.TARGET_VALID_IMAGES_PER_PARTICIPANT}")
        self.progress_var.set("\n".join(lines))
        self.progressbar.configure(maximum=max(total, 1), value=done)

    # ====================================================== validation + summary
    def _start_validation(self) -> None:
        self._validating = True
        self._validation_error = None

        def work():
            try:
                self.c.run_validation(deep=True)
            except Exception as exc:                    # shown to the operator
                self._validation_error = f"{type(exc).__name__}: {exc}"
            finally:
                self._validating = False
                self._validation_done = True

        self._validation_done = False
        threading.Thread(target=work, daemon=True).start()
        self._poll_validation()

    def _poll_validation(self) -> None:
        if self._closing:
            return
        if not getattr(self, "_validation_done", False):
            self.root.after(100, self._poll_validation)
            return
        if self._validation_error:
            self.c.needs_validation = False
            self.c.message = "Validation failed to run: " + self._validation_error
            messagebox.showerror("Validation", self.c.message, parent=self.root)
            return
        self.summary_btn.configure(state="normal")
        self._show_summary()

    def _show_summary(self) -> None:
        s = self.c.summary
        if s is None:
            return
        if self._summary_win is not None and self._summary_win.winfo_exists():
            self._summary_win.destroy()
        win = tk.Toplevel(self.root)
        self._summary_win = win
        win.title("Session summary")
        win.geometry("760x720+120+60")
        ok = s["integrity_overall"] == "PASS"
        tk.Label(win, text=f"Data-integrity validation: {s['integrity_overall']}",
                 fg="white", bg="#2e7d32" if ok else "#c62828",
                 font=("Segoe UI", 16, "bold"), pady=8).pack(fill="x")

        official = s["mode"] == cfg.MODE_OFFICIAL
        incomplete = s["incomplete_targets"]
        rows = [
            ("Participant ID", s["participant_id"]),
            ("Dataset split", s["split"].upper() + ("" if official else
                                                    " (never merged into train/validation/test)")),
            ("Session", s["session_id"]),
            ("Valid images (this session)", s["valid_images_session"]),
            ("Rejected frames", s["rejected_frames"]),
            ("Completed target positions", f"{s['completed_targets']} of {s['total_targets']}"),
            ("Incomplete targets", f"{len(incomplete)}"
             + (f"  (indices: {', '.join(map(str, incomplete[:20]))}"
                f"{' ...' if len(incomplete) > 20 else ''})" if incomplete else "")),
            ("Images remaining to reach 5,000",
             f"{s['remaining_to_5000']}  (participant total {s['valid_images_participant']})"
             if official else "n/a - pilot images never count toward 5,000"),
            ("Dataset folder", s["dataset_root"]),
            ("Session folder", s["session_dir"]),
        ]
        grid = ttk.Frame(win, padding=12)
        grid.pack(fill="x")
        grid.columnconfigure(1, weight=1)
        for i, (k, v) in enumerate(rows):
            ttk.Label(grid, text=k, style="Head.TLabel").grid(row=i, column=0, sticky="nw",
                                                              padx=(0, 12), pady=2)
            ttk.Label(grid, text=str(v), wraplength=470, justify="left").grid(
                row=i, column=1, sticky="w", pady=2)

        checks = ttk.LabelFrame(win, text="Integrity checks (image capture only - "
                                          "not gaze-model accuracy)", padding=8)
        checks.pack(fill="both", expand=True, padx=12)
        text = tk.Text(checks, height=12, wrap="word", font=("Consolas", 9), takefocus=False)
        text.pack(fill="both", expand=True)
        text.tag_configure("PASS", foreground="#2e7d32")
        text.tag_configure("FAIL", foreground="#c62828")
        text.tag_configure("N/A", foreground="#666666")
        for chk in s["integrity_checks"] + s.get("dataset_checks", []):
            text.insert("end", f"[{chk['status']}] ", chk["status"])
            text.insert("end", f"{chk['check']}\n        {chk['detail']}\n")
        text.configure(state="disabled")

        btns = ttk.Frame(win, padding=12)
        btns.pack(fill="x")
        ttk.Button(btns, text="Open dataset folder", takefocus=False,
                   command=self.open_dataset_folder).pack(side="left")
        ttk.Button(btns, text="View session report", takefocus=False,
                   command=lambda: self._view_report(s["report_path"])).pack(side="left", padx=6)
        ttk.Button(btns, text="Continue incomplete collection", takefocus=False,
                   command=self._continue_collection).pack(side="left")
        ttk.Button(btns, text="Return to participant selection", takefocus=False,
                   command=self._return_to_selection).pack(side="left", padx=6)
        self._install_space_handling(win)

    def _view_report(self, path: str) -> None:
        try:
            content = Path(path).read_text(encoding="utf-8")
        except OSError as exc:
            messagebox.showerror("Report", str(exc), parent=self.root)
            return
        win = tk.Toplevel(self.root)
        win.title(f"Session report - {path}")
        win.geometry("820x620+160+90")
        ttk.Label(win, text=path, style="Path.TLabel", wraplength=780).pack(anchor="w", padx=8,
                                                                            pady=6)
        text = tk.Text(win, wrap="word", font=("Consolas", 10), takefocus=False)
        text.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        text.insert("1.0", content)
        text.configure(state="disabled")
        ttk.Button(win, text="Open reports folder", takefocus=False,
                   command=lambda: open_in_file_explorer(Path(path).parent)).pack(pady=(0, 8))
        self._install_space_handling(win)

    def _close_summary(self) -> None:
        if self._summary_win is not None and self._summary_win.winfo_exists():
            self._summary_win.destroy()
        self._summary_win = None

    def _continue_collection(self) -> None:
        s = self.c.summary
        if s is None or self.c.sm.settings_locked:
            return
        if s["incomplete_targets"]:
            self.resume_var.set(True)                   # explicit operator choice
            note = (f"{len(s['incomplete_targets'])} incomplete targets queued. "
                    f"Press SPACE to continue {s['session_id']}.")
        elif s["mode"] == cfg.MODE_OFFICIAL and (s["remaining_to_5000"] or 0) > 0:
            nxt = self._next_free_session()
            if nxt is None:
                messagebox.showinfo("Continue", "No free session ID left for this participant.",
                                    parent=self.root)
                return
            self.session_var.set(nxt)
            self.resume_var.set(False)
            note = (f"{s['remaining_to_5000']} images still needed for {s['participant_id']}. "
                    f"Press SPACE to start {nxt}.")
        else:
            messagebox.showinfo("Continue", "Nothing is incomplete for this participant.",
                                parent=self.root)
            return
        self._close_summary()
        if self._apply_config() is None:
            self.c.message = note

    def _next_free_session(self) -> Optional[str]:
        c = self.c.config
        used = {p.name for p in self.c.layout.list_sessions(c.mode, c.participant_id)}
        for sid in cfg.SESSION_IDS:
            if sid not in used:
                return sid
        return None

    def _return_to_selection(self) -> None:
        if not self.c.return_to_selection():
            return
        self.resume_var.set(False)
        self._close_summary()
        self._apply_config()

    # ==================================================================== close
    def close(self) -> None:
        if self.c.state in (State.STABILIZING, State.CAPTURING):
            if not messagebox.askyesno(
                    "Quit", "Recording is active. Quit now?\n\nThe current fixation trial "
                            "will be discarded; completed targets are kept and the session "
                            "can be resumed later.", parent=self.root):
                return
        self._closing = True
        self.c.shutdown()
        try:
            self.camera.stop()
        finally:
            self.root.destroy()


def run(camera_index: int = cfg.CAMERA_INDEX) -> None:
    from .devices import set_dpi_awareness
    from .vision import create_detector

    set_dpi_awareness()
    root = tk.Tk()
    layout = DatasetLayout(cfg.load_dataset_root())
    controller = CollectionController(layout, create_detector())
    camera = Camera(camera_index)
    if not camera.start():
        messagebox.showwarning(
            "Camera", f"{camera.error}\n\nThe dashboard will open, but recording cannot "
                      f"start until a camera is available (try: python main.py --camera 1).",
            parent=root)
    App(root, controller, camera)
    root.mainloop()
