// Attention detector (UI plan, U6): what is the person lingering on? Turns a stream of gaze (or
// mouse) samples and the app's own events into the guide's three offers:
//   object  – dwell on a sky object, the field target or a mover        "Want help identifying this?"
//   colours – dwell on the band ribbon, a colour view "Wondering about these colours?"
//   change  – the same frames replayed over and over (see REPLAYS)      "Want to see what changed?"
//
// The top part is pure logic (no DOM, no timers, clock injected) so it is unit-tested with fake
// time, like the earlier gazeCore.js. The DOM wiring (mouse source, dwell ring, offers) is below it.
//
//   const a = createAttention({ now, targetAt, isQuiet, isCooling, onTrigger, onRing })
//   a.feed({ x, y, t?, confidence? })   a gaze/mouse sample in viewport px (t is informational:
//                                       the injected clock decides, so tracker clocks don't matter)
//   a.lose()                            the pointer left the page / tracking lost
//   a.tick()                            re-evaluate now (call ~10 Hz: targets move, blink runs)
//   a.observe(state, changed, source)   store subscriber: frame stepping, wraps, blink, new patch
//   a.commandStart(detail) / a.command(detail)   `meridian:command-start` / `meridian:command`
//   a.snapshot()                        { dwell, ring, replays, quiet }  (console, tests)
//   a.configure({ dwellMs, … })         tune at runtime (tests, user studies)
//
// Dwell rules: the catch radius (48 px) is the registry's targetAt pad. A ring appears after
// ringDelayMs (1.2 s) and fills to dwellMs (7 s); the dwell resets after graceMs (0.6 s) off the
// target (a glance away and back keeps it). Over a plain control (not a colour control) nothing
// happens: U9 uses its own 0.8 s dwell-to-press there.
//
// REPLAYS (change trigger), counted only in the field view and only while not quiet:
//   - a wrap: the frame index goes back down by itself (play loops, or ▶ past the last frame);
//   - a turn: a manual step (▶/◀, the slider, keys) in the opposite direction to the previous one;
//   - blink: every blinkReplayMs (2 s, i.e. 4 flips) that blink runs counts one.
//   replaysNeeded (3) inside replayWindowMs (30 s) -> offer "what changed". A new patch, band,
//   band mode or view starts the count again. The change video is not counted (it is a model
//   that loops by design). Commands run by the guide itself never count.
//
// Quiet (nothing counts, the dwell resets, no offer): a fly_to/go_preset pending (tracked here
// from the command events, at most pendingMaxMs each), plus whatever isQuiet() reports (the page
// passes: dragging, sky not ready, field frames loading, pop-up open, a guide script running,
// page hidden). Cool-down keys match the pop-up's (offerKey): object -> the target id,
// colours -> 'colours', change -> 'change'. A cooling key shows no ring and fires nothing.

export const DEFAULTS = Object.freeze({
  catchPx: 48,
  ringDelayMs: 1200,
  dwellMs: 7000,
  graceMs: 600,
  minConfidence: 0.5,
  lostMs: 500, // no sample for this long = no gaze
  replaysNeeded: 3,
  replayWindowMs: 30000,
  blinkReplayMs: 2000,
  pendingMaxMs: 15000,
  featureDwellMs: 7000, // a long look at a control (the mouse source sets 5 s)
});
export const MOUSE_DWELL_MS = 5000; // the mouse rests on a star or a control this long -> an offer

export const TEXTS = Object.freeze({
  object: 'Want to know what this is?',
  change: 'Trying to spot what changed?',
  colours: 'Wondering about these colours?',
});
// the muted second line of an offer (wireframe v4): why the guide is asking now
export const SUBS = Object.freeze({
  object: (s) => `You have been looking at it for ${s} seconds.`,
  colours: (s) => `You have been looking at the colours for ${s} seconds.`,
  change: () => 'You have replayed these pictures a few times.',
});

