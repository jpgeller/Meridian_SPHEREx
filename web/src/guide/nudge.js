// Proactive offers ("nudges"): a moment noticed by interest.js or attention.js becomes ONE short
// offer in the top-right card, with 2-3 buttons, after the pointer has flown to what it is about.
// Claude writes the offer (POST /api/guide/nudge, see api/guide.py); this module keeps it cheap:
//
//   - budget: at most one Claude call per `gapMs` (45 s), `maxPerVisit` (15) per visit (sessionStorage),
//     never while a card, a tour or a request is busy, no two offers within `offerGapMs` (30 s);
//     a moment's topic rests `topicMs` (3 min) after
//     an offer; "Not now" blocks that topic for the visit.
//   - local fallback: no key, a timeout, an invalid reply or an empty budget -> a fixed local offer for
//     that moment (FALLBACK below), so the guide never goes silent, at zero tokens.
//   - options: apply (run the setup now: commands/clicks, local), tour (a built-in tour), explain
//     (a short Claude tour about the offer: counted in the visit budget), plus "Not now".
//
//   const n = createNudge({ ask, buildBody, say, overlay, runScript, tour, explain, isBusy, now, storage })
//   n.handle({ moment, target? }) -> Promise<outcome>   n.snapshot()   n.configure(o)   n.reset()
//
// Pure apart from what is injected (unit-tested in tests/interest.test.js with fakes).

export const DEFAULTS = Object.freeze({
  gapMs: 45000,
  maxPerVisit: 15,
  topicMs: 180000,
  offerGapMs: 30000, // no two offers of any kind (Claude or local) closer than this
  autoHideMs: 14000,
});
const STORE_KEY = 'meridian.guide.nudges';

// Local offers when Claude is not available (or the budget is spent). Same shape as a Claude reply.
export const FALLBACK = {
  bands: { title: '102 infrared colours', line: 'You are trying different bands. Want a quick tour of what each detector shows?', point: 'band-ribbon',
    options: [{ label: 'Tour the bands', kind: 'tour', tour: 'colours' }, { label: 'Try D6 (coldest)', kind: 'apply', actions: [{ click: 'band-d6' }] }] },
  colours: { title: 'Colours are a choice', line: 'These colours paint infrared light. The Ices view shows cold, icy places well.', point: 'colour-views',
    options: [{ label: 'Try the Ices view', kind: 'apply', actions: [{ cmd: 'set_color', args: { color: 'ice' } }] }, { label: 'Tour the colours', kind: 'tour', tour: 'colours' }] },
  timelapse_start: { title: 'Real pictures, real dates', line: 'Each frame is a real SPHEREx picture of this spot. The change video makes motion easy to follow.', point: 'op-video',
    options: [{ label: 'Play the change video', kind: 'apply', actions: [{ click: 'op-video' }, { click: 'play' }] }, { label: 'Play the pictures', kind: 'apply', actions: [{ click: 'play' }] }] },
  compare: { title: 'Ways to compare dates', line: 'Blink flips two dates to catch brightness changes; the change video follows things that move.', point: 'op-blink',
    options: [{ label: 'Try Blink', kind: 'apply', actions: [{ click: 'op-blink' }] }, { label: 'Try the change video', kind: 'apply', actions: [{ click: 'op-video' }] }] },
  motion: { title: 'Looking for a change?', line: 'The change video slides between the real pictures from 2010 to 2026, so motion is easy to see.', point: 'op-video',
    options: [{ label: 'Play the change video', kind: 'apply', actions: [{ click: 'op-video' }, { click: 'play' }] }, { label: 'Show a moving star', kind: 'tour', tour: 'motion:barnard' }] },
  zoomed: { title: 'See the real pictures', line: 'You are zoomed in. The real SPHEREx pictures of this spot are sharper, one per visit.', point: 'open-field',
    options: [{ label: 'Open the pictures', kind: 'apply', actions: [{ click: 'open-field' }] }, { label: 'Show a moving star', kind: 'tour', tour: 'motion:barnard' }] },
  object_search: { title: 'Found it', line: 'This is where your search points. Zoom in and open the real pictures to see it in SPHEREx.', point: 'sky:target',
    options: [{ label: 'Open the pictures', kind: 'apply', actions: [{ click: 'open-field' }] }, { label: 'What am I seeing?', kind: 'tour', tour: 'where' }] },
};
// a moment's topic: features share one per control, objects one per object
export const topicOf = ({ moment, target } = {}) => (moment === 'object' && target?.id ? `object:${target.id}` : String(moment ?? ''));
const fallbackFor = (moment) => FALLBACK[moment] ?? null; // features and objects: no local offer, stay quiet

/**
 * @param {Object} o
 * @param {Function} o.ask        (body) -> Promise<reply | { fallback, reason }>   (client.askNudge)
 * @param {Function} o.buildBody  ({ moment, target }) -> request body
 * @param {Function} o.say        popup.say
 * @param {Object}   o.overlay    { pointAt, circle, clear }
 * @param {Function} o.runScript  runner.runScript
 * @param {Function} o.tour       (kind, id) -> Promise   (index.js tour)
 * @param {Function} o.explain    ({ offer, moment, target }) -> Promise   (a Claude tour)
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
  const blocked = new Set(); // "Not now" for this visit
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
      if (calls >= o.maxPerVisit) return tour('where', null); // budget spent: a local word instead
      countCall();
      return explain({ offer: [offer.title, offer.line].filter(Boolean).join(': '), moment: m.moment, target: m.target });
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
      if (answer === 'not_now') blocked.add(topicOf(m));
      return answer;
    }
    return act(opts[Number(i)], offer, m);
  }

  async function handle(m) {
    const topic = topicOf(m);
    if (!m?.moment || blocked.has(topic) || (rested.get(topic) ?? 0) > now() || pending || isBusy()) return 'skip';
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
    offer ??= fallbackFor(m.moment);
    if (!offer) return 'skip';
    return show(offer, m);
  }

  return {
    handle,
    snapshot: () => ({ calls, lastCall, pending, blocked: [...blocked], rested: Object.fromEntries(rested), budget: budgetReason() }),
    configure: (x = {}) => (o = { ...o, ...x }),
    reset() {
      calls = 0;
      lastCall = -Infinity;
      lastShown = -Infinity;
      writeCount(0);
      rested.clear();
      blocked.clear();
    },
  };
}
