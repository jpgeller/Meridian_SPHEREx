# Eye tracking: hand-off to Yassin's team

The Meridian mapping team does not build eye tracking. This note covers what the app already
provides for it, and where an earlier attempt can be found.

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

## The earlier app-side version (removed, in git history)

Commit `89f89ae` contains a complete app-side gaze layer, removed on 15 Nov 2026 so this team can
focus on mapping. Your team can reuse it or ignore it:

- `web/src/input/gazeCore.js`: dwell-to-press (0.8 s, adjustable from 0.4 to 1.5 s), 24 px snapping,
  smoothing, no double presses, edge panning only over the sky, a rest zone, low-confidence handling.
- `web/src/input/gaze.js`: finds the buttons on screen, progress bar, presses them, tells the
  tracker where the buttons are, and a mouse simulator.
- Tests: `web/tests/gaze.test.js`, `web/tests-e2e/gaze.spec.js`.

```bash
git show 89f89ae --stat
```

```bash
git checkout 89f89ae -- web/src/input
```

The first command lists what that version contained. The second restores the files.

## Notes from building it

- Put any rest or pause zone away from the bottom-right corner. Aladin's logo is there, and its
  licence asks that it stay visible.
- Do not pan when the person is reading a panel near the screen edge. Pan only when the gaze is
  over the sky (`#sky`).
- A command's reply cannot contain a Promise (`postMessage` cannot copy one). The bridge already
  replies when async commands finish.
