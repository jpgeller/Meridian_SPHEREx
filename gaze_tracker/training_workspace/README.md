# UniGaze fine-tuning and evaluation — NASA Space Apps eye-tracking

> Overview, results and install: [../README.md](../README.md). The trained model is in `trained_model/`;
> the live navigation demo is `scripts/live_navigation_demo.py`.

Training workspace for predicting **where on the screen** a person is looking from an ordinary webcam,
for hands-free navigation of the astronomy map. It reads the existing dataset in
`../NASA_EyeTracking_Dataset` (not included in the repository) without modifying, moving or copying it, and writes everything
into this folder.

**Nothing trains, downloads or opens the camera by itself.** Every expensive cell is behind a flag that is `False`
by default (`RUN_CACHE_BUILD`, `ALLOW_DOWNLOAD`, `RUN_FEATURE_EXTRACTION`, `RUN_STAGE_A`, `RUN_STAGE_B`,
`RUN_VAL_PREDICTION`, `RUN_DATA_CURVE`, `EXPORT`, `RUN_BENCHMARK`, `RUN_LIVE_DEMO`), and the test set needs a typed confirmation.

---

## 1. Quick start

```powershell
cd gaze_tracker\training_workspace
# one-time setup: see environment_setup.md (Python 3.12, PyTorch 2.15 + CUDA 13.2, unigaze --no-deps)
python scripts\verify_environment.py
python -m pytest
jupyter lab
```

Then open the notebooks **in order** (kernel "Python 3 (nasa-gaze)"):

| # | Notebook | Uses GPU? | What you get |
|---|---|---|---|
| 01 | `01_Dataset_Audit` | no | PASS/FAIL decision, `reports/dataset_audit.html`, `exclusion_report.csv`, train/validation/test manifests |
| 02 | `02_Preprocessing` | no (CPU, ~15–40 min, opt-in) | UniGaze-normalised face cache for train + validation |
| 03 | `03_Baseline_and_Calibration` | yes (feature extraction) | checkpoint download (opt-in), verified loading, baselines B1/B2, calibration curves |
| 04 | `04_UniGaze_Finetuning` | **yes** | Stage A (frozen) and Stage B (partial fine-tuning) runs, learning curves, validation evaluation, export |
| 05 | `05_Validation_Analysis` | optional | model comparisons, per-participant results, prediction maps, smoothing/calibration analysis |
| 06 | `06_Final_Test_Evaluation` | yes (prediction only) | **once**: P009, P010 and pooled test results |
| 07 | `07_Prediction_Maps_and_Deployment` | benchmark only | maps, latency benchmark, live-use chain, integration guide |

GPU-intensive cells: 03 §4 (features), 03 §6 (loads features; extracts them if missing), 04 §24 (both training
stages), 04 §27 (validation predictions, opt-in), 05 §2 (data-size curve, light), 06 §4 (test predictions), 07 §3
(benchmark), 07 §5 (live demo, opens the webcam).

Command-line equivalents (useful if Jupyter DataLoader workers misbehave on Windows):

```powershell
python scripts\run_audit.py --decode full
python scripts\build_cache.py --split train
python scripts\build_cache.py --split validation
python scripts\train.py --stage a --run
python scripts\train.py --stage b --run --init-head-from experiments\unigaze_b16_frozen_head_001\best.pt
```

## 2. Folder structure

