// The AI guide's entry point (docs/UI_AND_GUIDE_PLAN.md). Grows step by step: U2 registry,
// U3 overlay, U4 pop-up, U5 runner... Console: guide.resolve('band-d6'), guide.targetAt(x, y),
// guide.pointAt('band-d6', 'Longest wavelengths'), guide.circle('sky:barnard'), guide.clear(),
// guide.offer({ text: 'Want help identifying this?', onYes, target: 'sky:barnard' }),
// guide.say({ say: '…', answers: ['got_it', 'more', 'close'] }).then((answer) => …),
// guide.run([{ say: '…', actions: [{ circle: 'band-d6' }, { cmd: 'set_band', args: { band: 93 } }] }]).then((how) => …),
// guide.fallback('colours'), guide.fallback('object', { id: 'sky:barnard' }), guide.runner.isRunning(), guide.stop().
import { createRegistry } from './registry.js';
import { createOverlay } from './overlay.js';
import { createPopup } from './popup.js';
import { createRunner } from './runner.js';
import { fallbackScript } from './fallback.js';
import { sanitize } from '../core/state.js';

export function createGuide({ store, commands, sky, player }) {
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
  popup = createPopup({
    doc: document,
    resolve: (id) => {
      throughPopup = true;
      try {
        return registry.resolve(id);
      } finally {
        throughPopup = false;
      }
    },
    // the middle of the sky: in the field view, the target in the middle of the image
    getCentre: () => (store.get().view === 'field' ? registry.resolve('field:target') : null),
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
  return {
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
    stop: () => runner.stop(),
    runner,
  };
}
