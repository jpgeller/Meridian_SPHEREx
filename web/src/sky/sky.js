// The 3D sky: Aladin Lite showing the SPHEREx DR1 cube, kept in sync with the store.
//
//   store -> sky : position, fov, band, projection (anything not from the sky itself)
//   sky -> store : mouse drag / wheel (debounced, source 'sky')
//
// Also re-registers the navigation commands that need Aladin or the API:
// fly_to (names), go_preset, set_projection.
import A from 'aladin-lite';
import { parseCoordinates } from '../core/coords.js';
import { SPHEREX_HIPS, loadWavelengths, waitForLayer, showBand } from './spherexCube.js';
import { PRESETS, presetById, presetForText } from './presets.js';
import { createNativeLayer } from './nativeLayer.js';
import { createColorViews } from './colorViews.js';
import { createLevels } from './levels.js';
import { createSkyCoords } from './skyCoords.js';

const DEFAULT_FIELD_FOV = 0.5; // degrees, after flying to a named object
const SPHERE_FOV_AFTER_ALLSKY = 60;
const PLANETARIUM_MAX_FOV = 160; // stereographic stretches a lot beyond this

export async function createSky(container, { store, commands, onStatus = () => {} }) {
  await A.init;
  const s0 = store.get();
  const aladin = A.aladin(container, {
    survey: SPHEREX_HIPS,
    projection: s0.proj,
    cooFrame: s0.proj === 'AIT' ? 'galactic' : 'icrs',
    fov: s0.fov,
    target: `${s0.ra} ${s0.dec}`,
    showReticle: true,
    showFullscreenControl: false,
    showCooGridControl: true,
    showProjectionControl: false, // projection goes through our command (state + URL)
    showFrame: true,
  });

  const sky = { aladin, wavelengths: null, layer: null, ready: false };

  // --- band -------------------------------------------------------------------
  loadWavelengths().then((w) => {
    sky.wavelengths = w;
    window.dispatchEvent(new CustomEvent('meridian:wavelengths')); // panels redraw their band labels
    onStatus();
  });
  waitForLayer(aladin)
    .then((layer) => {
      sky.layer = layer;
      sky.ready = true;
      showBand(layer, store.get().band);
      sky.colors.apply(store.get()); // tint or colour mix from the start (and from the URL)
      onStatus();
    })
    .catch((err) => onStatus(`Sky failed to load: ${err.message}`));

  // --- store -> sky -------------------------------------------------------------
  function applyProjection(proj) {
    aladin.setProjection(proj);
    aladin.setFrame(proj === 'AIT' ? 'galactic' : 'icrs');
  }

  store.subscribe((state, changed, source) => {
    if (source === 'sky') return; // our own echo
    if (changed.includes('proj')) applyProjection(state.proj);
    if (changed.includes('ra') || changed.includes('dec')) aladin.gotoRaDec(state.ra, state.dec);
    if (changed.includes('fov')) aladin.setFoV(state.fov);
    if (changed.includes('band') && sky.layer) showBand(sky.layer, state.band);
  });

  // --- sky -> store (mouse) -------------------------------------------------------
  const coords = createSkyCoords(aladin, typeof container === 'string' ? document.querySelector(container) : container);
  sky.coords = coords;
  let pullTimer;
  const pull = () => {
    clearTimeout(pullTimer);
    pullTimer = setTimeout(() => {
      // not getRaDec: in the galactic (whole-sky) view Aladin 3.8.2 returns a wrong position (skyCoords.js)
      const [ra, dec] = coords.centre() ?? aladin.getRaDec();
      store.set({ ra, dec, fov: aladin.getFov()[0] }, 'sky');
    }, 150);
  };
  aladin.on('positionChanged', pull);
  aladin.on('zoomChanged', pull);

  // --- commands that need the sky or the API -----------------------------------------
  async function resolveName(name) {
    try {
      const res = await fetch(`/api/resolve?name=${encodeURIComponent(name)}`);
      if (res.status === 404) throw new Error(`No object called “${name}” was found`);
      if (!res.ok) throw new Error(`lookup failed (${res.status})`);
      const body = await res.json();
      return { ra: body.ra, dec: body.dec, label: body.name, otype: body.otype };
    } catch (err) {
      if (/No object/.test(err.message)) throw err;
      // API down: fall back to Aladin's own Sesame lookup (J2000, no proper motion).
      console.warn('[sky] /api/resolve unavailable, using Aladin lookup', err);
      return new Promise((resolve, reject) =>
        aladin.gotoObject(name, {
          success: ([ra, dec]) => resolve({ ra, dec, label: name, otype: null, j2000: true }),
          error: () => reject(new Error(`No object called “${name}” was found`)),
        }),
      );
    }
  }

  commands.register(
    'fly_to',
    async ({ target, fov }) => {
      if (typeof target !== 'string' || !target.trim()) throw new Error('nothing to fly to');
      const coords = parseCoordinates(target);
      const preset = coords ? null : presetForText(target);
      if (preset && preset.target !== target) {
        // Typed a known place: use its canonical target (e.g. a proper-motion-aware name).
        return commands.run('fly_to', { target: preset.target, fov: fov ?? preset.fov }, 'preset').value;
      }
      const where = coords ?? (await resolveName(target.trim()));
      if (store.get().proj === 'AIT') store.set({ proj: 'SIN' }, 'command');
      store.set({ ra: where.ra, dec: where.dec, fov: fov ?? DEFAULT_FIELD_FOV }, 'command');
      onStatus(`Showing ${where.label ?? target}`);
      return where;
    },
    { label: 'Fly to', args: { target: 'name or coordinates', fov: 'optional, degrees' } },
  );

  commands.register(
    'go_preset',
    ({ id }) => {
      const p = presetById(id);
      if (!p) throw new Error(`unknown preset ${id}`);
      return commands.run('fly_to', { target: p.target, fov: p.fov }, 'preset').value;
    },
    { label: 'Go to a preset place', args: { id: PRESETS.map((p) => p.id).join(' | ') } },
  );

  commands.register(
    'set_projection',
    ({ proj }) => {
      const patch = { proj };
      if (proj === 'AIT') Object.assign(patch, { fov: 360, ra: 266.4168, dec: -29.0078 });
      if (proj === 'SIN' && store.get().fov > 180) patch.fov = SPHERE_FOV_AFTER_ALLSKY;
      if (proj === 'STG' && store.get().fov > PLANETARIUM_MAX_FOV) patch.fov = 120;
      store.set(patch, 'command');
    },
    { label: 'Set view type', args: { proj: "'SIN' (3D globe), 'STG' (planetarium) or 'AIT' (whole sky, Gaia style)" } },
  );

  // Colour views: grey, tinted band, or false-colour mixes (see colorViews.js)
  sky.colors = createColorViews(aladin, sky, { store, onStatus });

  // Brightness/contrast: Aladin's right-drag gesture, made visible and resettable (see levels.js)
  sky.levels = createLevels(aladin, { store });

  // Sharper than the all-sky tiles when zoomed in (see nativeLayer.js)
  sky.native = createNativeLayer(aladin, { store, commands, onStatus });

  return sky;
}
