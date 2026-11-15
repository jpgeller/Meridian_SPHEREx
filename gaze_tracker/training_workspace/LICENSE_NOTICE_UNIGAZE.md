# UniGaze licence notice

This workspace uses the pretrained **UniGaze** models and code by Jiawei Qin, Xucong Zhang and Yusuke Sugano
(The University of Tokyo, TU Delft):

* Code: <https://github.com/ut-vision/UniGaze> (inspected at commit `9c240fbe33f3d6146970a77b7c8fa06a7e60019e`)
* Weights: <https://huggingface.co/UniGaze/UniGaze-models> (`unigaze_b16_joint.safetensors`)
* Paper: Qin, Zhang, Sugano. *UniGaze: Towards Universal Gaze Estimation via Large-scale Pre-Training.* WACV 2026.

The models are released under the **ModelGo Attribution-NonCommercial-ResponsibleAI License, Version 2.0
(MG-NC-RAI-2.0)**: <https://github.com/Xtra-Computing/ModelGo/blob/main/MGL/V2/MG-BY-NC-RAI/LICENSE>.

What this means in practice (not legal advice; read the licence itself):

* **Non-commercial only.** Fine-tuned checkpoints produced by this workspace (`experiments/*/best.pt`,
  `checkpoints/selected/gaze_model.pt`) are *Derivative Materials* and carry the same restriction.
* **Attribution** to the UniGaze authors is required whenever the model or its outputs are shared.
* **Distribution** in the licence includes hosting the model as a web/API service. Read the licence before
  publishing the model, a demo that runs it, or its weights.
* Responsible-AI use restrictions in the licence apply.
* **Before any commercial use** (selling the app, a paid service, a company product) obtain permission from the
  licensors. Retraining the head on top of UniGaze does not remove this restriction.

The 3D face-model coordinates in `src/geometry.py` and the normalisation procedure in `src/geometry.py` /
`src/preprocessing.py` follow UniGaze's `gazelib` (data normalisation by Zhang, Sugano & Bulling, ETRA 2018,
code under CC BY-NC-SA 4.0). Cite that work in any publication using these steps.

Citation:

```
@article{qin2025unigaze,
  title={UniGaze: Towards Universal Gaze Estimation via Large-scale Pre-Training},
  author={Qin, Jiawei and Zhang, Xucong and Sugano, Yusuke},
  journal={IEEE Winter Conference on Applications of Computer Vision (WACV)},
  year={2025}
}
```
