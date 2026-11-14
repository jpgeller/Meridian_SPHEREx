// Full-resolution SPHEREx layer for the 3D sky.
//
// IRSA's all-sky tiles stop at 12.9"/px, so past ~3 deg of zoom Aladin just magnifies them
// (blocky). When the view is zoomed in, this lays a patch built from the original SPHEREx
// images (6.15"/px, twice as sharp) over the sphere, optionally smoothed (display
// interpolation, no new detail). It follows panning and band changes.
import A from 'aladin-lite';

export const NATIVE_SHOW_FOV = 1.5; // degrees: below this the patch is shown
const MAX_PATCH_FOV = 0.5; // the API's limit (wavelength drifts across wider patches)
const LAYER = 'spherex-native';

export function createNativeLayer(aladin, { store, commands, onStatus = () => {} }) {
  const local = { enabled: true, smooth: true };
  let current = null; // { key, ra, dec, fov, band, smooth }
  let token = 0;
  let timer = null;

  const patchFovFor = (viewFov) => Math.min(MAX_PATCH_FOV, Math.max(0.05, viewFov * 1.3));
  // Snap the patch centre to a grid of a quarter patch, so small pans reuse the same patch.
  const snap = (v, step) => Math.round(v / step) * step;

  function wanted(s) {
    if (!local.enabled || s.view !== 'sky' || s.proj !== 'SIN' || s.fov >= NATIVE_SHOW_FOV) return null;
    const fov = Number(patchFovFor(s.fov).toFixed(3));
    const step = fov / 4;
    const dec = snap(s.dec, step);
    const ra = snap(s.ra, step / Math.max(Math.cos((dec * Math.PI) / 180), 0.05));
    return { ra: Number(((ra + 360) % 360).toFixed(5)), dec: Number(dec.toFixed(5)), fov, band: s.band, smooth: local.smooth };
  }

  const keyOf = (w) => (w ? `${w.ra},${w.dec},${w.fov},${w.band},${w.smooth}` : '');

  function clear() {
    if (current) {
      try {
        aladin.removeImageLayer(LAYER);
      } catch {
        /* layer may already be gone */
      }
      onStatus(''); // back to the default status line (all-sky tiles)
    }
    current = null;
    token++; // ignore any patch still on its way
  }

  async function update() {
    const w = wanted(store.get());
    const key = keyOf(w);
    if (!w) {
      clear();
      return;
    }
    if (current?.key === key) return;
    const my = ++token;
    onStatus('Loading full-resolution SPHEREx images…');
    try {
      const q = new URLSearchParams({ ra: w.ra, dec: w.dec, fov: w.fov, band: w.band, smooth: w.smooth });
      const r = await fetch(`/api/skypatch?${q}`);
      const meta = await r.json();
      if (!r.ok) throw new Error(meta.detail ?? `patch failed (${r.status})`);
      if (my !== token) return;
      const img = A.image(new URL(meta.url, location.href).href, {
        name: 'SPHEREx full resolution',
        imgFormat: 'png',
        wcs: meta.wcs,
      });
      aladin.setOverlayImageLayer(img, LAYER);
      current = { key, ...w };
      const bandNote = meta.band !== w.band ? ` (nearest band with images: ${meta.band})` : '';
      onStatus(
        `Full-resolution SPHEREx · 6.15″ pixels · band ${meta.band}${bandNote} · ${meta.wavelength_um.toFixed(2)} µm · ` +
          `${meta.n_frames} image${meta.n_frames > 1 ? 's' : ''}${w.smooth ? ' · smoothed for display' : ''}`,
      );
    } catch (err) {
      if (my !== token) return;
      console.error('[native]', err);
      onStatus(/no images/.test(err.message) ? 'No full-resolution SPHEREx images here yet' : 'Full-resolution images unavailable right now');
    }
  }

  // Wait until panning/zooming settles before asking for a patch.
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
        clear();
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
  return { update, get state() { return { ...local, current }; } };
}
