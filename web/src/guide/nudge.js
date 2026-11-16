// Proactive offers ("nudges"): a moment noticed by interest.js or attention.js becomes ONE short
// offer in the top-right card, with 2-3 buttons, after the pointer has flown to what it is about.
// Claude writes the offer (POST /api/guide/nudge, see api/guide.py); this module keeps it cheap:
//
//   - budget: at most one Claude call per `gapMs` (15 s), `maxPerVisit` (40) per visit (sessionStorage),
//     never while a card, a tour or a request is busy, no two offers within `offerGapMs` (15 s);
//     a moment's topic rests `topicMs` (90 s) after an offer; "Not now" mutes that topic for 5 minutes;
//     three "Not now" in a row -> one "Fewer suggestions?" (yes: half the rate). Ignored offers collapse after 8 s.
//   - local fallback: no key, a timeout, an invalid reply or an empty budget -> a fixed local offer for
//     that moment (FALLBACK below), so the guide never goes silent, at zero tokens.
//   - options: apply (run the setup now: commands/clicks, local), tour (a built-in tour), explain
//     (a short Claude tour about the offer: counted in the visit budget), plus "Not now".
//   - places (moment "object" with a sky:<place> target): no Claude offer -> presetOffer, the card's hook +
//     first fact with its suggested tours (local, zero tokens).
//   - objects (B7, moment "object", not one of the 7 places): explain asks for an object explanation
//     (trigger "object" with the target); no Claude offer -> a local "Yes, tell me" offer naming it;
//     visit budget spent -> the local object script (explain with local: true), no API call.
//
//   const n = createNudge({ ask, buildBody, say, overlay, runScript, tour, explain, isBusy, now, storage })
//   n.handle({ moment, target? }) -> Promise<outcome>   n.snapshot()   n.configure(o)   n.reset()
//
// Pure apart from what is injected (unit-tested in tests/interest.test.js with fakes).

import { factsFor } from '../sky/presetFacts.js';

export const DEFAULTS = Object.freeze({
  gapMs: 15000,
  maxPerVisit: 40,
  topicMs: 90000,
  offerGapMs: 15000, // no two offers of any kind (Claude or local) closer than this
  autoHideMs: 8000, // an ignored offer collapses after this, with no penalty
  muteMs: 300000, // "Not now" mutes that topic for 5 minutes
  fewerAfter: 3, // this many "Not now" in a row -> ask once "Fewer suggestions?"
});
const STORE_KEY = 'meridian.guide.nudges';

// Local offers when Claude is not available (or the budget is spent). Same shape as a Claude reply.
export const FALLBACK = {
  bands: { title: '102 infrared colours', line: 'Notice how the sky changes from D1 to D6: cold dust and ices only glow at the long end. Tour the bands?', point: 'band-ribbon',
    options: [{ label: 'Tour the bands', kind: 'tour', tour: 'colours' }, { label: 'Try D6 (coldest)', kind: 'apply', actions: [{ click: 'band-d6' }] }] },
  colours: { title: 'Colours are a choice', line: 'These colours paint invisible infrared light. See how the Ices view lights up cold, icy places?', point: 'colour-views',
    options: [{ label: 'Try the Ices view', kind: 'apply', actions: [{ cmd: 'set_color', args: { color: 'ice' } }] }, { label: 'Tour the colours', kind: 'tour', tour: 'colours' }] },
  timelapse_start: { title: 'Real pictures, real dates', line: 'Each frame is a real SPHEREx picture, taken on its own date. Watch the change video?', point: 'op-video',
    options: [{ label: 'Play the change video', kind: 'apply', actions: [{ click: 'op-video' }, { click: 'play' }] }, { label: 'Play the pictures', kind: 'apply', actions: [{ click: 'play' }] }] },
  compare: { title: 'Ways to compare dates', line: 'Blink flips two dates, so brightness changes jump out. Try it?', point: 'op-blink',
    options: [{ label: 'Try Blink', kind: 'apply', actions: [{ click: 'op-blink' }] }, { label: 'Try the change video', kind: 'apply', actions: [{ click: 'op-video' }] }] },
  motion: { title: 'Looking for a change?', line: 'Something here may move between frames. The change video spans 2010 to 2026. Play it?', point: 'op-video',
    options: [{ label: 'Play the change video', kind: 'apply', actions: [{ click: 'op-video' }, { click: 'play' }] }, { label: 'Show a moving star', kind: 'tour', tour: 'motion:barnard' }] },
  zoomed: { title: 'See the real pictures', line: 'The real SPHEREx pictures of this spot are sharper, one per visit. Open them?', point: 'open-field',
    options: [{ label: 'Open the pictures', kind: 'apply', actions: [{ click: 'open-field' }] }, { label: 'Show a moving star', kind: 'tour', tour: 'motion:barnard' }] },
  object_search: { title: 'Found it', line: 'Look here: this is where your search points. Open its real SPHEREx pictures?', point: 'sky:target',
    options: [{ label: 'Open the pictures', kind: 'apply', actions: [{ click: 'open-field' }] }, { label: 'What am I seeing?', kind: 'tour', tour: 'where' }] },
};
// a moment's topic: features share one per control, objects one per object
export const topicOf = ({ moment, target } = {}) =>
  (moment === 'object' || moment === 'arrival') && target?.id ? `${moment}:${target.id}` : String(moment ?? '');
