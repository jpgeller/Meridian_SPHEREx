// Interest detector (proactive guide): what is this person trying to do? It watches the commands
// they run (never the guide's own) and turns patterns into *moments* worth a proactive offer, plus
// a small profile that tells Claude what they seem to care about and what they already tried.
//
//   const it = createInterest({ now, onMoment, isPresetTarget })
//   it.command(detail)      a `meridian:command` detail { name, args, source, ok }
//   it.observe(state)       store subscriber (view, fov, band...): for "tried" and the zoom rule
//   it.tick()               call about once a second (time-based rules)
//   it.profile()            -> { topics: [top 3], recent: [last 6 actions], tried: [...], view, seconds }
//   it.snapshot()  it.configure(o)  it.reset()
//
// Moments (each one at most once per `cooldownMs`, 3 min):
//   bands            3+ band changes inside 40 s
//   colours          3+ colour-view changes inside 60 s
//   compare          3+ changes of what the 2D view shows inside 60 s
//   timelapse_start  the person opened the 2D view of real images for the first time
//   object_search    they searched a name that is not one of the preset places
//   zoomed           zoomed in on the sky (below 5°) for 20 s without opening the 2D view
//   arrival          the person flew to one of the 7 places (go_preset): { target: { id: 'sky:<place>' } }, every time
// Dwell moments (feature:<id>, object) come from attention.js, not from here.
//
// Pure: no DOM, clock injected, unit-tested (tests/interest.test.js).

export const DEFAULTS = Object.freeze({
  cooldownMs: 180000,
  bandsCount: 3,
  bandsWindowMs: 40000,
  coloursCount: 3,
  coloursWindowMs: 60000,
  compareCount: 3,
  compareWindowMs: 60000,
  zoomedFov: 5, // degrees: the sky offers the 2D view below this (FIELD_OPEN_MAX_FOV)
  zoomedMs: 20000,
});

// commands that do not mean "the person did this"
// ('code' = console and scripts: real people press buttons ('ui'), keys ('keyboard') or look ('gaze'))
const QUIET = new Set(['guide', 'preset', 'player', 'url', 'test', 'init', 'code']);

const TOPIC = {
  set_band: 'bands', next_band: 'bands', prev_band: 'bands', set_detector: 'bands', set_mode: 'bands',
  set_color: 'colours', set_mix: 'colours', brighter: 'colours', dimmer: 'colours', more_contrast: 'colours', less_contrast: 'colours',
  set_op: 'compare', set_show: 'compare', toggle_video: 'motion', toggle_blink: 'variability', toggle_wise: 'compare',
  show_timelapse: 'compare', set_compare: 'compare', toggle_layer: 'compare', toggle_epoch: 'compare', set_epochs: 'compare',
  play: 'motion', pause: 'motion', toggle_play: 'motion', step_next: 'motion', step_prev: 'motion', set_frame: 'motion',
  open_field: 'motion', close_field: 'exploring',
  fly_to: 'objects', go_preset: 'objects', select_point: 'spectrum',
  zoom_in: 'exploring', zoom_out: 'exploring', pan_left: 'exploring', pan_right: 'exploring', pan_up: 'exploring',
  pan_down: 'exploring', set_projection: 'exploring', set_field_fov: 'exploring',
};
const BANDS = new Set(['set_band', 'next_band', 'prev_band', 'set_detector']);
const COLOURS = new Set(['set_color', 'set_mix']);
const COMPARE = new Set(['set_op', 'set_show', 'toggle_video', 'toggle_blink', 'toggle_wise', 'show_timelapse', 'set_compare']);

const detectorOfBand = (b) => (Number.isFinite(b) && b >= 1 && b <= 101 ? Math.floor((b - 1) / 17) + 1 : null);

/** A short, readable form of a command for Claude: "set_band 93", "set_show video". */
export function describeCommand({ name, args } = {}) {
  const a = args && typeof args === 'object' ? Object.values(args).filter((v) => ['string', 'number', 'boolean'].includes(typeof v)) : [];
  return [name, ...a.map((v) => String(v).slice(0, 30))].join(' ').trim();
}

/**
 * @param {Object} o
 * @param {Function} [o.now]
 * @param {Function} [o.onMoment]        ({ moment, target? }) -> void
 * @param {Function} [o.isPresetTarget]  (text) -> boolean: a fly_to target that is one of the preset places
 */
