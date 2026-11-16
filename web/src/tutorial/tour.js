// The guided tour (mouse mode, eye control off). When the page opens for the first time it asks
// "Want a quick tour?"; the tour then moves a drawn mouse cursor to each control, rings it, explains it
// in a caption card and presses it where pressing shows something (a place, a colour view, a band, the
// time-lapse, Blink, Play). The steps live in tourScript.js.
//
// Rules kept: every action is a command (start_tour, skip_tour, stop_tour, tour_next, tour_prev, tour_pause;
// key H starts it); the card's controls are real <button>s, 64 px (global rule) and 6 % from the screen
// edges, so a gaze user can press them too. The cursor presses the real buttons through el.click() inside
// commands.actingAs('guide'): their own handlers run their commands, reported as the guide's, so the
// proactive guide stays quiet. While the tour runs the guide is held (no offers). Anything the person does
// themselves (a button, a key) pauses the tour; Esc or Stop ends it. Reduced motion: the cursor jumps.
//
// Console: meridian.tour.start(), .stop(), .step() (index), .running().
import './tour.css';
import { STEPS, STORAGE_KEY, TOUR_KEY, shouldOffer, readMs, placeCard, glideMs } from './tourScript.js';
import { easeInOutCubic, flyPoint } from '../guide/overlay.js';
import { FIELD_OPEN_MAX_FOV } from '../core/defaultCommands.js';

const PERSON_SOURCES = new Set(['ui', 'keyboard', 'key', 'gaze', 'message']);
const OWN_COMMANDS = new Set(['start_tour', 'skip_tour', 'stop_tour', 'tour_next', 'tour_prev', 'tour_pause']);
const CURSOR_SVG =
  '<svg viewBox="0 0 24 30" aria-hidden="true"><path d="M2 2 L2 23 L7.6 17.6 L11.3 26.4 L15.1 24.8 L11.5 16.2 L19 16.2 Z" fill="#fff" stroke="#05070f" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const TYPE_MS = 90; // per letter
const PRESS_MS = 180;

