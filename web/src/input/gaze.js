// Gaze adapter (UI plan U9): connects gaze samples to the page according to the input mode
// (inputMode.js). The press decisions live in gazeCore.js (restored from commit 89f89ae); this
// file finds the buttons on screen, draws the feedback, presses buttons, feeds the guide and
// answers the tracker with the on-screen targets.
//
//   tracker -> postMessage({ type: 'gaze', x, y, t, confidence }) -> core/messages.js
//           -> `meridian:gaze` event { x, y, t, confidence, reply, source }  -> here:
//      every mode : the face panel's gaze dot; the `targets` reply (targets.js)
//      assist (B) : guide.attention.feed(sample)                     (never presses)
//      gaze   (C) : gazeCore -> press a button (its own click handler runs the command),
//                   pan at the sky's edges, pause in the rest zone; and guide.attention.feed
//
// Timing uses the page's clock when a sample arrives (the tracker's `t` is informational), so a
// tracker's clock never matters and the simulator, a replay and a tracker behave the same.
// Console: meridian.gaze.replay(samples) / .stop() / .targets() / .core / .setSim(on)
import { createGazeCore, DWELL_MIN, DWELL_MAX } from './gazeCore.js';
import { modeBehaviour, nextMode, parseMode, INPUTS } from './inputMode.js';
import { buildTargets, buttonId, createTargetSender } from './targets.js';
import './gaze.css';

// Pressable in full gaze mode: Meridian's own buttons, the guide pop-up's answers and pill, the input-mode
// button, anything marked [data-gaze]. Text fields, sliders and Aladin's own widgets are left to
// keyboard / commands.
export const TARGET_SELECTOR = [
  '#ui button',
  '#handoff button',
  '#field-root button',
  '[data-guide="guide-popup"] button',
  '[data-guide="guide-pill"]',
  '.input-mode',
  '[data-gaze]',
].join(',');
const COLLECT_EVERY_MS = 250;
const LOST_MS = 500; // no sample for this long: hide the dot and the bar
const viewW = () => innerWidth || document.documentElement.clientWidth;
const viewH = () => innerHeight || document.documentElement.clientHeight;

/**
 * @param {Object} o
 * @param {Object} o.store
 * @param {Object} o.commands
 * @param {Object} [o.guide]       window.guide: attention (feed/lose/setMouse/setGaze), popup, runner, list
 * @param {boolean} [o.mouseParam] the guide's dwell follows the mouse in mode A (default; ?gaze=off turns it off)
 * @param {Function} [o.face]      () => face panel sink with setGaze({ x, y, confidence }) | null
 */