export function createInterest({ now = () => Date.now(), onMoment = () => {}, isPresetTarget = () => false, options = {} } = {}) {
  let o = { ...DEFAULTS, ...options };
  const t0 = now();
  let topics = new Map(); // topic -> count
  let recent = []; // last actions (strings)
  let tried = new Set(); // setups seen: D1..D6, color:x, show:x, mode:x, ffov:x, place:x, view:field
  let times = { bands: [], colours: [], compare: [] };
  let lastMoment = new Map(); // moment -> time
  let openedField = false;
  let view = null;
  let zoomSince = null; // time the sky went below zoomedFov
  let zoomFired = false;

  function emit(moment, extra = {}) {
    const t = now();
    const last = lastMoment.get(moment);
    if (last != null && t - last < o.cooldownMs) return false;
    lastMoment.set(moment, t);
    try {
      onMoment({ moment, ...extra });
    } catch (err) {
      console.warn('[guide] onMoment failed', err);
    }
    return true;
  }

  function bump(kind, windowMs, count, moment) {
    const t = now();
    times[kind] = [...times[kind].filter((x) => t - x <= windowMs), t];
    if (times[kind].length >= count) {
      times[kind] = [];
      emit(moment);
    }
  }

  return {
    command(d) {
      if (!d?.ok || !d.name || QUIET.has(d.source)) return;
      const topic = TOPIC[d.name];
      if (!topic) return;
      topics.set(topic, (topics.get(topic) ?? 0) + 1);
      recent = [...recent, describeCommand(d)].slice(-6);
      if (d.name === 'go_preset' && typeof d.args?.id === 'string') {
        tried.add(`place:${d.args.id}`);
        try {
          onMoment({ moment: 'arrival', target: { id: `sky:${d.args.id}` } }); // no cool-down: each arrival is new
        } catch (err) {
          console.warn('[guide] onMoment failed', err);
        }
      }
      if (BANDS.has(d.name)) bump('bands', o.bandsWindowMs, o.bandsCount, 'bands');
      else if (COLOURS.has(d.name)) bump('colours', o.coloursWindowMs, o.coloursCount, 'colours');
      else if (COMPARE.has(d.name)) bump('compare', o.compareWindowMs, o.compareCount, 'compare');
      if (d.name === 'open_field' && !openedField) {
        openedField = true;
        emit('timelapse_start');
      }
      if (d.name === 'fly_to' && d.source === 'ui') {
        const target = String(d.args?.target ?? '').trim();
        if (target && !isPresetTarget(target)) emit('object_search', { target: { id: 'sky:target', name: target.slice(0, 80) } });
      }
    },

    observe(s = {}) {
      const t = now();
      const d = detectorOfBand(s.band);
      if (d) tried.add(`D${d}`);
      if (s.color) tried.add(`color:${s.color}`);
      if (s.view === 'field') {
        tried.add('view:field');
        openedField = true;
        if (s.op) tried.add(`show:${s.compare && s.compare !== 'off' ? s.compare : s.op}`);
        if (s.mode) tried.add(`mode:${s.mode}`);
        if (s.ffov) tried.add(`ffov:${s.ffov}`);
      }
      view = s.view ?? view;
      const zoomed = s.view === 'sky' && Number.isFinite(s.fov) && s.fov < o.zoomedFov;
      if (zoomed && zoomSince == null) zoomSince = t;
      if (!zoomed) zoomSince = null;
    },

    tick() {
      const t = now();
      if (zoomSince != null && !openedField && !zoomFired && t - zoomSince >= o.zoomedMs) {
        zoomFired = true;
        emit('zoomed');
      }
    },

    profile() {
      const top = [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
      return { topics: top, recent: [...recent], tried: [...tried].slice(0, 24), view, seconds: Math.round((now() - t0) / 1000) };
    },

    snapshot: () => ({ topics: Object.fromEntries(topics), recent: [...recent], tried: [...tried], openedField, zoomSince, lastMoment: Object.fromEntries(lastMoment) }),
    configure: (x = {}) => (o = { ...o, ...x }),
    reset() {
      topics = new Map();
      recent = [];
      tried = new Set();
      times = { bands: [], colours: [], compare: [] };
      lastMoment = new Map();
      openedField = false;
      zoomSince = null;
      zoomFired = false;
    },
  };
}