export function createTour({ store, commands, sky = null, player = null, guide = null, params = null, doc = document, win = window }) {
  const storage = (() => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  })();
  const remember = (v) => {
    try {
      storage?.setItem(STORAGE_KEY, v);
    } catch {
      /* private mode: it will ask again next time */
    }
  };
  const reduced = () => !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const edges = () => ({ x: win.innerWidth * 0.06 + 4, y: win.innerHeight * 0.06 + 4 });

  // ---- DOM: welcome card, caption card, cursor, ring ----------------------------------------------
  const welcome = doc.createElement('section');
  welcome.className = 'tour-card tour-welcome';
  welcome.setAttribute('role', 'dialog');
  welcome.setAttribute('aria-labelledby', 'tour-welcome-title');
  welcome.hidden = true;
  welcome.innerHTML = `
    <h2 id="tour-welcome-title" class="tour-title">Welcome to Meridian</h2>
    <p class="tour-say">A sky made of real SPHEREx infrared images. New here? A short tour moves a cursor to each
      control and shows what it does (about 2 minutes, with eye control off).</p>
    <div class="tour-buttons">
      <button type="button" class="tour-primary" id="tour-yes" title="Start the tour of the controls (key H)">Show me around</button>
      <button type="button" id="tour-no" title="Skip the tour; key H starts it any time">No thanks</button>
    </div>
    <p class="tour-foot">Press <kbd>H</kbd> any time to start it later.</p>`;

  const card = doc.createElement('section');
  card.className = 'tour-card tour-step';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Tour of the controls');
  card.hidden = true;
  card.innerHTML = `
    <div class="tour-head"><span class="tour-count" id="tour-count"></span><span class="tour-state" id="tour-state"></span></div>
    <h2 class="tour-title" id="tour-title"></h2>
    <p class="tour-say" id="tour-say" aria-live="polite"></p>
    <div class="tour-bar" aria-hidden="true"><div class="tour-fill" id="tour-fill"></div></div>
    <div class="tour-buttons">
      <button type="button" id="tour-prev" title="Go back one step">Back</button>
      <button type="button" id="tour-pause" title="Pause or continue the tour">Pause</button>
      <button type="button" class="tour-primary" id="tour-next" title="Go on to the next step">Next</button>
      <button type="button" id="tour-stop" title="End the tour (Esc)">Stop</button>
    </div>`;

  const cursor = doc.createElement('div');
  cursor.className = 'tour-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.hidden = true;
  cursor.innerHTML = `${CURSOR_SVG}<span class="tour-click"></span>`;

  const ring = doc.createElement('div');
  ring.className = 'tour-ring';
  ring.setAttribute('aria-hidden', 'true');
  ring.hidden = true;

  doc.body.append(ring, cursor, welcome, card);
  const $ = (id) => doc.getElementById(id);

  welcome.querySelector('#tour-yes').addEventListener('click', () => commands.run('start_tour', {}, 'ui'));
  welcome.querySelector('#tour-no').addEventListener('click', () => commands.run('skip_tour', {}, 'ui'));
  $('tour-prev').addEventListener('click', () => commands.run('tour_prev', {}, 'ui'));
  $('tour-pause').addEventListener('click', () => commands.run('tour_pause', {}, 'ui'));
  $('tour-next').addEventListener('click', () => commands.run('tour_next', {}, 'ui'));
  $('tour-stop').addEventListener('click', () => commands.run('stop_tour', {}, 'ui'));

  // ---- state ----------------------------------------------------------------------------------------
  let running = false;
  let index = 0;
  let paused = false;
  let gen = 0; // each step (and stop) bumps it: older async work sees it and gives up
  let pos = { x: win.innerWidth / 2, y: win.innerHeight / 2 };
  let ringEl = null; // the element the ring follows
  let raf = 0;
  const pending = new Map(); // async commands still running (fly_to by name...)

  win.addEventListener('meridian:command-start', (e) => {
    const n = e.detail?.name;
    if (n) pending.set(n, (pending.get(n) ?? 0) + 1);
  });
  win.addEventListener('meridian:command', (e) => {
    const d = e.detail ?? {};
    if (pending.get(d.name) > 0) pending.set(d.name, pending.get(d.name) - 1);
    // the person took over (a button, a key, gaze): pause, so the tour does not fight them
    if (running && !paused && PERSON_SOURCES.has(d.source) && !OWN_COMMANDS.has(d.name)) setPaused(true, 'you took over');
  });

  // ---- helpers --------------------------------------------------------------------------------------
  const live = (g) => running && g === gen;
  const frame = () => new Promise((r) => win.requestAnimationFrame(() => r()));

  /** Wait `ms`, not counting paused time. false if the step was left meanwhile. */
  async function sleep(ms, g, onProgress) {
    let left = ms;
    let last = win.performance.now();
    while (left > 0) {
      await frame();
      if (!live(g)) return false;
      const now = win.performance.now();
      if (!paused) left -= now - last;
      last = now;
      onProgress?.(Math.max(0, left) / ms);
    }
    return live(g);
  }
  async function until(test, g, { min = 600, max = 20000 } = {}) {
    if (!(await sleep(min, g))) return false;
    const t0 = win.performance.now();
    while (!test() && win.performance.now() - t0 < max) {
      if (!(await sleep(150, g))) return false;
    }
    return live(g);
  }

  function find(sel) {
    if (!sel) return null;
    const el = doc.querySelector(sel);
    if (!el || (el.checkVisibility && !el.checkVisibility())) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right < 0 || r.bottom < 0 || r.left > win.innerWidth || r.top > win.innerHeight) return null;
    return el;
  }
  /** Where the cursor's tip goes on an element: its middle (a text field: near its start; the sky: off-centre). */
  function aim(el) {
    const r = el.getBoundingClientRect();
    if (el.id === 'sky') return { x: r.left + r.width * 0.62, y: r.top + r.height * 0.42 };
    if (el.tagName === 'INPUT' && el.type === 'text') return { x: r.left + Math.min(40, r.width / 3), y: r.top + r.height / 2 };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function drawCursor(p) {
    pos = p;
    cursor.style.transform = `translate(${p.x - 3}px, ${p.y - 3}px)`;
  }
  async function glide(to, g, ms = null) {
    const from = { ...pos };
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    if (reduced() || d < 2) {
      drawCursor(to);
      return live(g);
    }
    const total = ms ?? glideMs(d);
    const t0 = win.performance.now();
    for (;;) {
      await frame();
      if (!live(g)) return false;
      const t = Math.min(1, (win.performance.now() - t0) / total);
      drawCursor(flyPoint(from, to, easeInOutCubic(t)));
      if (t >= 1) return true;
    }
  }
  async function press(el, g) {
    if (!(await glide(aim(el), g))) return false;
    cursor.classList.remove('pressing');
    void cursor.offsetWidth; // restart the click animation
    cursor.classList.add('pressing');
    if (!(await sleep(PRESS_MS, g))) return false;
    // the button's own handler runs its command; reported as the guide's (quiet for the proactive guide)
    commands.actingAs('guide', () => {
      el.focus?.({ preventScroll: true });
      el.click();
    });
    el.blur?.(); // hand the keyboard back to the page (keys keep working)
    return sleep(PRESS_MS, g);
  }

  function followRing() {
    win.cancelAnimationFrame(raf);
    const tick = () => {
      if (!ringEl || !ringEl.isConnected) {
        ring.hidden = true;
        return;
      }
      const r = ringEl.getBoundingClientRect();
      const big = r.width > win.innerWidth * 0.6 && r.height > win.innerHeight * 0.6;
      ring.hidden = big || r.width < 2;
      ring.style.transform = `translate(${r.left - 6}px, ${r.top - 6}px)`;
      ring.style.width = `${r.width + 12}px`;
      ring.style.height = `${r.height + 12}px`;
      raf = win.requestAnimationFrame(tick);
    };
    tick();
  }

  function placeCardBeside(el) {
    const r = el?.getBoundingClientRect() ?? null;
    const cr = card.getBoundingClientRect();
    const p = placeCard(r, { w: cr.width || 380, h: cr.height || 220 }, { w: win.innerWidth, h: win.innerHeight }, edges());
    card.style.left = `${Math.round(p.left)}px`;
    card.style.top = `${Math.round(p.top)}px`;
  }

  function setPaused(on, why = '') {
    paused = !!on;
    card.classList.toggle('is-paused', paused);
    $('tour-pause').textContent = paused ? 'Continue' : 'Pause';
    $('tour-state').textContent = paused ? `Paused${why ? `: ${why}` : ''}` : '';
  }

  function showCard(step, i) {
    const last = i === STEPS.length - 1;
    $('tour-count').textContent = `${i + 1} / ${STEPS.length}`;
    $('tour-title').textContent = step.title;
    $('tour-say').textContent = step.say;
    $('tour-prev').disabled = i === 0;
    $('tour-pause').hidden = last;
    $('tour-next').textContent = last ? 'Done' : 'Next';
    $('tour-stop').hidden = last;
    card.querySelector('.tour-bar').hidden = step.ms === 0;
    $('tour-fill').style.transform = 'scaleX(1)';
    card.hidden = false;
  }

  /** Put back what the person had in the search box before the cursor typed its example. */
  function restoreSearch() {
    const input = doc.querySelector('#search-input');
    if (!input || !('tourSaved' in input.dataset)) return;
    input.value = input.dataset.tourSaved;
    delete input.dataset.tourSaved;
    input.blur();
  }

  // ---- the steps ----------------------------------------------------------------------------------
  async function act(a, el, g) {
    if ('click' in a) {
      const target = a.click ? find(a.click) : el;
      return target ? press(target, g) : live(g);
    }
    if ('type' in a) {
      if (a.into) el = find(a.into);
      if (!el || el.tagName !== 'INPUT') return live(g);
      if (!('tourSaved' in el.dataset)) el.dataset.tourSaved = el.value;
      el.value = '';
      for (const ch of a.type) {
        el.value += ch;
        if (!(await sleep(reduced() ? 0 : TYPE_MS, g))) return false;
      }
      return true;
    }
    if ('restore' in a) {
      restoreSearch();
      return live(g);
    }
    if ('drag' in a) {
      const [dx, dy] = a.drag;
      const start = { ...pos };
      cursor.classList.add('dragging');
      const times = a.times ?? 1;
      for (let k = 1; k <= times; k++) {
        commands.actingAs('guide', () => commands.run(a.cmd, a.args ?? {}, 'guide'));
        const ok = await glide({ x: start.x + (dx * k) / times, y: start.y + (dy * k) / times }, g, 380);
        if (!ok) return false;
      }
      cursor.classList.remove('dragging');
      return sleep(300, g);
    }
    if ('cmd' in a) {
      commands.actingAs('guide', () => commands.run(a.cmd, a.args ?? {}, 'guide'));
      return live(g);
    }
    if ('wait' in a) {
      if (a.wait === 'sky') return until(() => (sky ? sky.ready !== false : true) && ![...pending.values()].some((n) => n > 0), g, { min: 1500, max: 12000 });
      if (a.wait === 'frames') {
        return until(() => store.get().view === 'field' && (player?.getSequence?.().length ?? 1) > 0 && !player?.isLoading?.(), g, { min: 1200, max: 30000 });
      }
      return sleep(Number(a.wait) || 0, g);
    }
    return live(g);
  }

  /** Bring the view a step needs (Back from the 2D view returns to the sky; Next into it opens it). */
  async function ensureView(view, g) {
    const now = store.get().view;
    if (view === now) return true;
    if (view === 'field' && !(store.get().fov < FIELD_OPEN_MAX_FOV)) return false; // zoomed out: no time-lapse to open
    const name = view === 'field' ? 'open_field' : 'close_field';
    const r = commands.actingAs('guide', () => commands.run(name, {}, 'guide'));
    if (!r.ok) return false;
    return act({ wait: view === 'field' ? 'frames' : 'sky' }, null, g);
  }

  async function play(i, dir = 1) {
    const g = ++gen;
    restoreSearch(); // Next while the cursor was still typing
    // a step for the other view: switch to it; if that cannot be done (zoomed out too far for the
    // time-lapse), skip it in the direction of travel
    while (i >= 0 && i < STEPS.length && STEPS[i].view !== store.get().view && STEPS[i].id !== 'end') {
      if (await ensureView(STEPS[i].view, g)) break;
      if (!live(g)) return;
      i += dir;
    }
    if (i < 0) i = 0;
    if (i >= STEPS.length) return stop('done');
    index = i;
    const step = STEPS[i];
    const el = find(step.target);
    ringEl = el && el.id !== 'sky' ? el : null;
    showCard(step, i);
    placeCardBeside(el);
    followRing();
    cursor.hidden = !el; // no target (the last card): no cursor
    if (el) {
      if (!(await glide(aim(el), g))) return;
      for (const a of step.do ?? []) {
        if (!(await act(a, el, g))) return;
        while (paused && live(g)) await sleep(200, g); // pausing also holds the next press
      }
    }
    if (step.ms === 0) return; // the last card waits for Done
    const ok = await sleep(step.ms ?? readMs(step.say), g, (left) => ($('tour-fill').style.transform = `scaleX(${left})`));
    if (ok) play(i + 1, 1);
  }

  // ---- public ---------------------------------------------------------------------------------------
  function hideWelcome() {
    welcome.hidden = true;
  }
  function offer() {
    if (running) return;
    welcome.hidden = false;
  }
  async function start() {
    hideWelcome();
    remember('done');
    guide?.hold?.(true);
    // the tour is the mouse version: eye control off
    if (store.get().input !== 'mouse') commands.run('set_input_mode', { mode: 'mouse' }, 'tour');
    if (store.get().view !== 'sky') commands.run('close_field', {}, 'tour');
    if (doc.querySelector('#side-panel')?.hidden) commands.run('toggle_panel', { open: true }, 'tour');
    running = true;
    setPaused(false);
    card.classList.add('is-on');
    drawCursor({ x: win.innerWidth / 2, y: win.innerHeight / 2 });
    await frame(); // let the panel and the view settle before measuring
    play(0, 1);
  }
  function stop(why = 'stopped') {
    if (!running) return why;
    running = false;
    gen++;
    paused = false;
    ringEl = null;
    win.cancelAnimationFrame(raf);
    card.hidden = true;
    cursor.hidden = true;
    ring.hidden = true;
    cursor.classList.remove('pressing', 'dragging');
    restoreSearch();
    guide?.hold?.(false);
    return why;
  }

  commands.register('start_tour', () => void start(), { label: 'Tour of the controls', keys: [TOUR_KEY], personOnly: true });
  commands.register(
    'skip_tour',
    () => {
      hideWelcome();
      remember('skipped');
    },
    { label: 'No tour, thanks' },
  );
  commands.register('stop_tour', () => (hideWelcome(), stop()), { label: 'End the tour' });
  commands.register(
    'tour_next',
    () => {
      if (!running) return;
      if (index >= STEPS.length - 1) return void stop('done');
      setPaused(false);
      play(index + 1, 1);
    },
    { label: 'Tour: next step' },
  );
  commands.register(
    'tour_prev',
    () => {
      if (!running) return;
      setPaused(false);
      play(Math.max(0, index - 1), -1);
    },
    { label: 'Tour: previous step' },
  );
  commands.register('tour_pause', () => running && setPaused(!paused), { label: 'Tour: pause / continue' });

  // Esc ends the tour (before the page's own Esc, which would close the 2D view)
  win.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || (!running && welcome.hidden)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      commands.run(running ? 'stop_tour' : 'skip_tour', {}, 'keyboard');
    },
    true,
  );
  win.addEventListener('resize', () => {
    if (running) placeCardBeside(ringEl);
  });

  // first visit: ask once the page is up
  let stored = null;
  try {
    stored = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (shouldOffer({ params: params ?? new URLSearchParams(win.location.search), stored, webdriver: !!win.navigator?.webdriver })) {
    win.setTimeout(() => store.get().view === 'sky' && offer(), 900);
  }

  return { start, stop, offer, running: () => running, step: () => index, steps: STEPS, elements: { card, welcome, cursor, ring } };
}
