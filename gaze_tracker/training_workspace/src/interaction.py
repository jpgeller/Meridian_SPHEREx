"""Interaction (selection) metrics - only where they are scientifically defined.

Precision, recall and F1 need NEGATIVES: moments when the user did not intend
to select anything (reading, idle, looking between objects), or intended a
different object. The collected dataset has only positive fixations on a
single target, so false activations cannot be measured from it, and these
metrics are NOT computed on it. `selection_metrics` refuses when negatives are
missing.

What CAN be measured on the current data is the hit rate for a target of a
given radius (evaluation.evaluate_predictions -> target_selection_success).

`SELECTION_PROTOCOL` describes the extra recording needed.
"""
from __future__ import annotations

from typing import Dict

import pandas as pd

SELECTION_PROTOCOL = """\
Interaction evaluation protocol (to collect separately, per participant):
1. Show the real astronomy map with N selectable objects of the real size.
2. Trial types, randomised:
   a. SELECT  - a cue names one object; the user dwells on it to select it.
   b. IDLE    - the user reads a text panel / looks at empty sky for 10-20 s;
                any selection here is a false activation.
   c. DISTRACT- the user is asked to look at object A, then B; selections of A
                after the cue moves to B are false activations.
3. Log per decision window: time, intended_target (or 'none' for idle),
   selected_target (or 'none'), dwell time, prediction stream.
4. Score with interaction.selection_metrics(events_df).
"""


def selection_metrics(events: pd.DataFrame) -> Dict[str, float]:
    """events columns: intended_target ('none' allowed), selected_target ('none' allowed).

    TP: selected == intended != none     FP: selected != none and != intended
    FN: intended != none and selected != intended      TN: intended == none == selected
    """
    need = {"intended_target", "selected_target"}
    if not need <= set(events.columns):
        raise ValueError(f"events must have columns {need}")
    it = events["intended_target"].fillna("none").astype(str)
    sel = events["selected_target"].fillna("none").astype(str)
    if not (it == "none").any():
        raise ValueError("No negative (idle/no-intent) windows: false-activation rate, precision "
                         "and F1 are undefined. Collect data with SELECTION_PROTOCOL.")
    tp = int(((sel == it) & (it != "none")).sum())
    fp = int(((sel != "none") & (sel != it)).sum())
    fn = int(((it != "none") & (sel != it)).sum())
    tn = int(((it == "none") & (sel == "none")).sum())
    precision = tp / (tp + fp) if tp + fp else float("nan")
    recall = tp / (tp + fn) if tp + fn else float("nan")
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else float("nan")
    neg = int((it == "none").sum())
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": precision, "recall": recall,
            "f1": f1, "selection_success_rate": recall,
            "false_activation_rate": float(((it == "none") & (sel != "none")).sum() / neg),
            "missed_activation_rate": fn / max(1, int((it != "none").sum()))}