// a fly_to started by the person (or a preset): the sky is about to move
const MOVES = new Set(['fly_to', 'go_preset']);
// a different sequence of frames: the replay count starts again
const NEW_SEQUENCE = ['ra', 'dec', 'ffov', 'band', 'mode', 'rgb', 'formula', 'view'];

// Controls that never lead to an offer: the guide's own UI, big containers, layout buttons.
const NOT_FEATURES = new Set(['guide-popup', 'guide-pill', 'panel-toggle', 'face-panel', 'search', 'presets', 'time-player', 'show-modes']);

/**
 * Which moment a registry id leads to: 'object' | 'colours' | 'feature' | null.
 * feature = any other named control (a 2D mode button, Play, the field sizes...): a long look at it
 * makes the proactive guide offer help with that feature (nudge.js).
 */
export function classifyTarget(id) {
  if (typeof id !== 'string') return null;
  if (/^(sky|field):/.test(id)) return 'object';
  if (/^colou?r:/.test(id) || /^band-(ribbon|d[1-6])$/.test(id) || /^colour-view/.test(id)) return 'colours';
  if (/^(preset|proj):[\w.-]+$/.test(id) || (/^[a-z][a-z0-9-]*$/.test(id) && !NOT_FEATURES.has(id))) return 'feature';
  return null;
}

/** The cool-down key of an offer (the same string the pop-up's offerKey() makes from what we pass it). */
export const triggerKey = (trigger, id) => (trigger === 'object' ? id : trigger);

/**
 * @param {Object} o
 * @param {Function} o.targetAt   (x, y, pad) -> id | null
 * @param {Function} [o.now]
 * @param {Function} [o.classify] id -> 'object' | 'colours' | null
 * @param {Function} [o.isQuiet]  () -> reason string | null
 * @param {Function} [o.isCooling] key -> boolean
 * @param {Function} [o.onTrigger] ({ trigger, target, key }) -> void
 * @param {Function} [o.onRing]   (ring | null) ring = { id, trigger, progress 0..1, x, y }
 */
