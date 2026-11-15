# Dataset schema (as found in `NASA_EyeTracking_Dataset`, inspected 14 Nov 2026)

## Folder layout

```
NASA_EyeTracking_Dataset/
  train/P001..P006/S01..S05/      validation/P007..P008/S01..S05/      test/P009..P010/S01..S05/
  pilot/<id>/<session>/           (ignored by training)
  logs/official_<P>_<S>_events.jsonl     (state changes, used to prove no frame was captured while paused)
  manifests/  reports/            (the capture app's own; the training workspace writes its own copies)
```

Each session folder:

| Item | Content |
|---|---|
| `raw/<sample_id>.png` | original 1280×720 webcam frame, unmirrored, lossless, 3-channel |
| `face/<sample_id>.png` | 224×224 crop: YuNet face box × 1.15, square, resized |
| `left_eye/`, `right_eye/<sample_id>.png` | 112×112 crops around the participant's own left / right eye (side = 0.36 × face width) |
| `annotations.jsonl` | one line per observation (below) |
| `targets.json` | screen size + list of `{target_index, x_px, y_px, x_norm, y_norm}` |
| `session_metadata.json` | camera (backend, requested/actual resolution, fps), monitor (`width_px`, `height_px`; `*_mm` = null), protocol, runs |
| `quality_report.json` | valid/rejected frames, pauses, interrupted trials |

## `annotations.jsonl` fields

| Field | Meaning |
|---|---|
| `sample_id` | `P001_S02_T0041_F07` = participant, session, target index, frame index (unique) |
| `participant_id`, `session_id`, `mode`, `split` | identity; `split` = folder the session was recorded in |
| `target_index`, `frame_index` | trial number in the session; frame 0–9 within the trial |
| `target_x_px`, `target_y_px` | instructed fixation target on the participant monitor (origin top-left, y down) |
| `target_x_norm`, `target_y_norm` | the same divided by screen width/height |
| `screen_width_px`, `screen_height_px` | 2560, 1600 |
| `target_onset_time`, `capture_time` | Unix seconds; capture − onset ≥ 0.8 s by protocol |
| `state_at_capture` | always `CAPTURING` for saved frames |
| `images` | relative paths of the four image files (`raw`, `face`, `left_eye`, `right_eye`) |
| `raw_width`, `raw_height`, `raw_pixel_sha256` | raw frame size and SHA-256 of its pixel bytes |
| `face_box`, `left_eye_box`, `right_eye_box` | `[x, y, w, h]` in raw-frame pixels |
| `left_eye_center`, `right_eye_center` | YuNet eye centres in raw-frame pixels |
| `detector` | `opencv-yunet-2023mar` |
| `quality` | `face_score`, `sharpness` (variance of Laplacian), `brightness` (mean grey) |

## Actual contents (from the annotation files)

| | Participants | Sessions | Observations | Fixation trials | Image files |
|---|---|---|---|---|---|
| train | P001–P006 | 30 | 30,000 | 3,000 | 120,000 |
| validation | P007–P008 | 10 | 10,000 | 1,000 | 40,000 |
| test | P009–P010 | 10 | 10,000 | 1,000 | 40,000 |
| **total** | 10 | 50 | **50,000** | **5,000** | 200,000 |

* 0 duplicate sample IDs; 0 identical raw frames shared between splits; every session complete (100 trials × 10 frames).
* One monitor (2560×1600) and one camera mode (1280×720, DirectShow, 30 fps) throughout.
* Capture latency after target onset: 0.80–3.35 s (6 frames > 3 s, all in P001 S01, which mixes two sittings).
* Target coverage: 5,000 trials at 4,996 distinct positions within 6–94 % of the screen width/height; only
  ~1.2 % of trials lie within 10 % of a corner.

## What is NOT recorded (and why it matters)

| Missing | Consequence |
|---|---|
| Camera intrinsics and lens distortion | head pose and gaze angles can only be approximated |
| Camera position/orientation relative to the monitor | screen targets cannot be converted into true 3D gaze directions |
| Monitor physical size (`width_mm` = null) | no millimetre errors; no angular errors |
| Frames during target transitions (first 0.8 s) | smoothing delay/overshoot cannot be measured from this data |
| Idle / non-target periods | precision, recall, F1 and false-activation rate are undefined on this data |
