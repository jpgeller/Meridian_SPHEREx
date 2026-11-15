# Meridian UI + AI Guide plan (Steps U0–U10)

Scope: the **final UI**, the **AI Guide** (on-screen pointer, pop-up, highlights), the **face-tracking panel** and the
**gaze input contract**, built on top of the mapping work in `BUILD_PLAN.md` (Steps 0–15, already done).
Nothing here changes how data is fetched or drawn. Everything talks to the app through the **command bus**
(`core/commands.js`) and the **state store** (`core/state.js`), as `CLAUDE.md` requires.

How to use this file (same rules as BUILD_PLAN.md):
- Do the steps in order inside each priority tier. Each step leaves the app working.
- Each step lists **files**, **what to build** and **done when**. Tick `[x]` when done and add a one-line note.
- Facts about data are in `CLAUDE.md` → "Verified data facts". Do not re-research them.

Priorities for the hackathon (Nov 14–15):
- **P0 (the judges must see this):** U0, U2, U3, U4, U5, U6, U7, U8, U9
- **P1 (polish, same day if time allows):** U1, U10
- **Later:** voice, guide history, learning from past use, HiPS order 6

---

## The idea in one paragraph

A person looks at (or points at) something in the sky. If they stay on it, a small offer appears at the top right:
"Want help identifying this?" If they say yes, a pointer flies to the object, circles it, and a short explanation
appears. The same offer appears when they replay the same change several times ("Want to see what changed?") and when they
stay on the colours ("Wondering about these colours?"). The guide can *act*: change band, play the time-lapse, fly
somewhere, turn on the motion trail. It never types for the user, keeps no chat history, and never blocks the sky.
Eye tracking only informs the guide and, in "full gaze" mode, presses buttons (see U9).

## Architecture (what plugs into what)

```
 inputs ──► core/commands.js ◄── buttons, keys, postMessage (eye tracker), guide runner
              │   emits `meridian:command` on window  ◄── attention.js listens (replays, busy)
              ▼
         core/state.js  (view, ra, dec, fov, band, mode, op, t, frameIndex, color, layers…)
              │
   sky/ (Aladin)   field/ (player, trail, spectrum)        NEW: guide/
                                                             registry  → where is "X" on screen?
                                                             attention → what is the person lingering on?
                                                             overlay   → pointer, circle, highlight
                                                             popup     → offer + explanation card
                                                             runner    → run a script step by step
                                                             client    → POST /api/guide (Claude)
   api/ (FastAPI)                                            NEW: api/guide.py
```

Two shared pieces carry everything:
1. **Target registry**: `resolve(id)` returns a screen position/size for anything with a name. The gaze layer uses it to
   find what is being looked at; the guide uses it to know where to point. Same ids on both sides.
2. **Action whitelist = `commands.list()`**. The guide can only do what a button can do. Unknown action → dropped.

## Ownership (avoids merge conflicts)

| Area | Owner | Folders |
| --- | --- | --- |
| Mapping, data, API | Mapping team | `web/src/core, sky, field`, `api/*` (except `guide.py`) |
| UI, guide, face panel | UI/AI team | `web/src/ui/`, `web/src/guide/` (new), `web/src/style.css`, `api/guide.py` (new) |
| Eye tracker, landmarks | Eye-tracking team | external page/process; talks via `postMessage` (U9) |

Small hooks in mapping folders (e.g. exposing `aladin` or a pixel→RA/Dec function) are allowed; keep each one in its own
tiny commit and tell the mapping team.

---

