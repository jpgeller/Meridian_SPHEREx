// Guide pop-up card (UI plan, U4; wireframe v4): one small Siri-like card in the top-right corner that
// carries the guide's words, and the "AI Guide" pill that sits there when the card is closed.
//
//   card:  [orb] AI GUIDE                 1 / 3   [✕]
//          **Title**
//          One short thought.
//          muted line · facts (term / value)
//          [Primary] [Second] [Third]
//          ───────── progress bar (auto-advance / auto-hide; reading the card pauses it)
//   pill:  [orb] AI Guide      (a real button; opens the guide's menu through onPill -> command)
//
//   offer({ text, sub?, onYes, onNo?, target?, key? }) -> Promise<'yes'|'no'|'timeout'|'dismissed'|'replaced'|'cooling'|'busy'>
//        A bold question + a muted line + "Yes, tell me" / "Not now". Hides itself after AUTO_HIDE_MS
//        if ignored (unless auto-hide is off: gaze mode, U9); then the same target (or key, or text)
//        is not offered again for COOLDOWN_MS. "Not now" (or ✕) blocks it for the whole session.
//        Not shown while another card is open ('busy'). Offers are local: nothing here calls the API.
//   say(step) -> Promise<answer id>
//        step = 'text' | { say, title?, sub?, facts?: [[term, value]], answers?, step?: '1 / 3',
//                          auto?: ms, target? }
//        The explanation (about 40 words) + 1 to 3 answer buttons. answers: ids or labels, e.g.
//        ['next', 'stop'] -> "Next" / "Stop" (default: ['got_it']). With `auto`, the card answers
//        'auto' by itself after that many ms (the bar shows it; hover or focus on the card pauses it).
//        Resolves with the id pressed, 'close' for Esc or ✕, 'replaced' when a newer card takes its place.
//   dismiss(reason?)  isOpen()  kind() -> 'offer'|'step'|null  spot()  setAutoHide(bool)  cooldown
//
// Placement: always the top-right corner (the shell keeps it free; in the field view, below "Back to
// sky"). The guide's pointer lands beside its targets, so the card never needs to move. spotRects()
// and chooseSpot() stay for layouts that want other spots.
//
// Every button is a real <button>; Tab reaches them (the card is the first thing in the page),
// Esc closes the card before anything else hears the key. The words go through an aria-live region.
// U10: the first Tab after a card opens goes to its first answer wherever the focus was (e.g. deep in
// the time-lapse), so one "next" key + one "press" key always finish the guide; a second Tab leaves
// the card as usual. Not while typing in a field (Tab there keeps its meaning).

import { hits } from './overlay.js';

export const AUTO_HIDE_MS = 14000; // an ignored offer leaves by itself (the bar along the bottom shows it)
export const COOLDOWN_MS = 60000;
export const MAX_WORDS = 45; // "about 40": longer steps are cut with an ellipsis
export const MAX_ANSWERS = 3;
export const ANSWERS = {
  got_it: 'Got it',
  more: 'Show me more',
  close: 'Close',
  next: 'Next',
  stop: 'Stop',
  yes: 'Yes, tell me',
  no: 'Not now',
  show: 'Show me',
  again: 'Show me again',
  example: 'Show me an example',
};
const LEAVE_MS = 160;
// answers after which another card follows (a tour step, the tour an answer starts)
const LEADS_ON = new Set(['yes', 'next', 'more', 'auto', 'show', 'again', 'example', 'here', 'moving', 'colours']);
const HANDOFF_MS = 2500; // after an answer from the keyboard, the next card (still acting) may take the focus this long
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
 * @param {Function} [o.onPill]  the "AI Guide" pill was pressed (index.js runs the open_guide command)
 */
