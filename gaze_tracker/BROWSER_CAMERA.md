# Eye tracking on the deployed Meridian (browser camera + your laptop as the engine)

Visitors open the deployed Meridian, allow their camera, and control it with their eyes. Their browser sends
camera frames to **your laptop**, which runs the gaze model (UniGaze + our trained head, MediaPipe head
features, each visitor's own calibration and smoothing) and sends back where they look. Everything is free:
Render's free tier for the website, a Cloudflare quick tunnel for your laptop.

```
visitor's browser  https://<app>.onrender.com/eye.html        (camera permission, calibration, Meridian)
      │  JPEG frames (wss://)                 ▲ gaze points
      ▼                                       │
Cloudflare quick tunnel  https://<random>.trycloudflare.com   (free, no account)
      │
your laptop:  python gaze_tracker/gaze_server.py              (GPU, the model)
```

Nothing in Meridian changes: `/eye.html` wraps the normal page in a full-window frame and talks to it through
the documented `gaze` / `face` messages (docs/EYE_TRACKING.md). `/` still works exactly as before.

## Once, on your laptop

```powershell
conda activate nasa-gaze
cd D:\Meridian_SPHEREx\gaze_tracker
pip install -r requirements-server.txt          # adds the `websockets` package
winget install --id Cloudflare.cloudflared       # the free tunnel (or download cloudflared.exe from Cloudflare)
```

## Every time you demo (two PowerShell windows, keep both open)

Window 1, the engine (put the deployed site's address after `--allow-origin`):

```powershell
conda activate nasa-gaze
cd D:\Meridian_SPHEREx\gaze_tracker
python gaze_server.py --allow-origin https://YOUR-APP.onrender.com
```

Wait for `gaze engine on ws://127.0.0.1:8766/`.

Window 2, the tunnel:

```powershell
cloudflared tunnel --url http://localhost:8766
```

It prints an address like `https://quiet-river-1234.trycloudflare.com` (new each time you start it).

Then share this link (replace both parts):

```
https://YOUR-APP.onrender.com/eye.html?engine=wss://quiet-river-1234.trycloudflare.com
```

The visitor clicks **Allow camera and start**, allows the camera, chooses **Calibrate** (about 4 minutes:
100 dots, then a dot on each button) and then controls Meridian with their eyes. `&mode=assist` in the link
makes gaze only help the AI guide (never presses anything).

## Good to know

* **Keep your laptop awake and online** during the demo (plugged in; Windows sleep off). If it stops, the page
  says "engine unreachable, retrying" and reconnects by itself; the visitor then recalibrates.
* **Visitors at once:** 3 by default (`--max-clients`). More is possible on a fast GPU.
* **Privacy:** frames are decoded in memory, used once and dropped. Nothing is saved (visitors' calibrations are
  not saved either unless you add `--save-cal`). The page tells visitors this before asking for the camera.
* **Accuracy** depends on the visitor's camera, light and screen; the calibration adapts the model to them.
  Measured on the training laptop after calibration: 126-145 px. Other cameras are untested.
* **Browsers:** Chrome or Edge. Full screen is requested automatically; leaving full screen resets the calibration.
* **Test without the website:** run Meridian locally (`cd web && npm run dev`), start the engine, and open
  `http://localhost:5173/eye.html?engine=ws://localhost:8766` (no tunnel needed).
* **Test without the model:** `python gaze_server.py --simulate` sends fake gaze (checks the page and the tunnel).
* A stable address instead of a new random one each time needs a (free) Cloudflare account with your own domain,
  or ngrok's one free static domain: `ngrok http 8766 --url=<your-static-domain>`.

## Files

| File | What it is |
|---|---|
| `gaze_tracker/gaze_server.py` | the engine: one session per browser tab, shared model, origin check, no storage |
| `gaze_tracker/requirements-server.txt` | `websockets` |
| `gaze_tracker/tests/test_gaze_server.py` | sessions, calibration, resize reset, origin checks (no model needed) |
| `web/public/eye.html`, `web/public/eye/` | the camera page around Meridian: consent, camera, engine link, calibration |
