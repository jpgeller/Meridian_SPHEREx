# Gaze tracker: webcam eye tracking for Meridian

Eye-tracking module for Meridian (NASA Space Apps 2026). It lets a person navigate the screen **with their eyes and an
ordinary webcam**, with no special hardware. This folder contains everything we built:

1. **Capture app**: records a labelled gaze dataset (webcam images + the exact screen point being looked at).
2. **Training workspace**: 7 notebooks + code that audit the data, prepare it, and train a gaze model on top of the
   pre-trained **UniGaze** model.
3. **The trained model** (`training_workspace/trained_model/`).
4. **Live navigation demo**: webcam -> gaze model -> personal calibration -> smoothing -> large regions selected by
   looking (dwell).

It runs on its own (Python). It does not change the Meridian web app in `web/` and `api/`.

---

## Results

| | Result |
|---|---|
| Dataset | 10 participants x 5 sessions, 50,000 labelled frames, audit **PASS**, split **by person** (train P001-P006, validation P007-P008, test P009-P010) |
| Pre-trained model | UniGaze-B/16 (Vision Transformer, 86.6 M parameters), kept frozen |
| Our model (Stage A) | UniGaze + a small trained head (199,430 parameters) that predicts the screen point directly |
| Validation error (2 people never seen in training) | **225 px** mean (7.5 % of the 2,560 x 1,600 screen diagonal), median 203 px. Baselines: 300 px (ridge on UniGaze features), 723 px (guessing the centre) |
| Stage B (fine-tuning 4 UniGaze blocks) | 236.5 px: worse, rejected (overfits with only 6 training people) |
| Live, 100-dot personal calibration (2 runs, 1 user) | error on dots **not** used for fitting: 660 -> **145 px** and 583 -> **126 px** |
| Live 20-target test, 6 x 6 grid, before calibration (1 user) | gaze only: 25 % correct; gaze + head steering: **90 %** correct (median 3.2 s per selection) |
| Sealed test set (P009-P010) | not evaluated yet (notebook 06, run once when everything is final) |

The live tests were done by one team member on the training laptop; they are not yet a multi-user study. All numbers
come from files in `training_workspace/results/`. Full write-up with figures:
[training_workspace/reports/NASA_EyeTracking_Model_Development_and_Live_System.pdf](training_workspace/reports/NASA_EyeTracking_Model_Development_and_Live_System.pdf).

## How it works

```
webcam 1280x720 -> YuNet face + 5 landmarks -> UniGaze face normalisation (224x224)
  -> UniGaze-B/16 (frozen) + trained head -> screen point (x, y)
  -> personal calibration (gaze + head pose + face brightness, 100 dots)
  -> median-of-5 + One Euro smoothing + blink hold
  -> sticky regions + 1 s dwell = selection
```

* **Why regions and not a free pointer:** the error (~225 px, ~3 cm on a laptop) is mostly random from one look to
  the next, so the system selects large regions (the region you look at lights up; looking at it for 1 s selects it).
* **Personal calibration (runs first, ~2.5 min):** 100 dots, one at a time. It learns this user's gaze error as a
  function of where the model thinks they look **and** of head turn/tilt/roll, face position, distance and face
  brightness (MediaPipe), then subtracts it live. It is switched on only if it beats "no calibration" on dots it did
  not learn from.
* **Gaze + head steering (key H):** the eyes jump the cursor near the target, small head turns steer it the rest of
  the way.

## Install (Windows, Python 3.12)

You need Python 3.12 (Anaconda/Miniconda or python.org) and Git. A webcam is needed for the live demo and the capture
app. An NVIDIA GPU is recommended; the CPU works but is slow.

```powershell
cd <where you cloned the repo>\Meridian_SPHEREx\gaze_tracker

# 1. a clean environment
conda create -n nasa-gaze python=3.12 -y
conda activate nasa-gaze
#    (or:  python -m venv .venv   then   .venv\Scripts\activate)

# 2. PyTorch. With an NVIDIA GPU, the CUDA build (check https://pytorch.org/get-started/locally/ for your driver):
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu132
#    Without a GPU, skip this line (step 3 installs the CPU build).

# 3. everything else
pip install -r requirements.txt
pip install --no-deps -r requirements-nodeps.txt

# 4. check
python training_workspace\scripts\verify_environment.py
```

`requirements-nodeps.txt` installs the official `unigaze` package without its outdated `timm==0.3.2` pin (the
code runs with timm 1.x, which step 3 installs).

## Run the live navigation demo

```powershell
cd gaze_tracker\training_workspace
python scripts\live_navigation_demo.py --grid 6x6
```

