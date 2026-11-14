// The single store for view state. Everything the user can change lives here and is
// mirrored to the URL (core/url.js). Modules react with subscribe(); they never keep
// their own copy of these values.
import { normalizeBand } from './bands.js';

export const VIEWS = ['sky', 'field'];
export const PROJECTIONS = ['SIN', 'AIT'];
export const MODES = ['single', 'detector', 'rgb', 'custom'];
export const COMPARES = ['off', 'side', 'timeline', 'blink'];
export const LAYERS = ['gaia', 'wise', 'flags', 'simbad'];

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
  fov: 60,
  ffov: 0.1, // field-view size, one of FIELD_FOVS
  proj: 'SIN',
  band: 40,
  mode: 'single',
  rgb: [88, 72, 40],
  formula: '',
  frameIndex: 0,
  playing: false,
  compare: 'off',
  t: [], // selected epochs (frame indexes) for blink/add/subtract
  layers: [],
});

const wrapRa = (ra) => ((ra % 360) + 360) % 360;
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
      case 'ra': isNum(v) ? (out.ra = wrapRa(v)) : warn(k, v); break;
      case 'dec': isNum(v) ? (out.dec = clamp(v, -90, 90)) : warn(k, v); break;
      case 'fov': isNum(v) && v > 0 ? (out.fov = clamp(v, FOV_MIN, FOV_MAX)) : warn(k, v); break;
      case 'ffov': isNum(v) && v > 0 ? (out.ffov = snapFieldFov(v)) : warn(k, v); break;
      case 'band': {
        const dir = isNum(v) && v < current.band ? -1 : 1;
        const b = normalizeBand(v, dir);
        b !== null ? (out.band = b) : warn(k, v);
        break;
      }
      case 'rgb': {
        const ok = Array.isArray(v) && v.length === 3 && v.every((b) => normalizeBand(b) !== null);
        ok ? (out.rgb = v.map((b) => normalizeBand(b))) : warn(k, v);
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
