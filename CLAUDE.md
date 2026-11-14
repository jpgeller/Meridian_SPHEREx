# Meridian — SPHEREx sky explorer (NASA Space Apps 2026)

Public web tool: a 3D sky made of real SPHEREx images. Search or fly to a place → zoom in → 2D time-lapse of the
real SPHEREx images of that patch, with band tools and WISE/Gaia context. Built to be fully usable without a mouse
(eye tracking is merged later).

**Build plan: [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md). Work through it in order, one step per session, and tick
the checkboxes.** Product spec (for humans): docs/Meridian_SPHEREx_Project_Spec.pdf (source: docs/build_spec.py).

## Layout
- `web/` — Vite + vanilla JS (ES modules). Aladin Lite from npm `aladin-lite@3.8.2`.
- `api/` — Python 3.11+ FastAPI. astroquery, astropy, reproject, numpy, pillow.
- `docs/` — BUILD_PLAN.md (step-by-step, with notes on what was learned), the spec PDF and its generator `build_spec.py`.
- Outside this repo (in the parent `Test NAsa/` folder, local only): `prototype/index.html` (first single-file proof),
  `aladin-lite-master/` (Aladin source, read only, never build it; use the npm package), `spherex_fetch.py` (one-image download script).

## Run
```
cd api && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt   # first time
cd api && ./.venv/bin/python -m uvicorn main:app --reload --port 8000 --timeout-graceful-shutdown 5
cd web && npm install && npm run dev          # Vite on :5173, proxies /api -> :8000
cd web && npm test                            # unit tests (node:test)
cd web && npm run test:e2e                    # browser smoke tests (Playwright, installed Chrome; API must be running)
cd api && ./.venv/bin/python -m pytest -q     # API tests (offline; use the warmed cache)
cd api && ./.venv/bin/python -m ingest --targets showcase   # warm the cache for the 5 demo targets (~1 h, polite to IRSA)
```
- `--timeout-graceful-shutdown 5`: without it a code reload waits for long requests (spectra) and the API hangs.
- Use `python -m uvicorn`. macOS refused to run the venv's `uvicorn` script when the desktop app's preview launcher started it.
  The preview launcher also hung on servers inside `~/Documents`, so start the servers from a shell instead.
- This folder is the git repo (github.com/jpgeller/Meridian_SPHEREx). Python 3.14 works for every dependency.
- Console noise: `TypeError: Failed to fetch … tg.log` is Aladin's startup usage logger (alasky.unistra.fr). It has no
  off switch and is harmless.

## Rules
- **Every user action is a command** in `web/src/core/commands.js` (`run('zoom_in')`, `run('set_band', {band: 40})`).
  Buttons and keys only call `run(...)`. Never wire a feature only to a mouse handler; eye tracking will send the
  same commands later.
- All view state lives in `web/src/core/state.js` and mirrors to the URL (`?ra&dec&fov&band&proj&view&t&layers`).
  `store.set(patch, source)`: pass a source and ignore your own source in subscribers (avoids loops).
  Console: `meridian.run(...)`, `meridian.store.get()`, `meridian.commands.list()`.
- The backend never sends full 65 MB SPHEREx files. Always use cutouts (`access_url + ?center=RA,DECd&size=DEG`) and cache them in `api/cache/`.
- Show uncertainty and limits honestly. Never claim discoveries.
- Eye tracking is NOT built here: Yassin's team integrates it through the command bridge (`web/src/core/messages.js`).
  Keep every control a real `<button>` running a command, so their gaze layer can find and press it. See docs/EYE_TRACKING.md.

## Verified data facts (Nov 2026). Do not re-derive these.
- SPHEREx HiPS cube: `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube`. 102 frames, PNG tiles,
  files `_k` ascend in wavelength. Frames 0, 50, 51 are blank (404). Aladin's `setSliceNumber` loads the WRONG tile;
  use `layer.setFrequency({value: F_MIN + (k+0.5)/102*(F_MAX-F_MIN), unit:'Hz'})` with F = c/λ, λ from 5.009 µm (F_MIN)
  to 0.743 µm (F_MAX). Wait until `layer.added` is true before setting it. The cube has no time information.
- Views: 3D sphere `'SIN'`; Planetarium `'STG'` (≤160°); whole sky `aladin.setProjection('AIT'); aladin.setFrame('galactic'); setFoV(360)`.
  Aladin can't keep a fixed flat map while panning (it always re-projects around the view centre).
- Colour views: `web/src/sky/colorViews.js`. Mixes are server-built colour HiPS at `/api/hips/mix/R-G-B` (`api/colormix.py`).
  Aladin lowercases colormap names when applying them: register custom colormaps in lowercase.
- The HiPS cube stops at order 5 (12.9″/px) and Aladin draws tiles with NEAREST filtering (hard-coded), so deep zoom looks
  blocky. `web/src/sky/nativeLayer.js` + `/api/skypatch` overlay full-resolution (6.15″) patches below 1.5°. PNG overlays via
  `A.image(url, {imgFormat:'png', wcs})` need CD1_1 < 0 and CD2_2 > 0 (rows top = north).
- Time series: `Irsa.query_sia(pos=(coord, r), collection=['spherex_dr1','spherex_qr3'])` (+ `_deep`). Each row is
  one exposure of one detector (D1–D6). Columns: `access_url`, `t_min` (MJD), `energy_bandpassname` (`SPHEREx-D1`…).
- The wavelength varies ACROSS each image (linear variable filter). Get the target's wavelength from the cutout with
  `WCS(hdr, fobj=hdul, key='W').pixel_to_world(x, y)` → (wavelength, bandwidth). Astropy's SIP warning on these
  headers is expected.
- A 0.1° cutout is about 59×59 px and takes about 1.5 s. Pixels are 6.15″. Extensions: IMAGE (MJy/sr), FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE.
  Subtract ZODI for display. FLAGS also marks pixels with sources, so do not mask every flagged pixel.
- WISE frames: `GET https://moo23y1au0.execute-api.us-west-2.amazonaws.com/default/png-animation?ra&dec&band(1|2)&size(px)&minbright&maxbright&invert&stretch&window&diff_window&unique&...`
  returns JSON `ims` (keys on `https://amnh-citsci-public.s3-us-west-2.amazonaws.com/`) plus `mjds`, CRVAL/CRPIX, and 2.75″/px.
  Unofficial (Backyard Worlds); cache it. Registration verified: the PNG is north-up (row 0 = north) with TAN CD = ±2.75″.
- IRSA's cutout service throttles parallel requests with 503s that clear in seconds: back off and retry; keep 4 browser requests in parallel.
- Gaia DR3 = catalogue only (epoch 2016.0). Use the **ESA archive TAP** (`gea.esac.esa.int/tap-server/tap/sync`,
  `gaiadr3.gaia_source`). NOT astroquery MAST: it only has DR2 (epoch 2015.5) and silently ignores `version=3`.
  Propagate proper motion to each frame's date. Barnard's Star is about 2.8′ from its J2000 position.
- Challenge targets: Barnard's Star, eps Ind B, WISE 0855 (08h55m10.831s −07d14m42.53s), RW Aur, R Dra. Each has 4–19 SPHEREx visits.
- Names: `GET /api/resolve?name=` (Sesame + proper motion to a fixed epoch 2026.0, so cache keys don't drift).
  WISE 0855's resolvable name is `WISEA J085510.74-071442.5`, about 2′ from the challenge's (older) coordinates.
  RA/Dec are kept to 5 decimals everywhere (state, URL, API cache keys).
