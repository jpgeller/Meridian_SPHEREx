// The AI guide's entry point (docs/UI_AND_GUIDE_PLAN.md). Grows step by step: U2 registry,
// U3 overlay, U4 pop-up, U5 runner... Console: guide.resolve('band-d6'), guide.targetAt(x, y),
// guide.pointAt('band-d6', 'Longest wavelengths'), guide.circle('sky:barnard'), guide.clear(),
// guide.offer({ text: 'Want help identifying this?', onYes, target: 'sky:barnard' }),
// guide.say({ say: '…', answers: ['got_it', 'more', 'close'] }).then((answer) => …),
// guide.run([{ say: '…', actions: [{ circle: 'band-d6' }, { cmd: 'set_band', args: { band: 93 } }] }]).then((how) => …),
// guide.fallback('colours'), guide.fallback('object', { id: 'sky:barnard' }), guide.runner.isRunning(), guide.stop(),
// guide.startGuide('object', { id: 'sky:barnard' }) (asks /api/guide, U7; local fallback on any failure),
// guide.attention.snapshot(), guide.attention.feed({ x, y, confidence }),
// guide.run([{ say: '…', actions: [{ click: 'band-d6' }] }]) (the pointer presses the D6 button),
// guide.ask() (the top-bar Guide button: "What do you want to look at?", command open_guide).
import { createRegistry } from './registry.js';
import { createOverlay, QUIET_SOURCES, FLY_MS } from './overlay.js';
import { createPopup } from './popup.js';
import { createRunner } from './runner.js';
import { fallbackScript } from './fallback.js';
import { startAttention } from './attention.js';
import { askGuide, buildRequest, describeTarget, gatherFacts } from './client.js';
import { centreTarget } from './menu.js';
import { menuCard, identifyTour, motionTour, changeTour, coloursTour, exampleTour, whereTour, noteFor, presetIdOf } from './tours.js';
import { detectorOf } from '../core/bands.js';
import { PRESETS, presetById } from '../sky/presets.js';
import { sanitize } from '../core/state.js';

// An object explained by the model: its first step always shows where the thing is (the pointer flies
// there), even when the reply only circles it.
function pointFirst(steps, trigger, target) {
  if (trigger !== 'object' || !target?.id || !Array.isArray(steps) || !steps.length) return steps;
  const [first, ...rest] = steps;
  if (!first || typeof first !== 'object') return steps;
  const actions = Array.isArray(first.actions) ? first.actions : [];
  if (actions.some((a) => a?.point || a?.click)) return steps;
  return [{ ...first, actions: [{ point: target.id }, ...actions] }, ...rest];
}

