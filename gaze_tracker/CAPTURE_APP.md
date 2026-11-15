# NASA Eye-Tracking Dataset Collection (capture app)

> Part of the gaze tracker. Start with [README.md](README.md).

Collects webcam images of a participant looking at known fixation targets.
Capture only: there is no ViT training and no gaze inference in this project.

## Install (Windows)

```
cd gaze_tracker
python -m pip install -r requirements.txt   # or the full install in README.md
```

Python 3.9+ with Tkinter (included in the python.org and Anaconda installers).

## Run

```
python main.py              # dashboard + full-screen fixation map
python main.py --camera 1   # use a different webcam
python main.py --validate   # rebuild manifests + validate the whole dataset
python -m pytest            # automated tests
```

Two windows open: the **operator dashboard** (camera preview, settings, paths)
and the **gaze fixation map** (full screen on the selected participant monitor).
The application always starts in **READY** and records nothing until SPACE.

| State | SPACE does |
|---|---|
| READY | starts the session with a 3 s stabilization countdown |
| STABILIZING / CAPTURING | pauses immediately (the current trial is discarded) |
| PAUSED | resumes with a new 3 s countdown; the interrupted target restarts |
| COMPLETE | nothing, until a new session is configured |

SPACE works from either window. Holding it down does not toggle repeatedly.
While the cursor is in a text field, SPACE is typed into the field; press
Enter or click elsewhere to leave the field. **P does nothing.**

With one monitor, the fixation map comes to the front while recording and the
dashboard comes back when paused or finished.

## Pilot mode (testing)

1. Collection mode: **Pilot (testing)**.
2. Choose a pilot participant (PILOT01-PILOT05), a session, and 5 / 10 / 25 /
   Custom targets (10 images per target).
3. Press SPACE. Try pausing and resuming with SPACE mid-run.
4. The summary shows the automated integrity report: images saved, both eye
   crops created, RGB preserved, labels correct, SPACE worked, nothing recorded
   while paused, target map consistent with the monitor, sample IDs and file
   references valid.

Pilot data goes to `pilot/` only, its sample IDs start with `PILOT-`, and it is
never read when the train / validation / test manifests are built.

## Official dataset mode

Collection mode: **Official dataset**, then pick the participant. The split is
fixed and shown on the coloured banner:

| Participants | Split | Folder |
|---|---|---|
| P001-P006 | Training | `train\P00x\` |
| P007-P008 | Validation | `validation\P00x\` |
| P009-P010 | Testing | `test\P0xx\` |

* **Training data:** select P001...P006 in turn.
* **Validation data:** select P007 or P008.
* **Test data:** select P009 or P010.

Each participant needs 5,000 valid images. A session is 50 / 100 / 250 / 500
targets x 10 images; the default (100 targets = 1,000 images) reaches 5,000 in
five sessions S01-S05. The summary shows how many images remain, and
**Continue incomplete collection** selects the next step.

A participant cannot be stored in another split: the assignment is fixed in
`eyetrack/config.py`, recorded in `manifests/participant_registry.json`, and
every write is checked against it.

### Interrupted sessions

Closing the app or pausing never leaves partial samples: a target counts only
when all 10 of its images and labels are written. After relaunch the app is in
READY; select the same participant and session, tick **Resume incomplete
session**, and press SPACE. Only the unfinished targets are recorded.

## Where the data is

The dashboard shows the complete absolute path of the dataset root and of the
current participant folder. Default:

```
<your gaze_tracker folder>\NASA_EyeTracking_Dataset
```

(the project folder, not the terminal's working directory). To change it, type
or browse a new absolute path and confirm **Apply new root**; it is locked
while recording and never changes on its own.

* **Open Dataset Folder** - opens the dataset root in Windows File Explorer.
* **Open Current Participant Folder** - opens e.g. `...\train\P003`.
* Or paste the path shown on the dashboard into the File Explorer address bar.

```
NASA_EyeTracking_Dataset/
  pilot/<participant>/<session>/
  train/P001..P006/<session>/
  validation/P007..P008/<session>/
  test/P009..P010/<session>/
  manifests/   train.jsonl, validation.jsonl, test.jsonl, summary.json,
               participant_registry.json
  reports/     <mode>_<participant>_<session>_integrity.txt/.json,
               dataset_integrity.json
  logs/        <mode>_<participant>_<session>_events.jsonl
```

Each session folder contains:

| Item | Content |
|---|---|
| `raw/` | original webcam frames, unmirrored, lossless RGB PNG |
| `face/` | 224x224 face crops |
| `left_eye/`, `right_eye/` | 112x112 crops of the participant's own left / right eye |
| `annotations.jsonl` | one line per image: sample ID, target label, relative image paths, boxes, timestamps, quality |
| `targets.json` | fixation target coordinates (pixels and normalised) |
| `session_metadata.json` | camera, monitor, protocol and session configuration |
| `quality_report.json` | valid / rejected frames, pauses, incomplete targets |

Sample IDs: `P003_S02_T0041_F07` (participant, session, target, frame).

## Settings

All protocol, preprocessing and quality thresholds are in `eyetrack/config.py`
and are copied into every `session_metadata.json`. Physical monitor size and
viewing distance can be filled in there (`MONITOR_WIDTH_MM`, ...).

## Scope of validation

The integrity report validates image capture (files, labels, timing, splits).
It is not a measure of gaze-model accuracy.