export function createAttention({
  targetAt,
  now = () => Date.now(),
  classify = classifyTarget,
  isQuiet = () => null,
  isCooling = () => false,
  onTrigger = () => {},
  onRing = () => {},
  options = {},
} = {}) {
  const o = { ...DEFAULTS, ...options };
  let sample = null; // { x, y, at }
  let dwell = null; // { id, trigger, start, lastOn, fired }
  let other = null; // a different target seen while the dwell is in its grace period
  let ring = null;
  const pending = new Map(); // command name -> [start times]
  let replays = []; // times
  let lastIndex = null;
  let lastDir = 0;
  let blinkSince = null; // time blink last counted from

  const setRing = (r) => {
    const same = r === ring || (r && ring && r.id === ring.id && r.progress === ring.progress && r.x === ring.x && r.y === ring.y);
    ring = r;
    if (!same) onRing(r);
  };

  function quietReason(t) {
    for (const [name, starts] of pending) {
      const live = starts.filter((s) => t - s < o.pendingMaxMs);
      if (live.length) {
        pending.set(name, live);
        return `${name} pending`;
      }
      pending.delete(name);
    }
    try {
      return isQuiet() || null;
    } catch {
      return null; // a broken hook must not stop the guide
    }
  }

  // ---- dwell ----
  function hit(s, t) {
    if (!s || t - s.at > o.lostMs) return null;
    if (s.confidence != null && s.confidence < o.minConfidence) return null;
    let id = null;
    try {
      id = targetAt(s.x, s.y, o.catchPx);
    } catch {
      id = null;
    }
    const trigger = classify(id);
    // a control counts only when the eyes (or the mouse) are on it, not merely near it
    if (trigger === 'feature') {
      try {
        if (targetAt(s.x, s.y, 0) !== id) return null;
      } catch {
        return null;
      }
    }
    return trigger ? { id, trigger } : null;
  }

  function evaluateDwell(t, quiet) {
    if (quiet) {
      dwell = other = null;
      setRing(null);
      return;
    }
    const h = hit(sample, t);
    if (h && dwell && h.id === dwell.id) {
      dwell.lastOn = t;
      other = null;
    } else {
      if (h) other = other && other.id === h.id ? other : { ...h, start: t };
      else other = null;
      if (!dwell || t - dwell.lastOn > o.graceMs) {
        dwell = other ? { ...other, lastOn: t, fired: false } : null;
        other = null;
      }
    }
    if (!dwell) return setRing(null);
    const key = triggerKey(dwell.trigger, dwell.id);
    const elapsed = t - dwell.start;
    if (dwell.fired || isCooling(key)) return setRing(null);
    if (elapsed >= (dwell.trigger === 'feature' ? (o.featureDwellMs ?? o.dwellMs) : o.dwellMs)) {
      dwell.fired = true;
      setRing(null);
      onTrigger({ trigger: dwell.trigger, target: dwell.id, key });
      return;
    }
    // controls get no ring (a ring on every button the mouse rests on would be noise)
    if (elapsed < o.ringDelayMs || dwell.trigger === 'feature') return setRing(null);
    const progress = Math.round(((elapsed - o.ringDelayMs) / Math.max(1, o.dwellMs - o.ringDelayMs)) * 1000) / 1000;
    const at = sample && t - sample.at <= o.lostMs ? sample : null;
    setRing({ id: dwell.id, trigger: dwell.trigger, progress, x: at?.x ?? null, y: at?.y ?? null });
  }

  // ---- replays ----
  function countReplay(t) {
    replays.push(t);
  }

  function evaluateReplays(t, quiet) {
    replays = replays.filter((r) => t - r <= o.replayWindowMs);
    if (blinkSince != null) {
      if (quiet) blinkSince = t; // blink under a card or while loading does not count
      else
        while (t - blinkSince >= o.blinkReplayMs) {
          blinkSince += o.blinkReplayMs;
          countReplay(blinkSince);
        }
    }
    if (quiet || replays.length < o.replaysNeeded || isCooling('change')) return;
    replays = [];
    onTrigger({ trigger: 'change', target: null, key: 'change' });
  }

  function resetReplays() {
    replays = [];
    lastDir = 0;
  }

  function update() {
    const t = now();
    const quiet = quietReason(t);
    evaluateDwell(t, quiet);
    evaluateReplays(t, quiet);
    return ring;
  }

  return {
    feed(s) {
      if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
        sample = { x: s.x, y: s.y, at: now(), ...(Number.isFinite(s.confidence) ? { confidence: s.confidence } : {}) };
      } else sample = null;
      return update();
    },
    lose() {
      sample = null;
      return update();
    },
    tick: update,

    /** Store subscriber: (state, changedKeys, source). */
    observe(state, changed = [], source) {
      const t = now();
      const inField = state?.view === 'field';
      if (changed.some((k) => NEW_SEQUENCE.includes(k)) || !inField) {
        resetReplays();
        lastIndex = inField ? state.frameIndex : null;
      }
      const blinking = inField && state.op === 'blink';
      if (blinking && blinkSince == null) blinkSince = t;
      if (!blinking) blinkSince = null;
      if (changed.includes('op')) lastDir = 0;
      if (!inField || !changed.includes('frameIndex')) return update();
      const i = state.frameIndex;
      const prev = lastIndex;
      lastIndex = i;
      if (quietReason(t) || source === 'guide' || prev == null || state.op === 'video') return update();
      if (source === 'player') {
        if (i < prev) countReplay(t); // the player looped (or ▶ ran past the last frame)
      } else {
        const dir = Math.sign(i - prev);
        if (dir && lastDir && dir !== lastDir) countReplay(t);
        if (dir) lastDir = dir;
      }
      return update();
    },

    commandStart(d) {
      if (!d || !MOVES.has(d.name)) return;
      const list = pending.get(d.name) ?? [];
      list.push(now());
      pending.set(d.name, list);
      update();
    },
    command(d) {
      if (!d || !MOVES.has(d.name)) return;
      const list = pending.get(d.name);
      if (list?.length) list.shift();
      if (list && !list.length) pending.delete(d.name);
      update();
    },

    configure(patch = {}) {
      for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS && Number.isFinite(v) && v >= 0) o[k] = v;
      return { ...o };
    },
    reset() {
      dwell = other = null;
      resetReplays();
      setRing(null);
    },
    snapshot() {
      const t = now();
      return {
        dwell: dwell && { id: dwell.id, trigger: dwell.trigger, ms: t - dwell.start, fired: dwell.fired },
        ring,
        replays: replays.length,
        quiet: quietReason(t),
      };
    },
    options: () => ({ ...o }),
  };
}

