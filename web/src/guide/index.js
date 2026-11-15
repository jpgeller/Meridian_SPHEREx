// The AI guide's entry point (docs/UI_AND_GUIDE_PLAN.md). Grows step by step: U2 registry,
// U3 overlay, U4 pop-up, U5 runner... Console: guide.resolve('band-d6'), guide.targetAt(x, y),
// guide.pointAt('band-d6', 'Longest wavelengths'), guide.circle('sky:barnard'), guide.clear(),
// guide.offer({ text: 'Want help identifying this?', onYes, target: 'sky:barnard' }),
// guide.say({ say: '…', answers: ['got_it', 'more', 'close'] }).then((answer) => …),
// guide.run([{ say: '…', actions: [{ circle: 'band-d6' }, { cmd: 'set_band', args: { band: 93 } }] }]).then((how) => …),
// guide.fallback('colours'), guide.fallback('object', { id: 'sky:barnard' }), guide.runner.isRunning(), guide.stop(),
// guide.startGuide('object', { id: 'sky:barnard' }) (asks /api/guide, U7; local fallback on any failure),
// guide.attention.snapshot(), guide.attention.feed({ x, y, confidence }).
import { createRegistry } from './registry.js';
import { createOverlay, QUIET_SOURCES } from './overlay.js';
import { createPopup } from './popup.js';
import { createRunner } from './runner.js';
import { fallbackScript } from './fallback.js';
import { startAttention } from './attention.js';
import { askGuide, buildRequest, describeTarget, gatherFacts } from './client.js';
import { sanitize } from '../core/state.js';

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
  const overlay = createOverlay({ locate: registry.locate, doc: document, events: window });
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
      const how = await runner.runScript(reply.steps, { trigger, target: t });
      if (how !== 'empty') return how;
      console.info('[guide] nothing valid in the reply; playing the local script');
    } else console.info(`[guide] using the local script (${reply.reason})`);
    return fallback(trigger, target);
  }
  const guide = {
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
  guide.attention = startAttention({ guide, startGuide: (t, x) => guide.startGuide(t, x), store, sky, player, mouse: gaze === 'mouse' });
  return guide;
}