## Step U0 — Repo setup and rules  `[x]`  P0
**Files:** branch `ui-guide`, `CLAUDE.md` (small addition, with the owner's OK), this file.

- Get write access (collaborator) or fork. Work on branch `ui-guide`; open small PRs to `main`; rebase often.
- Add to `CLAUDE.md` (propose as a PR, do not edit silently):
  - "UI and guide live in `web/src/ui/` and `web/src/guide/`. They only call `run(...)` and read `store`."
  - "Eye tracking is merged through `postMessage` types `gaze` and `face` (docs/UI_AND_GUIDE_PLAN.md, U9)."
  - Update the line "Eye tracking is NOT built here": the gaze *contract* and a face panel now live here; the tracker itself does not.
- Add `ANTHROPIC_API_KEY` to the API's environment (never in the repo, never in the browser). `.env` is already
  git-ignored? Check `.gitignore`; add it if not.
- Run the existing checks once so you know the baseline: `npm test`, `npm run test:e2e`, `pytest -q`.

**Done when:** branch exists, baseline tests pass on it, `.env` is ignored, and the mapping team has approved the CLAUDE.md note.

Progress (Nov 14): branch `ui-guide` exists. `.env`/`.env.*` ignored, `api/.env.example` added (uvicorn `--env-file .env`).
CLAUDE.md note approved by the mapping team. Baseline: `npm test` 42/42, `pytest -q` 12 passed / 5 skipped
(cache not warmed), `test:e2e` 11/12. "every preset flies somewhere" fails sometimes: Aladin fetches the cube's default slice `_50`
(blank, 404) before the band is set. It passes on a rerun (a race in `sky/`, reported to the mapping team).
Setup: the system `python3` here is 3.9 (too old). Use `uv venv --python 3.12 .venv && uv pip install -r requirements.txt`.

---

## Step U1 — Shell and visual design  `[x]`  P1
**Files:** `web/src/ui/controls.js` (restyle), `web/src/ui/shell.js` (new), `web/src/style.css`

Today `controls.js` is one temporary panel ("the final UI design is merged later"). Replace its layout, not its logic.

- Layout (desktop only): search/coordinates on top; left column with **face panel** (U8) above the **presets**;
  centre = sky; **bottom dock** = band ribbon (6 detector blocks × 17 ticks, already in `.ribbon`) and, in the field view,
  the time player; top right is reserved for the guide pop-up (U4).
- Keep **every control a real `<button>`/`<input>` that calls `run(...)`**. Do not wire anything only to a mouse handler.
- Keep the coordinate search visible and unchanged (`fly_to` already parses `08h55m10.8s -07d14m42s`).
- Presets: all seven in `sky/presets.js` already exist (including RW Aurigae and R Draconis).
- Gaze-friendly sizes: targets at least 64 px in the dock and presets; visible focus ring; no hover-only controls.
- Keep the Aladin logo visible (licence), and do not put anything in the bottom-right corner.
- Use design tokens (CSS variables) for colour and spacing, so the look can change in one place.
- The time player (`field/player.js`) is an overlay of the field view. Restyle it; do not move its logic.

**Done when:** the app looks like the wireframe, `npm run test:e2e` still passes (Tab reaches every control), and nothing in `core/`, `sky/`, `field/` changed except CSS class names.

Progress (Nov 14): there was no wireframe. Chosen layout: search on top (centred, clear of Aladin's top-left widgets), left = `#face-slot`
(hidden until U8) + presets in a 2-column grid of 64 px buttons, bottom dock = six real detector buttons (`set_band` to the
middle channel, 17 ticks each, current channel marked, wavelength range per detector) + the slider, **right column = "Sky tools"**
(view type, colours, brightness), collapsible through the new command `toggle_tools`. Look: the existing navy + amber, refined;
all tokens on `:root` in `style.css` (`--target: 64px`, `--left-top`, `--tools-top`, `--dock-h`…). Regions in `ui/shell.js`;
`#controls` is still the shell root (e2e waits for it, field view hides it). `data-guide` ids for U2 already set: `search`, `presets`,
`band-ribbon`, `band-d1`…`band-d6`, `colour-views`, `face-panel`. Field view and player: tokens + hover only, no logic moved.
At 1280×800 the tools column scrolls (brightness is below the fold); at 1440×900 everything fits. `test:e2e` 13/13 (new: shell test).

---

## Step U2 — Target registry  `[x]`  P0
**Files:** `web/src/guide/registry.js` (new), `web/tests/registry.test.js`, tiny hooks in `sky/sky.js` and `field/player.js`

`resolve(id) → { x, y, r } | { rect } | null` in viewport pixels, and `targetAt(x, y) → id | null`.

Ids, and where they come from:
- **Controls:** any element with `data-guide="…"`. Add the attribute to: `band-ribbon`, `band-d1`…`band-d6`, `time-player`,
  `colour-views`, `trail-legend`, `presets`, `search`, `face-panel`. Position = `getBoundingClientRect()`.
- **Sky objects (globe view):** the presets and the resolved target. Position = `aladin.world2pix(ra, dec)` (Aladin Lite v3 API;
  confirm the exact name and return order in 3.8.2 first). Return `null` when off screen. `window.aladin` is already exposed in `main.js`.
- **Objects in the field view:** pixel ↔ RA/Dec already exists for `select_point` (click on the image). Reuse it in reverse
  to place the target ring, and for movers use the position at the current frame's date (proper motion; the Gaia layer
  already does this).
- **Colours:** `colour:<band-or-detector>` → the ribbon tick or the legend stop.

Rules: resolve every frame (the sky moves); return `null` instead of throwing; never block the main thread.

**Done when:** unit tests cover DOM ids and the pixel maths; in the console, `guide.resolve('band-d6')` and
`guide.resolve('sky:barnard')` return sensible positions, and `null` when Barnard's Star is off screen.

Progress (Nov 14): `guide/registry.js` (pure, everything injected) + `guide/index.js` (`window.guide = { resolve, targetAt, list }`,
set up in `main.js`). Answers are viewport px: points `{x, y, r}`, elements `{x, y, rect}` (the centre is included so the
pointer can aim at either). Ids: every `data-guide`, `sky:<preset id>`, `sky:target`, `field:target`, `field:mover:<n>`,
`colour:D1…D6`, `colour:<band>` (the ribbon tick), `colour:trail`. Sky positions use `sky.coords.world2pix` (the existing
wrapper; Aladin's own is broken in 3.8.2). Name presets are looked up once through `/api/resolve`; every successful `fly_to`
also teaches the registry (the target is the view centre right after it), so it works with the API down. A sky object
behind a panel counts as off screen (`elementFromPoint`). In the field view `sky:*` resolve onto the image, but `list()` and
`targetAt` name those spots `field:*` (no duplicates on one spot). `targetAt`: a point's circle beats the box under it,
then the smallest box, then the nearest within the pad (the 48 px catch radius of U6). Hooks in `field/player.js`:
`data-guide="time-player"` / `"trail-legend"`, `getGeometry()` (shown frame's centre, ″/px, date) and `getMovers()`.
No hook in `sky/sky.js` was needed. `npm test` 52/52 (10 new), `test:e2e` 15/15 (2 new). The first full e2e run had one
failure in "a cached field opens its time-lapse" that did not come back in 8 more runs (probably the known cold-start race).

---

## Step U3 — Overlay: pointer, circle, highlight  `[x]`  P0
**Files:** `web/src/guide/overlay.js` (new), CSS in `style.css`

- One full-screen `<div id="guide-overlay">` with `pointer-events: none`, above the Aladin canvas, below the pop-up.
  It must never swallow a click or a gaze press.
- API: `pointAt(id, label?)`, `circle(id)`, `trail(idFrom, idTo)`, `highlight(id)`, `clear()`. Each follows `resolve(id)`
  with `requestAnimationFrame` and fades out when the target goes off screen.
- The pointer flies to the target in about 600 ms (ease-out), then idles with a small pulse. Respect `prefers-reduced-motion`
  (jump instead of fly, no pulse).
- Annotations auto-clear when the step ends or the person changes the view.
- A label next to the pointer must not overlap the dwell ring (reposition above/below).

**Done when:** from the console, `guide.pointAt('band-d6','Longest wavelengths')` and `guide.circle('sky:barnard')` work, follow a pan, and clicks pass through them.

Progress (Nov 14): `guide/overlay.js` (pure geometry exported and unit-tested, DOM part below it); `window.guide` gains
`pointAt / circle / highlight / trail / clear` and `guide.overlay` (`setAvoid(fn)` for the U6 dwell ring, `active()`).
Choices made with the team: the pointer is an **amber arrow cursor with a glow** (so nobody takes it for the mouse). It
flies on a slight arc **from the pop-up card** (`[data-guide="guide-popup"]`, U4; until then the top-right corner), then
moves from wherever it is. Sky objects: tip on the rim, pointing up-left. Controls: tip on the top edge pointing down, so
the button text stays readable (bottom edge, pointing up, near the top of the screen). It mirrors near the edges. **Auto-clear =
any successful command whose source is not `guide`** (and not `preset`, the `fly_to` nested in `go_preset`). Dragging or
zooming by hand is not a command, so the marks follow it. The runner (U5) calls `clear()` at step end. **Off screen:** new
`registry.locate(id)` gives `{offscreen, from, dir, bounds}`, and the pointer waits at the edge aimed at the target (circles
and highlights show a chevron). Directions come from `world2pix` when it projects, otherwise from the view's orientation
via `pix2world` (behind the globe). In the field view the edge is the image's. Hidden or covered by a panel → fade.
Layer `z-index: 40` (above the field view; the pop-up should use 50+), `pointer-events: none`, `aria-hidden` (U4 speaks).
Reduced motion: no flight or glide (jump), no pulse. The label tries 8 spots and avoids the target, the arrow and `setAvoid`
shapes. `npm test` 62/62 (10 new), `test:e2e` 18/18 (3 new).

---

## Step U4 — Pop-up card  `[x]`  P0
**Files:** `web/src/guide/popup.js` (new), CSS

One small card at the top right (Siri-like). Two kinds:
- **Offer:** one line + two buttons, e.g. "Want help identifying this?" **Yes / No thanks**. Auto-hides after about 12 s
  if ignored (not in gaze mode, see U9), and does not come back for the same target for 60 s.
- **Step:** the explanation text (max about 40 words), plus 1 to 3 answer buttons ("Got it", "Show me more", "Close").
- No text input, no history, no repeat button, no voice (for now).
- Must not cover the centre of the sky or the thing being explained: if it would, move to another spot (never shrink).
- `role="status"`/`aria-live="polite"`, every button reachable with Tab, Esc dismisses.
- Offers are **local**: no API call until the person says yes.

**Done when:** `guide.offer({ text, onYes })` and `guide.say(step)` render and dismiss correctly, and Tab/Esc work.

Progress (Nov 14): `guide/popup.js` (pure helpers exported and unit-tested, DOM card below them); `window.guide` gains
`offer / say / dismiss` and `guide.popup` (`isOpen()`, `kind()`, `setAutoHide(bool)` for gaze mode, `cooldown` with
`isCooling(key) / remaining / mark / clear`, `element`). **`offer({ text, onYes, onNo?, target?, key? })` returns a promise**:
`'yes' | 'no' | 'timeout' | 'dismissed'` (Esc) `| 'replaced'`, or, without showing anything, `'cooling'` (same key inside 60 s)
or `'busy'` (a card is already open: offers never push a step away). Cool-down key = `target`, else `key`, else the text; it
starts on **every** outcome, Yes included (so a person still looking at the star after the explanation is not asked again).
**`say(step)`**, step = text or `{ say, answers?, target? }`, returns a promise of the answer id: `answers` take ids or labels
(`got_it` "Got it", `more` "Show me more", `close` "Close", or any label → its slug), 1 to 3, default "Got it"; Esc → `'close'`;
a newer `say` resolves the old one with `'replaced'` (the U5 runner just awaits each step). Text cut at 45 words with "…".
Steps never auto-hide; offers hide after 12 s, paused while the mouse or the keyboard focus is on the card. **Shrink rule:**
a step whose full card would touch the sky's centre (a disc of 10% of the short side; in the field view, around
`field:target`) or its `target` (24 px pad) goes to the offer form: one line with an ellipsis (full text in `title` and
in the live region), re-checked every 250 ms. For that check only, the registry looks through the card (a star behind it
is otherwise "covered", as in U2). Place: fixed top right, `z-index: 50`, width `--popup-w` 340 px; in the field view 72 px
down so the "Back to sky" button stays free. The card is the first element in `<body>` (first Tab stop when open); focus is
not stolen when it appears, but an answer given from the keyboard keeps the focus in the card for the next step, and it
returns to where it was when the card closes. Esc is caught in the capture phase, so it closes the card and not the field
view. Words go to a separate always-present `role="status"` live region ("Guide: …"). Answer buttons are 64 px high.
Reduced motion: no slide/fade. No API call anywhere in the card. `npm test` 68/68 (6 new), `test:e2e` 21/21 (3 new).
**Update (Nov 14): the card moves instead of shrinking** (sighted users kept losing the text). Pure `spotRects()` +
`chooseSpot(candidates, avoid, current)`: first clear spot of top right → top left (x 12, y `--left-top`, over the places
column, clear of Aladin's buttons and the search bar) → above the dock right (left of the tools column) → above the dock left;
field view: top right (72 px down) → right / left of the image. Avoids the centre zone, the target (24 px pad) and, at a
quarter weight, the hand-off button; least overlap when nothing is clear. It stays put while its spot is clear (no jitter),
slides 0.25 s (jumps with reduced motion), and `guide.popup.spot()` says where it is; the overlay's label also avoids the card.

---

## Step U5 — Script runner and action tags  `[x]`  P0
**Files:** `web/src/guide/runner.js` (new), `web/src/guide/fallback.js` (new), `web/tests/runner.test.js`

A **script** is a list of steps: `{ say: string, actions: Action[] }`.

| Action | Does | Calls |
| --- | --- | --- |
| `{point:id}` / `{circle:id}` / `{trail:[a,b]}` | overlay | `overlay.*` |
| `{cmd:name, args}` | anything a button can do | `run(name, args, 'guide')` |

Useful commands that already exist: `fly_to`, `set_band`, `set_mode`, `set_color`, `toggle_trail` (the motion trail, ideal for "what changed"),
`toggle_blink`, `toggle_subtract`, `set_epochs`/`toggle_epoch`, `play`, `pause`, `set_compare`, `toggle_layer`, `select_point`, `open_field`/`close_field`.

- **Whitelist:** accept only names present in `commands.list()`; validate args through the same sanitiser the commands use. Drop anything else and log it.
- Runner: `runScript(steps)` shows step 1, runs its actions, waits for an answer button, then the next. "Close" or any manual
  view change by the person ends the script at once.
- **Fixed fallback scripts** for the three triggers (object, change, colours) that need no network. The runner uses them when the API fails, times out, or returns invalid JSON.

**Done when:** a script with a bad command name runs the good steps and skips the bad one; killing the API still plays the fallback scripts.

Progress (Nov 14): `guide/runner.js` (validation exported and unit-tested, runner with everything injected) + `guide/fallback.js`.
`window.guide` gains **`run(steps, { trigger?, target? })`** → promise of `'done' | 'closed'` (Close or Esc) `| 'interrupted'` (the
person ran a command) `| 'stopped'` (`guide.stop()`) `| 'replaced'` (a newer script, or someone else's `guide.say`) `| 'empty'`,
**`fallback(trigger, target?)`** (same promise), `stop()` and `guide.runner` (`isRunning()`). Steps: `{ say, actions?, answers?, target? }`
(or a plain string; `{ steps }` is accepted). Actions: `{point:id, label?}`, `{circle:id}`, `{highlight:id}`, `{trail:[a,b]}`, `{cmd, args?}`.
**Whitelist:** the command must be in `commands.list()` and not a `stub` (so `select_point` is out until it has a real meta), every arg
must be named in that command's own `args` spec, and each value that maps to a state field (`band, mode, rgb, formula, color, mix, proj,
compare, op, t, fov, ra, dec`, `layer`→`layers`, `index`→`t`) must survive `state.js sanitize()`; other args only as short strings,
numbers or booleans. Overlay ids must look like ids. Each drop is logged (`[guide] step 2, action 1 dropped: …`); a step keeps its
text when all its actions are dropped; a step without text is dropped; at most 6 steps × 6 actions. Order per step: clear the marks,
show the card, then run the actions (the pointer flies from the card; an async command such as `fly_to` is awaited, at most 10 s,
before the next action), then wait for the answer. The card gets `target` = the step's first marked id so it shrinks rather than cover
it. **Default answers:** middle steps "Show me more" / "Close", the last step "Got it"; any answer but Close goes on. **End rule** =
the overlay's (`QUIET_SOURCES`, now exported): any successful command whose source is not `guide`/`preset` ends the script at once and
dismisses the card; failed commands do not. Dragging/zooming by hand is not a command, so it does **not** end the script (the marks follow
the sky). Fallbacks (2–3 steps each, no network, say plainly that the guide is offline): **object** circles the target and uses the
preset's `note` when the id is a preset; **change** points at the player and, in the field view, `set_op {op:'trail'}` (idempotent, unlike
`toggle_trail`) + points at the trail legend, then says a streak is a hint, not proof; **colours** points at the ribbon, `set_band 93`
(middle of D6, as the D6 button) + circles `band-d6`, then says the colours are a display choice. `npm test` 75/75 (7 new),
`test:e2e` 23/23 (2 new: a console script with a bad command interrupted by a button press; the fallbacks with `/api/**` aborted).

---

## Step U6 — Attention detector (the triggers)  `[x]`  P0
**Files:** `web/src/guide/attention.js` (new), `web/tests/attention.test.js`

Input: a stream of `{x, y, t, confidence}` samples from the gaze contract (U9), or from the mouse (`?gaze=mouse`, for development and for people without a tracker).

Rules (tune with real users):
- Catch radius 48 px around a target (`targetAt`). A dwell ring appears after 1.2 s and fills to **7 s**. It resets after 0.6 s off target.
- **Quiet** when: a `fly_to` is pending, the person is dragging, the sky is still loading (`sky.ready` false), the field view is loading frames, or a pop-up is already open.
- Triggers:
  1. **Object:** dwell on a sky object or the field target → offer "identify".
  2. **Change:** listen to `meridian:command`. The same two or three frames stepped or played over again (for example `frameIndex` wraps 3 times, or blink/step back and forth) → offer "what changed".
  3. **Colours:** dwell on the band ribbon, a colour view or the trail legend → offer "wondering about these colours?".
- An accepted offer starts U5; "No thanks" silences that trigger for that target for 60 s.
- Pure logic, no DOM, so it can be unit-tested with fake time (like the earlier `gazeCore.js`).

**Done when:** unit tests with fake samples fire each trigger once, never during busy states, and never again inside the cool-down; with `?gaze=mouse`, hovering Barnard's Star for 7 s shows the offer.

Progress (Nov 14): `guide/attention.js`: pure `createAttention({ now, targetAt, isQuiet, isCooling, onTrigger, onRing })` (unit-tested
with fake time) + `startAttention()` DOM wiring below it; `window.guide` gains **`attention`** (`feed({x, y, t, confidence})` for U9,
`lose()`, `configure({ringDelayMs, dwellMs, graceMs, …})`, `snapshot()` → `{dwell, ring, replays, quiet}`, `source`) and
**`startGuide(trigger, target)`**, the one function an accepted offer calls (today the fallback script; U7 swaps in the client).
Dwell: `targetAt` with the 48 px pad; `sky:*`/`field:*` → **object**, `band-ribbon`, `band-d1…6`, `colour-views`, `trail-legend`,
`colour:*` → **colours**, anything else (plain controls, `time-player`) → nothing. Ring after 1.2 s, offer at 7 s, once per dwell;
a glance away under 0.6 s keeps the dwell, longer resets it (a new target's clock runs from when it was first seen). Samples
below 0.5 confidence or older than 0.5 s count as no gaze; the clock is the page's (the sample's `t` is ignored). **Change rule**
(field view only, 3 replays within 30 s): a *wrap* = the frame index drops by itself (play loops, or ▶ past the last frame); a *turn* =
a manual step opposite to the previous one (keys, ▶/◀, slider); *blink* = one replay per 2 s it runs. New patch/band/mode/view
resets the count; the change video and the guide's own commands do not count. **Quiet** = `fly_to`/`go_preset` pending, dragging
(pointer down), `sky.ready` false, field frames loading, pop-up open, a script running, page hidden: the dwell resets (busy time does
not count) and replays are ignored. Cool-down keys are the pop-up's: object → target id, colours → `'colours'` (one key for all
colour controls), change → `'change'`; a cooling key shows no ring. Ring = `#guide-attention` (z 45, `pointer-events: none`), on the
object for sky/field points, at the pointer for controls; `overlay.setAvoid` keeps the pointer's label off it. **Default:** the
change trigger always runs (it needs no gaze, so keyboard users get it); dwell needs a source: the mouse only with `?gaze=mouse`
(read in `main.js` before the URL sync drops it), or gaze samples through `guide.attention.feed`. Two tiny hooks (own commit):
`commands.js` emits `meridian:command-start` when an async command begins, `player.isLoading()`. `npm test` 92/92 (16 new),
`test:e2e` 26/26 (3 new: the real 7 s mouse dwell on Barnard's Star → Yes → script; mouse ignored without the param, gaze feed on
D6 → colours offer, presets → none; back-and-forth stepping → "what changed").

---

## Step U7 — Guide endpoint (Claude)  `[ ]`  P0
**Files:** `api/guide.py` (new), `api/main.py` (one `include_router`), `api/requirements.txt` (`anthropic`), `api/tests/test_guide.py`, `web/src/guide/client.js` (new)

`POST /api/guide` body:
```json
{ "trigger": "object|change|colours",
  "target": { "id": "sky:barnard", "name": "Barnard's Star" },
  "state": { "view":"field", "band":37, "mode":"single", "op":"none", "fov":0.1, "frameIndex":2 },
  "facts": { "…": "real numbers from the API for this target" } }
```
Reply: `{ "steps": [ { "say": "...", "actions": [ ... ] } ] }` (the script format of U5, 2 to 4 steps).

- The server holds the key, calls the Messages API with a **system prompt** that lists the whitelist (from `commands.list()`), the
  output schema, and the rules: short, plain words, no discoveries claimed, state limits honestly (CLAUDE.md rule), say when unsure.
- **Ground it:** put real facts in `facts` (frame count, dates, wavelength, band/detector, Gaia match, `blends` from the spectrum API,
  proper motion) so the model explains from data rather than from memory. Never send gaze coordinates or anything about the person.
- Ask for JSON only and validate it with a schema. Anything invalid → return the fixed fallback script (U5), not an error.
- Timeout about 8 s; cache by `(trigger, target.id, state hash)`; simple per-IP rate limit.
- Choose the model by speed (a small, fast model is enough for 2 to 4 short steps).
- Tests mock the client: valid JSON, invalid JSON, timeout, a command not on the whitelist.

**Done when:** `curl` with a sample body returns a valid script for each trigger; with the key missing or the network off, the same call returns the fallback script; tests pass offline.

---

## Step U8 — Face-tracking panel  `[ ]`  P0
**Files:** `web/src/ui/facePanel.js` (new), `web/tests/face.test.js`

Goal: judges see that the system detects the person's face and eyes.
- Panel above the presets: a 68-point landmark mesh (dlib layout, mouth 48 to 67) drawn on a canvas, plus small readouts: **EAR** (blink if below 0.16),
  **MAR** (mouth open above 0.30), head turn, and a live gaze dot indicator.
- Data in: `postMessage` `{ type:'face', landmarks:[[x,y]×68], ear:[l,r], mar, pose:{yaw,pitch,roll}, confidence }` (U9).
- **Demo mode** (toggle, default when no tracker is connected): a scripted loop of movements (look left/right, blink, open mouth,
  turn head) drawn on the same mesh, clearly labelled "simulated", so the panel is never empty.
- Collapsible (a button), so it does not crowd the sky. A privacy line: "Video stays on this computer."

**Done when:** feeding recorded `face` messages animates the mesh and readouts; with no tracker, demo mode runs and is labelled "simulated".

---

## Step U9 — Eye-tracker contract and input modes  `[ ]`  P0
**Files:** `web/src/core/messages.js` (add two message types), `web/src/input/` (restore from commit `89f89ae` for mode C), `docs/EYE_TRACKING.md` (update)

New `postMessage` types, same origin allow-list as `command`:
- `{ type:'gaze', x, y, t, confidence }`: screen position in viewport pixels, about 30 per second. Meridian sends back `{type:'targets', items:[{id,x,y,w,h}]}`
  (from the registry, throttled) so the tracker can snap to buttons.
- `{ type:'face', … }`: see U8.

Three input modes (a setting, default **A**):
- **A. Mouse/keyboard only.** Guide works from the mouse position (`?gaze=mouse`).
- **B. Gaze-assisted.** Gaze only feeds the guide (U6). It never clicks. Safest for the demo.
- **C. Full gaze control.** Restore `web/src/input/gazeCore.js` and `gaze.js` (dwell-to-press 0.8 s, 24 px snapping, smoothing, rest zone). Pop-up buttons and the dock become dwell-pressable.

Two different dwell times, on purpose: **0.8 s presses a button**, **7 s over the sky or a colour asks the guide**. Over a button, the press rule wins.
Keep the rest zone away from the bottom-right corner (Aladin logo).

**Done when:** the real tracker (or a replay file of samples) drives the dwell ring in mode B; switching to C lets a person open the field view and answer the guide with eyes only; mode A still works with no tracker.

---

## Step U10 — Accessibility and ALS-friendly behaviour  `[ ]`  P1
**Files:** `web/src/ui/*`, `web/src/guide/*`

- Everyone can finish the whole guide flow with **dwell or one switch**: answer buttons at least 64 px, large gaps, no hover-only actions.
- In gaze mode, offers do **not** auto-hide, and no step needs a fast reaction.
- Contrast at least 4.5:1, visible focus, `prefers-reduced-motion`, no information by colour alone (the band ribbon needs labels/ticks).
- Screen-reader text for each guide step (it already goes through `aria-live`).
- Eye control can be switched off (mode A) from a button, at any time.

**Done when:** a keyboard-only and a dwell-only pass through "offer, yes, explanation, got it" both succeed, and axe (or Lighthouse) reports no serious issues on the main screen.

---

## Demo path for the judges (3 minutes)
1. Open the app. Face panel shows the mesh (live or simulated). Say what it detects.
2. Gaze at the globe: the ring fills on Barnard's Star, the offer appears, "Yes". The pointer flies there, circles it, one sentence about its motion.
3. Open the time-lapse (field view), replay the visits: the "what changed" offer appears; the guide turns on the motion trail.
4. Look at the band ribbon: "Wondering about these colours?" The guide circles D6 and explains long wavelengths.
5. Show that a person can decline, and the sky stays untouched.

## Risks and open items
- **Showcase cache (BUILD_PLAN Step 11) is unfinished:** IRSA answered 503 after heavy use. Before the demo run `python -m ingest --targets showcase` (about an hour for five targets) and confirm all five open with the network off.
- **Tracker precision:** a webcam tracker is noisy at the 48 px catch radius. Measure it, then adjust the radius and the 7 s rule. Mode B is the safe fallback.
- **Which epochs exist per target:** a band has 2 to 4 frames per spot; use "detector" mode for fuller time-lapses (BUILD_PLAN Step 5).
- **API key exposure:** the key stays on the server. If the demo is hosted, add the rate limit from U7.
- **Guide accuracy:** the model only gets facts from the API, and must say when it does not know. Never present a result as a discovery.
- **Later (not in this plan):** voice, guide history, learning from past use, HiPS order 6.
