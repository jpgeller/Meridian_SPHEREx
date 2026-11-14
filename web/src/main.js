// App entry: core (state, commands, URL, inputs) -> sky -> controls -> status.
import './style.css';
import { store, commands, run, startCore } from './core/index.js';
import { createSky } from './sky/sky.js';
import { createControls } from './ui/controls.js';
import { createHandoff } from './sky/handoff.js';
import { createFieldView } from './field/fieldView.js';
import { createPlayer } from './field/player.js';

const statusEl = document.querySelector('#status');
const { name: urlName } = startCore();

let apiOk = null;
let message = '';
let sky = null;

function renderStatus(msg) {
  if (typeof msg === 'string') message = msg;
  const s = store.get();
  const loading = sky && !sky.ready ? ' · loading sky…' : '';
  const api = apiOk === false ? ' · API not reachable' : '';
  statusEl.textContent = `${message || `SPHEREx DR1 · ${s.view} view`}${loading}${api}`;
}

// Report command failures (e.g. unknown names) in the status line for everyone,
// including screen-reader users (it is an aria-live region).
window.addEventListener('meridian:command', (e) => {
  if (!e.detail.ok && e.detail.error) renderStatus(e.detail.error);
});

sky = await createSky('#sky', { store, commands, onStatus: renderStatus });
window.aladin = sky.aladin; // console debugging
createControls(document.querySelector('#ui'), { store, commands, getWavelengths: () => sky.wavelengths });
createHandoff(document.querySelector('#handoff'), { store, commands });
export const field = createFieldView(document.querySelector('#field-root'), {
  store,
  commands,
  getWavelengths: () => sky.wavelengths,
});
createPlayer(field.stage, { store, commands });
store.subscribe(() => renderStatus());

if (urlName) run('fly_to', { target: urlName, fov: store.get().fov < 5 ? store.get().fov : undefined }, 'url');

fetch('/api/health')
  .then((r) => r.json())
  .then((b) => (apiOk = b.ok === true))
  .catch(() => (apiOk = false))
  .finally(() => renderStatus());
renderStatus();
