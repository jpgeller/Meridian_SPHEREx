// The single store for view state. Everything the user can change lives here and is
// mirrored to the URL (core/url.js). Modules react with subscribe(); they never keep
// their own copy of these values.
import { normalizeBand } from './bands.js';

export const VIEWS = ['sky', 'field'];
// SIN: 3D globe · STG: planetarium (stereographic, shapes kept as they move) · AIT: whole sky (Gaia style)
export const PROJECTIONS = ['SIN', 'STG', 'AIT'];
export const MODES = ['single', 'detector', 'rgb', 'custom'];
export const COMPARES = ['off', 'side', 'timeline', 'blink', 'gaia'];
// Operations on SPHEREx frames of different dates (field view)
export const OPS = ['none', 'blink', 'video']; // Add, Difference, Motion trail removed 16 Nov 2026
// The 2D view's one list of what to show (one choice at a time). Each sets op + compare.
export const SHOWS = {
  timelapse: { op: 'none', compare: 'off' },
  video: { op: 'video', compare: 'off' },
  blink: { op: 'blink', compare: 'off' },
  wise: { op: 'none', compare: 'side' },
  gaia: { op: 'none', compare: 'gaia' },
};
/** Which entry of SHOWS the state is in, or null (e.g. the older timeline / WISE-blink modes from a link). */
export function showOf(s) {
  for (const [name, v] of Object.entries(SHOWS)) if (v.op === s.op && v.compare === s.compare) return name;
  return null;
}
export const LAYERS = ['gaia', 'wise', 'flags', 'simbad'];
// Colour views of the full map: one band in grey or tinted, or a false-colour mix of three bands
export const COLORS = ['grey', 'tint', 'ir', 'dust', 'ice', 'custom'];
// Input modes (UI plan U9): mouse/keyboard only, gaze helps the guide, full gaze control (dwell presses buttons)
export const INPUTS = ['mouse', 'assist', 'gaze'];

export const FOV_MIN = 0.01; // degrees
export const FOV_MAX = 360;

// Field-view (time-lapse) sizes, degrees. Wider = catches faster movers, loads slower.
export const FIELD_FOVS = [0.05, 0.1, 0.25, 0.5, 1];
export const snapFieldFov = (v) =>
  FIELD_FOVS.reduce((best, f) => (Math.abs(f - v) < Math.abs(best - v) ? f : best), FIELD_FOVS[0]);

export const DEFAULTS = Object.freeze({
  view: 'sky',
  ra: 266.4168, // Milky Way centre
  dec: -29.0078,
  fov: 180, // open on the whole globe, not zoomed in on the Milky Way
  ffov: 0.1, // field-view size, one of FIELD_FOVS
  proj: 'SIN',
  band: 40,
  color: 'grey', // full-map colour view (COLORS)
  mix: [62, 46, 22], // custom colour mix: red, green, blue bands
  level: [0, 0], // map brightness and contrast steps (0, 0 = as served); see sky/levels.js
  mode: 'single',
  rgb: ['D6', 'D4', 'D2'], // colour mix: red, green, blue; each a band (1-101) or a detector 'D1'..'D6'
  formula: '',
  frameIndex: 0,
  playing: false,
  compare: 'off',
  op: 'none',
  t: [], // selected epochs (frame indexes) for blink/add/subtract
  layers: [],
  input: 'mouse', // INPUTS; how eye tracking is used (web/src/input/)
});

// Positions are kept to 5 decimals (0.04″): the API caches by 5-decimal keys, so a shared URL
// and a live session hit the same cache.
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const wrapRa = (ra) => round5(((ra % 360) + 360) % 360);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate and normalise a patch. Invalid fields are dropped (with a warning), so a bad
 * URL or a bad command can never put the app in a broken state.
 */
