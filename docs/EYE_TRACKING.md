# Eye tracking: hand-off to Yassin's team

The Meridian mapping team does not build eye tracking. This note covers what the app provides for
it: the command bridge, the `face` and `gaze` messages, the `targets` reply and the three input modes.

## What Meridian provides: the command bridge

Every action in the app is a named command: `zoom_in`, `pan_left`, `fly_to`, `set_band`,
`open_field`, `play`, `toggle_blink`, `select_point`, and more. Any program can run them with
`window.postMessage` to the Meridian page (`web/src/core/messages.js`):

```js
meridianWindow.postMessage({ type: 'command', name: 'zoom_in' }, 'http://localhost:5173');
meridianWindow.postMessage({ type: 'command', name: 'fly_to', args: { target: 'WISE 0855' } }, origin);
meridianWindow.postMessage({ type: 'list_commands' }, origin); // replies { type: 'commands', items: [...] }
```

- Each command replies `{ type: 'command_result', name, ok, error? }`. For `fly_to` the reply comes
  when the flight is done.
- `list_commands` returns every command with its label, keyboard keys and arguments. A gaze UI can
  build its menus from it.
- Accepted senders: the page itself and `localhost` / `127.0.0.1` on any port. Others can be added
  in `startCore({ allowedOrigins })` in `web/src/main.js`.
- In the page's console: `meridian.run(name, args)`, `meridian.commands.list()`, `meridian.store.get()`.

### Sky positions for overlays

An overlay that draws on the sky (labels, gaze targets, an AI guide pointing at a star) needs sky ↔ screen
positions. Use these, not `aladin.world2pix` directly (see why below):

```js
// in the page
meridian.world2pix(83.822, -5.391); // -> { x, y, pageX, pageY, inView } or null (not on screen / far side of the globe)
meridian.pix2world(640, 360);       // -> { ra, dec } or null
// from another window or frame, through the bridge (id is echoed back)
meridianWindow.postMessage({ type: 'world2pix', id: 1, points: [{ ra: 83.822, dec: -5.391 }] }, origin);
//   -> { type: 'world2pix_result', id: 1, points: [{ x, y, pageX, pageY, inView } | null] }
meridianWindow.postMessage({ type: 'pix2world', id: 2, points: [{ x: 640, y: 360 }] }, origin);
meridianWindow.postMessage({ type: 'get_state', id: 3 }, origin); // -> { type: 'state', id: 3, state: { ra, dec, fov, proj, view, ... } }
```

- RA/Dec are ICRS degrees in every view. `x, y` are pixels inside the sky (`#sky`, top-left origin);
  `pageX, pageY` are page coordinates for `position: fixed` elements.
- Positions change when the view moves: recompute on `meridian.store.subscribe(...)` (in the page), or
  poll `get_state` and recompute when `ra/dec/fov/proj` change (from outside).
- Why not `aladin.world2pix`: in Aladin 3.8.2 it throws for any frame argument, and without one it is
  wrong in the whole-sky (galactic) view. `meridian.world2pix` works around both and checks every answer.

Every on-screen control is a real `<button>` that only calls a command. So a gaze layer can either
send commands directly, or find buttons on screen and press them.

## Face landmarks: the `face` message (face panel, UI plan U8)

The face panel (top of the left column) shows what the tracker sees: a 68-point mesh, blink and
mouth readouts, head turn and a gaze dot. Send it one message per camera frame (15-30 per second is
plenty), same origins as `command`:

```js
meridianWindow.postMessage({
  type: 'face',
  landmarks: [[x, y], /* ... 68 points, dlib order */],
  ear: [0.31, 0.29],                    // optional: eye aspect ratio, points 36-41 then 42-47
  mar: 0.04,                            // optional: mouth aspect ratio (inner lips 60-67)
  pose: { yaw: -12, pitch: 4, roll: 2 },// optional: degrees
  confidence: 0.93,                     // optional: 0..1, default 1
}, 'http://localhost:5173');
```

- **Landmarks:** exactly 68 points in the dlib layout (jaw 0-16, brows 17-26, nose 27-35, eyes
  36-47, mouth 48-67), as `[x, y]` pairs or `{x, y}` objects, y pointing down. Any unit works:
  camera-frame pixels, or 0..1. The panel only draws the face's shape: it fits the mesh's bounding
  box into its canvas, so where the face sits in the camera frame does not matter. Send the points
  as the camera sees them (do not mirror them for us).
- **Optional fields** are computed from the landmarks when missing or not numbers:
  EAR = (|p2-p6| + |p3-p5|) / (2|p1-p4|) per eye; MAR = (|61-67| + |62-66| + |63-65|) / (2|60-64|);
  pose = a rough estimate from the eye line and the nose tip (within about 10 degrees). Send your own
  if you have better ones. Signs: yaw > 0 = nose towards the image's right, pitch > 0 = nose down,
  roll > 0 = clockwise on screen.
