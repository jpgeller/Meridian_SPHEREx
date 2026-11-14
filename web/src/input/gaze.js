// Gaze adapter: connects gaze samples (from the eye tracker, or the mouse simulator) to the
// page. The decisions live in gazeCore.js; this file finds the targets on screen, draws the
// feedback and turns intentions into clicks and commands.
//
//   tracker -> postMessage({type:'gaze', x, y, confidence, t}) -> messages.js -> 'meridian:gaze'
//   -> gazeCore -> press a button (its click handler runs the command) / pan / pause
//   app -> tracker: {type:'targets', items:[{id,label,x,y,w,h}]} whenever the buttons move
//
// Targets: visible buttons, radio buttons and date chips in Meridian's own panels, plus
// anything marked [data-gaze]. Text fields and sliders are left to keyboard/voice/commands.
import { createGazeCore, DWELL_MIN, DWELL_MAX } from './gazeCore.js';

const TARGET_SELECTOR = [
  '#ui button', '#handoff button', '#field-root button', '[data-gaze]',
].join(',');
const SEND_TARGETS_EVERY_MS = 500;
// innerWidth/innerHeight can read 0 in hidden or embedded frames; fall back to the document size.
const viewW = () => innerWidth || document.documentElement.clientWidth;
const viewH = () => innerHeight || document.documentElement.clientHeight;

