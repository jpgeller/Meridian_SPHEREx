// Default commands. They only change state; the sky (Step 2) and the field view
// (Steps 3+) subscribe to state and do the drawing. Later steps may re-register a command
// with a richer implementation (e.g. fly_to with name lookup).
import { stepBand } from './bands.js';
import { parseCoordinates } from './coords.js';

const PAN_FRACTION = 1 / 8; // pan by 1/8 of the field of view
const ZOOM_FACTOR = 1.5;

export function registerDefaultCommands(commands, store) {
  const { register } = commands;
  const s = () => store.get();
  const set = (patch) => store.set(patch, 'command');

  // --- navigation -------------------------------------------------------------
  const pan = (dRa, dDec) => {
    const { ra, dec, fov } = s();
    const step = fov * PAN_FRACTION;
    // RA degrees shrink towards the poles; scale so a pan moves the same distance on screen.
    const cosDec = Math.max(Math.cos((dec * Math.PI) / 180), 0.05);
    set({ ra: ra + (dRa * step) / cosDec, dec: Math.min(90, Math.max(-90, dec + dDec * step)) });
  };
  // East is to the left on the sky (north up), so "pan left" increases RA.
  register('pan_left', () => pan(+1, 0), { label: 'Pan left', keys: ['ArrowLeft'] });
  register('pan_right', () => pan(-1, 0), { label: 'Pan right', keys: ['ArrowRight'] });
  register('pan_up', () => pan(0, +1), { label: 'Pan up', keys: ['ArrowUp'] });
  register('pan_down', () => pan(0, -1), { label: 'Pan down', keys: ['ArrowDown'] });
  register('zoom_in', () => set({ fov: s().fov / ZOOM_FACTOR }), { label: 'Zoom in', keys: ['+', '='] });
  register('zoom_out', () => set({ fov: s().fov * ZOOM_FACTOR }), { label: 'Zoom out', keys: ['-', '_'] });

  register(
    'fly_to',
    ({ target, fov }) => {
      const c = parseCoordinates(target);
      if (!c) {
        // Name lookup (Sesame) arrives in Step 2 when the sky re-registers fly_to.
        throw new Error(`cannot resolve "${target}" yet (names need Step 2)`);
      }
      set({ ra: c.ra, dec: c.dec, fov: fov ?? Math.min(s().fov, 1) });
      return c;
    },
    { label: 'Fly to', args: { target: 'name or coordinates', fov: 'optional, degrees' } },
  );

  register('set_projection', ({ proj }) => set({ proj }), {
    label: 'Set view type',
    args: { proj: "'SIN' (3D sphere) or 'AIT' (whole sky)" },
  });

  // --- bands --------------------------------------------------------------------
  register('set_band', ({ band }) => set({ band }), { label: 'Set band', args: { band: '1-101' } });
  register('next_band', () => set({ band: stepBand(s().band, +1) }), { label: 'Next band', keys: [']'] });
  register('prev_band', () => set({ band: stepBand(s().band, -1) }), { label: 'Previous band', keys: ['['] });
  register('set_mode', ({ mode, rgb, formula }) => {
    const patch = { mode };
    if (rgb !== undefined) patch.rgb = rgb;
    if (formula !== undefined) patch.formula = formula;
    set(patch);
  }, {
    label: 'Set band mode',
    args: { mode: 'single | detector | rgb | custom', rgb: '[r,g,b] bands', formula: 'e.g. b88 - b40' },
  });

  // --- field view -------------------------------------------------------------
  register('open_field', () => set({ view: 'field' }), { label: 'Open time-lapse here', keys: ['Enter'] });
  register('close_field', () => set({ view: 'sky', playing: false }), { label: 'Back to sky', keys: ['Escape'] });
  register('play', () => set({ playing: true }), { label: 'Play' });
  register('pause', () => set({ playing: false }), { label: 'Pause' });
  register('toggle_play', () => set({ playing: !s().playing }), { label: 'Play / pause', keys: [' '] });
  register('step_next', () => set({ frameIndex: s().frameIndex + 1, playing: false }), { label: 'Next frame', keys: ['.'] });
  register('step_prev', () => set({ frameIndex: Math.max(0, s().frameIndex - 1), playing: false }), {
    label: 'Previous frame',
    keys: [','],
  });
  register('set_compare', ({ compare }) => set({ compare }), {
    label: 'Compare mode',
    args: { compare: 'off | side | timeline | blink' },
  });
  register('set_epochs', ({ t }) => set({ t }), { label: 'Choose dates to compare', args: { t: 'frame indexes' } });

  // --- layers -------------------------------------------------------------------
  register('toggle_layer', ({ layer }) => {
    const layers = new Set(s().layers);
    layers.has(layer) ? layers.delete(layer) : layers.add(layer);
    set({ layers: [...layers] });
  }, { label: 'Show/hide layer', args: { layer: 'gaia | wise | flags | simbad' } });

  // --- stubs filled in by later steps ---------------------------------------
  const stub = (name, step) => () => console.info(`[commands] ${name}: arrives in Step ${step}`);
  register('select_point', stub('select_point', 10), { label: 'Spectrum here', stub: true, args: { ra: 'deg', dec: 'deg' } });
  register('focus_search', stub('focus_search', 2), { label: 'Search', keys: ['/'], stub: true });
}