export function startGaze({ store, commands, guide = null, mouseParam = false, face = () => null }) {
  const core = createGazeCore({ canPan: (p) => canPan(p) });
  const sender = createTargetSender({ minMs: COLLECT_EVERY_MS });
  const ids = new WeakMap();
  const byId = new Map();
  let nextId = 1;
  let lastCollect = -Infinity;
  let targets = [];
  let active = false; // a sample arrived since gaze was last lost
  let lostTimer = null;
  let behaviour = modeBehaviour(store.get().input);

  // --- feedback layer ------------------------------------------------------------------
  const layer = document.createElement('div');
  layer.className = 'gaze-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = `
    <div class="gaze-dot" hidden></div>
    <div class="gaze-bar" hidden><div class="gaze-bar-fill"></div></div>
    <div class="gaze-rest" hidden><strong class="gaze-rest-title">Rest</strong><span class="gaze-rest-text">look 1 s: pause</span></div>
    <div class="gaze-sim" hidden>Gaze simulator: the mouse acts as your eyes</div>`;
  document.body.append(layer);
  const dot = layer.querySelector('.gaze-dot');
  const bar = layer.querySelector('.gaze-bar');
  const fill = layer.querySelector('.gaze-bar-fill');
  const restEl = layer.querySelector('.gaze-rest');
  const restText = layer.querySelector('.gaze-rest-text');
  const restTitle = layer.querySelector('.gaze-rest-title');
  const simEl = layer.querySelector('.gaze-sim');
  // spoken once, separately (the layer itself is aria-hidden)
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  document.body.append(live);

  function canPan(p) {
    // reading a guide card, or looking at what the guide points at near an edge, never pans
    if (guide?.popup?.isOpen?.() || guide?.runner?.isRunning?.()) return false;
    const el = document.elementFromPoint(p.x, p.y);
    return Boolean(el && el.closest('#sky') && !el.closest('.aladin-ui, button, a, input, select'));
  }

  // --- targets ---------------------------------------------------------------------
  function idFor(el) {
    if (!ids.has(el)) ids.set(el, buttonId(el.dataset) ?? (el.id ? `#${el.id}` : `t${nextId++}`));
    return ids.get(el);
  }

  /** A button counts if it is shown, enabled, on screen and not covered (e.g. by the guide card). */
  function pressable(el, r) {
    if (el.disabled || el.closest('[hidden]') || r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > viewH() || r.left > viewW()) return false;
    const cx = Math.min(viewW() - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(viewH() - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    return !top || el.contains(top) || top.contains(el);
  }

  function collect(now = performance.now()) {
    lastCollect = now;
    byId.clear();
    const buttons = [];
    for (const el of document.querySelectorAll(TARGET_SELECTOR)) {
      const r = el.getBoundingClientRect();
      if (!pressable(el, r)) continue;
      let id = idFor(el);
      if (byId.has(id)) id = `${id}~${nextId++}`; // two buttons with the same data (rare)
      byId.set(id, el);
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      buttons.push({ id, label, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    core.setTargets(buttons);
    core.setViewport(viewW(), viewH());
    let named = [];
    try {
      named = guide?.list?.() ?? [];
    } catch {
      named = [];
    }
    targets = buildTargets(buttons, named);
    sender.update(targets, now);
    return targets;
  }
  const refresh = (now) => (now - lastCollect >= COLLECT_EVERY_MS ? collect(now) : sender.update(targets, now));

  // --- events -> page ------------------------------------------------------------------
  function showProgress(id, p) {
    const el = byId.get(id);
    if (!el || p <= 0) {
      bar.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    bar.hidden = false;
    bar.style.left = `${r.left}px`;
    bar.style.top = `${r.bottom + 2}px`;
    bar.style.width = `${r.width}px`;
    fill.style.width = `${Math.round(p * 100)}%`;
  }

  function showRest(paused) {
    restEl.classList.toggle('paused', paused);
    restTitle.textContent = paused ? 'Paused' : 'Rest';
    restText.textContent = paused ? 'look 1 s: resume' : 'look 1 s: pause';
    live.textContent = paused ? 'Gaze paused.' : 'Gaze resumed.';
    bar.hidden = true;
    if (paused) guide?.attention?.lose?.();
  }

  function showRestIdle() {
    restEl.classList.remove('paused');
    restTitle.textContent = 'Rest';
    restText.textContent = 'look 1 s: pause';
  }

  function press(el) {
    if (!el || el.disabled) return;
    el.focus({ preventScroll: true });
    el.click(); // the button's own handler runs the command
    el.classList.add('gaze-pressed');
    setTimeout(() => el.classList.remove('gaze-pressed'), 250);
  }

  function handle(events) {
    for (const ev of events) {
      if (ev.type === 'progress') showProgress(ev.id, ev.p);
      else if (ev.type === 'activate') {
        press(byId.get(ev.id));
        lastCollect = -Infinity; // the page probably changed
      } else if (ev.type === 'pan') commands.run(`pan_${ev.dir}`, {}, 'gaze');
      else if (ev.type === 'rest') showRest(ev.paused);
      else if (ev.type === 'lost') bar.hidden = true;
    }
  }

  function lost() {
    active = false;
    dot.hidden = true;
    bar.hidden = true;
    if (behaviour.attention) guide?.attention?.lose?.();
    face()?.setGaze?.(null);
  }

  function onSample(d) {
    const now = performance.now();
    const s = { x: d.x, y: d.y, t: now, confidence: Number.isFinite(d.confidence) ? d.confidence : 1 };
    if (typeof d.reply === 'function') sender.setSend(d.reply, d.source ?? d.reply);
    if (!active) lastCollect = -Infinity;
    active = true;
    clearTimeout(lostTimer);
    lostTimer = setTimeout(lost, LOST_MS);
    try {
      face()?.setGaze?.({ x: s.x, y: s.y, confidence: s.confidence });
    } catch (err) {
      console.warn('[gaze] face panel', err);
    }
    refresh(now);

    const usable = s.confidence >= core.options.minConfidence;
    dot.hidden = !behaviour.dot || !usable;
    if (!dot.hidden) dot.style.transform = `translate(${s.x - 9}px, ${s.y - 9}px)`;

    if (behaviour.press) {
      restEl.hidden = false;
      core.setEdgePanning(store.get().view === 'sky');
      handle(core.update(s));
    }
    if (behaviour.attention && !(behaviour.press && core.paused)) guide?.attention?.feed?.(s);
  }

  addEventListener('meridian:gaze', (e) => {
    const d = e.detail;
    if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return;
    onSample(d);
  });

  // --- input mode ------------------------------------------------------------------
  function applyMode(mode) {
    const prev = behaviour;
    behaviour = modeBehaviour(mode);
    guide?.popup?.setAutoHide?.(behaviour.autoHide);
    guide?.attention?.setMouse?.(behaviour.mouseAttention && mouseParam);
    guide?.attention?.setGaze?.(behaviour.attention);
    if (prev.attention && !behaviour.attention) guide?.attention?.lose?.();
    if (!behaviour.press) {
      core.setPaused(false);
      restEl.hidden = true;
      showRestIdle();
      bar.hidden = true;
    }
    if (!behaviour.dot) dot.hidden = true;
    document.body.dataset.input = behaviour.mode;
    if (prev.mode !== behaviour.mode) live.textContent = `Eye control: ${modeText(behaviour.mode)}.`;
  }
  const modeText = (m) => ({ mouse: 'off', assist: 'helps the guide only', gaze: 'full control' })[m];
  store.subscribe((s, changed) => changed.includes('input') && applyMode(s.input));
  applyMode(store.get().input);

  // --- the button list changes: re-collect (throttled), tell the tracker -------------
  let pending = null;
  const scheduleCollect = () => {
    if (!active || pending) return;
    pending = setTimeout(() => {
      pending = null;
      collect();
    }, 120);
  };
  new MutationObserver(scheduleCollect).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['hidden', 'disabled', 'class', 'aria-pressed', 'aria-checked'],
  });
  addEventListener('resize', scheduleCollect);

  // --- mouse simulator (testing without a tracker) -------------------------------------
  // Like a tracker, it sends the mouse position ~30 times a second through the same path, so
  // holding the mouse still is the same as looking (mode B feeds the guide, mode C presses).
  let simOn = false;
  let lastMouse = null;
  addEventListener('mousemove', (e) => (lastMouse = { x: e.clientX, y: e.clientY }));
  setInterval(() => {
    if (simOn && lastMouse) dispatchEvent(new CustomEvent('meridian:gaze', { detail: { ...lastMouse, t: performance.now(), confidence: 1 } }));
  }, 33);
  function setSim(on) {
    simOn = Boolean(on);
    simEl.hidden = !simOn;
    return simOn;
  }

  // --- replay of recorded samples (console, tests) -------------------------------------
  // samples: [{ x, y, t, confidence? }] with t in ms from the start, or { viewport: { w, h }, samples }
  // (positions are then scaled to this window). Resolves 'done' or 'stopped'.
  let replayRun = 0;
  function replay(data, { speed = 1 } = {}) {
    const run = ++replayRun;
    const list = Array.isArray(data) ? data : data?.samples ?? [];
    const vp = Array.isArray(data) ? null : data?.viewport;
    const sx = vp?.w ? viewW() / vp.w : 1;
    const sy = vp?.h ? viewH() / vp.h : 1;
    const t0 = list[0]?.t ?? 0;
    const start = performance.now();
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (run !== replayRun) return resolve('stopped');
        const elapsed = (performance.now() - start) * speed;
        while (i < list.length && list[i].t - t0 <= elapsed) {
          const s = list[i++];
          dispatchEvent(new CustomEvent('meridian:gaze', { detail: { x: s.x * sx, y: s.y * sy, t: s.t, confidence: s.confidence ?? 1 } }));
        }
        if (i >= list.length) return resolve('done');
        setTimeout(step, 15);
      };
      step();
    });
  }

  // --- commands (only the person runs these; the guide may not: personOnly) -----------
  const personOnly = true;
  commands.register(
    'set_input_mode',
    ({ mode } = {}) => {
      const m = parseMode(mode);
      if (!m) return store.get().input; // nothing given: keep the mode
      store.set({ input: m }, 'command');
      return m;
    },
    { label: 'Eye control mode', args: { mode: INPUTS.join(' | ') }, personOnly },
  );
  commands.register(
    'cycle_input_mode',
    () => {
      const m = nextMode(store.get().input);
      store.set({ input: m }, 'command');
      return m;
    },
    { label: 'Change eye control (off, guide only, full)', keys: ['g'], personOnly },
  );
  commands.register('set_dwell', ({ ms } = {}) => core.setDwellMs(Number(ms)), {
    label: 'Gaze press time',
    args: { ms: `${DWELL_MIN}–${DWELL_MAX}` },
    personOnly,
  });
  commands.register('dwell_longer', () => core.setDwellMs(core.options.dwellMs + 100), { label: 'Longer gaze press time', personOnly });
  commands.register('dwell_shorter', () => core.setDwellMs(core.options.dwellMs - 100), { label: 'Shorter gaze press time', personOnly });
  commands.register(
    'toggle_gaze_pause',
    () => {
      core.setPaused(!core.paused);
      showRest(core.paused);
      return core.paused;
    },
    { label: 'Pause / resume gaze', personOnly },
  );
  commands.register('toggle_gaze_sim', () => setSim(!simOn), { label: 'Gaze simulator (mouse as eyes)', personOnly });

  return {
    core,
    replay,
    stop: () => void replayRun++,
    targets: () => collect(),
    setSim,
    mode: () => behaviour.mode,
    get paused() {
      return core.paused;
    },
    get dwellMs() {
      return core.options.dwellMs;
    },
  };
}
