# Trained model: `gaze_head_stageA.pt`

| | |
|---|---|
| What it predicts | the screen point (x, y) a person looks at, from one webcam frame |
| Architecture | UniGaze-B/16 (frozen, public) + this trained head: LayerNorm -> Linear(770->256) -> GELU -> Linear(256->2) |
| Head input | UniGaze's 768-d CLS feature + its 2 gaze angles |
| This file | the head only (199,430 parameters, 0.8 MB) + preprocessing settings + the SHA-256 of the UniGaze checkpoint |
| Backbone | `unigaze_b16_joint.safetensors` from Hugging Face `UniGaze/UniGaze-models` (86.6 M parameters, ~350 MB), downloaded automatically on first use and checked against SHA-256 `2580d707...46ffb8` |
| Training run | `unigaze_b16_frozen_head_001` (Stage A), best epoch 4 of 12, seed 1234 |
| Training data | 6 participants (P001-P006), 30,000 frames |
| Validation (2 unseen participants, 10,000 frames) | mean error **225.2 px** (7.5 % of the screen diagonal), median 202.9 px, 95 % CI 205-245 px; P007 202.3 px, P008 248.0 px |
| Screen / camera it was trained for | 2,560 x 1,600 px screen, built-in webcam 1,280 x 720 above the screen |
| Sealed test set (P009-P010) | not evaluated yet |

The head is shipped instead of the full 350 MB model because the backbone is unchanged public UniGaze
(verified: every backbone tensor of the deployed model equals the public checkpoint, and the rebuilt model gives
bit-identical outputs).

```python
from src.config import load_config
from src.infer import GazePredictor
cfg = load_config("training_config.yaml")
predictor = GazePredictor.from_head("trained_model/gaze_head_stageA.pt", cfg, cfg.paths.yunet_model, device="cuda")
result = predictor.predict_frame(frame_bgr)      # {"ok": True, "x_px": ..., "y_px": ...} or {"ok": False, ...}
```

**Licence:** trained on top of UniGaze, whose weights are under the ModelGo MG-NC-RAI-2.0 licence
(attribution, **non-commercial**, responsible AI). See `../LICENSE_NOTICE_UNIGAZE.md`.
