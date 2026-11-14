// Default commands. They only change state; the sky (Step 2) and the field view
// (Steps 3+) subscribe to state and do the drawing. Later steps may re-register a command
// with a richer implementation (e.g. fly_to with name lookup).
import { stepBand } from './bands.js';
import { parseCoordinates } from './coords.js';
import { snapFieldFov, FIELD_FOVS } from './state.js';

const PAN_FRACTION = 1 / 8; // pan by 1/8 of the field of view
const ZOOM_FACTOR = 1.5;
export const FIELD_OPEN_MAX_FOV = 3; // degrees: below this the sky offers the time-lapse

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
  // In the field view, zoom steps through the field sizes instead of zooming the sky.
  const stepFieldFov = (dir) => {
    const i = FIELD_FOVS.indexOf(s().ffov);
    set({ ffov: FIELD_FOVS[Math.min(FIELD_FOVS.length - 1, Math.max(0, i + dir))] });
  };
  register('zoom_in', () => (s().view === 'field' ? stepFieldFov(-1) : set({ fov: s().fov / ZOOM_FACTOR })), {
    label: 'Zoom in',
    keys: ['+', '='],
  });
  register('zoom_out', () => (s().view === 'field' ? stepFieldFov(+1) : set({ fov: s().fov * ZOOM_FACTOR })), {
    label: 'Zoom out',
    keys: ['-', '_'],
  });

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
  register(
    'open_field',
    ({ fov } = {}) => {
      if (s().view === 'field') return;
      if (fov === undefined && s().fov >= FIELD_OPEN_MAX_FOV) {
        throw new Error(`Zoom in below ${FIELD_OPEN_MAX_FOV}° (or pick a place) to open the time-lapse`);
      }
      // Field size follows how far the user zoomed in, within 0.05°–1° (cutout cost grows fast).
      const size = fov ?? Math.min(1, Math.max(0.05, s().fov));
      set({ view: 'field', ffov: snapFieldFov(size), frameIndex: 0, playing: false });
    },
    { label: 'Open time-lapse here', keys: ['Enter'], args: { fov: 'optional field size, degrees' } },
  );
  register('set_field_fov', ({ fov }) => set({ ffov: fov }), {
    label: 'Time-lapse field size',
    args: { fov: '0.05 | 0.1 | 0.25 | 0.5 | 1 (degrees)' },
  });
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
  register('toggle_epoch', ({ index }) => {
    const t = new Set(s().t);
    t.has(index) ? t.delete(index) : t.add(index);
    set({ t: [...t].sort((a, b) => a - b) });
  }, { label: 'Select / unselect a date', args: { index: 'frame index' } });
  const opCommand = (op) => () => set({ op: s().op === op ? 'none' : op, playing: false });
  register('set_op', ({ op }) => set({ op, playing: false }), {
    label: 'Compare dates',
    args: { op: 'none (time-lapse) | blink | add | subtract' },
  });
  register('toggle_blink', opCommand('blink'), { label: 'Blink two dates', keys: ['b'] });
  register('toggle_add', opCommand('add'), { label: 'Add dates (deeper image)', keys: ['m'] });
  register('toggle_subtract', opCommand('subtract'), { label: 'Difference of two dates', keys: ['d'] });
  register('show_timelapse', () => set({ op: 'none' }), { label: 'Back to time-lapse', keys: ['t'] });

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