// B7: an object (not one of the places) always gets an offer to explain it, named when we know its name
export function objectOffer(target) {
  const name = typeof target?.name === 'string' && target.name.trim() ? target.name.trim() : null;
  return {
    title: name ?? 'This star',
    line: `Look here: ${name ?? 'this star'}. Show you what catalogs list for it?`,
    point: target?.id ?? '',
    options: [{ label: 'Yes, tell me', kind: 'explain' }],
  };
}
// One of the 7 places (sky:<place>): the local offer opens with its fact card's hook and first fact, and its
// buttons are the card's suggested actions as local tours (zero tokens), plus its own tour ("Tell me more").
export function presetOffer(target) {
  const card = factsFor(target?.id);
  if (!card) return null;
  const tours = (card.suggested_actions ?? []).map((a) => ({ label: a.label, kind: 'tour', tour: `${a.tour}:${card.id}` }));
  if (!tours.some((o) => o.tour === `identify:${card.id}`)) tours.push({ label: 'Tell me more', kind: 'tour', tour: `identify:${card.id}` });
  return { title: card.name, line: `${card.hook} ${card.facts[0]}`, point: target.id, options: tours.slice(0, 2) };
}
// Arrival at a place (spec, "Arrival trigger"): the card's hook plus its first suggested action, local (zero tokens)
export function arrivalOffer(target) {
  const card = factsFor(target?.id);
  const first = card?.suggested_actions?.[0];
  if (!card || !first) return null;
  const offer = presetOffer(target);
  return { ...offer, line: `${card.hook} ${first.label}?` };
}
const fallbackFor = (m) => (m?.moment === 'object' ? presetOffer(m.target) ?? objectOffer(m.target) : FALLBACK[m?.moment] ?? null); // features: stay quiet

/**
 * @param {Object} o
 * @param {Function} o.ask        (body) -> Promise<reply | { fallback, reason }>   (client.askNudge)
 * @param {Function} o.buildBody  ({ moment, target }) -> request body
 * @param {Function} o.say        popup.say
 * @param {Object}   o.overlay    { pointAt, circle, clear }
 * @param {Function} o.runScript  runner.runScript
 * @param {Function} o.tour       (kind, id) -> Promise   (index.js tour)
 * @param {Function} o.explain    ({ offer, moment, target, trigger, local? }) -> Promise   (a Claude tour; trigger 'object'
 *                                for an object moment, else 'explore'; local: true = budget spent, play the local script)
 * @param {Function} o.isBusy     () -> boolean   (a card or a tour is on)
 * @param {Function} [o.canShow]  (id) -> boolean   (a point id is on screen)
 */
