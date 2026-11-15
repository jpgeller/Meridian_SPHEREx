# Meridian deep-zoom artist's impressions plan (Steps A0–A8)

Scope: at the five challenge targets (Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, R Draconis), the 3D sky lets you
keep zooming past the sharpest the SPHEREx map gets, and **dives into AI-generated artist's impressions** of the object, like the
pictures people know from the web. The deeper you zoom, the more detailed the picture. The 2D view does not change: it always
shows the real SPHEREx images at their own 6.15″/px (`CLAUDE.md` → Rules).

How to use this file (same rules as BUILD_PLAN.md):
- Do the steps in order. Each step leaves the app working. Tick `[x]` when done and add a one-line note.
- Every new action is a command (`run('dive_in')`); every control is a 64 px `<button>` outside the 6% edges.
- Data facts are in `CLAUDE.md`. Facts about the objects for the prompts are checked in A0, not taken from this file.

Priorities: **P0** A0–A6 (the demo). **P1** A7 (real sharper surveys in between), A8 (Milky Way centre, Solar System).

---

## The idea in one paragraph

You fly to Epsilon Indi B and zoom in. The SPHEREx sky stops getting sharper at 1.5°–3°. Today the app says "this is the
sharpest" and offers the 2D view. At a target, zooming in continues instead: the real star point at the centre brightens into a
painted picture of the system (the orange star Epsilon Indi A with, far away, the two brown dwarfs), then the two brown dwarfs
orbiting each other, then the banded, methane-dark face of one of them. Each step is a sharper, more detailed picture. A badge
says, the whole time any of it is on screen, **"Artist's impression (AI-generated), not SPHEREx data"**. One button (or Esc,
or zooming out) brings back the real sky, and Enter still opens the real images in 2D.

## Honesty rules (non-negotiable)