```
training_workspace/
  README.md  environment_setup.md  dataset_schema.md  LICENSE_NOTICE_UNIGAZE.md
  requirements.txt  training_config.yaml  pytest.ini
  notebooks/   01 ... 07
  scripts/     verify_environment.py  run_audit.py  build_cache.py  train.py
  src/
    config.py         YAML loading, path resolution, split validation
    dataset.py        discovery, manifests, leakage checks, sealed test split, Dataset, balanced sampler
    audit.py          integrity / timing / quality / coverage checks, HTML + JSON reports
    geometry.py       gaze-angle convention, screen coordinates, head pose, UniGaze normalisation maths
    preprocessing.py  YuNet landmarks, face normalisation, colour handling, cache builder, augmentation
    models.py         UniGaze adapter, coordinate head, freezing, parameter groups, feature extraction
    losses.py         screen-coordinate Huber / MSE / Euclidean loss in screen-diagonal units
    trainer.py        Stage A/B loops, schedulers, early stopping, AMP, checkpoints, resume, logging
    baselines.py      ridge baselines with leave-one-participant-out alpha selection
    metrics.py        regression metrics, regions, trial averaging, hierarchical bootstrap
    evaluation.py     prediction tables, evaluation reports, one-time test gate
    calibration.py    per-user k-point calibration (fit/apply/save) and its evaluation protocol
    smoothing.py      EMA, One Euro, Kalman, jitter metric, lost-tracking guard
    interaction.py    precision/recall/F1 for selection (refuses without negative trials) + protocol
    visualization.py  learning curves, error analysis, prediction maps (static + interactive), replay
    infer.py          export + live GazePredictor (same preprocessing as training)
    benchmark.py      synchronised latency / throughput measurement
    pipeline.py       shared high-level steps used by notebooks and scripts
  tests/        synthetic-fixture unit tests (no real images, no weights)
  manifests/ processed_cache/ checkpoints/ experiments/ reports/ figures/ predictions/   (outputs)
```

## 3. What the inspection found (Phase 1–2)

**Dataset** (details in `dataset_schema.md`): 10 participants × 5 sessions × 100 trials × 10 frames =
**50,000 observations = 5,000 independent fixation trials**, 200,000 image files. Train 30,000 / validation 10,000 /
test 10,000, subject-disjoint, no duplicate IDs, no raw frame shared between splits. Notebook 01 re-verifies all of
this on your machine, including decoding the images (I only had the annotation files, not the PNGs).