export function createPopup({ doc = document, onPill = () => {} } = {}) {
  const win = doc.defaultView;
  const reduced = () => !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const cooldown = createCooldown();

  const card = doc.createElement('aside');
  card.className = 'guide-popup';
  card.dataset.guide = 'guide-popup';
  card.dataset.spot = 'top-right';
  card.setAttribute('aria-label', 'Guide');
  card.hidden = true;
  card.innerHTML =
    '<div class="gp-head"><span class="gp-orb" aria-hidden="true"></span><b class="gp-name">AI GUIDE</b>' +
    '<span class="gp-step"></span><button type="button" class="gp-x" aria-label="Dismiss">✕</button></div>' +
    '<p class="gp-title"></p><p class="gp-text"></p><p class="gp-sub"></p><dl class="gp-facts"></dl>' +
    '<div class="gp-answers"></div><div class="gp-bar" aria-hidden="true"><i></i></div>';
  const q = (sel) => card.querySelector(sel);
  const titleEl = q('.gp-title');
  const textEl = q('.gp-text');
  const subEl = q('.gp-sub');
  const factsEl = q('.gp-facts');
  const stepEl = q('.gp-step');
  const answersEl = q('.gp-answers');
  const barEl = q('.gp-bar i');
  q('.gp-x').addEventListener('click', () => close('close'));

  // the pill: where the guide waits (its pointer parks beside it)
  const pill = doc.createElement('button');
  pill.type = 'button';
  pill.className = 'guide-pill';
  pill.dataset.guide = 'guide-pill';
  pill.setAttribute('aria-keyshortcuts', 'a');
  pill.title = 'AI Guide (key A)';
  pill.innerHTML = '<span class="gp-orb" aria-hidden="true"></span>AI Guide';
  pill.addEventListener('click', () => onPill());

  // a separate, always-present live region: a region that appears with its text is often not read
  const live = doc.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  // first in the page, so Tab reaches the card's buttons before anything else
  doc.body.prepend(live);
  doc.body.prepend(pill);
  doc.body.prepend(card);

  let open = null; // { kind, resolve, key?, onYes?, onNo?, target? }
  let autoHide = true;
  let leaveTimer = 0;
  let returnFocus = null;
  let handoff = false; // closed by an answer from the keyboard; the next card may take the focus
  let tabbedIn = false; // the first Tab of this card has brought the focus in (U10)
  let timer = null; // this card's auto-hide / auto-advance
  let handoffTimer = 0;

  const setText = (el, text) => {
    el.textContent = text ?? '';
    el.hidden = !text;
  };

  function startBar(ms) {
    barEl.parentElement.hidden = !ms;
    barEl.style.animation = 'none';
    barEl.classList.remove('is-paused');
    if (!ms || reduced()) return;
    void barEl.offsetWidth; // restart
    barEl.style.animation = `gp-bar ${ms}ms linear forwards`;
  }

  // In the 2D view the screen's top-right corner holds the controls column; the card sits in the top-right
  // corner of the image instead (the target is in the middle of the image, so it stays visible).
  let placeTimer = 0;
  function place() {
    const box = doc.body.classList.contains('field-open') ? doc.querySelector('.canvas-wrap')?.getBoundingClientRect() : null;
    if (!(box?.width > 0)) {
      card.style.left = card.style.top = card.style.right = '';
      card.dataset.spot = 'top-right';
      return;
    }
    card.style.right = 'auto';
    card.style.left = `${Math.round(Math.max(8, box.right - card.offsetWidth - 12))}px`;
    card.style.top = `${Math.round(box.top + 12)}px`;
    card.dataset.spot = 'image-top-right';
  }

  function render(kind, c, answers, auto) {
    win.clearTimeout(leaveTimer);
    const focusWasInside = handoff || card.contains(doc.activeElement);
    win.clearTimeout(handoffTimer);
    handoff = false;
    if (!open && !focusWasInside) returnFocus = doc.activeElement;
    const fresh = card.hidden || card.classList.contains('is-leaving');
    card.hidden = false;
    pill.hidden = true;
    card.className = `guide-popup is-${kind}${fresh ? '' : ' is-placed'}`;
    setText(titleEl, c.title);
    setText(textEl, c.text);
    setText(subEl, c.sub);
    setText(stepEl, c.step);
    factsEl.replaceChildren(
      ...(c.facts ?? []).flatMap(([k, v]) => {
        const dt = doc.createElement('dt');
        dt.textContent = k;
        const dd = doc.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
    factsEl.hidden = !c.facts?.length;
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
    const spoken = [c.title, c.text, c.sub, ...(c.facts ?? []).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join(' ');
    live.textContent = '';
    win.setTimeout(() => (live.textContent = `Guide: ${spoken}`), 30);
    // the person was already answering the card: keep the keyboard in it
    if (focusWasInside) answersEl.querySelector('button')?.focus();
    timer?.cancel();
    timer = auto ? createTimer(auto, () => close(kind === 'offer' ? 'timeout' : 'auto')) : null;
    startBar(auto);
    if (timer && !card.matches(':hover') && !card.contains(doc.activeElement)) timer.start();
    place();
    win.clearInterval(placeTimer);
    placeTimer = win.setInterval(place, 250); // the view may change under an open card (a tour opens the 2D view)
    if (fresh) {
      void card.offsetWidth;
      card.classList.add('is-placed');
    }
  }

  function close(outcome) {
    if (!open) return false;
    win.clearInterval(placeTimer);
    const was = open;
    open = null;
    tabbedIn = false; // the next card gets its own first Tab
    timer?.cancel();
    timer = null;
    const focusWasInside = card.contains(doc.activeElement);
    const hide = () => {
      card.hidden = true;
      card.classList.remove('is-leaving');
      answersEl.replaceChildren();
      if (!open) pill.hidden = false;
    };
    if (reduced()) hide();
    else {
      card.classList.add('is-leaving');
      leaveTimer = win.setTimeout(hide, LEAVE_MS);
    }
    if (focusWasInside) {
      // the answer may open the next card (Yes -> step, Next -> the next step, which may first finish
      // acting): keep the keyboard for it a moment; otherwise give the focus back to where it was
      handoff = true;
      win.clearTimeout(handoffTimer);
      handoffTimer = win.setTimeout(() => {
        handoff = false;
        if (open) return;
        const back = returnFocus;
        returnFocus = null;
        if (back?.isConnected && back !== doc.body && !card.contains(back)) back.focus();
        else if (card.contains(doc.activeElement)) doc.activeElement.blur();
      }, LEADS_ON.has(outcome) ? HANDOFF_MS : 0);
    } else returnFocus = null;
    if (was.kind === 'offer') {
      const result = outcome === 'yes' ? 'yes' : outcome === 'close' ? 'dismissed' : outcome;
      // "Not now" or ✕: not this object again in this session; ignored: a minute's rest
      cooldown.mark(was.key, result === 'no' || result === 'dismissed' ? Infinity : COOLDOWN_MS);
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
  function offer({ text, sub, onYes, onNo, target, key, yes = ANSWERS.yes, no = ANSWERS.no } = {}) {
    const line = clipWords(text, 16).text;
    if (!line) return Promise.resolve('busy');
    const k = offerKey({ target, key, text: line });
    if (cooldown.isCooling(k)) return Promise.resolve('cooling');
    if (open) return Promise.resolve('busy');
    return new Promise((res) => {
      open = { kind: 'offer', resolve: res, key: k, onYes, onNo, target };
      render('offer', { title: line, sub: clipWords(sub, 20).text }, [
        { id: 'yes', label: yes },
        { id: 'no', label: no },
      ], autoHide ? AUTO_HIDE_MS : 0);
    });
  }

  function say(step) {
    const s = typeof step === 'string' ? { say: step } : (step ?? {});
    const { text, clipped } = clipWords(s.say ?? s.text);
    const title = clipWords(s.title, 12).text;
    if (!text && !title) return Promise.resolve('close');
    if (clipped) console.warn('[guide] step text cut to', MAX_WORDS, 'words');
    if (open) close('replaced');
    const facts = Array.isArray(s.facts)
      ? s.facts.filter((f) => Array.isArray(f) && f.length === 2).slice(0, 4).map(([k, v]) => [String(k), String(v)])
      : null;
    const auto = Number.isFinite(s.auto) && s.auto > 0 ? s.auto : 0;
    return new Promise((res) => {
      open = { kind: 'step', resolve: res, target: typeof s.target === 'string' ? s.target : null };
      render('step', { title, text, sub: clipWords(s.sub, 20).text, facts, step: typeof s.step === 'string' ? s.step : '' }, normaliseAnswers(s.answers), auto);
    });
  }

  function setAutoHide(on) {
    autoHide = !!on;
    if (!autoHide && open?.kind === 'offer') {
      timer?.cancel();
      timer = null;
      startBar(0);
    }
  }

  // reading the card (hover, keyboard focus) pauses its bar
  const pause = () => {
    if (!timer) return;
    timer.pause();
    barEl.classList.add('is-paused');
  };
  const resume = () => {
    if (!timer || card.matches(':hover') || card.contains(doc.activeElement)) return;
    barEl.classList.remove('is-paused');
    timer.resume();
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
    spot: () => (open ? card.dataset.spot : null),
    setAutoHide,
    autoHide: () => autoHide,
    cooldown,
    element: card,
    pill,
  };
}
