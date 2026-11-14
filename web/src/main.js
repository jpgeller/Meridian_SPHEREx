// Step 0 shell: mounts Aladin Lite on the SPHEREx cube and checks the API.
// Real modules (core/, sky/, field/) arrive in Steps 1–3 of docs/BUILD_PLAN.md.
import './style.css';
import A from 'aladin-lite';

const SPHEREX_HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
const statusEl = document.querySelector('#status');

async function checkApi() {
  try {
    const res = await fetch('/api/health');
    const body = await res.json();
    return body.ok === true;
  } catch {
    return false;
  }
}

await A.init;
const aladin = A.aladin('#sky', {
  survey: SPHEREX_HIPS,
  projection: 'SIN',
  fov: 60,
  target: '266.4168 -29.0078', // Milky Way centre
  cooFrame: 'icrs',
  showFullscreenControl: false,
});
window.aladin = aladin; // handy for console debugging

// Aladin opens the cube on frame 50, which is blank on IRSA. Until Step 2 adds the
// band helper, show frame 40 (1.905 µm). Formula: see CLAUDE.md "Verified data facts".
const C = 299792458;
const F_MIN = C / 5.009e-6, F_MAX = C / 7.43e-7;
const waitLayer = setInterval(() => {
  const layer = aladin.getBaseImageLayer();
  if (layer?.added) {
    clearInterval(waitLayer);
    layer.setFrequency({ value: F_MIN + ((40 + 0.5) / 102) * (F_MAX - F_MIN), unit: 'Hz' });
  }
}, 200);

const apiOk = await checkApi();
statusEl.textContent = `SPHEREx DR1 sky · API ${apiOk ? 'connected' : 'not reachable'}`;