export function sanitize(patch, current = DEFAULTS) {
  const out = {};
  const warn = (k, v) => console.warn(`[state] ignoring invalid ${k}:`, v);
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'view': VIEWS.includes(v) ? (out.view = v) : warn(k, v); break;
      case 'proj': PROJECTIONS.includes(v) ? (out.proj = v) : warn(k, v); break;
      case 'mode': MODES.includes(v) ? (out.mode = v) : warn(k, v); break;
      case 'compare': COMPARES.includes(v) ? (out.compare = v) : warn(k, v); break;
      case 'op': OPS.includes(v) ? (out.op = v) : warn(k, v); break;
      case 'color': COLORS.includes(v) ? (out.color = v) : warn(k, v); break;
      case 'input': INPUTS.includes(v) ? (out.input = v) : warn(k, v); break;
      case 'mix': {
        // three real bands (blank frames 0, 50, 51 have no all-sky tiles)
        const ok = Array.isArray(v) && v.length === 3 && v.every((b) => Number.isInteger(b) && b >= 1 && b <= 101 && b !== 50 && b !== 51);
        ok ? (out.mix = [...v]) : warn(k, v);
        break;
      }
      case 'level': {
        const ok = Array.isArray(v) && v.length === 2 && v.every(isNum);
        ok ? (out.level = v.map((x) => Math.round(clamp(x, -10, 10) * 100) / 100)) : warn(k, v);
        break;
      }
      case 'ra': isNum(v) ? (out.ra = wrapRa(v)) : warn(k, v); break;
      case 'dec': isNum(v) ? (out.dec = round5(clamp(v, -90, 90))) : warn(k, v); break;
      case 'fov': isNum(v) && v > 0 ? (out.fov = clamp(v, FOV_MIN, FOV_MAX)) : warn(k, v); break;
      case 'ffov': isNum(v) && v > 0 ? (out.ffov = snapFieldFov(v)) : warn(k, v); break;
      case 'band': {
        const dir = isNum(v) && v < current.band ? -1 : 1;
        const b = normalizeBand(v, dir);
        b !== null ? (out.band = b) : warn(k, v);
        break;
      }
      case 'rgb': {
        const channel = (c) => (/^[dD][1-6]$/.test(String(c)) ? `D${String(c)[1]}` : normalizeBand(c));
        const ok = Array.isArray(v) && v.length === 3 && v.every((c) => channel(c) !== null);
        ok ? (out.rgb = v.map(channel)) : warn(k, v);
        break;
      }
      case 'formula': typeof v === 'string' && v.length <= 200 ? (out.formula = v) : warn(k, v); break;
      case 'frameIndex': Number.isInteger(v) && v >= 0 ? (out.frameIndex = v) : warn(k, v); break;
      case 'playing': typeof v === 'boolean' ? (out.playing = v) : warn(k, v); break;
      case 't': Array.isArray(v) && v.every((i) => Number.isInteger(i) && i >= 0) ? (out.t = [...v]) : warn(k, v); break;
      case 'layers': {
        const list = [...new Set(v)];
        list.every((l) => LAYERS.includes(l)) ? (out.layers = list) : warn(k, v);
        break;
      }
      default: warn(k, v);
    }
  }
  return out;
}

/**
 * Create a store. The app uses the shared `store` below; tests create their own.
 * Subscribers get (state, changedKeys, source); `source` says who changed it
 * ('url' | 'command' | 'sky' | ...) so a module can ignore its own echoes.
 */
export function createStore(initial = {}) {
  let state = { ...DEFAULTS, ...sanitize(initial) };
  const subs = new Set();

  function set(patch, source = 'unknown') {
    const clean = sanitize(patch, state);
    const changed = Object.keys(clean).filter(
      (k) => JSON.stringify(clean[k]) !== JSON.stringify(state[k]),
    );
    if (!changed.length) return [];
    state = { ...state, ...clean };
    for (const fn of subs) {
      try {
        fn(state, changed, source);
      } catch (err) {
        console.error('[state] subscriber failed', err);
      }
    }
    return changed;
  }

  return {
    get: () => state,
    set,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const store = createStore();
