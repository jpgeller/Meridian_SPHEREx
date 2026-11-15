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
- The eye tracker itself is NOT built here: Yassin's team runs it outside the app. The gaze *contract* and the face panel
  do live here: eye tracking is merged through `postMessage` types `gaze` and `face` on the command bridge
  (`web/src/core/messages.js`; docs/UI_AND_GUIDE_PLAN.md, U9). Keep every control a real `<button>` running a command,
  so their gaze layer can find and press it. See docs/EYE_TRACKING.md.
- **Nothing clickable within 6% of the screen edges** (eye tracking is least accurate there): use `--edge-x` / `--edge-y`
  in `web/src/style.css`. Aladin's corner toolbar is off for this (zoom and view type are our buttons). The browser test
  "eye tracking: no control within 6% of the screen edges" checks the sky view and every 2D mode.
- **Every clickable is at least 64 × 64 px** (eye tracking; global rule at the end of `web/src/style.css`, `--hit`). On/off
  options are `role="switch"` buttons and choices are stepping buttons (no checkboxes or drop-downs: they can't be 64 px and
  gaze presses buttons). The 2D view is two columns (image | controls) so it fits without scrolling at ≥1280×800. The test
  "every control is at least 64 x 64 px and reachable" checks the sky view and every 2D mode.
- UI and guide live in `web/src/ui/` and `web/src/guide/` (plan: docs/UI_AND_GUIDE_PLAN.md). They only call `run(...)`
  and read `store`. `ANTHROPIC_API_KEY` stays in `api/.env` (git-ignored; see `api/.env.example`), never in the browser.
- The guide is proactive but cheap: `guide/interest.js` notices patterns, `guide/nudge.js` asks `/api/guide/nudge` (Claude
  Haiku, low effort, cached system block) for one offer with buttons. Budget: one call per 45 s and 15 per visit in the
  browser, `GUIDE_DAILY_MAX` (400) per day on the server; spend at `GET /api/guide/usage`. The 7 places keep local tours
  (`guide/tours.js`, zero tokens). The mouse counts as attention after a 5 s rest (`?gaze=off` turns it off).

## Verified data facts (Nov 2026). Do not re-derive these.
- SPHEREx HiPS cube: `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube`. 102 frames, PNG tiles,
  files `_k` ascend in wavelength. Frames 0, 50, 51 are blank (404). Aladin's `setSliceNumber` loads the WRONG tile;
  use `layer.setFrequency({value: F_MIN + (k+0.5)/102*(F_MAX-F_MIN), unit:'Hz'})` with F = c/λ, λ from 5.009 µm (F_MIN)
  to 0.743 µm (F_MAX). Wait until `layer.added` is true before setting it. The cube has no time information.
- Views: 3D sphere `'SIN'`; Planetarium `'STG'` (≤160°); whole sky `aladin.setProjection('AIT'); aladin.setFrame('galactic'); setFoV(360)`.
  Aladin can't keep a fixed flat map while panning (it always re-projects around the view centre).
- Sky ↔ screen for overlays: `meridian.world2pix / pix2world` (`web/src/sky/skyCoords.js`, also bridge messages). Aladin 3.8.2's
  `world2pix` throws for any frame argument, and in the galactic (whole-sky) view `world2pix`/`getRaDec` treat ICRS numbers as
  galactic l/b (double conversion). `pix2world` without a frame is correct ICRS: the app reads the view centre with it.
- Colour views: `web/src/sky/colorViews.js`. Mixes are server-built colour HiPS at `/api/hips/mix/R-G-B` (`api/colormix.py`).
  Aladin lowercases colormap names when applying them: register custom colormaps in lowercase.
- Aladin's right-drag (trackpad two-finger click + drag) changes the base layer's cuts (PNG default [0, 255]).
  `web/src/sky/levels.js` mirrors it to state `level`. Black blotches near the Galactic centre are masked pixels in IRSA's
  all-sky tiles, not missing SPHEREx data (the full-resolution layer fills them).
