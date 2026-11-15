// The AI guide's entry point (docs/UI_AND_GUIDE_PLAN.md). Grows step by step: U2 registry,
// U3 overlay, U4 pop-up, U5 runner... Console: guide.resolve('band-d6'), guide.targetAt(x, y).
import { createRegistry } from './registry.js';

export function createGuide({ store, sky, player }) {
  const skyEl = document.querySelector('#sky');
  const registry = createRegistry({
    root: document,
    getState: () => store.get(),
    world2pix: (ra, dec) => sky.coords.world2pix(ra, dec),
    // a point of the sky counts only if no panel covers it (pointer-events: none layers don't count)
    isSkyVisible: (x, y) => {
      const el = document.elementFromPoint(x, y);
      return !el || skyEl.contains(el);
    },
    field: player && { canvas: player.elements.canvas, getGeometry: player.getGeometry, getMovers: player.getMovers },
    fetchJson: (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
    viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
    events: window,
  });
  return { resolve: registry.resolve, targetAt: registry.targetAt, list: registry.list };
}
