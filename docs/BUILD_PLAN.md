# Meridian build plan: 3D map, zoom, 2D views

Scope of this plan: the **3D sky**, **search and zoom**, the **2D time-lapse field view**, **band tools**,
**WISE/Gaia context** and **spectra**. The final UI design, the AI guide and eye tracking are merged later. So that
the merge is easy, every step goes through the command bus and the state store (Step 1).

How to use this file:
- Do the steps in order; each one leaves the app working.
- Each step lists its **files**, **what to build** and the **done when** checks. Do not start the next step until every check passes.
- Tick `[x]` when done and add a one-line note under the step if something differed from the plan.
- Facts about the data are in `CLAUDE.md` → "Verified data facts". Trust them; don't re-research.

---

## Step 0 — Repo skeleton  `[x]`
**Files:** `web/{package.json,vite.config.js,index.html,src/main.js}`, `api/{main.py,requirements.txt}`, `.gitignore`

- `npm create vite@latest web -- --template vanilla`, then `npm i aladin-lite@3.8.2`.
- `vite.config.js`: `server.proxy = { '/api': 'http://localhost:8000' }`.
- `api/requirements.txt`: `fastapi uvicorn[standard] astroquery astropy reproject numpy pillow httpx`.
- `api/main.py`: FastAPI app with `GET /api/health → {"ok": true}` and CORS for localhost:5173.
- `.gitignore`: `node_modules`, `api/cache/`, `.venv`, `__pycache__`, `dist`.
- `git init`, first commit.

**Done when:** `npm run dev` shows a page; `curl localhost:5173/api/health` returns `{"ok":true}` through the proxy.

