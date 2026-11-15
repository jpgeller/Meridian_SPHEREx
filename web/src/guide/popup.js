// Guide pop-up card (UI plan, U4): one small card at the top right that carries the guide's words.
//
//   offer({ text, onYes, onNo?, target?, key? }) -> Promise<'yes'|'no'|'timeout'|'dismissed'|'replaced'|'cooling'|'busy'>
//        One line + "Yes" / "No thanks". Hides itself after AUTO_HIDE_MS if ignored (unless auto-hide
//        is off: gaze mode, U9), and the same target (or key, or text) is not offered again for
//        COOLDOWN_MS, whatever the outcome. Not shown while another card is open ('busy').
//        Offers are local: nothing here calls the API.
//   say(step) -> Promise<answer id>       step = 'text' | { say, answers?, target? }
//        The explanation (about 40 words) + 1 to 3 answer buttons. answers: ids or labels, e.g.
//        ['got_it', 'more', 'close'] -> "Got it" / "Show me more" / "Close" (default: ['got_it']).
//        Resolves with the id pressed, 'close' for Esc, 'replaced' when a newer card takes its place.
//        Steps never auto-hide.
//   dismiss(reason?)  isOpen()  kind() -> 'offer'|'step'|null  spot()  setAutoHide(bool)  cooldown
//
// Placement: the card sits top right, and moves (it never shrinks) when it would cover the sky's
// centre, its `target` or the hand-off button: to the first clear spot of top right, top left,
// above the dock on the right, above the dock on the left (never the bottom-right corner: Aladin's
// logo). Re-checked every 250 ms; it moves only when its own spot becomes blocked (no jitter).
//
// Every button is a real <button>; Tab reaches them (the card is the first thing in the page),
// Esc closes the card before anything else hears the key. The words go through an aria-live region.
// U10: the first Tab after a card opens goes to its first answer wherever the focus was (e.g. deep in
// the time-lapse), so one "next" key + one "press" key always finish the guide; a second Tab leaves
// the card as usual. Not while typing in a field (Tab there keeps its meaning).

import { hits } from './overlay.js';

export const AUTO_HIDE_MS = 12000;
export const COOLDOWN_MS = 60000;
export const MAX_WORDS = 45; // "about 40": longer steps are cut with an ellipsis
export const MAX_ANSWERS = 3;
export const ANSWERS = { got_it: 'Got it', more: 'Show me more', close: 'Close' };
const LEAVE_MS = 160;
const CHECK_MS = 250; // how often an open card re-checks what it covers
export const TARGET_PAD = 24; // px around a point target (the pointer and ring sit there too)

// --- pure helpers (unit-tested) --------------------------------------------------------

/** Cut `text` to `max` words. -> { text, clipped } */
export function clipWords(text, max = MAX_WORDS) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return { text: words.join(' '), clipped: false };
  return { text: `${words.slice(0, max).join(' ').replace(/[,;:.!?]+$/, '')}…`, clipped: true };
}

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const LABEL_TO_ID = Object.fromEntries(Object.entries(ANSWERS).map(([id, label]) => [slug(label), id]));

/** Answer buttons: ids, labels or {id, label} -> [{ id, label }], 1 to MAX_ANSWERS, no duplicates. */
export function normaliseAnswers(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    let id;
    let label;
    if (typeof a === 'string') {
      id = ANSWERS[a] ? a : (LABEL_TO_ID[slug(a)] ?? slug(a));
      label = ANSWERS[id] ?? a.trim();
    } else if (a && typeof a === 'object') {
      id = a.id != null ? slug(a.id) : slug(a.label ?? '');
      label = String(a.label ?? ANSWERS[id] ?? a.id ?? '').trim();
    }
    if (id && label && !out.some((o) => o.id === id)) out.push({ id, label });
    if (out.length === MAX_ANSWERS) break;
  }
  return out.length ? out : [{ id: 'got_it', label: ANSWERS.got_it }];
}