* The first run downloads the UniGaze checkpoint once (~350 MB, from Hugging Face) and checks its SHA-256.
* Sit as you normally would, facing the webcam, with your face evenly lit (no window behind you).
* Calibration starts automatically (100 dots, no breaks), then the grid appears.

| Key | Action |
|---|---|
| T | 20-target accuracy test (result saved to `reports/live_demo/`) |
| H | switch gaze only <-> gaze + head steering |
| K / S | redo calibration / calibration on-off |
| [ ] | less / more smoothing |
| , . | head steering sensitivity |
| R / C | show raw model dot / smoothed cursor |
| M | mouse control (test the interface without a camera) |
| G | change grid size |
| ESC | quit |

Options: `--grid 3x3` (easier), `--no-cal`, `--load-cal reports\live_demo\calibration_<time>.json` (same person and
set-up), `--head` (start with head steering), `--check-head` (15 s head-tracking check), `--mouse`, `--cpu`.

**It is tuned for one set-up:** a 2,560 x 1,600 screen with the webcam above it. On another screen or camera the
calibration absorbs part of the difference, but accuracy will be lower; retraining on data from that set-up is the
proper fix (see below).

## Record your own data (capture app)

```powershell
cd gaze_tracker
python main.py
```

Two windows: the operator dashboard and a full-screen fixation map. SPACE starts / pauses / resumes. Each target is
recorded as 10 frames; data goes to `NASA_EyeTracking_Dataset/` (git-ignored). Details: [CAPTURE_APP.md](CAPTURE_APP.md).

## Train the model

Open the notebooks in `training_workspace/notebooks/` in order (`jupyter lab` from `training_workspace`). Nothing
trains, downloads or opens the camera by itself: every expensive cell is behind a flag that is `False` by default.

| Notebook | What it does |
|---|---|
| 01 Dataset audit | checks every image, label and timing; writes the split manifests |
| 02 Preprocessing | UniGaze face normalisation, builds the cache |
| 03 Baselines and calibration | downloads UniGaze, baselines every model must beat |
| 04 UniGaze fine-tuning | Stage A (frozen backbone + head), Stage B (partial fine-tuning), selection, export |
| 05 Validation analysis | error maps, per-person results, calibration analysis |
| 06 Final test evaluation | the sealed test set, run once, behind a typed confirmation |
| 07 Prediction maps and deployment | maps, speed benchmark, smoothing, integration notes |

Command-line training: `python scripts\train.py --stage a --run`. Tests: `python -m pytest tests` in `gaze_tracker\` (capture app,
52 tests) and `python -m pytest` in `training_workspace\` (training code, 31 tests). Full background:
[training_workspace/README.md](training_workspace/README.md), [environment_setup.md](training_workspace/environment_setup.md),
[dataset_schema.md](training_workspace/dataset_schema.md).

## Folder layout

```
gaze_tracker/
  README.md                  this file
  requirements.txt           all pip packages (one list for everything)
  requirements-nodeps.txt    unigaze (installed with --no-deps)
  main.py, eyetrack/         capture app            CAPTURE_APP.md: its manual
  tests/                     capture app tests
  models/                    YuNet face detector (used by the capture app, training and live demo)
  NASA_EyeTracking_Dataset/  your recordings go here (not in the repository)
  training_workspace/
    notebooks/               01-07, outputs cleared
    src/                     all model, data, training, evaluation and live-inference code
    scripts/                 live_navigation_demo.py, train.py, build_cache.py, run_audit.py, verify_environment.py
    trained_model/           gaze_head_stageA.pt (the trained model) + its model card
    models/                  MediaPipe face landmarker (head tracking)
    results/                 training history, validation evaluation, audit summary, live test and calibration results
    reports/                 model development report (PDF)
    tests/                   training code tests
    training_config.yaml     every setting, paths relative to this folder
```

## Data and privacy

The dataset is **not** published: it shows the participants' faces. The notebooks run on any dataset recorded with
the capture app. The data-collection report (it contains participant face images) is kept out of the repository
for the same reason. The personal calibration files contain only head-pose and brightness statistics, no images.

## Licences and credits

* **UniGaze** (Qin et al., 2025; github.com/ut-vision/UniGaze): pre-trained gaze model. Weights under the
  ModelGo MG-NC-RAI-2.0 licence: **non-commercial use only**; our trained head is a derivative under the same terms.
  See [training_workspace/LICENSE_NOTICE_UNIGAZE.md](training_workspace/LICENSE_NOTICE_UNIGAZE.md).
* **YuNet** face detector (OpenCV Zoo) - `models/face_detection_yunet_2023mar.onnx`.
* **MediaPipe Face Landmarker** (Google, Apache 2.0) - `training_workspace/models/face_landmarker.task`.
* **One Euro filter**: Casiez, Roussel and Vogel, CHI 2012.