> Done 14 Nov 2026. Vite 8 + aladin-lite 3.8.2 (pinned); FastAPI on Python 3.14. `main.js` is a temporary shell
> that sets band 40 (frame 50, Aladin's default, is blank). Step 2 replaces it. `npm run build` passes.

---

## Step 1 — Core: state, commands, URL  `[x]`
**Files:** `web/src/core/state.js`, `web/src/core/commands.js`, `web/src/core/url.js`, `web/src/core/keys.js`

- `state.js`: one plain object plus `subscribe(fn)` and `set(patch)`:
  `{ view:'sky'|'field', ra, dec, fov, proj:'SIN'|'AIT', band:1..101, mode:'single'|'detector'|'rgb'|'custom',
     rgb:[b,b,b], formula:'', frameIndex, playing, compare:'off'|'side'|'timeline'|'blink', layers:Set }`.
- `commands.js`: `register(name, fn, {label, keys})`, `run(name, args)`, `list()`; every `run` dispatches a
  `CustomEvent('meridian:command')` on `window` (the future eye-tracker and AI guide hook into this).
- Register now as stubs, filled in later: `pan_left/right/up/down, zoom_in, zoom_out, fly_to, set_band, next_band,
  prev_band, set_projection, open_field, close_field, play, pause, step_next, step_prev, set_mode, set_compare, toggle_layer, select_point`.
- `url.js`: state → `history.replaceState` (throttled to 300 ms); URL → state on load.
- `keys.js`: arrows to pan, `+`/`-` to zoom, `[`/`]` for band, Space for play, `,`/`.` to step, `Enter` to open the field, `Esc` to close it, `/` for search.
  Keys only call `run()`.
- Also accept `window.postMessage({type:'command', name, args})` → `run(name, args)` (the eye-tracking contract from the spec).

**Done when:** in the console, `run('set_band',{band:72})` updates the state and the URL; `postMessage({type:'command',name:'zoom_in'})` logs the command.

> Done 14 Nov 2026. As built: `core/{state,commands,defaultCommands,url,keys,messages,coords,bands,index}.js`.
> - State changes carry a `source` ('url' | 'command' | 'keyboard' | 'message' | 'sky'); subscribers ignore their own echoes.
> - `layers` is an array, not a Set (simpler to serialise). There are extra commands `toggle_play`, `set_epochs`
>   and `focus_search` (stub). The key map comes from each command's `keys` metadata.
> - postMessage also supports `{type:'list_commands'}` and replies with `command_result`. Allowed origins: this page and localhost.
> - `fly_to` parses coordinates (decimal, `08h55m10.8s -07d14m42s`, `08 55 10.8 -07 14 42`); names wait for Step 2.
> - main.js still has a TEMPORARY Aladin bridge (state <-> sky, band via setFrequency). Step 2 moves it into `sky/`.
> - `npm test` (node:test, 10 tests) covers bands, state, coords, url and commands.

---

## Step 2 — 3D sky with SPHEREx  `[x]`
**Files:** `web/src/sky/sky.js`, `web/src/sky/spherexCube.js`, `web/src/sky/presets.js`

- Port `prototype/index.html` into modules. `import A from 'aladin-lite'`, then `await A.init`.
- `spherexCube.js`: `bandToFrequency(k)`, `BLANK = {0,50,51}`, `waitForLayer()`, and the wavelength table
  parsed from `${HIPS}/properties` → `data_cube_crval3_arr`.
- Wire the commands: `pan_*` and `zoom_*` (step = fov/8, factor 1.5), `set_band`, `set_projection` ('SIN' → icrs frame; 'AIT' → galactic + fov 360).
- `fly_to(target)`: if `target` parses as coordinates (sexagesimal or degrees), use `gotoRaDec`; otherwise use `aladin.gotoObject`.
  Then set fov = 1°. Presets: the five challenge targets, the Milky Way centre (266.4168, −29.0078), and the Solar
  System (the ecliptic; show `aladin.showCooGrid` in the ecliptic frame if available, otherwise just fly to the ecliptic pole at 270, 66.56).
- Aladin's `positionChanged` and `zoomChanged` events → `state.set` (debounced) so the URL follows.
- Keep the Aladin logo visible (licence).

**Done when:** a cold load of `/?ra=133.795&dec=-7.245&fov=2&band=72` shows WISE 0855 at band 72 (3.97 µm);
the `AIT` view shows the whole sky with the Milky Way horizontal; `[`/`]` skip frames 50/51; the network tab shows tiles `_72` loading with no 404s.

> Done 14 Nov 2026. `sky/{sky,spherexCube,presets}.js` and `ui/controls.js` (temporary panel: search, presets, band slider, view switch).
> - Names resolve through the new **`GET /api/resolve?name=&epoch=`** (`api/resolve.py`): Sesame XML with proper motion, moved
>   to the current epoch (Barnard's Star is about 4.6′ from J2000). astroquery's SIMBAD TAP returned 404, and cds.unistra.fr redirects to
>   a mirror (follow redirects). If the API is down, it falls back to Aladin's gotoObject (J2000).
> - `run()` now supports async commands: it returns `{ok, pending, value: Promise}` and emits `meridian:command` when they settle (with `error`).
> - New commands: `go_preset {id}`. `set_projection` now also sets AIT → galactic frame + 360°, SIN → icrs.
> - Command failures appear in the `#status` aria-live line.
> - Test tool caveat: the browser pane's key action sends `/` and `]` with an empty `e.key`; test those with dispatched KeyboardEvents.

---

## Step 3 — Zoom-in → field-view hand-off  `[x]`
**Files:** `web/src/sky/handoff.js`, `web/src/field/fieldView.js` (empty shell)

- When `fov < 3°`, show an "Open time-lapse here" action (command `open_field`). Don't open it automatically; that's surprising and bad for gaze users.
- `open_field`: `state.view='field'`, keep `ra/dec`, and set the field fov to `clamp(aladin fov, 0.05°, 1°)`. Show a field-of-view slider with steps
  0.05 / 0.1 / 0.25 / 0.5 / 1° and the hint "wider fields load slower".
- The field view is an overlay panel (the sky stays mounted underneath). `close_field` returns to the sky at the same place.
- `?view=field` in the URL opens it directly (needed for embedding).

**Done when:** keyboard only, from load: `/`, type "WISE 0855", Enter, Enter opens the field shell showing RA/Dec/fov, and Esc returns to the sky.

> Done 14 Nov 2026. `sky/handoff.js`, `field/fieldView.js` (panel shell with a `#field-stage` for Steps 6+).
> - New state `ffov` (field size, snapped to 0.05/0.1/0.25/0.5/1°) in the URL. New command `set_field_fov`. In the field view
>   `zoom_in`/`zoom_out` step through field sizes. `open_field` refuses above 3° with a message.
> - Focus moves to the panel title when it opens and back to the page when it closes.
> - Typed names matching a preset label or alias ("wise 0855", "sun", "milky way") use the preset's target.
> - **WISE 0855:** Sesame doesn't know "WISE 0855". The preset uses `WISEA J085510.74-071442.5`, which resolves
>   with proper motion to 133.7578, −7.2420 (2026.9), about 2.2′ from the challenge's coordinates (an older epoch). Use the moved position for SPHEREx queries.

---

## Step 4 — Backend: list frames  `[x]`
**Files:** `api/spherex.py`, `api/cache.py`, `api/main.py`

- `GET /api/frames?ra&dec&fov` → SIA query (`spherex_dr1`, `spherex_qr3`, plus `_deep`), deduplicated by `obs_id` (a frame can be in both DR1 and QR3; prefer DR1).
  Return a list sorted by `t_min`:
  `{id, obs_id, collection, mjd, date_iso, detector (1-6), access_url, visit}`.
  `visit` = group number for exposures less than 5 days apart.
- Cache the JSON for each `(ra, dec rounded to 0.001°, fov)` in `api/cache/frames/` for 24 h (new data arrives weekly).
- The SIA query is slow (several seconds), so run it in a threadpool (`run_in_threadpool`).

**Done when:** `curl '/api/frames?ra=133.7951&dec=-7.2451&fov=0.1'` returns about 258 frames in 4 visits; a second call returns in under 50 ms.

> Done 14 Nov 2026. `api/spherex.py`, `api/cache.py`; `GET /api/frames?ra&dec&fov&refresh`.
> - WISE 0855 at its 2026 position (133.7578, −7.2420): 258 frames, 4 visits (May 2025, Oct–Nov 2025, Dec 2025, Apr–May 2026).
>   1.3 s cold, 1 ms cached. Everything there is DR1 today (QR3 appears for other fields).
> - One row = exposure × detector; id = `{obs_id}_D{n}`. A point usually falls on 2 detectors per exposure. DR1 beats QR3 on duplicates.
> - The response also has `visits[]` (start/end/n_frames/detectors). Each frame is indexed in the cache by id, so `/api/cutout?id=` can find its URL.
> - `api/tests/test_units.py` (pytest, offline): Sesame parsing, proper motion, visit grouping, deduplication.

---

## Step 5 — Backend: aligned cutouts  `[x]`
**Files:** `api/cutouts.py`, `api/main.py`

- `GET /api/cutout?id&ra&dec&fov&fmt=f32|png`:
  1. Download `access_url + f'?center={ra},{dec}d&size={fov}'` with httpx (timeout 60 s, 3 retries) and cache the FITS on disk by (obs_id, ra, dec, fov).
  2. `img = IMAGE − ZODI`. Bad pixels = non-finite values plus the FLAGS bits that mark non-functional or saturated pixels (look the bits up in the FLAGS header,
     `MP_*` keywords; don't mask the source-detection bit).
  3. **Reproject** onto a common north-up TAN grid centred on (ra, dec) at 6.15″/px with size = fov (`reproject.reproject_interp`).
     Then all frames of a field share pixels, which blink and subtract need.
  4. Wavelength at the centre: `WCS(hdr, fobj=hdul, key='W').pixel_to_world(x, y)` → `wavelength_um`, `bandwidth_um`.
  5. `fmt=f32`: response = raw little-endian Float32 array, with headers `X-Width`, `X-Height`, `X-Wavelength`, `X-MJD`, `X-Flags-Pct`.
     `fmt=png`: an asinh stretch (1–99.7 percentile) for quick looks.
- Also `GET /api/field?ra&dec&fov&band=k` → the frames whose centre wavelength is closest to cube band k (± half a channel),
  with their metadata, so the frontend can ask "band 72 over time".
  Compute each frame's centre wavelength once and cache it (it needs that frame's cutout).

**Done when:** for WISE 0855, fov 0.1: each cutout is about 59×59 Float32 with a wavelength header; two frames from different visits are
pixel-aligned (a bright star stays on the same pixel within 0.5 px); a cached cutout returns in under 30 ms.

> Done 14 Nov 2026. `api/cutouts.py`, `api/framemeta.py`. Endpoints: `/api/frames/meta`, `/api/field`, `/api/cutout`.
> - **Per-frame wavelength without downloading images:** two HTTP Range reads per file (IMAGE header at the start, `WCS-WAVE`
>   table at the end; IRSA answers 206). The table is the same for every exposure of a detector, so it's cached per (detector, pipeline vN).
>   258 frames take 5.4 s cold. It matches the cutout's spectral WCS exactly (2.365 µm test).
> - `/api/frames/meta?ra&dec` adds `wavelength_um`, `bandwidth_um`, `band` (nearest cube band), `inside`, `edge_px` to every frame.
>   `/api/field?ra&dec&band` returns the frames that saw that band, in date order. WISE 0855: band 40 → 3 frames (3 visits); band 72 → 2.
>   **Each band has only 2–4 frames per spot**, because each exposure sees a spot at one wavelength per detector. Step 6 should
>   default to "detector" mode (all frames of one detector, about 17 bands) for a fuller time-lapse.
> - `/api/cutout?id&ra&dec&fov&fmt=f32|png&ext=image|variance`: IMAGE−ZODI, broken pixels masked (TRANSIENT, OVERFLOW, SUR_ERROR,
>   NONFUNC, MISSING_DATA, HOT; read from MSKN/MSKM keys), bilinear reprojection onto an odd-sized north-up TAN grid at 6.15″/px.
>   f32 = little-endian, row 0 = south; `X-Meta` JSON has wavelength, mjd, detector, bad_pct, coverage_pct, flags_pct.
>   0.1° → 59×59; 3–9 s cold, about 7 ms cached. A bright star lands within 0.15 px across 3 visits.
> - Thread-safety: the wave-table cache is locked (first version raced on a cold cache).

---

## Step 6 — Field view: time-lapse player  `[x]`
**Files:** `web/src/field/player.js`, `web/src/field/render.js`, `web/src/field/frames.js`

- `frames.js`: fetch `/api/field` for the current band → fetch the Float32 cutouts (6 in parallel) → `{data: Float32Array, w, h, mjd, wavelength}`.
- `render.js`: draw to a `<canvas>` scaled up with `image-rendering: pixelated`. Use **one stretch for all frames**
  (shared percentiles over the stack, asinh), otherwise blinking lies. A colormap option (grey, inferno).
- `player.js`: commands `play`, `pause`, `step_next`, `step_prev`, a speed setting (2–10 fps), and a frame scrubber with dates.
  Label every frame with its date, detector, λ and flag %.
- Order: by date. Option "one per visit" (median of the exposures in a visit at that band) to reduce noise.

**Done when:** Barnard's Star (fov 0.1, a band in D3/D4) plays through 7 visits, and its shift of about 2 px between the first and last visit
is visible when blinking. Keyboard only works: Space, comma, period.

> Done 14 Nov 2026. `field/{frames,render,player}.js` and a band control in the field header.
> - Barnard's Star, band 37 (1.78 µm), 0.1°: 5 frames, Aug 2025 → Aug 2026. The saturated core moves **12.7″ north**
>   (expected 10.3″ north). Space/comma/period work; `.` wraps from the last frame to the first.
> - One stretch shared by all frames (1–99.7 percentile, asinh); colormaps grey/inferno; a dashed ring marks the target;
>   "One per visit" = per-pixel median of the frames in each visit. If a band has no frames here, buttons offer the nearest bands that do.
> - **Saturation:** bright star cores are flagged OVERFLOW/SUR_ERROR/NONLINEAR, often *also* NONFUNC/TRANSIENT, with NaN values.
>   Saturation wins: the API fills them with the field's peak before reprojection and sends them as **+Infinity**
>   (drawn at full brightness, excluded from percentiles and maths). NaN still means no data. `X-Meta.saturated_px` counts them.
> - IRSA's cutout service returned 503 every time for one QR3 file whose full file downloads fine. On 503 the API now falls back
>   to the whole file (about 65 MB, cached) and processes it the same way.
> - The player keeps whatever loaded (`allSettled`) and notes "N images could not be loaded". Error text stays short (details go to the console).
> - Browser caching of cutouts is off (`no-cache`): stale pixels survived a processing change. Frontend URLs carry `&v=2` to skip old entries.
> - Cube bands 0/50/51 are blank in the HiPS, but L2 images exist there: field selection folds them into 1/49/52.

---

## Step 7 — Compare modes: blink, add, subtract  `[x]`
**Files:** `web/src/field/compare.js`

- `blink(a, b)`: alternate two chosen frames at 2 Hz.
- `add(frames)`: mean of the selected frames, ignoring NaNs → deeper image.
- `subtract(a, b)`: `a − b` with a diverging colormap centred on 0, scaled by `sqrt(var_a + var_b)` (show it as a significance map;
  add `VARIANCE` to the cutout response as a second array, or as `&ext=variance`).
- Selection: epoch chips (`t=1,3` in the URL).

**Done when:** WISE 0855 `subtract(first visit, last visit)` shows a positive and a negative blob next to each other; static stars cancel to noise.

> Built 14 Nov 2026 (the WISE 0855 check needs Step 8's detector sum, see the Step 8 note). `field/compare.js`, `field/sequence.js`; player restructured.
> - New state `op` (`none|blink|add|subtract`, URL `op=`), kept separate from `compare` (WISE/Gaia in Step 9). Dates are chosen with
>   epoch chips (`toggle_epoch`, URL `t=`). Keys: `b` blink, `m` add, `d` difference, `t` back to the time-lapse.
> - The difference is **brightness-matched** (k = median ratio of pixels >5σ in both; needed because dates differ in wavelength, k≈1.29
>   on Barnard band 37) and expressed in σ with error = √(σ_bg² + (0.15·brightness)²), so blur differences between exposures
>   don't light up every star. Barnard field: pixels beyond 5σ fell from 12% → 2.5%. Diverging colours: orange = brighter later.
> - Variance maps aren't needed: σ_bg is the robust MAD of the difference.
> - **WISE 0855 check (done with Step 8's detector sum, D6, 0.1°):** detected at **14.8σ** in the Apr 2026 visit (21 frames) at
>   dx≈−0.6 px (predicted −0.73) and at **3.6σ** in May 2025 (3 frames) at dx≈−2 (predicted −2.0), so the motion is seen.
>   The difference shows the pair in the right places but weakly (−2.5σ at the old position, +3.4σ at the new one), limited by the
>   3-frame first visit. Brightness term only counts real sources (>3σ); an earlier version biased colours towards orange.

---

## Step 8 — Band tools  `[x]`
**Files:** `web/src/field/bands.js`, `web/src/ui/ribbon.js`

- **Single band**: `set_band k` (the default).
- **Detector sum**: `set_mode('detector', {d})` → use every frame from detector d at this visit (all its wavelengths), averaged per visit.
- **RGB overlay**: `set_mode('rgb', {r,g,b})` with bands or detectors; normalise each channel separately; render as an RGB canvas.
- **Custom**: `set_mode('custom', {formula})`, e.g. `D6 - D1` or `(b88 + b89) / b40`. Parse with a tiny safe parser
  (tokens: numbers, `b<k>`, `D<d>`, `+ - * / ( )`); never use `eval`.
- Ribbon: 6 coloured detector blocks × 17 ticks; the current band(s) highlighted; it's also a control (each tick is a command target for gaze later).

**Done when:** WISE 0855 in RGB = (D6, D4, D2) clearly looks redder than nearby stars; `/?view=field&mode=rgb&rgb=D6,D4,D2` reproduces it.

> Done 14 Nov 2026. `field/formula.js` (shunting-yard, no eval), `field/sequence.js` modes, `render.drawRGB`, mode controls in the field header.
> - `detector`: all frames of the current band's detector, averaged per visit (WISE 0855 D6: 3/18/3/21 frames).
> - `rgb`: channels are bands or `D1`–`D6` (state `rgb` now accepts both; default D6,D4,D2), averaged per visit, each with its own stretch;
>   a missing channel in a visit is dark and named in the caption. Difference is disabled for colour (meaningless).
> - `custom`: `b1–b101`, `D1–D6`, numbers, `+ − × ÷ ()`; visits missing an input are skipped; errors are shown in plain words.
> - **Saturation fix:** `SUR_ERROR` alone is scattered over long-wavelength detectors (12–16 px per D6 frame), so it's now *bad*, not
>   saturated (saturated = OVERFLOW | NONLINEAR | BLOOM). Sums only call a pixel saturated if most frames say so. Before this,
>   D6 sums were salt-and-pepper. Cache key bumped to v5 (frontend `&v=5`).

---

## Step 9 — WISE and Gaia context  `[x]`
**Files:** `api/context.py`, `web/src/field/context.js`

- `GET /api/context/wise?ra&dec&fov&band=2`: call WiseView's `png-animation` (size in px = fov·3600/2.75), cache the JSON and the PNGs
  locally, and return `[{mjd, date_iso, png_url:'/api/cache/...'}]` plus a WCS. **Check the registration first**: build the WCS
  from its CRVAL/CRPIX/2.75″ and confirm a bright Gaia star lands on its WISE blob (this failed to line up in a quick test, which
  suggests an offset or convention issue). If it can't be fixed quickly, fall back to IRSA unWISE / WISE cutouts.
- `GET /api/context/gaia?ra&dec&fov&mjd`: MAST Gaia DR3 cone (radius = fov·0.75 + |pm|·Δt margin) → propagate with
  `SkyCoord(..., pm_ra_cosdec, pm_dec, obstime=Time(2016.0, format='jyear')).apply_space_motion(Time(mjd, format='mjd'))`.
  Cache the raw cone; propagate on each request.
- Frontend:
  - `set_compare('side')`: SPHEREx | WISE W2 | Gaia circles on SPHEREx, locked to the same centre/fov.
  - `set_compare('timeline')`: one scrubber with WISE 2010–2024 then SPHEREx 2025–26, labelled by mission.
  - `set_compare('blink')`: WISE W2 against SPHEREx ≈ 4.6 µm (D6).
  - Gaia layer: circles (shape, not just colour); sources with no Gaia match are highlighted (amber).

**Done when:** Barnard's Star: the Gaia circle sits on the star in both 2014 WISE and 2026 SPHEREx frames (proper motion applied);
the WISE 0855 timeline scrolls 2010 to 2026.

> Done 14 Nov 2026. `api/context.py`; `/api/context/wise`, `/api/context/wise/frame` (PNG), `/api/context/gaia`; `web/src/field/context.js`.
> - **WiseView registration is correct**: read the PNG north-up (row 0 = north). The earlier "11 px offset" was a flipped-axis mistake.
>   Each epoch is reprojected north-up onto a grid centred on the target at 2.75″/px. Barnard's Star field: 14 epochs, Jun 2010 → Mar 2024.
> - **Gaia must come from the ESA archive (TAP, `gaiadr3.gaia_source`, epoch 2016.0).** astroquery's MAST Gaia catalogue only serves
>   **DR2 (epoch 2015.5)** and silently falls back to it for `version=3`. That half-year cost 5.2″ on Barnard's Star and briefly
>   made SIMBAD look wrong; it wasn't. SIMBAD positions match ESA DR3 to <0.01″ (the resolver stays SIMBAD-only).
> - Compare modes: `side` (SPHEREx | WISE, locked), `timeline` (one scrubber, 19 images for Barnard: 14 WISE + 5 SPHEREx), `blink`
>   (WISE W2 ↔ SPHEREx at 2 Hz). The Gaia layer draws circles (G < 18) moved to each image's date. Check: Barnard's predicted position
>   vs its WISE image = **0.4″ (2014) and 1.6″ (2024)**.
> - IRSA cutout 503s are transient throttling (503, 503, 200). The API now backs off (3/6/12 s) before the full-file fallback
>   (max 2 big downloads at once), and the browser uses 4 parallel requests instead of 6. An earlier burst left about 4 GB in `api/cache/full`.

---

## Step 10 — Spectrum on demand  `[ ]`
**Files:** `api/spectra.py`, `web/src/field/spectrum.js`

- `GET /api/spectrum?ra&dec&visit` (optional visit): for each frame covering the point, do forced photometry in a 2-pixel-radius aperture
  with a local background annulus on the (IMAGE − ZODI) cutout. Error from VARIANCE. Wavelength from the spectral WCS at that pixel.
  Return `{lambda_um[], flux_mJy[], err[], mjd[], flag[]}`. (Optional speed-up: compare with IRSA's Spectrophotometry Tool.)
- `select_point` command (click, Enter on a crosshair, or gaze dwell later) → a plot panel (canvas or a tiny SVG chart):
  points coloured by detector, with error bars; note "bands taken at different times".

**Done when:** the R Dra spectrum shows a smooth stellar shape across 0.75–5 µm; WISE 0855 rises steeply towards 4–5 µm.

> Built 14 Nov 2026 (R Dra check pending the ingest run). `api/spectra.py`, `GET /api/spectrum?ra&dec&ra0&dec0&fov&max_new`, `web/src/field/spectrum.js`.
> - Forced photometry on the aligned field cutouts (r = 2 px, annulus 4–7 px), errors from VARIANCE, wavelength **at the measured
>   point** (header range reads), flags `saturated` (drawn as squares = lower limits) and `partial`. mJy, no aperture correction.
> - Works in **rounds**: the first call uses only cached frames (instant), later calls add `max_new` downloads; the plot fills in.
>   At most 2 frames per band (most recent): R Dra has 2493 frames.
> - `select_point`: key `s` (target) or click on the image (pixel → RA/Dec). SVG plot coloured by detector, data table in `<details>`,
>   plain-language summary.
> - **WISE 0855:** D4 0.27 → D5 0.41 → D6 0.49 mJy, rising to 5 µm. D6 matches WISE W2 (13.9 mag ≈ 0.47 mJy). The short-wavelength
>   light is a **G=16.3 Gaia star 3.3″ away** (blended in the 12″ aperture). The API now returns `blends` (Gaia stars inside the
>   aperture at the measurement date) and the panel warns about them.

---

## Step 11 — Showcase cache + update command  `[~]`
**Files:** `api/ingest.py`

- `python -m ingest --targets showcase` precomputes frames, cutouts (fov 0.1 and 0.25), WISE and Gaia for the 5 targets.
- `python -m ingest --refresh` clears the frame lists older than 7 days (new SPHEREx data). The app never waits on IRSA for the demo targets.

**Done when:** with the network off, all 5 targets open in the field view from the cache.

> Built 14 Nov 2026 (`api/ingest.py`: `--targets showcase|names`, `--refresh`, `--clean-full`); first full run in progress.
> - Cache consistency: state and URL keep RA/Dec to **5 decimals** (the API's cache keys); names resolve at a fixed **epoch 2026.0**
>   (not "now", which moved fast stars' cache keys daily).
> - Frame cap shared by web (`capPerVisitBand`) and ingest (`per_visit_band`): one per band per visit, then **≤4 per detector per
>   visit**, spread across bands. Spectra separately use 2 per band.
> - The API must run with `--timeout-graceful-shutdown 5`: a reload waiting on a long spectrum request hung the server once.
> - **Not finished:** on 14 Nov IRSA's cutout service answered 503 to everything after heavy use (full files still download, at
>   64 MB in 16 s). Ingest now uses 2 workers, **never** falls back to full files, pauses 2 min after 6 straight 503s, and skips
>   (reports) frames that stay busy. Rerun `python -m ingest --targets showcase` when IRSA is responsive: about an hour for all five.
> - `api/cache/full` holds about 4 GB from the earlier fallback burst. `python -m ingest --clean-full` frees it.

---

## Step 12 — Smoke tests  `[x]`
**Files:** `api/tests/test_api.py` (pytest, uses the cache), `web/tests/smoke.spec.js` (Playwright)

- API: frames count > 0, cutout shape, wavelength in [0.74, 5.01] µm, Gaia propagation (Barnard moves about 10.4″/yr).
- Web: load each preset URL, `run()` every registered command once, no console errors, every control reachable with Tab.

**Done when:** `pytest` and `npx playwright test` pass.

> Done 14 Nov 2026. `api/tests/test_api.py` (FastAPI TestClient against the warmed cache; skips when data is missing, never hits
> the network) + `test_units.py`: **14 passed**. `web/tests-e2e/smoke.spec.js` (Playwright using the installed Chrome via
> `channel: 'chrome'`, no browser download; `npm run test:e2e`): presets, every command once, Tab reachability, cached time-lapse.
> **4 passed**, stable over 4 runs. It reports failing URLs (one early run saw 404s while ingest was loading IRSA heavily).

---

## Step 13 — Sharper deep zoom on the 3D sky  `[x]`
**Files:** `api/skypatch.py`, `GET /api/skypatch` + `/api/skypatch/png`, `web/src/sky/nativeLayer.js`

Why: IRSA's all-sky cube is a multi-resolution HEALPix pyramid (the "mesh") that stops at **order 5 = 12.9″/px**.
Past ~3° of zoom Aladin only magnifies those tiles, and its WebGL core draws them with **NEAREST** filtering (hard-coded in
`src/core/.../texture.rs`, so it can't be changed without rebuilding Aladin), which gives the blocky diamonds.
SPHEREx's own pixels are 6.15″, twice as fine.

- Below 1.5° (3D sphere view) the app lays a **full-resolution patch** over the sphere: the median of the 4 most recent frames
  that saw the centre in the current band, on the 6.15″ grid, stretched to an 8-bit PNG (transparent where there's no data),
  placed with `A.image(url, {imgFormat:'png', wcs})` (CD1_1 < 0, CD2_2 > 0 for north-up PNG rows; verified against the tiles).
- **Smoothing** (default on, key `i`): 4× Lanczos upsampling on the server, display only, no new detail. Key `n` turns the layer off.
- The patch centre snaps to a quarter-patch grid so small pans reuse it. Patches are ≤0.5° because the wavelength drifts by
  about 5 bands per degree across a SPHEREx image (at 0.5° the edges are about ±1 band off).
- Limit, said honestly: nothing can show detail finer than 6.15″; that's the telescope.
- Before/after: `docs/img/zoom_before_allsky_tiles.png`, `docs/img/zoom_after_full_resolution.png` (Barnard's Star, 0.3°).
- IRSA's search sometimes returns a transient 502 "proxy error": `spherex._query` now retries 3 times.
- **Whole zoomed view at full quality (15 Nov):** below 1.5° the view is covered by a fixed grid of patches (`web/src/sky/grid.js`:
  0.5° spacing, 0.6° patches so neighbours overlap, ≤9 patches, centre first, 2 at a time). Edges are feathered (6%), and the centre
  patch's brightness scale (`lo`/`hi`, returned by the API) is reused by the rest, so the mosaic is seamless. Barnard's Star at 1.2°:
  9 patches from 28 images, about 50 s cold, instant when cached. Panning reuses cells (fixed grid).
- **Three view types (15 Nov):** `SIN` 3D globe, **`STG` Planetarium** (stereographic: shapes stay the same as they move, like
  standing inside the sky; ≤160°), `AIT` whole sky. All Aladin views already show the sky from the inside (east on the left); the
  globe's look comes from SIN squeezing things towards its edge. A fixed flat Gaia-style map (ESA's EDR3 page is a single
  deep-zoom image) would need a different viewer, because Aladin always re-projects around the view centre; not done, by choice.
- **Opening view:** the 3D globe zoomed out to 180° (was 60° on the Milky Way's centre, which looked like "only the Milky Way").
  The data covers the whole sky (whole-sky view and the north galactic pole checked).

---

## Step 14 — Colour views of the full map  `[x]`
**Files:** `web/src/sky/colorViews.js`, `api/colormix.py`, `/api/hips/mix/{R-G-B}/…`; state `color` + `mix` (URL `color=`, `mix=`).

Infrared has no visible colour; IRSA's cube is one grey picture per band, so switching bands barely changed the map.
- **Grey** (one band as brightness) and **Tinted band** (default): the band drawn in its detector's ribbon colour
  (D1 blue → D6 rose), so moving the slider visibly changes the map.
- **False-colour mixes**, three bands as red/green/blue (longest in red): **Infrared colour** 87/42/22 (4.50/2.00/1.25 µm),
  **Dust glow** 62/46/22 (3.29 µm PAH dust emission in red → orange dust lanes), **Ices** 65/59/52 (3.03 µm water-ice
  absorption in green → purple icy clouds), and **Your mix** (any three bands). The band slider is disabled in mixes.
- Mixes are built **on the server**: each HiPS tile = IRSA's three band tiles stacked as RGB, cached (`api/cache/hipsmix`), served
  as a virtual colour HiPS. Why not three blended layers in the browser: Aladin 3.8.2 shares settings between layers of the same
  survey address, and its additive blending didn't combine them in tests.
- Gotchas: Aladin **lowercases colormap names when applying them** but not when registering (`addColormap`), so use lowercase
  names. IRSA's **1.0 µm tiles have gaps near the Galactic centre** (yellow bars in a mix), so the Infrared preset uses 1.25 µm for blue.
- Full-resolution patches follow the colour view (tinted with the same colormap); they're off in colour mixes (they're single-band).
- Images: `docs/img/colour_views.png`, `docs/img/colour_tinted_bands.png`.

## Step 15 — Motion trail (all dates in one picture)  `[x]`
**Files:** `web/src/field/trail.js` (pure maths, `tests/trail.test.js`), `web/src/field/wiseFrames.js`, op `trail`
in `player.js`; command `toggle_trail` (key `r`, URL `op=trail`). Background: `docs/research/CHANGE_VIDEO.md` (option D).
- Each date is scaled on its own (background → 0, bright → 1, asinh), tinted by when it was taken (blue 2010 → red 2026),
  and summed, normalised by the summed colour so that **anything present on every date is white**. A mover leaves a
  rainbow streak; a variable star a coloured fringe. A gamma lift keeps one-date streaks visible next to static stars.
- SPHEREx visits are medians of their exposures. **Include WISE 2010–2024** (on by default) adds the WiseView W2 epochs:
  the SPHEREx frames are resampled onto WISE's 2.75″ grid (same centre, same patch), giving a ~16-year baseline. Without
  WISE, SPHEREx's ~1 year shows almost no motion for the challenge targets.
- Not available in colour-mix sequences (three channels already use the colours). The legend bar places a colour stop per date.
- Verified: Barnard's Star streaks blue (south) → red (north), its known motion; WISE 0855 leaves a clean streak ending
  at its 2026 position, all field stars white. Images: `docs/img/trail_barnard.png`, `docs/img/trail_wise0855.png`.
- Next (if wanted): the model-based video (option C in the research note).

---

## Optional (final version): sharp tile level for the whole sky  `[ ]`
Goal: full SPHEREx quality (≈6.4″/px) everywhere on the sphere, not only in zoomed patches. Deferred on 15 Nov 2026:
build all other requirements first.

- Idea: add HiPS **order 6** (512×512 tiles, 6.44″/px, 49 152 tiles over the sky), built **on demand** by our API from the Level 2
  images and cached; orders 0–5 keep coming from IRSA. Per tile pixel, use only images that saw that spot at the chosen band's
  wavelength (per-pixel spectral WCS), like IRSA does, so there's no wavelength drift and no 0.5° patch limit.
- Prototype: `api/experiments/tile_prototype.py RA DEC BAND OUT_DIR` (search → header-only wavelength masks → partial cutouts →
  median), with timings for each stage.
- Not measured yet: IRSA's search service was down (502) during both attempts on 15 Nov. Expected from the parts already measured:
  ~10–30 images per tile and band, ~0.5–2 min for the first view of a tile, instant afterwards. Pre-building the whole sky is
  impractical (TBs of source images); pre-build only the demo areas.
- Effort estimate: about half a day plus tuning, replacing `nativeLayer.js` with a custom HiPS endpoint.

---

## Merge later (not in this plan)
- **Eye tracking: handed to Yassin's team (15 Nov 2026).** A first app-side version was built, then removed so this team
  focuses on mapping; it is in git history (commit 89f89ae). What it was: `web/src/input/gazeCore.js` (pure logic: dwell 0.8 s adjustable 0.4–1.5 s,
  24 px snapping, 120 ms smoothing, no double presses, sky-only edge panning, top-right rest zone, low-confidence/lost tracking)
  and `web/src/input/gaze.js` (finds buttons, progress bar, presses them, replies `{type:'targets'}` to the tracker, and a mouse
  simulator via `?gaze=mouse` or `g`). Guide for the tracker author: **docs/EYE_TRACKING.md**. Tests: 9 unit + 5 Playwright
  (real postMessage samples). Fixes found on the way: async command replies tried to post a Promise; the first targets list
  was throttled away on fast page loads. Left: plug in the real tracker and tune the timings with real users.
- **Final UI design:** restyle `web/src/ui/*`. Logic lives in `core/`, `sky/` and `field/`, so the UI layer can be swapped.
- **AI guide:** an LLM with tools that map one-to-one onto `commands.list()`.