export function startGaze({ store, commands, simulate = false }) {
  const core = createGazeCore({ canPan: (p) => isOverSky(p) });
  const ids = new WeakMap();
  const byId = new Map();
  let nextId = 1;
  let reply = null; // channel back to the tracker that sent the last sample
  let lastSentTargets = '';
  let lastSendT = -Infinity; // not 0: on a fast page load the first list would be throttled away
  let active = false; // any gaze received yet (feedback stays hidden until then)

  // --- feedback layer ------------------------------------------------------------------
  const layer = document.createElement('div');
  layer.className = 'gaze-layer';
  layer.innerHTML = `
    <div class="gaze-dot" hidden></div>
    <div class="gaze-bar" hidden><div class="gaze-bar-fill"></div></div>
    <div class="gaze-rest" hidden role="status" aria-live="polite">
      <strong>Rest</strong><span id="gaze-rest-text">Look here for 1 s to pause gaze</span>
    </div>
    <div class="gaze-sim" hidden>Gaze simulator: the mouse acts as your eyes · <kbd>g</kbd> to stop</div>`;
  document.body.append(layer);
  const dot = layer.querySelector('.gaze-dot');
  const bar = layer.querySelector('.gaze-bar');
  const fill = layer.querySelector('.gaze-bar-fill');
  const restEl = layer.querySelector('.gaze-rest');
  const restText = layer.querySelector('#gaze-rest-text');
  const simEl = layer.querySelector('.gaze-sim');

  function isOverSky(p) {
    const el = document.elementFromPoint(p.x, p.y);
    return Boolean(el && el.closest('#sky') && !el.closest('.aladin-ui, button, a, input, select'));
  }

  // --- targets ---------------------------------------------------------------------
  function idFor(el) {
    if (!ids.has(el)) ids.set(el, `t${nextId++}`);
    return ids.get(el);
  }

  function collectTargets() {
    byId.clear();
    const list = [];
    for (const el of document.querySelectorAll(TARGET_SELECTOR)) {
      if (el.disabled || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > viewH() || r.left > viewW()) continue;
      const id = idFor(el);
      byId.set(id, el);
      list.push({ id, x: r.left, y: r.top, w: r.width, h: r.height, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) });
    }
    core.setTargets(list);
    core.setViewport(viewW(), viewH());
    sendTargets(list);
    return list;
  }

  function sendTargets(list) {
    if (!reply) return;
    const now = performance.now();
    const json = JSON.stringify(list.map(({ id, x, y, w, h }) => [id, Math.round(x), Math.round(y), Math.round(w), Math.round(h)]));
    if (json === lastSentTargets || now - lastSendT < SEND_TARGETS_EVERY_MS) return;
    lastSentTargets = json;
    lastSendT = now;
    reply({ type: 'targets', items: list.map(({ id, label, x, y, w, h }) => ({ id, label, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })) });
  }

  let pending = null;
  const scheduleCollect = () => {
    clearTimeout(pending);
    pending = setTimeout(collectTargets, 120);
  };
  new MutationObserver(scheduleCollect).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'class', 'aria-pressed', 'aria-checked'] });
  addEventListener('resize', scheduleCollect);
  setInterval(() => active && collectTargets(), 1000); // layout can shift without DOM changes

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

  function handle(events) {
    for (const ev of events) {
      if (ev.type === 'progress') showProgress(ev.id, ev.p);
      else if (ev.type === 'activate') {
        const el = byId.get(ev.id);
        if (el && !el.disabled) {
          el.focus({ preventScroll: true });
          el.click(); // the button's own handler runs the command
          el.classList.add('gaze-pressed');
          setTimeout(() => el.classList.remove('gaze-pressed'), 250);
        }
        scheduleCollect();
      } else if (ev.type === 'pan') commands.run(`pan_${ev.dir}`, {}, 'gaze');
      else if (ev.type === 'rest') {
        restEl.classList.toggle('paused', ev.paused);
        restText.textContent = ev.paused ? 'Gaze paused · look here for 1 s to resume' : 'Look here for 1 s to pause gaze';
        bar.hidden = true;
      } else if (ev.type === 'lost') bar.hidden = true;
    }
  }

  function onSample(s) {
    if (!active) {
      active = true;
      restEl.hidden = false;
      collectTargets();
    }
    dot.hidden = false;
    dot.style.transform = `translate(${s.x - 9}px, ${s.y - 9}px)`;
    core.setEdgePanning(store.get().view === 'sky');
    handle(core.update(s));
  }

  addEventListener('meridian:gaze', (e) => {
    const d = e.detail;
    if (d.reply) reply = d.reply;
    onSample({ x: d.x, y: d.y, t: Number.isFinite(d.t) ? d.t : performance.now(), confidence: d.confidence ?? 1 });
  });

  // --- mouse simulator (for testing without the tracker) ------------------------------
  // Like a tracker, it sends the current position ~30 times a second, so holding the mouse
  // still over a button is the same as looking at it.
  let simOn = false;
  let lastMouse = null;
  addEventListener('mousemove', (e) => (lastMouse = { x: e.clientX, y: e.clientY }));
  setInterval(() => {
    if (simOn && lastMouse) dispatchEvent(new CustomEvent('meridian:gaze', { detail: { ...lastMouse, t: performance.now(), confidence: 1 } }));
  }, 33);
  function setSim(on) {
    simOn = on;
    simEl.hidden = !on;
    if (!on) {
      dot.hidden = true;
      bar.hidden = true;
    }
  }

  // --- commands --------------------------------------------------------------------
  commands.register('toggle_gaze_sim', () => setSim(!simOn), { label: 'Gaze simulator (mouse as eyes)', keys: ['g'] });
  commands.register(
    'set_dwell',
    ({ ms }) => {
      const v = core.setDwellMs(Number(ms));
      return v;
    },
    { label: 'Gaze dwell time', args: { ms: `${DWELL_MIN}–${DWELL_MAX}` } },
  );
  commands.register('dwell_longer', () => core.setDwellMs(core.options.dwellMs + 100), { label: 'Longer dwell time' });
  commands.register('dwell_shorter', () => core.setDwellMs(core.options.dwellMs - 100), { label: 'Shorter dwell time' });
  commands.register(
    'toggle_gaze_pause',
    () => {
      core.setPaused(!core.paused);
      handle([{ type: 'rest', paused: core.paused }]);
      return core.paused;
    },
    { label: 'Pause / resume gaze' },
  );

  if (simulate) setSim(true);
  return { core, collectTargets, setSim, get dwellMs() { return core.options.dwellMs; } };
}
