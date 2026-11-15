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
//        Steps never auto-hide. If the full card would cover the sky's centre or `target`, it shrinks
//        to the offer form (one line + the buttons; screen readers still get the whole text).
//   dismiss(reason?)  isOpen()  kind() -> 'offer'|'step'|null  setAutoHide(bool)  cooldown
//
// Every button is a real <button>; Tab reaches them (the card is the first thing in the page),
// Esc closes the card before anything else hears the key. The words go through an aria-live region.

import { hits } from './overlay.js';

export const AUTO_HIDE_MS = 12000;
export const COOLDOWN_MS = 60000;
export const MAX_WORDS = 45; // "about 40": longer steps are cut with an ellipsis
export const MAX_ANSWERS = 3;
export const ANSWERS = { got_it: 'Got it', more: 'Show me more', close: 'Close' };
const LEAVE_MS = 160;
const CHECK_MS = 250; // how often an open step re-checks what it covers

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

/**
 * Would a card at `rect` hide something that matters? `shapes`: registry answers ({x, y, r} or
 * {rect}) or null. A point target gets `pad` px around it (the pointer and ring sit there too).
 */
export function wouldCover(rect, shapes, pad = 24) {
  return shapes.some((s) => {
    if (!s) return false;
    if (s.rect) return hits(rect, s);
    return hits(rect, { x: s.x, y: s.y, r: (s.r ?? 0) + pad });
  });
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
 */
export function createPopup({ doc = document, resolve = () => null, getCentre = () => null } = {}) {
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

  let open = null; // { kind, resolve, key?, onYes?, onNo?, target?, fullH? }
  let autoHide = true;
  let leaveTimer = 0;
  let checkTimer = 0;
  let returnFocus = null;
  let handoff = false; // closed by an answer from the keyboard; the next card may take the focus
  const timer = createTimer(AUTO_HIDE_MS, () => close('timeout'));

  function render(kind, text, answers, target) {
    win.clearTimeout(leaveTimer);
    const focusWasInside = handoff || card.contains(doc.activeElement);
    if (!open && !focusWasInside) returnFocus = doc.activeElement;
    card.hidden = false;
    card.className = `guide-popup is-${kind}`;
    textEl.textContent = text;
    textEl.title = '';
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
    if (kind === 'step') {
      open.fullH = card.getBoundingClientRect().height;
      checkCover();
      checkTimer = win.setInterval(checkCover, CHECK_MS);
    }
  }

  /** A step that would hide the centre of the sky or its own target shrinks to the offer form. */
  function checkCover() {
    if (open?.kind !== 'step') return;
    const b = card.getBoundingClientRect();
    if (!(b.width > 0)) return;
    const full = { x: b.left, y: b.top, w: b.width, h: open.fullH || b.height };
    const viewport = { w: win.innerWidth, h: win.innerHeight };
    let target = null;
    try {
      target = open.target ? resolve(open.target) : null;
    } catch {
      target = null;
    }
    const compact = wouldCover(full, [centreZone(viewport, getCentre()), target]);
    card.classList.toggle('is-compact', compact);
    textEl.title = compact ? textEl.textContent : '';
  }

  function close(outcome) {
    if (!open) return false;
    const was = open;
    open = null;
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
    setAutoHide,
    autoHide: () => autoHide,
    cooldown,
    element: card,
  };
}