// ---------------------------------------------------------------------------------------------
// DOM wiring: the mouse source (?gaze=mouse), the dwell ring, and the offers.

const SVG = 'http://www.w3.org/2000/svg';
const RING_R = 22;
const TICK_MS = 100;

/**
 * @param {Object} o
 * @param {Object} o.guide   { targetAt, resolve, offer, popup, runner, overlay }
 * @param {Function} o.startGuide  (trigger, target) -> Promise (an accepted offer)
 * @param {Object} o.store
 * @param {Object} [o.sky]   { ready }
 * @param {Object} [o.player] { isLoading() }
 * @param {boolean} [o.mouse]  feed the mouse position as gaze (?gaze=mouse); setMouse() changes it later
 */
export function startAttention({ guide, startGuide, onMoment = () => false, store, sky, player, mouse = false, doc = document, win = window }) {
  let dragging = false;
  let dwellMs = DEFAULTS.dwellMs; // for the offer's "looking at it for 7 seconds"
  const quietHook = () => {
    if (doc.hidden) return 'page hidden';
    if (dragging) return 'dragging';
    if (sky && !sky.ready) return 'sky loading';
    if (store.get().view === 'field' && player?.isLoading?.()) return 'frames loading';
    if (guide.popup.isOpen()) return 'pop-up open';
    if (guide.runner.isRunning()) return 'guide running';
    return null;
  };

  // ---- the dwell ring ----
  const layer = doc.createElement('div');
  layer.id = 'guide-attention';
  layer.setAttribute('aria-hidden', 'true');
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ga-svg');
  const track = doc.createElementNS(SVG, 'circle');
  track.setAttribute('class', 'ga-track');
  const fill = doc.createElementNS(SVG, 'circle');
  fill.setAttribute('class', 'ga-fill');
  for (const c of [track, fill]) c.setAttribute('r', String(RING_R));
  const len = 2 * Math.PI * RING_R;
  fill.setAttribute('stroke-dasharray', String(len));
  svg.append(track, fill);
  layer.append(svg);
  doc.body.append(layer);
  let ringAt = null; // { x, y } where the ring is drawn

  function drawRing(r) {
    if (!r) {
      ringAt = null;
      layer.classList.remove('is-on');
      return;
    }
    // around a sky object: on the object; around a control or a big box: where the person looks
    const p = guide.resolve(r.id);
    const pos = p && !p.rect && Number.isFinite(p.x) ? p : r.x != null ? { x: r.x, y: r.y } : p;
    if (!pos) return drawRing(null);
    ringAt = { x: pos.x, y: pos.y };
    svg.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    fill.setAttribute('stroke-dashoffset', String(len * (1 - r.progress)));
    layer.dataset.target = r.id;
    layer.classList.add('is-on');
  }
  guide.overlay.setAvoid(() => (ringAt ? [{ x: ringAt.x, y: ringAt.y, r: RING_R + 8 }] : []));

  // ---- offers ----
  async function onTrigger({ trigger, target, key }) {
    // the proactive guide (nudge.js) takes the moments it handles; the rest get the local offers below
    if (onMoment({ trigger, target, key })) return;
    if (trigger === 'feature') return;
    // the pointer goes first: it flies to the thing and circles it, so the question needs no explaining
    const mark = trigger === 'change' ? 'time-player' : target ?? 'band-ribbon';
    guide.overlay.clear(); // B3: no earlier ring or label stays beside the new offer
    guide.overlay.circle(mark);
    guide.overlay.pointAt(mark);
    const secs = Math.round(dwellMs / 1000);
    const res = await guide.offer({
      text: TEXTS[trigger],
      sub: SUBS[trigger]?.(secs),
      key,
      // the card keeps clear of an object; colours and change share one cool-down key each
      target: trigger === 'object' ? target : undefined,
    });
    if (res === 'yes') startGuide(trigger, trigger === 'object' ? { id: target } : undefined);
    else guide.overlay.clear();
  }

  const attention = createAttention({
    targetAt: (x, y, pad) => guide.targetAt(x, y, pad),
    isQuiet: quietHook,
    isCooling: (k) => guide.popup.cooldown.isCooling(k),
    onTrigger: (e) => onTrigger(e).catch((err) => console.warn('[guide] offer failed', err)),
    onRing: drawRing,
  });

  // ---- inputs ----
  store.subscribe((s, changed, source) => attention.observe(s, changed, source));
  attention.observe(store.get(), [], 'init');
  win.addEventListener('meridian:command-start', (e) => attention.commandStart(e.detail));
  win.addEventListener('meridian:command', (e) => attention.command(e.detail));
  win.addEventListener('pointerdown', () => (dragging = true), true);
  for (const ev of ['pointerup', 'pointercancel', 'blur']) win.addEventListener(ev, () => (dragging = false), true);

  // The mouse source (?gaze=mouse) can be switched off and on: the input mode (U9) turns it off
  // while gaze feeds the guide, so two sources never fight over one dwell.
  let pos = null;
  let mouseOn = Boolean(mouse);
  // the mouse rests 5 s (a mouse that lingers that long means interest); gaze keeps the 7 s look
  const useDwell = (byMouse) => {
    const ms = byMouse ? MOUSE_DWELL_MS : DEFAULTS.dwellMs;
    dwellMs = ms;
    attention.configure({ dwellMs: ms, featureDwellMs: ms });
  };
  if (mouseOn) useDwell(true);
  let gazeOn = false; // only a label: gaze samples come through feed()
  win.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pos = { x: e.clientX, y: e.clientY };
    if (!mouseOn) return;
    dragging = e.buttons !== 0;
    attention.feed(pos);
  });
  // the mouse left the window
  doc.addEventListener('mouseout', (e) => {
    if (e.relatedTarget) return;
    pos = null;
    if (mouseOn) attention.lose();
  });
  // the sky moves under a still mouse, and the dwell clock runs on: re-check ~10 times a second
  setInterval(() => (mouseOn && pos ? attention.feed(pos) : attention.tick()), TICK_MS);

  return {
    feed: attention.feed, // U9: gaze samples { x, y, t, confidence }
    lose: attention.lose,
    configure: (o = {}) => {
      if (Number.isFinite(o.dwellMs)) dwellMs = o.dwellMs;
      return attention.configure(o);
    },
    snapshot: attention.snapshot,
    reset: attention.reset,
    /** 'mouse' (?gaze=mouse in mode A), 'gaze' (modes B and C) or 'none' */
    get source() {
      return mouseOn ? 'mouse' : gazeOn ? 'gaze' : 'none';
    },
    setMouse(on) {
      if (mouseOn && !on) attention.lose();
      mouseOn = Boolean(on);
      useDwell(mouseOn);
    },
    setGaze(on) {
      gazeOn = Boolean(on);
    },
    element: layer,
  };
}
