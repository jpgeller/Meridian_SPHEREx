// Full-resolution SPHEREx layer for the 3D sky.
//
// IRSA's all-sky tiles stop at 12.9"/px, so past a few degrees of zoom Aladin just magnifies
// them (blocky). When the view is zoomed in, this covers it with patches built from the
// original SPHEREx images (6.15"/px, twice as sharp), optionally smoothed (display
// interpolation, no new detail).
//
// Patches sit on a fixed sky grid of CELL degrees, so panning reuses patches already loaded
// (and the API caches each one). The visible cells are loaded centre-first, at most MAX_CELLS.
// Patches have feathered edges, so neighbours blend without seams.
import A from 'aladin-lite';
import { CELL, PATCH, cellsForView } from './grid.js';

export { CELL };

export const NATIVE_SHOW_FOV = 1.5; // degrees: below this the full-resolution layer is shown
const MAX_CELLS = 9;
const PARALLEL = 2; // patches built at once (each downloads several images)
const PREFIX = 'spherex-native-';

export function createNativeLayer(aladin, { store, commands, onStatus = () => {} }) {
  const local = { enabled: true, smooth: true };
  const shown = new Map(); // key -> { name, meta }
  let generation = 0;
  let scale = null; // { band, lo, hi }: one brightness scale for the whole view (from the centre patch)
  let timer = null;

  const keyOf = (c, band, smooth) => `${c.ra},${c.dec}|${band}|${smooth}`; // scale is fixed per band

  function removeLayer(name) {
    try {
      aladin.removeImageLayer(name);
    } catch {
      /* already gone */
    }
  }

  function clearAll() {
    const had = shown.size > 0;
    for (const { name } of shown.values()) removeLayer(name);
    shown.clear();
    generation++; // ignore patches still on their way
    if (had) onStatus(''); // back to the default status line (all-sky tiles)
  }

  function describe(band) {
    const metas = [...shown.values()].map((v) => v.meta);
    if (!metas.length) return;
    const nImages = metas.reduce((n, m) => n + m.n_frames, 0);
    const wl = metas[0].wavelength_um;
    onStatus(
      `Full-resolution SPHEREx · 6.15″ pixels · band ${band} · ${wl.toFixed(2)} µm · ${metas.length} patch${metas.length > 1 ? 'es' : ''}, ` +
        `${nImages} images${local.smooth ? ' · smoothed for display' : ''}`,
    );
  }

  async function update() {
    const s = store.get();
    if (!local.enabled || s.view !== 'sky' || s.proj !== 'SIN' || s.fov >= NATIVE_SHOW_FOV) {
      clearAll();
      return;
    }
    const gen = ++generation;
    const cells = cellsForView(s.ra, s.dec, s.fov);
    const wanted = new Map(cells.map((c) => [keyOf(c, s.band, local.smooth), c]));
    // Drop patches that left the view or belong to another band/smoothing.
    for (const [key, v] of shown) {
      if (!wanted.has(key)) {
        removeLayer(v.name);
        shown.delete(key);
      }
    }
    if (scale && scale.band !== s.band) {
      // New band: new brightness scale, so every patch is rebuilt from the centre outwards.
      for (const v of shown.values()) removeLayer(v.name);
      shown.clear();
      scale = null;
    }
    const todo = [...wanted].filter(([key]) => !shown.has(key));
    if (!todo.length) {
      describe(s.band);
      return;
    }
    onStatus(`Loading full-resolution SPHEREx images… (${shown.size}/${wanted.size} patches)`);
    let failures = 0;

    async function load([key, c]) {
      try {
        const params = { ra: c.ra, dec: c.dec, fov: PATCH, band: s.band, smooth: local.smooth };
        if (scale) Object.assign(params, { lo: scale.lo, hi: scale.hi });
        const r = await fetch(`/api/skypatch?${new URLSearchParams(params)}`);
        const meta = await r.json();
        if (!r.ok) throw new Error(meta.detail ?? `patch failed (${r.status})`);
        if (gen !== generation) return;
        if (!scale) scale = { band: s.band, lo: meta.lo, hi: meta.hi };
        const name = `${PREFIX}${c.ra}_${c.dec}`;
        const img = A.image(new URL(meta.url, location.href).href, { name: 'SPHEREx full resolution', imgFormat: 'png', wcs: meta.wcs });
        aladin.setOverlayImageLayer(img, name);
        shown.set(key, { name, meta });
        describe(s.band);
      } catch (err) {
        failures++;
        console.warn('[native]', err.message);
      }
    }

    // The centre patch goes first and sets one brightness scale for the whole view, so the
    // other patches match it. If it fails, the others still load (each with its own scale).
    const queue = [...todo];
    if (!scale) await load(queue.shift());
    const worker = async () => {
      while (queue.length && gen === generation) await load(queue.shift());
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (gen !== generation) return;
    if (!shown.size) onStatus(failures ? 'Full-resolution images unavailable here right now' : '');
  }

  // Wait until panning/zooming settles before asking for patches.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 500);
  };
  store.subscribe((s, changed) => {
    if (['ra', 'dec', 'fov', 'band', 'view', 'proj'].some((k) => changed.includes(k))) schedule();
  });

  commands.register(
    'toggle_native',
    () => {
      local.enabled = !local.enabled;
      if (!local.enabled) {
        clearAll();
        onStatus('Full-resolution layer off');
      } else schedule();
      return local.enabled;
    },
    { label: 'Full-resolution SPHEREx layer on/off', keys: ['n'] },
  );
  commands.register(
    'toggle_smooth',
    () => {
      local.smooth = !local.smooth;
      schedule();
      return local.smooth;
    },
    { label: 'Smooth / sharp pixels', keys: ['i'] },
  );

  schedule();
  return { update, get state() { return { ...local, patches: shown.size }; } };
}
