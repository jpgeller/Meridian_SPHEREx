// Sparkle hints (mouse mode only). In input mode A (mouse and keyboard) every section title with an
// explanation (`data-hint-section`: the 2D view's Zoom, Detector, View, Dates, Playback; the panel's
// Places, View, Colours) gets a small white star right after its words; resting the mouse on it explains
// the whole section. (Until 16 Nov 2026 every button had its own star: too busy. ui/hintText.js still
// holds the per-button sentences, for buttons' titles and the guide.) Off in modes B and C: a gaze user cannot hover, and the badges
// would only be clutter near the targets.
//
// The badges live in one fixed layer of their own (#hints), never inside the buttons, so no button's
// text, size or accessible name changes (the 64 px and "no text spills out" rules are untouched). The
// layer is aria-hidden: the same words are in each button's name or title for screen readers. A badge
// is not a control: it only reacts to hover, so a click on it does nothing.
import './hints.css';

const BADGE = 18; // px
// a four-point sparkle: curved sides meeting in four sharp points
const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 0C12.7 6.4 17.6 11.3 24 12C17.6 12.7 12.7 17.6 12 24C11.3 17.6 6.4 12.7 0 12C6.4 11.3 11.3 6.4 12 0Z"/></svg>';
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
      b.innerHTML = STAR;
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
      for (const btn of doc.querySelectorAll('[data-hint-section]')) {
        if (ours(btn) || btn.closest('[hidden]')) continue;
        const text = btn.dataset.hintSection;
        if (!text) continue;
        if (btn.checkVisibility && !btn.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const r = titleRect(btn);
        if (!r || r.width < 8 || r.height < 8 || r.bottom < 0 || r.right < 0 || r.top > H || r.left > W) continue;
        // the title must be on screen and its own (not under a panel or the guide card)
        if (!reaches(btn, r.left + Math.min(10, r.width / 2), r.top + r.height / 2)) continue;
        const b = badgeFor(btn);
        b.dataset.hint = text;
        // `translate`, not `transform`: the hover `scale` would multiply a transform and fling the star away
        b.style.translate = `${Math.round(r.right + 6)}px ${Math.round(r.top + (r.height - BADGE) / 2)}px`;
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

  /** The box of a title's words (not the whole heading's width): the star goes right after them. */
  function titleRect(el) {
    // all of the title's words, small print included ("Colours · infrared translated": the star went on "inf")
    const words = el.querySelector('.fsec-text') ?? el;
    const range = doc.createRange();
    range.selectNodeContents(words);
    const r = range.getBoundingClientRect();
    return r.width ? r : el.getBoundingClientRect();
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
    // measured before the hover scale (1.7) applies: leave room for the grown star
    const grow = BADGE * 0.35 + 6;
    const below = a.bottom + grow;
    const y = below + h + pad > win.innerHeight ? a.top - h - grow : below;
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