- **Thresholds shown:** blink when both EAR < 0.16 (one eye = wink), mouth open when MAR > 0.30.
  Confidence below 0.5 draws the mesh faded with "low confidence".
- A message with the wrong shape is ignored (one console warning per 100). There is no reply.
- **Live / Simulated:** the panel is "Live" while valid messages keep arriving. After 2 s without
  one it plays a scripted face (look left/right, blink, open mouth, turn head), labelled
  "Simulated". The "Demo" button (command `toggle_face_demo`) forces the simulated face.
- **Gaze dot:** fed by the gaze contract (U9) through `meridian.face.setGaze({ x, y, confidence })`,
  viewport pixels. "no gaze" when there is none, it is older than 0.5 s, or confidence < 0.5.
- In the page itself the bridge re-sends each `face` message as the window event `meridian:face`.

Testing without a tracker, in the browser console:

```js
const s = await (await fetch('/tests-e2e/fixtures/face-sample.json')).json(); // dev server only
meridian.face.replay(s.frames, { fps: 15, loop: true }); // posts through the real bridge
meridian.face.stopReplay();
meridian.face.snapshot(); // { mode, ear, mar, pose, flags, gaze, ... }
```

`web/tests-e2e/fixtures/make-face-sample.mjs` regenerates that file.

## Gaze: the `gaze` message, the `targets` reply and the input modes (UI plan U9)

Send the gaze point about 30 times a second, from an allowed origin (same rule as `command`):

```js
meridianWindow.postMessage({ type: 'gaze', x: 812, y: 455, t: performance.now(), confidence: 0.9 }, origin);
```

- `x, y`: viewport pixels of the Meridian page (CSS px, top-left origin). `confidence` 0 to 1
  (missing = 1); below 0.5 the sample counts as "no gaze". `t` is informational: Meridian times
  everything with its own clock when a sample arrives, so the tracker's clock does not matter.
  Stop sending (or send low confidence) when tracking is lost; after 0.5 s without a sample the
  dot hides and any dwell resets.
- Meridian answers the window that sent the latest sample with the things on screen, so the
  tracker can snap its cursor to them:

```js
{ type: 'targets', items: [
  { id: 'band-d6', x: 1005, y: 683, w: 133, h: 62, kind: 'button', label: 'Detector D6, 4.43 to 4.99 µm' },
  { id: 'preset:barnard', x: 25, y: 559, w: 115, h: 64, kind: 'button', label: "Barnard's Star" },
  { id: 'sky:barnard', x: 598, y: 300, w: 28, h: 28, kind: 'target', label: "Barnard's Star" },
] }
```

  `x, y` is the top-left corner, `w, h` the size, rounded px. `kind: 'button'` = a real button that
  full gaze mode can press (shown, enabled, not covered by the guide card); `kind: 'target'` = a
  named thing from the guide's registry (sky objects, the field target, colour ticks, panels).
  Sent when the list changes, at most 4 times a second (it also changes when the sky moves).
- In the page the bridge re-sends each sample as the window event `meridian:gaze`.

### Three input modes (a setting, default A)

| Mode | `state.input` / URL | What gaze does |
| --- | --- | --- |
| **A. Mouse/keyboard** | `mouse` (default, not in the URL) | Moves the face panel's gaze dot, nothing else: no presses, no guide. The guide's 7 s dwell follows the mouse only with `?gaze=mouse`. Offers hide after 12 s. |
| **B. Gaze helps the guide** | `?input=assist` | Feeds the guide (`guide.attention`): the dwell ring and, after 7 s on a sky object or a colour control, the offer. Never presses anything. Offers stay until answered. A gaze dot shows on the page. |
| **C. Full gaze control** | `?input=gaze` | Everything in B, plus: a **0.8 s look presses a button** (a bar fills under it), 24 px snapping, smoothing, edge panning, a rest zone. |

Full gaze (C) details (`web/src/input/gazeCore.js`, `gaze.js`):
- Pressable: Meridian's own buttons (places, band ribbon, tools, the time-lapse, "Open time-lapse
  here"), the guide card's answers and the eye-control button. Text fields, sliders and Aladin's own
  widgets are left to the keyboard and commands.
- Two dwell times on purpose: **0.8 s presses a button**, **7 s over the sky or a colour asks the
  guide**. Over a plain button only the press happens. The detector buttons are colour controls *and*
  buttons: the press comes at 0.8 s (and repeats every ~1.8 s while you keep looking, which sets the
  same band again), and the guide's dwell keeps counting, so a 7 s look still brings "Wondering
  about these colours?".