- The HiPS cube stops at order 5 (12.9″/px) and Aladin draws tiles with NEAREST filtering (hard-coded), so deep zoom looked
  blocky. `web/src/sky/smoothTiles.js` (imported first in main.js) turns the tile textures' MAG filter to LINEAR through
  WebGL2's `texParameteri`, and snaps the cube shader's band coordinate to its slice centre (else LINEAR blends neighbour
  bands: blacks turned grey). MIN filter left alone (it changed wide-view brightness). It also rewrites the cube's fragment
  shader: zoomed in, a 4×4 cubic B-spline (round soft stars, no pixel grid); star-core holes filled. IRSA's palette PNGs store
  saturated cores as index 0 (transparent) but the darkest sky as index 1 (opaque black), and Aladin's RG8 texture keeps
  only the grey value (both channels = grey, alpha = grey), so a 0 is a hole only if enclosed by a bright rim (`HOLE_RIM`);
  a looser test drew streaks across dark fields. `?smooth=0` turns it all off. `web/src/sky/nativeLayer.js` + `/api/skypatch` overlay full-resolution (6.15″) patches below 1.5°: **switched off**
  (`NATIVE_LAYER_ENABLED = false`) until the whole sky can have that quality, as only the zoomed patch looked different. PNG overlays via
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
  IRSA also has outages (SIA and SCS 502 "Proxy Error", 15 Nov 2026): frame lists, WISE and cube wavelengths fall back to
  their expired cached copy rather than fail.
- Gaia DR3 = catalogue only (epoch 2016.0). Sources in order (`context._gaia_cone`): VizieR `I/355/gaiadr3` at
  `vizier.cfa.harvard.edu` (~1.5 s; identical rows), the CDS VizieR, then the **ESA archive TAP** (`gea.esac.esa.int`),
  which went silent for minutes on 15 Nov 2026. NOT astroquery MAST: it only has DR2 (epoch 2015.5) and silently ignores `version=3`.
  Propagate proper motion to each frame's date. Barnard's Star is about 2.8′ from its J2000 position.
- Challenge targets: Barnard's Star, eps Ind B, WISE 0855 (08h55m10.831s −07d14m42.53s), RW Aur, R Dra. Each has 4–19 SPHEREx visits.
- Moving objects: `/api/context/movers` (Gaia DR3 + CatWISE2020). CatWISE via IRSA SCS
  (`irsa.ipac.caltech.edu/SCS?table=catwise_2020&RA&DEC&SR&format=csv`, pm in arcsec/yr at `meanobsmjd`); IRSA's TAP timed out
  and SCS fails above ~0.1° radius. CatWISE duplicates fast movers and fragments bright glare: fit/merge (see changeModel.js).
  Gaia-propagated positions match the WiseView frames to ~1 px (Barnard's Star, 2014–2024).
- "Not in Gaia" (2D view, key n, `web/src/field/notInGaia.js`): median-stacks the SPHEREx frames, detects sources (5σ, 3×3),
  moves Gaia DR3 to the frames' mean date, measures the SPHEREx↔Gaia shift (<1″ on all 5 targets, scatter ~1.5″) and
  matches within 2.5×scatter + 32″/SNR (3.5–9″); bright sources (≥30σ) also match a bright Gaia star further out (glare).
  WISE 0855 in D6: found at the target (12σ, a G=16.3 star 6.6″ away; a fixed 9″ radius hid it). Candidates only.
- R Dra saturates SPHEREx in every image (no spectrum possible; the panel says so). Ingest must pick frames per mode
  exactly like the player (per detector; single bands 40 and 92): neighbouring detectors share band numbers.
- Names: `GET /api/resolve?name=` (Sesame + proper motion to a fixed epoch 2026.0, so cache keys don't drift).
  WISE 0855's resolvable name is `WISEA J085510.74-071442.5`, about 2′ from the challenge's (older) coordinates.
  RA/Dec are kept to 5 decimals everywhere (state, API cache keys). The URL writes them readably
  (`ra=17h57m47.105s&dec=4d46m05.52s`, exact to those 5 decimals; plain degrees are read too).
