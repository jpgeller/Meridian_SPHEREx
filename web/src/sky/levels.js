// Brightness and contrast of the map (state.level = [brightness, contrast] in steps).
//
// Aladin Lite has a built-in gesture: right-click drag (on a Mac trackpad, a two-finger click
// held while dragging) changes the display cuts of the map, DS9 style: sideways = brightness,
// up/down = contrast. It's invisible and has no reset, so we read the cuts back after each drag
// into state.level (shown in the panel, in the URL, resettable) and also drive it with commands.
//
// The cuts are display limits over the tile pixel values (PNG tiles: 0..255, Aladin's default).
export const DEFAULT_CUTS = [0, 255];
const BRIGHT_STEP = 0.1; // one brightness step moves the window by 10% of the full range
const CONTRAST_STEP = 0.8; // one contrast step narrows the window to 80%

const r2 = (x) => Math.round(x * 100) / 100;

/** [brightness, contrast] -> [minCut, maxCut] */
export function levelToCuts([b, c], [lo0, hi0] = DEFAULT_CUTS) {
  const range0 = hi0 - lo0;
  const mid = (lo0 + hi0) / 2 - b * BRIGHT_STEP * range0;
  const range = range0 * Math.pow(CONTRAST_STEP, c);
  return [mid - range / 2, mid + range / 2];
}

/** [minCut, maxCut] -> [brightness, contrast] (inverse of levelToCuts) */
export function cutsToLevel([lo, hi], [lo0, hi0] = DEFAULT_CUTS) {
  const range0 = hi0 - lo0;
  const range = Math.max(1e-6, hi - lo);
  const c = Math.log(range / range0) / Math.log(CONTRAST_STEP);
  const b = ((lo0 + hi0) / 2 - (lo + hi) / 2) / (BRIGHT_STEP * range0);
  return [r2(b), r2(c)];
}

const sign = (x) => (x > 0 ? `+${x}` : `${x}`);
/** Short text for the panel, e.g. 'brightness +2 · contrast −1', or '' when unchanged. */
export function describeLevel([b, c]) {
  const parts = [];
  if (Math.abs(b) >= 0.05) parts.push(`brightness ${sign(Math.round(b * 10) / 10)}`);
  if (Math.abs(c) >= 0.05) parts.push(`contrast ${sign(Math.round(c * 10) / 10)}`);
  return parts.join(' · ').replace(/-/g, '−');
}

export function createLevels(aladin, { store }) {
  const layer = () => aladin.getBaseImageLayer?.();
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;

  function apply(level) {
    const l = layer();
    if (!l?.setCuts) return false;
    const want = levelToCuts(level);
    const have = l.getCuts?.() ?? [];
    if (!(Math.abs(have[0] - want[0]) < 1e-3 && Math.abs(have[1] - want[1]) < 1e-3)) l.setCuts(want[0], want[1]);
    return true;
  }

  // After a colour change the base layer is replaced: re-apply once the new one exists.
  let retry = null;
  function applySoon() {
    clearInterval(retry);
    let tries = 0;
    retry = setInterval(() => {
      const l = layer();
      if ((l && l.added !== false && apply(store.get().level)) || ++tries > 40) clearInterval(retry);
    }, 250);
  }

  // Read the cuts back while/after the user right-drags on the sky.
  function readBack() {
    const cuts = layer()?.getCuts?.();
    if (!cuts || !cuts.every(Number.isFinite)) return;
    const level = cutsToLevel(cuts);
    if (!same(level, store.get().level)) store.set({ level }, 'levels');
  }
  const el = aladin.aladinDiv ?? document.querySelector('#sky');
  el.addEventListener('pointermove', (e) => e.buttons & 2 && readBack());
  el.addEventListener('mousemove', (e) => e.buttons & 2 && readBack());
  window.addEventListener('mouseup', (e) => e.button === 2 && readBack());

  store.subscribe((s, changed, source) => {
    if (changed.includes('color') || changed.includes('mix')) applySoon();
    else if (changed.includes('level') && source !== 'levels') apply(s.level);
  });
  applySoon();
  return { apply, readBack };
}
