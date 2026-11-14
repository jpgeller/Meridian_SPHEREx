// App entry. Core first (state, commands, URL, inputs), then the sky.
// The Aladin bridge below is TEMPORARY: Step 2 moves it into src/sky/ with proper band
// handling, presets and name lookup.
import './style.css';
import A from 'aladin-lite';
import { store, run, startCore } from './core/index.js';

const SPHEREX_HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const statusEl = document.querySelector('#status');

const { name: urlName } = startCore();

let apiOk = false;
const statusText = () => {
  const st = store.get();
  return `SPHEREx DR1 · band ${st.band} · ${st.view} view · API ${apiOk ? 'connected' : 'not reachable'}`;
};

async function checkApi() {
  try {
    const res = await fetch('/api/health');
    return (await res.json()).ok === true;
  } catch {
    return false;
  }
}

await A.init;
const s = store.get();
const aladin = A.aladin('#sky', {
  survey: SPHEREX_HIPS,
  projection: s.proj,
  fov: s.fov,
  target: `${s.ra} ${s.dec}`,
  cooFrame: 'icrs',
  showFullscreenControl: false,
});
window.aladin = aladin;

// --- temporary sky bridge (replaced in Step 2) -------------------------------
const C = 299792458;
const F_MIN = C / 5.009e-6, F_MAX = C / 7.43e-7;
const bandFreq = (k) => F_MIN + ((k + 0.5) / 102) * (F_MAX - F_MIN);
const layerReady = () => aladin.getBaseImageLayer()?.added;

function applyBand(band) {
  if (layerReady()) aladin.getBaseImageLayer().setFrequency({ value: bandFreq(band), unit: 'Hz' });
}
const waitLayer = setInterval(() => {
  if (layerReady()) {
    clearInterval(waitLayer);
    applyBand(store.get().band);
  }
}, 200);

// state -> sky
store.subscribe((state, changed, source) => {
  if (source === 'sky') return; // our own echo
  if (changed.includes('ra') || changed.includes('dec')) aladin.gotoRaDec(state.ra, state.dec);
  if (changed.includes('fov')) aladin.setFoV(state.fov);
  if (changed.includes('band')) applyBand(state.band);
  if (changed.includes('proj')) aladin.setProjection(state.proj);
  statusEl.textContent = statusText();
});

// sky -> state (mouse drag / wheel), debounced
let skyTimer;
const pullFromSky = () => {
  clearTimeout(skyTimer);
  skyTimer = setTimeout(() => {
    const [ra, dec] = aladin.getRaDec();
    store.set({ ra, dec, fov: aladin.getFov()[0] }, 'sky');
  }, 150);
};
aladin.on('positionChanged', pullFromSky);
aladin.on('zoomChanged', pullFromSky);

if (urlName) {
  const r = run('fly_to', { target: urlName }, 'url');
  if (!r.ok) console.info('[main] name lookup arrives in Step 2:', urlName);
}

apiOk = await checkApi();
statusEl.textContent = statusText();