**UniGaze** (official repo commit `9c240fb`, pip package 0.1.3): `unigaze_b16_joint` = timm ViT-Base/16, 12 blocks,
768-d, **86,569,194 parameters**, input 224×224 RGB with ImageNet mean/std, output `pred_gaze` = (pitch, yaw) in
radians in the *normalised camera* frame, read from the CLS token by `gaze_fc = Linear(768, 2)`. Weights load with
`strict=True` from `UniGaze/UniGaze-models/unigaze_b16_joint.safetensors`. I verified that the official model code
runs unchanged under timm 1.0.31 / PyTorch 2.15 (the README's torch 2.0.1 + timm 0.3.2 cannot run on an RTX 5060).

## 4. Key design decisions and why

### Label strategy: Approach B (direct screen-coordinate regression)
Converting a screen pixel into a physically meaningful 3D gaze direction needs camera intrinsics, the camera's
pose relative to the screen and the screen's size in millimetres. **None of these were recorded**
(`monitor.width_mm` is null; no calibration exists). Inventing them would produce wrong angular labels, so:

* the model regresses **normalised screen (x, y)** directly from the real labels;
* UniGaze's pretrained representation (CLS feature) and its gaze output (pitch, yaw) are **inputs** to the head;
* no angular error is ever reported; errors are in pixels, % of screen diagonal, and millimetres only if you
  enter measured monitor dimensions in `training_config.yaml`.

Approach A becomes possible later if you calibrate the webcam (OpenCV checkerboard), measure the monitor, and
measure the camera's position relative to the screen.

### Preprocessing: UniGaze data normalisation with an approximated camera
UniGaze was trained on geometrically normalised faces; the capture app's crops are not normalised. Notebook 02
re-detects 5 landmarks with the same YuNet model, estimates head pose with solvePnP and warps each face exactly as
UniGaze's own video script does, including its **approximate camera** (focal = 4 × crop width, no distortion). This
approximation is documented and versioned (`preprocessing.version`). Because it is identical for training,
validation, test and the live cursor, it creates no train/deploy mismatch. `input_mode: existing_face_crop` keeps
the original crops available as a comparison experiment.

RGB is preserved; no grayscale, flips, rotations, crop jitter or perspective augmentation. Optional photometric
augmentation (brightness, contrast, noise) is **off by default** and only kept if it improves validation.

### Model and training
* Head: `LayerNorm → Linear(770→256) → GELU → Dropout → Linear(→2)`, linear output (no sigmoid, so edge targets keep
  their gradient), initialised to predict the screen centre.
* **Stage A**: backbone frozen; features computed once, head trained on them (identical maths, ~100× faster).
  AdamW lr 3e-4, wd 0.01, cosine with 1-epoch warm-up, ≤40 epochs, patience 7.
* **Stage B**: last 4 of 12 blocks + final norm unfrozen, head initialised from Stage A; backbone lr 1e-5 with
  layer-wise decay 0.75, head lr 1e-4, wd 0.05, BF16 autocast, batch 32 × 2 accumulation, gradient clipping 1.0,
  ≤25 epochs, patience 6. Frozen blocks stay in eval mode (no stochastic depth on frozen weights).
* Sampler: every epoch draws the same number of trials from each training participant (balanced across sessions)
  and 2 frames per trial, so no participant/session dominates and near-duplicate frames are not over-counted.
* Loss: Huber on residuals scaled to screen-diagonal units (δ = 0.02 ≈ 60 px), so x and y errors are weighted by
  their real pixel size and wrong instructed-fixation labels (blinks, look-aways) have bounded influence.
* **Checkpoint selection**: participant-averaged mean Euclidean pixel error on P007 and P008. Never training loss,
  never test data. The best checkpoint is restored after early stopping.

### Evaluation
* Core metrics in px, normalised units and % diagonal: mean/median Euclidean error, RMSE, P90/P95/max, mean |x| and
  |y| (reported separately from Euclidean), bias, residual SD, R²; within-16/32/64/100/150/200 px; per participant,
  session, screen region; frame-level and trial-level.
* Uncertainty: hierarchical bootstrap (trials averaged, sessions and trials resampled) — conditional on the
  participants evaluated. With two validation and two test people, **no confidence interval here describes
  accuracy for new users**.
* Precision/recall/F1 are **not** computed: the dataset has only positive fixations, so false activations are
  undefined. `src/interaction.py` implements them for a proper selection experiment and contains the collection
  protocol. What is reported instead is the *hit rate* for targets of 40/80/120 px radius.
* Calibration (5/9/16 points) is evaluated per participant with points from S01 and scoring on S02–S05 only, and is
  always reported separately from uncalibrated results.

### Test-set protection
`load_split(cfg, "test")` raises `TestSetSealed`. Notebook 06 needs an exported model, a decision record written
before testing, and a typed confirmation; it issues a one-time token, logs the evaluation in
`reports/test_unsealed.json`, and refuses a second run unless you give an override reason (recorded).

## 5. Running experiments sensibly

Follow the plan at the top of notebook 04: A0 → (A1) → B0 → B1 (adjust blocks/LR based on B0) → B2 (augmentation)
→ stop when two changes in a row fail to improve validation by more than ~2 %. Every run is saved in
`experiments/<name>_<NNN>/` with its config, environment, data-manifest hash, checkpoint hash, history and best
checkpoint, so results are reproducible and comparable. Many small re-tries overfit the two validation people.

**Reading learning curves** (`experiments/<run>/figures/`):

| Pattern | Meaning | Action |
|---|---|---|
| train and validation both high, close, still falling | underfitting | more epochs, slightly higher LR, more unfrozen blocks |
| train keeps falling, validation flat/rising, gap growing | overfitting | earlier best epoch is used automatically; fewer blocks, lower backbone LR, more weight decay, augmentation |
| loss spikes, gradient norm jumps, validation erratic | LR too high | halve LR |
| curves almost flat, tiny gradient norm | LR too low | ×2–3 LR |

**Best checkpoint**: `experiments/<run>/best.pt` of the run with the lowest `best_val_metric` in
`run_info.json` (notebook 04 §25 lists them). Export it with notebook 04 §30 →
`checkpoints/selected/gaze_model.pt`.

## 6. Where to look at results

* Audit: `reports/dataset_audit.html` (double-click opens it in a browser), `reports/exclusion_report.csv`.
* Training: `experiments/<run>/history.csv`, `step_log.csv`, `figures/*.png|svg`.
* Validation maps: `experiments/validation_analysis_<NNN>/figures/map_*.png`,
  `interactive_prediction_map_validation.html` (hover for sample ID, target, prediction, error), `replay.html`.
* Test: `reports/test_evaluation.json`, `predictions/test/test_predictions.csv`,
  `predictions/test/interactive_prediction_map_test.html`, `figures/test/`.
* Prediction tables contain sample ID, participant, session, ground-truth and predicted x/y, residuals, Euclidean
  error, checkpoint identifier and preprocessing version.

## 7. Using the model for the live cursor

```python
from src.infer import GazePredictor
from src.calibration import PersonalCalibration
from src.smoothing import OneEuroFilter, TrackingGuard

predictor = GazePredictor.from_export("checkpoints/selected/gaze_model.pt",
                                      "../models/face_detection_yunet_2023mar.onnx", device="cuda")
calib = PersonalCalibration.load("user_calibration.json")     # 9-point calibration per user
smooth, guard = OneEuroFilter(min_cutoff=1.0, beta=0.01), TrackingGuard(0.25)

r = predictor.predict_frame(frame_bgr, t)                     # same preprocessing as training
xy = calib.apply([[r["x_norm"], r["y_norm"]]])[0] if r["ok"] else None
cursor = guard.update(t, None if xy is None else smooth(t, xy))   # None = no gaze; pause dwell timers
```

Measure the real frame rate with notebook 07 §3 before promising 15–30 predictions/s. On a CPU in my sandbox the
model forward alone took ~160–440 ms; a laptop RTX 5060 should be far faster, but this is unmeasured.

## 8. Scientific limitations

* **Six training people, two validation, two test.** Results describe these people under this setup. Accuracy for
  new users must be established with more participants; personal calibration is likely to matter.
* **Instructed-fixation labels** assume the participant looked at the dot; blinks and look-aways add label noise
  (flagged by the audit heuristic, not removed automatically).
* **One monitor, one camera position, little head movement.** The model is tied to this geometry; a different
  screen, camera placement or seating distance needs re-validation (and probably calibration).
* **No angular or physical-distance accuracy** without camera calibration and monitor measurements.
* **Targets stop ~6 % from the screen edges**; edge/corner accuracy is weakly constrained — keep interactive
  elements away from the outermost margin.
* **Smoothing latency/overshoot and selection precision/recall** cannot be measured from this dataset; protocols
  for collecting the needed data are in `src/smoothing.py` and `src/interaction.py`.
* Measured image-capture validation (notebook 01) is not gaze-model accuracy validation (notebooks 04–06).

## 9. Licence

UniGaze weights and code: ModelGo MG-NC-RAI-2.0 (non-commercial). Fine-tuned models are derivatives under the same
terms. See `LICENSE_NOTICE_UNIGAZE.md` before redistributing, hosting, or any commercial use.

## 10. Verification status of this codebase

Verified in a Linux sandbox (CPU, Python 3.12, torch 2.15.0, timm 1.0.31, unigaze 0.1.3):
* 31 unit tests pass (`python -m pytest`), including a strict-load round trip of the real 86.6 M-parameter
  UniGaze-B/16 architecture.
* All seven notebooks executed end-to-end on a **synthetic** dataset (real face photo composited into frames,
  random UniGaze weights): audit → cache → features → baselines → Stage A → Stage B → evaluation → export → test
  gate → maps; the live inference path reproduced the cached-path prediction exactly.

**Not verified**: anything on your RTX 5060 / Windows (CUDA kernels, BF16, DataLoader workers, speed), the real
pretrained checkpoint download and its numerical outputs, and the audit/cache on your real images. No accuracy has
been measured.
