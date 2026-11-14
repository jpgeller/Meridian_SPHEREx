// Gaze -> intentions. Pure logic (no DOM, no timers), so it can be unit-tested and reused.
// Feed it gaze samples with update(sample); it returns events:
//   { type: 'progress', id, p }   dwell progress on a target, 0..1 (for the visual ring/bar)
//   { type: 'activate', id }      the user looked at target `id` long enough: press it
//   { type: 'pan', dir }          looking at a screen edge (left|right|up|down), repeats while held
//   { type: 'rest', paused }      the rest zone toggled pausing (paused: gaze does nothing)
//   { type: 'lost' }              tracking dropped for a while; any dwell is reset
//
// Design rules (from the spec): nothing happens on a quick glance; dwell time is adjustable;
// visible progress; a rest zone so people can read without triggering anything; targets snap
// because eye trackers are noisy (typically 0.5–1° = 20–40 px on a laptop).

export const DEFAULTS = Object.freeze({
  dwellMs: 800, // look this long at a target to press it (settable 400–1500)
  refractoryMs: 1000, // after a press, the same target needs this long again (no double presses)
  snapPx: 24, // gaze this close to a target still counts as on it
  smoothMs: 120, // average samples over this window (tracker noise)
  minConfidence: 0.5,
  lostMs: 500, // no usable sample for this long -> reset
  edgePx: 56, // edge band for panning (sky only)
  edgeDelayMs: 600, // look at an edge this long before panning starts
  panEveryMs: 450, // then pan this often while still looking
  restMs: 1000, // look at the rest zone this long to pause / resume
  // Top-right: the bottom-right corner holds Aladin's logo, which its licence asks us to keep visible.
  rest: { w: 150, h: 110, corner: 'top-right' },
  // (p) => boolean: may this point pan? The page passes "is the gaze over the sky", so
  // reading a panel near the screen edge never pans the view.
  canPan: null,
});

export const DWELL_MIN = 400;
export const DWELL_MAX = 1500;

export function createGazeCore(options = {}) {
  const o = { ...DEFAULTS, ...options };
  let viewport = { w: 1280, h: 800 };
  let targets = []; // { id, x, y, w, h }
  let edgePanning = true;
  const samples = []; // recent { x, y, t }
  let lastSampleT = -Infinity;

  let dwell = null; // { id, start }
  let lastActivated = { id: null, t: -Infinity };
  let edge = null; // { dir, start, lastPan }
  let rest = null; // { start, fired }
  let paused = false;

  function smoothed(now) {
    while (samples.length && now - samples[0].t > o.smoothMs) samples.shift();
    if (!samples.length) return null;
    let x = 0;
    let y = 0;
    for (const s of samples) {
      x += s.x;
      y += s.y;
    }
    return { x: x / samples.length, y: y / samples.length };
  }

  /** Target under the point: inside first, else the nearest within snapPx. */
  function hit(p) {
    let best = null;
    let bestD = Infinity;
    for (const t of targets) {
      const dx = Math.max(t.x - p.x, 0, p.x - (t.x + t.w));
      const dy = Math.max(t.y - p.y, 0, p.y - (t.y + t.h));
      const d = Math.hypot(dx, dy);
      if (d <= o.snapPx && d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  function inRest(p) {
    const right = o.rest.corner.endsWith('right');
    const top = o.rest.corner.startsWith('top');
    const inX = right ? p.x >= viewport.w - o.rest.w : p.x <= o.rest.w;
    const inY = top ? p.y <= o.rest.h : p.y >= viewport.h - o.rest.h;
    return inX && inY;
  }

  function edgeDir(p) {
    if (p.x <= o.edgePx) return 'left';
    if (p.x >= viewport.w - o.edgePx) return 'right';
    if (p.y <= o.edgePx) return 'up';
    if (p.y >= viewport.h - o.edgePx) return 'down';
    return null;
  }

  function reset(events, why) {
    if (dwell) events.push({ type: 'progress', id: dwell.id, p: 0 });
    dwell = null;
    edge = null;
    if (why) events.push({ type: why });
  }

  /** Feed one sample { x, y, t (ms), confidence? }. Returns a list of events. */
  function update(sample) {
    const events = [];
    const now = sample.t;
    if (now - lastSampleT > o.lostMs && lastSampleT > -Infinity && (dwell || edge)) reset(events, 'lost');
    if (sample.confidence != null && sample.confidence < o.minConfidence) return events;
    lastSampleT = now;
    samples.push({ x: sample.x, y: sample.y, t: now });
    const p = smoothed(now);
    if (!p) return events;

    // Rest zone works even while paused (it is how you resume).
    if (inRest(p)) {
      if (!rest) rest = { start: now, fired: false };
      if (!rest.fired && now - rest.start >= o.restMs) {
        rest.fired = true;
        paused = !paused;
        reset(events);
        events.push({ type: 'rest', paused });
      }
      return events;
    }
    rest = null;
    if (paused) return events;

    // Dwell on targets
    const t = hit(p);
    if (t) {
      edge = null;
      if (!dwell || dwell.id !== t.id) {
        if (dwell) events.push({ type: 'progress', id: dwell.id, p: 0 });
        dwell = { id: t.id, start: now };
      }
      const blocked = lastActivated.id === t.id && now - lastActivated.t < o.refractoryMs;
      if (blocked) {
        dwell.start = now; // must look again after the refractory period
        return events;
      }
      const prog = Math.min(1, (now - dwell.start) / o.dwellMs);
      events.push({ type: 'progress', id: t.id, p: prog });
      if (prog >= 1) {
        events.push({ type: 'activate', id: t.id });
        events.push({ type: 'progress', id: t.id, p: 0 });
        lastActivated = { id: t.id, t: now };
        dwell = { id: t.id, start: now };
      }
      return events;
    }
    if (dwell) {
      events.push({ type: 'progress', id: dwell.id, p: 0 });
      dwell = null;
    }

    // Edge panning (only off-target, only when enabled e.g. in the sky view)
    const dir = edgePanning && (!o.canPan || o.canPan(p)) ? edgeDir(p) : null;
    if (!dir) {
      edge = null;
      return events;
    }
    if (!edge || edge.dir !== dir) edge = { dir, start: now, lastPan: -Infinity };
    if (now - edge.start >= o.edgeDelayMs && now - edge.lastPan >= o.panEveryMs) {
      edge.lastPan = now;
      events.push({ type: 'pan', dir });
    }
    return events;
  }

  return {
    update,
    setTargets(list) {
      targets = list;
      if (dwell && !targets.some((t) => t.id === dwell.id)) dwell = null;
    },
    setViewport(w, h) {
      viewport = { w, h };
    },
    setEdgePanning(on) {
      edgePanning = on;
      if (!on) edge = null;
    },
    setDwellMs(ms) {
      o.dwellMs = Math.min(DWELL_MAX, Math.max(DWELL_MIN, ms));
      return o.dwellMs;
    },
    setPaused(v) {
      paused = Boolean(v);
    },
    get paused() {
      return paused;
    },
    get options() {
      return { ...o };
    },
  };
}
