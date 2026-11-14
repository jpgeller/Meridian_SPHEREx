# Connecting an eye tracker to Meridian

Meridian is built so that **everything can be done by looking**. The tracker only has to send
where the person is looking. The app decides what that means: pressing buttons, panning the
sky, pausing.

## 1. Send gaze samples

Send one message per sample, 30–60 per second, to the Meridian page with `window.postMessage`:

```js
meridianWindow.postMessage(
  { type: 'gaze', x: 512, y: 300, confidence: 0.93, t: Date.now() },
  'http://localhost:5173', // the Meridian page's origin
);
```

- `x`, `y`: where the person is looking, in **CSS pixels of the Meridian page's viewport**
  (0,0 = top-left of the page, not of the screen). If your tracker gives screen coordinates,
  subtract the browser window's content position.
- `confidence`: 0–1. Samples below 0.5 are ignored. Leave it out if your tracker has none.
- `t`: a timestamp in ms. Any steady clock works.

How to reach the page:
- **Tracker in an iframe or tab opened by Meridian:** use `window.parent` or `window.opener`.
- **Tracker as a separate program:** run a tiny local web page (e.g. on `localhost:8080`) that
  receives your samples (WebSocket) and forwards them with `postMessage`.

Only this page's own origin and `localhost` / `127.0.0.1` (any port) are accepted. To allow
another origin, pass it in `startCore({ allowedOrigins: [...] })` in `web/src/main.js`.

## 2. What the app does with gaze

| Look at… | For | Result |
| --- | --- | --- |
| A button (or within 24 px of it) | 0.8 s | It is pressed. A bar fills under it while you look. |
| The same button again | — | It needs 1 s more after a press, so it never presses twice by accident. |
| The edge of the **sky** (56 px band) | 0.6 s | The sky pans that way, repeating every 0.45 s. Panel edges never pan. |
| The **Rest** box (top-right corner) | 1 s | Gaze is paused, so you can read freely. Look again for 1 s to resume. |
| Anything else | — | Nothing. Quick glances never do anything. |

The dwell time is adjustable from 400 to 1500 ms with commands `set_dwell {ms}`,
`dwell_longer` and `dwell_shorter`. You can also pause from code with `toggle_gaze_pause`.

## 3. Where the buttons are (app → tracker)

After the first gaze sample, the app replies to the sender whenever the on-screen buttons change:

```js
{ type: 'targets', items: [ { id: 't12', label: 'WISE 0855', x: 26, y: 541, w: 55, h: 45 }, ... ] }
```

Use it to snap your cursor, enlarge targets, or read the labels aloud.

## 4. Sending commands directly (optional)

If your tracker recognises its own gestures (a blink, a voice word), it can skip dwell and run
any command:

```js
meridianWindow.postMessage({ type: 'command', name: 'zoom_in' }, origin);
meridianWindow.postMessage({ type: 'command', name: 'fly_to', args: { target: 'WISE 0855' } }, origin);
meridianWindow.postMessage({ type: 'list_commands' }, origin); // replies { type: 'commands', items: [...] }
```

Each command replies `{ type: 'command_result', name, ok, error? }`. For `fly_to` the reply
comes when the flight is done.

## 5. Testing without a tracker

- **Mouse as eyes:** open `http://localhost:5173/?gaze=mouse` or press `g`. Hold the mouse still
  on a button and it presses after the dwell time, exactly as gaze would.
- **Automated:** `cd web && npm run test:e2e` runs `tests-e2e/gaze.spec.js`. It sends real
  `postMessage` gaze samples and checks dwell, glances, edge panning, the rest zone and the
  targets reply.
- **The logic alone:** `web/src/input/gazeCore.js` has no DOM. Its unit tests are in
  `web/tests/gaze.test.js`.

## Files

- `web/src/core/messages.js`: the postMessage contract (accepts gaze/commands, replies).
- `web/src/input/gazeCore.js`: dwell, snapping, smoothing, edge panning, rest zone.
- `web/src/input/gaze.js`: finds buttons on screen, draws the feedback, presses buttons,
  sends targets to the tracker, and runs the mouse simulator.
