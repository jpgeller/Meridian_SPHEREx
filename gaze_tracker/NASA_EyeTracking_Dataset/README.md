# Dataset folder (not included)

The recorded dataset (10 participants, 50,000 labelled webcam frames, 200,000 image files) is **not** in this
repository: the images show participants' faces and were collected for this project only.

* The capture app (`python main.py` in the folder above) writes new recordings here.
* The training notebooks read the dataset from here (`dataset_root: ../NASA_EyeTracking_Dataset` in
  `training_workspace/training_config.yaml`).
* You do **not** need the dataset to run the live demo: the trained model is in `training_workspace/trained_model/`.

Layout written by the capture app: see `CAPTURE_APP.md`, "Where the data is".
