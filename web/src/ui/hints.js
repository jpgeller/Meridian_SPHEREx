// Yellow "!" hints (mouse mode only). In input mode A (mouse and keyboard) every visible button that
// has an explanation (ui/hintText.js) gets a small yellow "!" on its top-right corner; resting the mouse
// on it shows what the button does. Off in modes B and C: a gaze user cannot hover, and the badges
// would only be clutter near the targets.
//
// The badges live in one fixed layer of their own (#hints), never inside the buttons, so no button's
// text, size or accessible name changes (the 64 px and "no text spills out" rules are untouched). The
// layer is aria-hidden: the same words are in each button's name or title for screen readers. A badge
// is not a control: it only reacts to hover, so a click on it does nothing.
import { hintFor } from './hintText.js';
import './hints.css';

const BADGE = 18; // px
const MIN_GAP_MS = 120; // re-place at most this often (the readout changes text while panning)

export function createHints({ store, doc = document, win = window }) {
  const layer = doc.createElement('div');
  layer.id = 'hints';
  layer.className = 'hints';
  layer.setAttribute('aria-hidden', 'true');
  const bubble = doc.createElement('div');
  bubble.className = 'hint-bubble';
  bubble.hidden = true;
  layer.append(bubble);
  doc.body.append(layer);

  /** @type {Map<Element, HTMLElement>} button -> its badge */
  const badges = new Map();
  let active = false;
  let shownFor = null; // the button whose explanation the bubble shows
  let pending = 0;
  let last = 0;

  const ours = (n) => n === layer || layer.contains(n);

  /** The button itself is what the mouse would reach at this point (not covered, not clipped). */
  function reaches(btn, x, y) {
    for (const t of doc.elementsFromPoint(x, y)) {
      if (ours(t)) continue;
      return btn === t || btn.contains(t);
    }
    return false;
  }

  function badgeFor(btn) {
    let b = badges.get(btn);
    if (!b) {
      b = doc.createElement('span');
      b.className = 'hint-badge';
      b.textContent = '!';
      b.addEventListener('mouseenter', () => showBubble(btn, b));
      b.addEventListener('mouseleave', hideBubble);
      // not a control: keep a click on the badge from reaching anything
      b.addEventListener('click', (e) => (e.preventDefault(), e.stopPropagation()));
      badges.set(btn, b);
      layer.append(b);
    }
    return b;
  }

  function place() {
    pending = 0;
    last = performance.now();
    const seen = new Set();
    if (active) {
      const W = win.innerWidth;
      const H = win.innerHeight;
      for (const btn of doc.querySelectorAll('button')) {
        if (ours(btn) || btn.hidden) continue;
        const text = hintFor(btn);
        if (!text) continue;
        if (btn.checkVisibility && !btn.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const r = btn.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.right < 0 || r.top > H || r.left > W) continue;
        // the badge's corner of the button must be on screen and the button's own (not under a panel)
        if (!reaches(btn, r.left + r.width / 2, r.top + r.height / 2) || !reaches(btn, r.right - 14, r.top + 14)) continue;
        const b = badgeFor(btn);
        b.dataset.hint = text;
        b.style.transform = `translate(${Math.round(r.right - BADGE + 5)}px, ${Math.round(r.top - 5)}px)`;
        seen.add(btn);
      }
    }
    for (const [btn, b] of badges) {
      if (seen.has(btn)) continue;
      b.remove();
      badges.delete(btn);
    }
    if (shownFor && !badges.has(shownFor)) hideBubble();
  }

  function schedule() {
    if (pending) return;
    const wait = Math.max(0, MIN_GAP_MS - (performance.now() - last));
    // a timer, not requestAnimationFrame: rAF stalls in background or throttled panes and left
    // the badges where the buttons used to be
    pending = win.setTimeout(place, wait);
  }

  function showBubble(btn, badge) {
    shownFor = btn;
    bubble.textContent = badge.dataset.hint ?? '';
    bubble.hidden = false;
    // below the badge, or above it near the bottom of the screen; kept inside the window
    const a = badge.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const pad = 8;
    const x = Math.min(Math.max(pad, a.left + a.width / 2 - w / 2), win.innerWidth - w - pad);
    const below = a.bottom + 6;
    const y = below + h + pad > win.innerHeight ? a.top - h - 6 : below;
    bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(pad, y))}px)`;
  }

  function hideBubble() {
    shownFor = null;
    bubble.hidden = true;
  }

  // Anything that can move, show or hide a button: DOM changes, scrolling, resizing, transitions.
  const observer = new MutationObserver((records) => {
    if (records.some((m) => !ours(m.target))) schedule();
  });
  const onEvent = () => active && schedule();

  function setActive(on) {
    if (on === active) return;
    active = on;
    layer.hidden = !on;
    if (on) {
      observer.observe(doc.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['hidden', 'class', 'style', 'disabled', 'title', 'data-hint', 'aria-expanded'],
      });
    } else {
      observer.disconnect();
      hideBubble();
    }
    place();
  }

  win.addEventListener('resize', onEvent);
  doc.addEventListener('scroll', onEvent, { capture: true, passive: true });
  doc.addEventListener('transitionend', onEvent, true);
  doc.addEventListener('animationend', onEvent, true);
  store.subscribe((s, changed) => {
    if (changed.includes('input')) setActive(s.input === 'mouse');
    else onEvent();
  });
  // a slow safety net for layout changes nothing announces (fonts loading, Aladin resizing itself)
  win.setInterval(onEvent, 1000);
  setActive(store.get().input === 'mouse');

  return {
    element: layer,
    refresh: place,
    /** [{ text, x, y }] of the badges on screen (tests and debugging). */
    list: () => [...badges.values()].map((b) => ({ text: b.dataset.hint, rect: b.getBoundingClientRect() })),
  };
}
