// App entry: core (state, commands, URL, inputs) -> sky -> controls -> status.
import './style.css';
import './sky/smoothTiles.js'; // before Aladin starts: smooth (bilinear) sky tiles instead of hard pixel squares
import { store, commands, run, startCore, setSkyCoords } from './core/index.js';
import { formatSexagesimal } from './core/coords.js';
import { createSky } from './sky/sky.js';
import { createControls } from './ui/controls.js';
import { createHandoff } from './sky/handoff.js';
import { createFieldView } from './field/fieldView.js';
import { createPlayer } from './field/player.js';
import { createContext } from './field/context.js';
import { createSpectrum } from './field/spectrum.js';
import { createGuide } from './guide/index.js';
import { startGaze } from './input/gaze.js';
import { createInputModeButton } from './ui/inputModeButton.js';
import { createHints } from './ui/hints.js';
import { startGazeSocket } from './input/gazeSocket.js';

const statusEl = document.querySelector('#status');
// The guide's attention follows the mouse in input mode A (a 5 s rest = interest); ?gaze=off turns that off.
// Read before the URL sync rewrites the URL.
const gazeParam = new URLSearchParams(window.location.search).get('gaze');
const { name: urlName } = startCore();

let apiOk = null;
let message = '';
let sky = null;

function renderStatus(msg) {
  if (typeof msg === 'string') message = msg;
  const s = store.get();
  const loading = sky && !sky.ready ? ' · loading sky…' : '';
  const api = apiOk === false ? ' · API not reachable' : '';
  // the view centre (Aladin's own coordinate box is off: it sat in the screen corner)
  const where = s.view === 'sky' ? ` · ${formatSexagesimal(s.ra, s.dec)} · ${s.fov >= 10 ? Math.round(s.fov) : s.fov.toFixed(2)}° wide` : '';
  statusEl.textContent = `${message || `SPHEREx DR1 · ${s.view} view`}${where}${loading}${api}`;
}

// Report command failures (e.g. unknown names) in the status line for everyone,
// including screen-reader users (it is an aria-live region).
window.addEventListener('meridian:command', (e) => {
  if (!e.detail.ok && e.detail.error) renderStatus(e.detail.error);
});

sky = await createSky('#sky', { store, commands, onStatus: renderStatus });
window.aladin = sky.aladin; // console debugging (overlays: use meridian.world2pix / pix2world)
setSkyCoords(sky.coords);
createControls(document.querySelector('#ui'), { store, commands, getWavelengths: () => sky.wavelengths });
createHandoff(document.querySelector('#handoff'), { store, commands });
export const field = createFieldView(document.querySelector('#field-root'), {
  store,
  commands,
  getWavelengths: () => sky.wavelengths,
});
const player = createPlayer(field.stage, { store, commands });
// 2D view in two columns: the size and band buttons join the controls column (field/player.js)
player.elements.right.prepend(document.querySelector('.field-controls'));
window.meridian.player = player; // debugging and tests
createContext(player, { store, commands });
const spectrum = createSpectrum(player, { store, commands });
window.guide = createGuide({ store, commands, sky, player, spectrum, gaze: gazeParam }); // UI plan: registry (U2), overlay, pop-up, runner, attention…
// Eye tracking (U9): gaze messages -> the face panel's dot, the guide (mode B) and dwell-to-press (mode C).
window.meridian.gaze = startGaze({ store, commands, guide: window.guide, mouseParam: gazeParam !== 'off', face: () => window.meridian.face });
createInputModeButton({ store, commands });
// mouse mode (A): a yellow "!" on each button; hovering it explains what the button does
window.meridian.hints = createHints({ store });
// ?gaze_ws=8765: a native eye tracker on this machine streams gaze over a WebSocket (docs/EYE_TRACKING.md)
window.meridian.gazeSocket = startGazeSocket(new URLSearchParams(window.location.search).get('gaze_ws'), {
  getInput: () => store.get().input,
});
store.subscribe(() => renderStatus());

if (urlName) run('fly_to', { target: urlName, fov: store.get().fov < 5 ? store.get().fov : undefined }, 'url');

fetch('/api/health')
  .then((r) => r.json())
  .then((b) => (apiOk = b.ok === true))
  .catch(() => (apiOk = false))
  .finally(() => renderStatus());
renderStatus();