/** The middle of the sky that the card must leave free: a disc of 10% of the short side. */
export function centreZone(viewport, centre) {
  const c = centre ?? { x: viewport.w / 2, y: viewport.h / 2 };
  return { x: c.x, y: c.y, r: Math.min(viewport.w, viewport.h) * 0.1 };
}

/** Area of `rect` that a shape's box (a circle's bounding square) covers. */
function overlapArea(rect, s) {
  const b = s.rect ?? { x: s.x - (s.r ?? 0), y: s.y - (s.r ?? 0), w: 2 * (s.r ?? 0), h: 2 * (s.r ?? 0) };
  const ix = Math.max(0, Math.min(rect.x + rect.w, b.x + b.w) - Math.max(rect.x, b.x));
  const iy = Math.max(0, Math.min(rect.y + rect.h, b.y + b.h) - Math.max(rect.y, b.y));
  return ix * iy;
}

/**
 * Where the card may go, in order of preference. -> [{ id, rect }]
 * Sky: top right (default), top left (below Aladin's buttons, over the places column, clear of the
 * search bar), above the dock on its right (left of the tools column) and on its left. Never the
 * bottom-right corner (Aladin's logo). Field view: top right 72 px down (below "Back to sky"),
 * then the right and left sides of the image, half way down.
 * @param {Object} o  { viewport: {w, h}, size: {w, h}, field: bool, layout: { edge, leftTop, leftW,
 *                    toolsW, dockTop, dockLeft, dockRight } }
 */
export function spotRects({ viewport, size, field = false, layout = {} }) {
  const { w: vw, h: vh } = viewport;
  const { w, h } = size;
  const L = { edge: 12, leftTop: 116, leftW: 264, toolsW: 284, ...layout };
  const e = L.edge;
  // distance from the screen edges (6% for eye tracking; `edge` when not given)
  const ex = L.edgeX ?? e;
  const ey = L.edgeY ?? e;
  const dockTop = L.dockTop ?? vh - ey - 132;
  const dockLeft = L.dockLeft ?? ex + e + L.leftW;
  const dockRight = L.dockRight ?? vw - 112;
  const clampX = (x) => Math.max(ex, Math.min(vw - ex - w, x));
  const clampY = (y) => Math.max(ey, Math.min(vh - ey - h, y));
  const at = (id, x, y) => ({ id, rect: { x: clampX(x), y: clampY(y), w, h } });
  if (field) {
    const mid = (vh - h) / 2;
    // below the 2D view's header ("Back to sky"), measured when known: 64 px targets make it taller
    const top = L.fieldHeadBottom != null ? L.fieldHeadBottom + 8 : ey + 60;
    return [at('top-right', vw - ex - 16 - w, top), at('right', vw - ex - 16 - w, mid), at('left', ex + 16, mid)];
  }
  const aboveDock = dockTop - e - h;
  return [
    at('top-right', vw - ex - w, ey),
    at('top-left', ex, Math.max(L.leftTop, ey)),
    at('bottom-right', Math.min(dockRight, vw - ex - e - L.toolsW) - w, aboveDock),
    at('bottom-left', dockLeft, aboveDock),
  ];
}

/**
 * Pick the card's spot. `avoid`: shapes ({x, y, r} or {rect}, pads already added, optional
 * `weight`). Keeps `current` while it is clear (hysteresis: no hopping to a "better" spot), else
 * the first clear candidate, else the one with the least (weighted) overlap, preferring `current`
 * on a tie. -> spot id, or null with no candidates.
 */
export function chooseSpot(candidates, avoid = [], current = null) {
  const shapes = avoid.filter(Boolean);
  const blocked = (c) => shapes.some((s) => hits(c.rect, s));
  const cur = candidates.find((c) => c.id === current);
  if (cur && !blocked(cur)) return cur.id;
  const clear = candidates.find((c) => !blocked(c));
  if (clear) return clear.id;
  const score = (c) => shapes.reduce((t, s) => t + (s.weight ?? 1) * overlapArea(c.rect, s), 0);
  let best = null;
  for (const c of candidates) {
    const sc = score(c);
    if (!best || sc < best.sc) best = { id: c.id, sc };
  }
  if (cur && best && score(cur) <= best.sc) return cur.id;
  return best?.id ?? null;
}