export function createNudge({
  ask, buildBody, say, overlay, runScript, tour, explain, isBusy = () => false, canShow = () => true,
  now = () => Date.now(), storage = globalThis.sessionStorage, options = {}, log = (...a) => console.info('[guide]', ...a),
}) {
  let o = { ...DEFAULTS, ...options };
  let lastCall = -Infinity;
  let lastShown = -Infinity;
  let pending = false;
  const rested = new Map(); // topic -> until
  const blocked = new Map(); // topic -> muted until ("Not now": 5 minutes)
  let declines = 0; // "Not now" in a row
  let askedFewer = false;
  const readCount = () => {
    try {
      return Number(storage?.getItem?.(STORE_KEY)) || 0;
    } catch {
      return 0;
    }
  };
  const writeCount = (n) => {
    try {
      storage?.setItem?.(STORE_KEY, String(n));
    } catch {
      /* private mode: the in-memory gap still applies */
    }
  };
  let calls = readCount();

  /** Why Claude may not be asked now (null = it may). */
  function budgetReason() {
    if (calls >= o.maxPerVisit) return 'visit budget spent';
    if (now() - lastCall < o.gapMs) return 'too soon';
    return null;
  }
  const countCall = () => {
    calls += 1;
    lastCall = now();
    writeCount(calls);
  };

  async function act(option, offer, m) {
    if (option.kind === 'tour') {
      const [kind, id] = String(option.tour).split(':');
      return tour(kind, id ?? null);
    }
    if (option.kind === 'explain') {
      const isObject = m.moment === 'object';
      if (calls >= o.maxPerVisit) {
        // budget spent: a local word instead (for an object, its local script)
        if (!isObject) return tour('where', null);
        return explain({ trigger: 'object', target: m.target, moment: m.moment, local: true });
      }
      countCall();
      if (isObject) return explain({ trigger: 'object', target: m.target, moment: m.moment });
      return explain({ offer: [offer.title, offer.line].filter(Boolean).join(': '), moment: m.moment, target: m.target, trigger: 'explore' });
    }
    // apply: run the setup now, through the same buttons and commands a person uses
    const more = calls < o.maxPerVisit ? [{ id: 'explain', label: 'Tell me more' }] : [];
    const how = await runScript([{ title: option.label, say: offer.line, actions: option.actions, answers: ['got_it', ...more] }], { trigger: 'nudge' });
    if (how === 'explain') return act({ kind: 'explain' }, offer, m);
    return how;
  }

  async function show(offer, m) {
    lastShown = now();
    const point = offer.point && canShow(offer.point) ? offer.point : m.target?.id && canShow(m.target.id) ? m.target.id : null;
    overlay.clear(); // B3: a new offer starts from a clean screen, then draws only its own marks
    if (point) {
      // the pointer goes first: it flies there and circles it, so the offer needs no explaining
      overlay.circle(point);
      overlay.pointAt(point);
    }
    const opts = offer.options.slice(0, 3);
    const answer = await say({
      title: offer.title,
      say: offer.line,
      // up to three buttons fit: two options + "Not now", or three options (✕ still closes it)
      answers: [...opts.map((op, i) => ({ id: `o${i}`, label: op.label })), ...(opts.length < 3 ? [{ id: 'not_now', label: 'Not now' }] : [])],
      auto: o.autoHideMs,
      target: point ?? undefined,
    });
    const i = /^o(\d)$/.exec(answer)?.[1];
    if (i == null) {
      overlay.clear();
      if (answer === 'not_now' && m.moment !== 'menu') {
        blocked.set(topicOf(m), now() + o.muteMs);
        declines += 1;
        if (declines >= o.fewerAfter && !askedFewer) {
          askedFewer = true;
          const a = await say({ title: 'Fewer suggestions?', say: 'I can offer things half as often.', answers: [{ id: 'fewer', label: 'Yes, fewer' }, { id: 'keep', label: 'Keep as is' }] });
          if (a === 'fewer') o = { ...o, gapMs: o.gapMs * 2, offerGapMs: o.offerGapMs * 2, topicMs: o.topicMs * 2 };
        }
      }
      return answer;
    }
    declines = 0;
    return act(opts[Number(i)], offer, m);
  }

  async function handle(m) {
    const topic = topicOf(m);
    if (!m?.moment || (blocked.get(topic) ?? 0) > now() || (rested.get(topic) ?? 0) > now() || pending || isBusy()) return 'skip';
    if (m.moment === 'arrival') {
      // the person just chose this place: a local teaser at once (no Claude call, no offer gap)
      const offer = arrivalOffer(m.target);
      if (!offer) return 'skip';
      rested.set(topic, now() + o.topicMs);
      return show(offer, m);
    }
    if (now() - lastShown < o.offerGapMs) return 'skip';
    rested.set(topic, now() + o.topicMs);
    let offer = null;
    const why = budgetReason();
    if (!why) {
      pending = true;
      countCall();
      try {
        const reply = await ask(buildBody(m));
        if (reply && !reply.fallback && Array.isArray(reply.options) && reply.options.length) offer = reply;
        else log(`nudge: local offer (${reply?.reason ?? 'no reply'})`);
      } catch (err) {
        log('nudge failed', err);
      } finally {
        pending = false;
      }
      if (isBusy()) return 'busy'; // the person started something while we waited
    } else log(`nudge: ${why}; local offer`);
    offer ??= fallbackFor(m);
    if (!offer) return 'skip';
    return show(offer, m);
  }

  /**
   * The pill (dynamic menu, spec "Context model"): Claude's options for what is on screen now, shown like an
   * offer. Counts in the visit budget (not the gap: the person asked). -> outcome, or null when Claude is not
   * available or the budget is spent (the caller shows the fixed menu).
   */
  async function menu(m = {}) {
    if (calls >= o.maxPerVisit || pending) return null;
    pending = true;
    countCall();
    let reply = null;
    try {
      reply = await ask(buildBody({ ...m, moment: 'menu' }));
    } catch (err) {
      log('menu failed', err);
    } finally {
      pending = false;
    }
    if (!reply || reply.fallback || !Array.isArray(reply.options) || !reply.options.length) {
      log(`menu: fixed menu (${reply?.reason ?? 'no reply'})`);
      return null;
    }
    return show(reply, { ...m, moment: 'menu' });
  }

  return {
    handle,
    menu,
    snapshot: () => ({ calls, lastCall, pending, blocked: Object.fromEntries(blocked), declines, rested: Object.fromEntries(rested), budget: budgetReason() }),
    configure: (x = {}) => (o = { ...o, ...x }),
    reset() {
      calls = 0;
      lastCall = -Infinity;
      lastShown = -Infinity;
      writeCount(0);
      rested.clear();
      blocked.clear();
      declines = 0;
      askedFewer = false;
    },
  };
}