- No chains of presses: the same button presses again only after 1 s plus a new dwell, and a
  *different* button that appears where you just pressed (the card's "Yes" becomes "Got it") waits
  until your eyes leave that spot.
- Edge panning only over the sky view, never over a panel, and never while the guide card is open
  or a guide script runs (looking at what the guide points at near an edge must not move the sky).
- **Rest zone: the bottom-left corner** (160 × 40 px, over Aladin's zoom buttons, marked "Rest").
  Look there 1 s to pause gaze (nothing is pressed and the guide gets no gaze), 1 s again to resume.
  Not bottom-right (Aladin's logo), not top-right (the guide card), not top-left (the time-lapse
  size buttons).

### Switching modes

- The **eye-control button** (always on screen: top of the left column; in the time-lapse it floats
  left of "Back to sky") cycles A → B → C → A. In C a 0.8 s look at it turns eye control off.
- Key `G` (same cycle), or commands: `set_input_mode { mode: 'mouse' | 'assist' | 'gaze' }` (also
  `'A' | 'B' | 'C'`), `cycle_input_mode`. The tracker can switch with
  `postMessage({ type: 'command', name: 'set_input_mode', args: { mode: 'assist' } }, origin)`.
- Also: `set_dwell { ms }` (400–1500), `dwell_longer`, `dwell_shorter`, `toggle_gaze_pause`,
  `toggle_gaze_sim` (the mouse acts as the eyes, through the same path). These are `personOnly`:
  the AI guide can never run them.

Testing without a tracker, in the browser console (dev server):

```js
const g = await (await fetch('/tests-e2e/fixtures/gaze-sample.json')).json();
meridian.run('set_input_mode', { mode: 'assist' });
guide.attention.configure({ dwellMs: 3000 }); // optional: a shorter guide dwell
meridian.gaze.replay(g); // 6 s on detector D6: ring, then "Wondering about these colours?"
meridian.gaze.targets(); // what the tracker would receive
```

The fixture holds `{ viewport: { w, h }, samples: [{ x, y, t, confidence }] }`; a replay scales it to
the window. A real recording in that shape replays the same way.

The first version of this layer (commit `89f89ae`, removed for a while) is now back in `web/src/input/`,
with the rest zone moved and the modes added.

## Connecting a Python tracker: the local WebSocket (`?gaze_ws=`)

A native tracker cannot call `postMessage`, so Meridian can connect to it instead. Open the page with
`?gaze_ws=PORT` and Meridian connects to `ws://localhost:PORT/` (only this machine is allowed), keeps
reconnecting, and shows "Eye tracker connected" at the bottom of the screen. The parameter stays in the
URL across reloads. No relay page is needed. Code: `web/src/input/gazeSocket.js`.

The tracker side is ready to use, standard library only: `gaze_tracker/meridian_bridge.py`.

```python
from meridian_bridge import MeridianBridge
bridge = MeridianBridge(port=8765, screen_w=2560, screen_h=1600).start()  # physical screen pixels
bridge.send_gaze(x, y, confidence)   # each calibrated sample, ~30 per second
bridge.send_gaze(None, None, 0)      # tracking lost
bridge.targets                       # the page's buttons (page px), for your own snapping or tests
bridge.send_face(landmarks, ear=[...], mar=0.1)   # optional: the face panel
bridge.command("zoom_in")            # optional: any Meridian command
```

- **Messages** (JSON, one per WebSocket text message or an array): `{type: 'gaze', x, y, confidence?,
  screen_w?, screen_h?, space?}` and the bridge messages `face`, `command`, `list_commands`, `get_state`.
  Meridian sends back `{type: 'hello', input, viewport}` on connect and `{type: 'targets', items}` as in the
  gaze section above.
- **Coordinates:** send the physical screen pixels your model outputs, with `screen_w`/`screen_h`. Meridian
  converts them to its own pixels with the screen size the browser reports, so macOS "scaled" resolutions
  and Windows display scaling are handled. It also subtracts the window's position and toolbar, but the
  toolbar height is estimated: **run the browser full-screen** and the conversion is exact.
  `space: 'viewport'` skips the conversion if you already send page pixels.
- **Calibrate first**, then stream calibrated raw points. Meridian smooths (120 ms), snaps (24 px) and
  times the dwell itself; do not add your own dwell.
- **Which mode:** with an error of about one button (64 px), use `&input=assist` (mode B): gaze feeds the
  guide and never presses anything. `&input=gaze` (mode C) presses after a 0.8 s look and will often press a
  neighbouring button at that accuracy.
- **Try it without a tracker:** `python gaze_tracker/meridian_bridge.py --fake circle` (a point circling the
  screen) or `--fake buttons` (visits each button the page reports), then open
  `http://localhost:5173/?gaze_ws=8765&input=assist`.

## Notes from building it

- Put any rest or pause zone away from the bottom-right corner. Aladin's logo is there, and its
  licence asks that it stay visible. The top-right corner belongs to the guide card.
- Do not pan when the person is reading a panel near the screen edge. Pan only when the gaze is
  over the sky (`#sky`).
- A command's reply cannot contain a Promise (`postMessage` cannot copy one). The bridge already
  replies when async commands finish.