/**
 * The card's own key for the cool-down: the target id when there is one, else an explicit key,
 * else the text (so the same offer is not repeated).
 */
export const offerKey = ({ target, key, text } = {}) => String(target || key || text || '');

/** Per-key cool-down. now() is injectable for tests. */
export function createCooldown({ ms = COOLDOWN_MS, now = () => Date.now() } = {}) {
  const until = new Map();
  const remaining = (key) => {
    const t = until.get(key);
    if (t == null) return 0;
    const left = t - now();
    if (left <= 0) until.delete(key);
    return Math.max(0, left);
  };
  return {
    mark: (key, dur = ms) => until.set(key, now() + dur),
    remaining,
    isCooling: (key) => remaining(key) > 0,
    clear: (key) => (key == null ? until.clear() : until.delete(key)),
  };
}

/**
 * A pausable one-shot timer (auto-hide). pause() keeps the time left; resume() continues it.
 * Timer functions are injectable for tests.
 */
export function createTimer(ms, onFire, { setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
  let id = null;
  let left = ms;
  let started = 0;
  const stop = () => {
    if (id != null) clearTimer(id);
    id = null;
  };
  return {
    start() {
      stop();
      left = ms;
      this.resume();
    },
    pause() {
      if (id == null) return;
      stop();
      left = Math.max(0, left - (now() - started));
    },
    resume() {
      if (id != null) return;
      started = now();
      id = setTimer(() => {
        id = null;
        onFire();
      }, left);
    },
    cancel() {
      stop();
      left = ms;
    },
    running: () => id != null,
  };
}

// --- the card ----------------------------------------------------------------------------

/**
 * @param {Object} o
 * @param {Document} [o.doc]
 * @param {Function} [o.resolve]    id -> registry answer | null (to see what a step would cover)
 * @param {Function} [o.getCentre]  () -> {x, y} | null: the middle of the sky (default: the viewport's)
 * @param {Function} [o.getAvoid]   () -> shapes the card should rather not cover (e.g. the hand-off
 *                                  button), each with a `weight` (less than the target's 1)
 */
export function createPopup({ doc = document, resolve = () => null, getCentre = () => null, getAvoid = () => [] } = {}) {
  const win = doc.defaultView;
  const reduced = () => !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const cooldown = createCooldown();

  const card = doc.createElement('aside');
  card.className = 'guide-popup';
  card.dataset.guide = 'guide-popup';
  card.setAttribute('aria-label', 'Guide');
  card.hidden = true;
  card.innerHTML = '<p class="gp-text"></p><div class="gp-answers"></div>';
  const textEl = card.querySelector('.gp-text');
  const answersEl = card.querySelector('.gp-answers');
  // a separate, always-present live region: a region that appears with its text is often not read
  const live = doc.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  // first in the page, so Tab reaches the card's buttons before anything else
  doc.body.prepend(live);
  doc.body.prepend(card);

  let open = null; // { kind, resolve, key?, onYes?, onNo?, target? }
  let spot = null; // where the card is: a spotRects id
  let autoHide = true;
  let leaveTimer = 0;
  let checkTimer = 0;
  let returnFocus = null;
  let handoff = false; // closed by an answer from the keyboard; the next card may take the focus
  let tabbedIn = false; // the first Tab of this card has brought the focus in (U10)
  const timer = createTimer(AUTO_HIDE_MS, () => close('timeout'));

  function render(kind, text, answers, target) {
    win.clearTimeout(leaveTimer);
    const focusWasInside = handoff || card.contains(doc.activeElement);
    if (!open && !focusWasInside) returnFocus = doc.activeElement;
    const fresh = card.hidden || card.classList.contains('is-leaving');
    card.hidden = false;
    // is-placed turns on the slide between spots; a card that was gone jumps into its first spot
    card.className = `guide-popup is-${kind}${fresh ? '' : ' is-placed'}`;
    textEl.textContent = text;
    answersEl.replaceChildren(
      ...answers.map((a, i) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        b.dataset.answer = a.id;
        if (i === 0) b.classList.add('is-primary');
        b.addEventListener('click', () => close(a.id));
        return b;
      }),
    );
    live.textContent = '';
    win.setTimeout(() => (live.textContent = `Guide: ${text}`), 30);
    // the person was already answering the card: keep the keyboard in it
    if (focusWasInside) answersEl.querySelector('button')?.focus();
    win.clearInterval(checkTimer);
    if (fresh) spot = null; // a card that was gone starts again from the top right
    place();
    if (fresh) {
      void card.offsetWidth; // commit the first spot before the slide transition is on
      card.classList.add('is-placed');
    }
    checkTimer = win.setInterval(place, CHECK_MS);
  }

  /** The page's layout, from the shell's CSS tokens and the dock's real box. */
  function layout(vw, vh) {
    const cs = win.getComputedStyle(doc.documentElement);
    const v = (name, d) => parseFloat(cs.getPropertyValue(name)) || d;
    const edge = v('--edge', 12);
    // --edge-x/-y are calc(6vw/6vh + 4px): compute them here (parseFloat cannot)
    const edgeX = 0.06 * vw + 4;
    const edgeY = 0.06 * vh + 4;
    // top-left spot: below the side panel's "Controls" button (and clear of the search bar)
    // (measured: with 64 px targets the search bar can end lower than the button)
    const searchBottom = doc.querySelector('.shell-top')?.getBoundingClientRect().bottom ?? 0;
    const leftTop = Math.max(Math.max(v('--left-top', 12), edgeY) + v('--toggle-h', 64), searchBottom) + v('--space-2', 8);
    const head = doc.querySelector('.field-head')?.getBoundingClientRect();
    const out = { edge, edgeX, edgeY, leftTop, leftW: v('--left-w', 264), toolsW: v('--tools-w', 284), fieldHeadBottom: head?.height ? head.bottom : null };
    const dock = doc.querySelector('[data-region="dock"]')?.getBoundingClientRect();
    if (dock?.width > 0) Object.assign(out, { dockTop: dock.top, dockLeft: dock.left, dockRight: dock.right });
    else Object.assign(out, { dockTop: vh - out.edgeY - v('--dock-h', 132), dockRight: vw - v('--logo-clear', 112) });
    return out;
  }

  /** Move the card off the centre of the sky, its own target and the hand-off button (see chooseSpot). */
  function place() {
    if (!open) return;
    const size = { w: card.offsetWidth, h: card.offsetHeight };
    if (!(size.w > 0)) return;
    const viewport = { w: win.innerWidth, h: win.innerHeight };
    const safe = (fn) => {
      try {
        return fn();
      } catch {
        return null;
      }
    };
    const target = open.target ? safe(() => resolve(open.target)) : null;
    const pad = (s) => (s && !s.rect ? { x: s.x, y: s.y, r: (s.r ?? 0) + TARGET_PAD } : s);
    const avoid = [centreZone(viewport, safe(getCentre)), pad(target), ...(safe(getAvoid) ?? [])];
    const field = doc.body.classList.contains('field-open');
    const spots = spotRects({ viewport, size, field, layout: layout(viewport.w, viewport.h) });
    spot = chooseSpot(spots, avoid, spots.some((c) => c.id === spot) ? spot : null);
    const r = spots.find((c) => c.id === spot)?.rect;
    if (!r) return;
    card.style.left = `${r.x}px`;
    card.style.top = `${r.y}px`;
    card.dataset.spot = spot;
  }

  function close(outcome) {
    if (!open) return false;
    const was = open;
    open = null;
    tabbedIn = false; // the next card gets its own first Tab
    timer.cancel();
    win.clearInterval(checkTimer);
    const focusWasInside = card.contains(doc.activeElement);
    const hide = () => {
      card.hidden = true;
      card.classList.remove('is-leaving');
      answersEl.replaceChildren();
    };
    if (reduced()) hide();
    else {
      card.classList.add('is-leaving');
      leaveTimer = win.setTimeout(hide, LEAVE_MS);
    }
    if (focusWasInside) {
      // the answer may open the next card right away (Yes -> step): keep the keyboard in the card;
      // otherwise give focus back to where it was before the card appeared
      handoff = true;
      win.setTimeout(() => {
        handoff = false;
        if (open) {
          if (!card.contains(doc.activeElement)) answersEl.querySelector('button')?.focus();
          return;
        }
        const back = returnFocus;
        returnFocus = null;
        if (back?.isConnected && back !== doc.body && !card.contains(back)) back.focus();
        else if (card.contains(doc.activeElement)) doc.activeElement.blur();
      }, 0);
    } else returnFocus = null;
    if (was.kind === 'offer') {
      cooldown.mark(was.key);
      const result = outcome === 'yes' ? 'yes' : outcome === 'close' ? 'dismissed' : outcome;
      const cb = result === 'yes' ? was.onYes : result === 'replaced' ? null : was.onNo;
      was.resolve(result);
      try {
        cb?.(result);
      } catch (err) {
        console.error('[guide] offer callback failed', err);
      }
    } else {
      was.resolve(outcome);
    }
    return true;
  }

  // ---- public API ----
  function offer({ text, onYes, onNo, target, key } = {}) {
    const line = clipWords(text, 16).text;
    if (!line) return Promise.resolve('busy');
    const k = offerKey({ target, key, text: line });
    if (cooldown.isCooling(k)) return Promise.resolve('cooling');
    if (open) return Promise.resolve('busy');
    return new Promise((res) => {
      open = { kind: 'offer', resolve: res, key: k, onYes, onNo, target };
      render('offer', line, [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No thanks' },
      ]);
      if (autoHide) timer.start();
    });
  }

  function say(step) {
    const s = typeof step === 'string' ? { say: step } : (step ?? {});
    const { text, clipped } = clipWords(s.say ?? s.text);
    if (!text) return Promise.resolve('close');
    if (clipped) console.warn('[guide] step text cut to', MAX_WORDS, 'words');
    if (open) close('replaced');
    return new Promise((res) => {
      open = { kind: 'step', resolve: res, target: typeof s.target === 'string' ? s.target : null };
      render('step', text, normaliseAnswers(s.answers));
    });
  }

  function setAutoHide(on) {
    autoHide = !!on;
    if (!autoHide) timer.cancel();
    else if (open?.kind === 'offer' && !timer.running()) timer.start();
  }

  // pause the auto-hide while the person is on the card (hover, keyboard focus)
  const pause = () => timer.pause();
  const resume = () => {
    if (autoHide && open?.kind === 'offer' && !card.matches(':hover') && !card.contains(doc.activeElement)) timer.resume();
  };
  card.addEventListener('pointerenter', pause);
  card.addEventListener('pointerleave', resume);
  card.addEventListener('focusin', pause);
  card.addEventListener('focusout', () => win.setTimeout(resume, 0));

  // the first Tab after a card opens brings the keyboard to its first answer (U10)
  const typing = (el) => !!el?.matches?.('input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=""], [contenteditable="true"]');
  win.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || !open || tabbedIn) return;
      tabbedIn = true;
      if (card.contains(doc.activeElement) || typing(doc.activeElement)) return;
      const first = answersEl.querySelector('button');
      if (!first) return;
      e.preventDefault();
      first.focus();
    },
    true,
  );

  // Esc closes the card first (capture phase: before the app's own Esc, "back to sky")
  win.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !open || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close('close');
    },
    true,
  );

  return {
    offer,
    say,
    dismiss: (reason = 'close') => close(reason),
    isOpen: () => !!open,
    kind: () => open?.kind ?? null,
    spot: () => (open ? spot : null),
    setAutoHide,
    autoHide: () => autoHide,
    cooldown,
    element: card,
  };
}
