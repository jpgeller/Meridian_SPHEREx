// State <-> URL. parseQuery/toQuery are pure (unit-tested); startUrlSync wires them to
// the browser. URL format (all optional):
//   ?ra=133.7951&dec=-7.2451&fov=2&band=72&proj=AIT&view=field&mode=rgb&rgb=88,72,40
//    &formula=b88-b40&compare=side&op=subtract&t=0,3&layers=gaia,wise&ffov=0.25&name=WISE%200855
// `name` is not state: it is returned separately so the app can fly_to it after start-up.
import { DEFAULTS } from './state.js';

const NUMBER_KEYS = ['ra', 'dec', 'fov', 'band', 'ffov'];
const STRING_KEYS = ['view', 'proj', 'mode', 'compare', 'op', 'formula', 'color'];

const round = (v, d) => Number(v.toFixed(d));

/** URLSearchParams | string -> { patch, name } (patch is unvalidated; store.set sanitises it) */
export function parseQuery(query) {
  const q = new URLSearchParams(query);
  const patch = {};
  for (const k of NUMBER_KEYS) {
    if (q.has(k)) patch[k] = Number(q.get(k));
  }
  for (const k of STRING_KEYS) {
    if (q.has(k)) patch[k] = q.get(k);
  }
  if (q.has('rgb')) patch.rgb = q.get('rgb').split(',').map((c) => (/^[dD][1-6]$/.test(c) ? c : Number(c)));
  if (q.has('mix')) patch.mix = q.get('mix').split(',').map(Number);
  if (q.has('t')) patch.t = q.get('t').split(',').filter(Boolean).map(Number);
  if (q.has('layers')) patch.layers = q.get('layers').split(',').filter(Boolean);
  return { patch, name: q.get('name') || null };
}

/** state -> query string. Position is always written; everything else only when not default. */
export function toQuery(state) {
  const q = new URLSearchParams();
  q.set('ra', String(round(state.ra, 5)));
  q.set('dec', String(round(state.dec, 5)));
  q.set('fov', String(round(state.fov, state.fov < 1 ? 4 : 2)));
  q.set('band', String(state.band));
  for (const k of STRING_KEYS) {
    if (state[k] !== DEFAULTS[k]) q.set(k, state[k]);
  }
  if (state.view === 'field' || state.ffov !== DEFAULTS.ffov) q.set('ffov', String(state.ffov));
  if (state.mode === 'rgb') q.set('rgb', state.rgb.join(','));
  if (state.color === 'custom') q.set('mix', state.mix.join(','));
  if (state.t.length) q.set('t', state.t.join(','));
  if (state.layers.length) q.set('layers', state.layers.join(','));
  // URLSearchParams encodes ',' as %2C; keep lists readable.
  return q.toString().replace(/%2C/g, ',');
}

/**
 * Apply the current URL to the store, then keep the URL updated (throttled).
 * Returns { name } from the URL, and a stop() function.
 */
export function startUrlSync(store, { throttleMs = 300 } = {}) {
  const { patch, name } = parseQuery(window.location.search);
  store.set(patch, 'url');

  let timer = null;
  const write = () => {
    timer = null;
    const next = `?${toQuery(store.get())}`;
    if (next !== window.location.search) {
      window.history.replaceState(null, '', next + window.location.hash);
    }
  };
  const unsubscribe = store.subscribe(() => {
    if (!timer) timer = setTimeout(write, throttleMs);
  });
  write(); // normalise the URL right away (e.g. fill in defaults, fix invalid values)

  // Back/forward or a pasted URL with only a hash change: re-read it.
  const onPop = () => store.set(parseQuery(window.location.search).patch, 'url');
  window.addEventListener('popstate', onPop);

  return {
    name,
    stop() {
      unsubscribe();
      window.removeEventListener('popstate', onPop);
      clearTimeout(timer);
    },
  };
}