export function createGuide({ store, commands, sky, player, spectrum = null, gaze = null }) {
  const skyEl = document.querySelector('#sky');
  let throughPopup = false;
  let popup = null;
  const registry = createRegistry({
    root: document,
    getState: () => store.get(),
    world2pix: (ra, dec) => sky.coords.world2pix(ra, dec),
    pix2world: (x, y) => sky.coords.pix2world(x, y),
    skyRect: () => skyEl.getBoundingClientRect(),
    // a point of the sky counts only if no panel covers it (pointer-events: none layers don't count)
    // (the pop-up asks "would I cover this?", so for its own check it does not count as a panel)
    isSkyVisible: (x, y) => {
      const el = document.elementsFromPoint(x, y).find((e) => !(throughPopup && popup.element.contains(e)));
      return !el || skyEl.contains(el);
    },
    field: player && { canvas: player.elements.canvas, getGeometry: player.getGeometry, getMovers: player.getMovers },
    fetchJson: (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
    viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
    events: window,
  });
  // the pointer parks just left of the pill (or of the card while it is open), as in wireframe v4
  const getHome = () => {
    const card = document.querySelector('.guide-popup:not([hidden])')?.getBoundingClientRect();
    // beside the card's lower-left corner (clear of the search bar), or beside the pill
    if (card?.width > 0) return { x: card.left - 30, y: card.bottom - 26 };
    const pill = document.querySelector('.guide-pill:not([hidden])')?.getBoundingClientRect();
    return pill?.width > 0 ? { x: pill.left - 30, y: pill.top + pill.height / 2 } : null;
  };
  const overlay = createOverlay({ locate: registry.locate, doc: document, events: window, getHome });
  // the pop-up asks "would I cover this?": for that question it looks through itself
  const throughCard = (fn) => {
    throughPopup = true;
    try {
      return fn();
    } finally {
      throughPopup = false;
    }
  };
  popup = createPopup({
    doc: document,
    onPill: () => commands.run('open_guide', {}, 'ui'),
    resolve: (id) => throughCard(() => registry.resolve(id)),
    // the middle of the sky: in the field view, the target in the middle of the image
    getCentre: () => (store.get().view === 'field' ? throughCard(() => registry.resolve('field:target')) : null),
    // the zoomed-in hand-off button: better not covered, but less important than the target
    getAvoid: () => {
      const b = document.querySelector('.handoff')?.getBoundingClientRect();
      return b?.width > 0 ? [{ rect: { x: b.left, y: b.top, w: b.width, h: b.height }, weight: 0.25 }] : [];
    },
  });
  const runner = createRunner({
    say: popup.say,
    dismiss: popup.dismiss,
    overlay,
    run: commands.run,
    list: commands.list,
    sanitize,
    getState: () => store.get(),
    events: window,
    // { click: id }: only a [data-guide] control that is on screen now (not hidden, not covered off)
    findControl: (id) => (registry.resolve(id) ? registry.control(id) : null),
    actingAs: commands.actingAs,
    flyMs: () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : FLY_MS),
    // { wait: 'frames' }: the time-lapse is open and its pictures are on screen; { wait: 'sky' }: the sky is drawn
    waitFor: (what, alive) =>
      new Promise((res) => {
        const ready = () =>
          what === 'sky' ? sky.ready : store.get().view === 'field' && !!player && !player.isLoading() && player.getSequence().length > 0;
        const t = setInterval(() => {
          if (!alive() || ready()) {
            clearInterval(t);
            res();
          }
        }, 150);
      }),
  });
  // trigger: 'object' | 'change' | 'colours'; target: { id, name } or an id
  const fallback = (trigger, target) =>
    runner.runScript(fallbackScript(trigger, target, store.get()), { trigger, target });
  // An accepted offer starts the guide (U7): a "Thinking…" card while /api/guide (Claude) answers,
  // then its script; the fixed local script (U5) on any failure, timeout or empty/invalid reply.
  // Close/Esc on the card, any command the person runs, or guide.stop() cancels the wait.
  let pending = null; // AbortController of the request in flight
  async function startGuide(trigger, target) {
    pending?.abort();
    const ctrl = new AbortController();
    pending = ctrl;
    const t = describeTarget(target);
    let outcome = null;
    const cancel = (how) => {
      if (outcome) return;
      outcome = how;
      ctrl.abort();
    };
    popup.say({ say: 'Thinking…', answers: ['close'], target: t?.id }).then((a) => {
      if (a !== 'replaced') cancel('closed'); // 'replaced' = the script (or fallback) took the card
    });
    const onCommand = (e) => {
      if (e.detail?.ok && !QUIET_SOURCES.has(e.detail.source)) {
        cancel('interrupted');
        popup.dismiss('close');
      }
    };
    window.addEventListener('meridian:command', onCommand);
    let reply;
    try {
      const state = store.get();
      const body = buildRequest({
        trigger,
        target: t,
        state,
        facts: gatherFacts({ state, target: t, player, spectrum, wavelengths: sky.wavelengths }),
        commands: commands.list(),
        ids: registry.list().map((x) => x.id),
      });
      reply = await askGuide(body, { signal: ctrl.signal });
    } catch (err) {
      reply = { fallback: true, reason: String(err?.message ?? err) };
    } finally {
      window.removeEventListener('meridian:command', onCommand);
      if (pending === ctrl) pending = null;
    }
    if (outcome || ctrl.signal.aborted) return outcome ?? 'stopped';
    if (reply.steps) {
      const how = await runner.runScript(pointFirst(reply.steps, trigger, t), { trigger, target: t });
      if (how !== 'empty') return how;
      console.info('[guide] nothing valid in the reply; playing the local script');
    } else console.info(`[guide] using the local script (${reply.reason})`);
    return fallback(trigger, target);
  }
  // The top-bar Guide button (spec 1, P1-2): "What do you want to look at?" with 2-3 buttons for what
  // is in the middle of the view now. An answer starts the guide like an accepted offer.
  // ---- tours (wireframe v4): the guide explains one thought at a time and drives the app ----
  const inField = () => store.get().view === 'field';
  /** What is in the middle of the view now ({ id, name } of a sky object), or null. */
  function centre() {
    if (inField()) {
      const pid = fieldPreset();
      return pid ? { id: `sky:${pid}`, name: presetById(pid).label } : { id: 'field:target' };
    }
    const box = skyEl.getBoundingClientRect();
    const c = inField() ? registry.resolve('field:target') : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    return c ? centreTarget(registry.list(), c, Math.min(window.innerWidth, window.innerHeight) * 0.12) : null;
  }
  /** In the time-lapse: the place whose position is the image's target, if it is one with notes. */
  function fieldPreset() {
    const c = registry.resolve('field:target');
    if (!c) return null;
    for (const p of PRESETS) {
      const q = registry.resolve(`sky:${p.id}`);
      if (q && Math.hypot(q.x - c.x, q.y - c.y) < Math.max(40, c.r ?? 0) && presetIdOf(p.id)) return p.id;
    }
    return null;
  }
  function scriptFor(kind, id) {
    const field = inField();
    const s = store.get();
    if (kind === 'identify') return identifyTour(id, { inField: field });
    if (kind === 'motion') return motionTour(id, { inField: field, atTarget: presetIdOf(centre()?.id) === id });
    if (kind === 'change') return changeTour();
    if (kind === 'colours') return coloursTour({ inField: field });
    if (kind === 'example') return exampleTour();
    if (kind === 'where') return whereTour({ fov: s.fov, detector: detectorOf(s.band).detector });
    return null;
  }
  /** Play a tour, then follow the closing card's answer (Show me -> motion, Show me again, an example…). */
  async function tour(kind, id = null) {
    guide.stop();
    await null; // let the command that asked for this finish first (its event must not end the new tour)
    let how = 'empty';
    for (let hops = 0; hops < 6 && kind; hops++) {
      const script = scriptFor(kind, id);
      if (!script) return 'empty';
      how = await runner.runScript(script, { trigger: kind, target: id });
      if (how === 'show') [kind, id] = kind === 'example' ? ['motion', 'wise_0855'] : ['motion', id];
      else if (how === 'again') continue;
      else if (how === 'example') kind = 'example';
      else if (how === 'colours') kind = 'colours';
      else if (how === 'moving') [kind, id] = ['motion', 'barnard'];
      else if (how === 'back') {
        commands.run('close_field', {}, 'guide');
        return how;
      } else return how;
    }
    return how;
  }
  /** An accepted offer or a click on a sky object: a tour for places with notes, else the API (U7). */
  async function accept(trigger, target) {
    const id = typeof target === 'string' ? target : target?.id;
    if (trigger === 'colours') return tour('colours');
    if (trigger === 'change') return tour('change');
    const pid = id === 'field:target' ? fieldPreset() : presetIdOf(id);
    if (pid) return tour('identify', pid);
    guide.stop();
    await null;
    return startGuide('object', target);
  }
  /** "What am I looking at?": the object in the middle of the view, or the view itself. */
  async function hereTour() {
    const t = centre();
    if (presetIdOf(t?.id)) return tour('identify', presetIdOf(t.id));
    if (t) return accept('object', t);
    return tour('where');
  }
  /** The pill (key A): "What can I show you?" */
  async function ask() {
    guide.stop();
    const a = await popup.say(menuCard());
    if (a === 'here') return hereTour();
    if (a === 'moving') return tour('motion', 'barnard');
    if (a === 'colours') return tour('colours');
    return a;
  }
  commands.register('open_guide', () => void ask(), { label: 'Ask the guide', personOnly: true, keys: ['a'] });
  commands.register(
    'ask_guide',
    ({ id } = {}) => {
      if (id != null && (typeof id !== 'string' || !/^(sky|field):/.test(id))) throw new Error('nothing to ask about');
      void (id ? accept('object', { id }) : hereTour());
    },
    { label: 'Ask the guide about this object', personOnly: true, args: { id: 'optional: sky:<place> or field:target (default: the middle of the view)' } },
  );
  // a click (not a drag) on a sky object asks the guide about it, as in the wireframe
  let down = null;
  skyEl.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }), true);
  skyEl.addEventListener(
    'pointerup',
    (e) => {
      const d = down;
      down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return;
      const id = registry.targetAt(e.clientX, e.clientY, 8);
      if (id && /^sky:/.test(id)) commands.run('ask_guide', { id }, 'ui');
    },
    true,
  );
  overlay.park(); // idle: the pointer waits beside the pill

  const guide = {
    ask,
    tour,
    accept,
    notes: noteFor,
    resolve: registry.resolve,
    locate: registry.locate,
    targetAt: registry.targetAt,
    list: registry.list,
    pointAt: overlay.pointAt,
    circle: overlay.circle,
    highlight: overlay.highlight,
    trail: overlay.trail,
    clear: overlay.clear,
    overlay,
    offer: popup.offer,
    say: popup.say,
    dismiss: popup.dismiss,
    popup,
    run: runner.runScript,
    fallback,
    stop: () => {
      if (pending) {
        pending.abort();
        popup.dismiss('close');
      }
      runner.stop();
    },
    runner,
    startGuide,
  };
  // U6: what the person lingers on -> offers. Always listens for replays (change); dwell needs a
  // source: the mouse with ?gaze=mouse, or gaze samples through guide.attention.feed() (U9).
  guide.attention = startAttention({ guide, startGuide: (t, x) => accept(t, x), store, sky, player, mouse: gaze === 'mouse' });
  return guide;
}