1. An AI image is never shown without the badge. The badge is part of the impression layer, not a separate toggle (test A6).
2. AI images never appear in the 2D view, the spectrum, the change video, the Gaia/WISE comparisons or any data export.
3. Each level has a caption with real facts and a source ("Two brown dwarfs, about 2.4 AU apart, orbit each other every
   ~11 years. Distances not to scale."). Captions say "not to scale" when they are not.
4. Pictures follow the published physics (colours, sizes relative to each other, discs, jets, clouds) as far as an artist's
   impression can; where things are unknown (what a brown dwarf's surface looks like), the caption says it is imagined.
5. **Original pictures only.** "Like they are on the web" means the familiar *kind* of image: space-agency style artist's
   impressions. No existing artwork (NASA, ESA, ESO, NOIRLab, artists') is used as an input image, traced or named in a prompt.
6. The guide (`guide/`) never describes an impression as an observation. Its facts sheet for each target gets a line
   "The close-up pictures are artist's impressions".

## Architecture (what plugs into what)

```
 offline (once per target)                          browser
 ─────────────────────────                          ───────
 api/impressions/facts/<id>.md   (A0, reviewed)     state.dive  0 … N  (URL &dive=1.6)
 api/impressions/prompts.yaml    (A1–A2)                    ▲
 api/tools/impressions.py ──► provider image API         │ commands: dive_in / dive_out / dive_reset
        │  outpaint chain, close-up first (A2)           │ (zoom_in / zoom_out continue into them at a target)
        ▼                                                │
 web/public/impressions/<id>/L1..L4.webp  ─────────► sky/impressions.js (A4): canvas over Aladin,
 web/public/impressions/<id>/manifest.json            cross-fades levels by `dive`, badge + caption,
   (prompt, model, date, seed, captions, sources)     blends the widest level into the real star point
```

Pictures are generated **offline and reviewed by a person** (A3), then served as static files. Nothing is generated live in the
browser: it would be slow, cost per visitor, and could show an unreviewed or wrong picture.

## The zoom ladder (per target)

| `dive` | What is on screen | Source | Readout "Field" shows |
|---|---|---|---|
| 0 | SPHEREx 3D sky, down to `skyMinFov` (1.5°–3°) | real data | the field size |
| 0–1 | Real star point at the centre fades into L1 through a soft round mask | real → AI | "Artist's impression" |
| 1 | **L1 system**: the object and its companions/disc/shell in a starfield | AI | "Artist's impression · not to scale" |
| 2 | **L2 object**: the star or pair, filling a third of the screen | AI | same |
| 3 | **L3 close-up**: surface, clouds, disc edge, jet base | AI | same |
| 4 | **L4 detail** (optional per target): one feature up close | AI | same |

Between whole levels the next picture is the **centre of the previous one, 4× closer**, cross-faded while both are scaled
continuously, so zooming feels smooth and every step adds detail rather than blur. That only works if each wider level contains
the closer one exactly at its centre, which is why A2 generates the chain **from the close-up outwards by outpainting**
(the "infinite zoom" technique): L3 first, then shrink it to the central quarter of a blank 2048² canvas and let the model paint
the surroundings to make L2, and so on. The centre is never repainted, so it lines up perfectly.

`dive` is its own state key, not a tiny `fov`: the sky's field size stays honest (Aladin stays at `skyMinFov`), and the readout
does not claim an arcsecond scale for a painting.

## Per-target picture brief (to be fact-checked in A0)

Each line is what the levels should show. **Numbers here are working notes; A0 replaces them with checked values and sources.**

- **Barnard's Star**: L1 a small, dim red dwarf among stars, with the thin orbits of its small planets close in (four
  sub-Earth-mass planets were reported in 2024–25); L2 the red dwarf with a planet in the foreground; L3 the star's surface,
  starspots, a small flare (it is old and quiet but does flare). Caption: the fastest-moving star on our sky.
- **Epsilon Indi B**: L1 the orange K-dwarf Epsilon Indi A with, far off, the brown-dwarf pair (they are ~1,500 AU apart: say
  not to scale); L2 the two brown dwarfs, Ba (T1, warmer) and Bb (T6, cooler), orbiting each other; L3 one brown dwarf's banded,
  cloudy face, deep red-magenta (methane absorbs in the visible). Optionally mention the giant planet Epsilon Indi Ab imaged by
  JWST (2024) at L1.
- **WISE 0855**: L1 a lone, almost black world against the stars (no companion); L2 the brown dwarf glowing faintly in the
  infrared, rendered as a dim dark-red sphere; L3 its atmosphere with high water-ice clouds (JWST found water vapour, methane and
  other molecules; ice clouds are expected, not imaged). Caption: the coldest known brown dwarf, about as cold as the North
  Pole, ~7.4 light-years away.
- **RW Aurigae**: L1 the young binary in a dusty nebula; L2 star A with its disc, the long tidal arm pulled out by a past
  close pass of star B, and a bipolar jet; L3 the dusty inner disc partly in front of the star (the dimming events since
  2010 are blamed on dust crossing our line of sight). Caption: a young (T Tauri) star system, a few million years old.
- **R Draconis**: L1 a red giant inside a faint dusty shell it has shed; L2 the swollen, mottled red giant (huge convection
  cells); L3 its surface with dust forming above it. Caption: a Mira variable whose brightness swings by about 6 magnitudes over
  ~245 days. Note it saturates SPHEREx in every image (the 2D view already says so).

---

## Step A0 — Facts sheets, checked  `[ ]`
**Files:** `api/impressions/facts/{barnard,eps_ind_b,wise_0855,rw_aur,r_dra}.md`
**Build:** one page per target: spectral type, temperature, mass/radius (relative is enough), distance, companions/planets and
separations, disc/jet/shell, colour in visible light, what is unknown. Each line has a source (SIMBAD entry, NASA Exoplanet
Archive, or the discovery paper). These sheets feed the prompts (A2), captions (A4) and the guide (A5).
**Done when:** every fact used in a caption has a source; a team member has read each sheet.
- 15 Nov 2026: `eps_ind_b.md` written (for the A1 bake-off); 4 values still marked **Check**. Other four targets to do.

## Step A1 — Choose the image model (bake-off)  `[ ]` — needs a decision and an API key
**Files:** `api/tools/impressions_bakeoff.py`, `api/.env` (key, git-ignored, never in the browser), `docs/research/AI_IMAGES.md`
**Build:** one Epsilon Indi B close-up and one outpaint step on 2–3 candidate image APIs (for example Google's Gemini/Imagen
image models, OpenAI's image API, Black Forest Labs' FLUX; check the current model ids and terms on the day). Score: realism in
the space-art style, following the physics in the prompt, outpainting that leaves the centre untouched, commercial/public-use
terms, cost per image. Claude (our current API) does not generate images, so this is a second provider.
**Done when:** one provider chosen and written down with the reasons and the price; the key is in `api/.env`.
- 15 Nov 2026: `api/tools/impressions_bakeoff.py` built (Gemini `gemini-nano-banana-2.1`, OpenAI `gpt-image-2`, BFL
  `flux-3-image` + `flux-tools/outpainting-v1`; model ids from each provider's docs that day, overridable in `.env`).
  `--dry-run` and 8 offline tests pass. FLUX 3 searches the web for reference pictures by default: the script sends
  `grounding: false`. **Waiting for the three API keys** to run it (`--check` first, then `--n 2`, ~12 images).

## Step A2 — Generation script: outpaint chains  `[ ]`
**Files:** `api/tools/impressions.py`, `api/impressions/prompts.yaml`, `api/tests/test_impressions.py`
**Build:** for each target: generate L3 (or L4) from its prompt, 4 candidates; for each wider level shrink the chosen picture
to the central 1/4 of a 2048² canvas and outpaint the rest with that level's prompt, 4 candidates each. Write
`web/public/impressions/<id>/L{n}.webp` (2048², ~300 KB) and `manifest.json` (per level: file, prompt, model id, date, seed,
caption, sources, `"ai_generated": true`). Polite: one request at a time, cached by prompt hash, `--target` and `--level` flags
to redo one picture. A check compares the centre quarter of each level with the next level shrunk (must match closely).
**Done when:** all five targets have L1–L3; the centre check passes; a full run costs what A1 estimated.

## Step A3 — Review page  `[ ]`
**Files:** `web/review-impressions.html` (dev only, not linked from the app)
**Build:** every level of every target side by side with its caption, facts sheet and prompt; a "regenerate" note per picture.
A person checks: physics plausible, no text or logos painted in, no likeness of a known artwork, no artifacts at the seams.
**Done when:** every picture is approved and its approval is recorded in `manifest.json` (`"reviewed_by"`, date).

## Step A4 — Dive layer in the sky  `[ ]`
**Files:** `web/src/core/state.js` (`dive`, URL `&dive=`), `web/src/core/commands.js` (`dive_in`, `dive_out`, `dive_reset`),
`web/src/sky/impressions.js`, `web/src/sky/sky.js`, `web/src/ui/readout.js`, `web/src/style.css`, `web/tests/impressions.test.js`
**Build:**
- A target is "diveable" when the view centre is within ~0.2° of a target with a manifest and `fov` is at `skyMinFov`.
  There, `zoom_in` runs `dive_in` (+0.5 level per press; wheel and pinch the same) instead of showing "the sharpest" note;
  `zoom_out` at `dive > 0` runs `dive_out`. Panning away or flying elsewhere resets `dive` to 0.
- A canvas over Aladin, centred on the target's screen position (`meridian.world2pix`), draws the two levels around `dive`,
  scaled continuously by 4^(dive − level) and cross-faded; from `dive` 0 to 1 the widest picture grows out of the real star point
  through a soft round mask. Pictures load only when the view is near a target (prefetch L1 at `skyMinFov`).
- Badge "Artist's impression (AI-generated), not SPHEREx data" + the level's caption, bottom centre, ≥64 px buttons:
  "Back to the real sky" (`dive_reset`) and "Real images (2D)" (`show_timelapse`). Esc = `dive_reset`.
- The "Field" readout shows "Artist's impression · not to scale" while `dive > 0`.
- Respects `prefers-reduced-motion` (steps instead of a continuous fade). `?impressions=0` turns the whole feature off.
- Pure functions (which levels and weights for a `dive`, diveable or not) are unit-tested.
**Done when:** at each target, zoom in from 3° to L3 and back with the keyboard alone, with the gaze commands, and with the mouse
wheel; the badge is visible at every `dive > 0`; panning away removes everything.

## Step A5 — Guide and places  `[ ]`
**Files:** `web/src/guide/tours.js`, guide facts (`api/guide.py` system block), `web/src/sky/presets.js`
**Build:** each target's local tour gets a last step "Zoom in to see an artist's impression" that runs `dive_in` and explains
that it is imagined from what is known. The guide's whitelist gets the three new commands; its facts get the honesty line.
**Done when:** the five tours end in the dive and say "artist's impression" aloud in the text.

## Step A6 — Tests  `[ ]`
**Files:** `web/tests-e2e/impressions.spec.js`, `web/tests-e2e/smoke.spec.js`
**Build:** for each target: dive to L3 with `run('dive_in')`; the badge is visible whenever the impression canvas has opacity
> 0 (checked at several `dive` values); opening the 2D view shows no impression and passes the 6.15″/px check; the 64 px and
6% edge tests include the dive controls; every new command is in "every registered command runs once"; away from a target,
`zoom_in` at `skyMinFov` still shows "the sharpest" note.
**Done when:** `npm test` and `npm run test:e2e` pass.

## Step A7 (P1) — Real sharper surveys before the paintings  `[ ]`
Between SPHEREx's limit and the first painting, show **real** sharper sky at the target: CDS HiPS such as 2MASS (~1″/px) or
unWISE (2.75″/px), and Pan-STARRS or DSS where the declination allows (Epsilon Indi is at −57°). Labelled with the survey name
and "not SPHEREx". This makes "the more you zoom, the more detail" true with real data first, before the art.

## Step A8 (later) — Milky Way centre and Solar System  `[ ]`
The other two places are not single objects. Possible impressions: Sgr A* and the stars orbiting it; the planets along the
ecliptic. Same pipeline, after A0–A6 work for the five targets.

---

## Cost and time (estimate)
- Images: 5 targets × 3–4 levels × ~4 candidates ≈ 60–80 generations plus redos; a few dollars to a few tens of dollars depending
  on the provider (A1 writes the real number).
- Effort: A0 2–3 h, A1 2 h, A2 3–4 h, A3 1–2 h of review, A4 4–6 h, A5 1 h, A6 2 h.

## Open decisions (for the team)
1. **Image provider and its API key** (A1).
2. Whether real surveys (A7) come before the paintings in the demo, or later.
3. How deep: L3 for all, L4 only where there is a clear feature (RW Aur's jet base, WISE 0855's clouds)?
