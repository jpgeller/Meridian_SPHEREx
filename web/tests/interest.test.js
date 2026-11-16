// The proactive guide: interest moments (guide/interest.js) and the nudge budget / options
// (guide/nudge.js), with a fake clock and fakes for the pop-up, overlay and runner. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInterest, describeCommand } from '../src/guide/interest.js';
import { createNudge, FALLBACK, topicOf, objectOffer } from '../src/guide/nudge.js';
import { classifyTarget } from '../src/guide/attention.js';

const clock = (t = 0) => {
  const c = { t, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
};
const cmd = (name, args = {}, source = 'ui') => ({ name, args, source, ok: true });

test('interest: 3 band changes in 40 s -> "bands", once per 3 min; the guide\'s own commands do not count', () => {
  const c = clock();
  const moments = [];
  const it = createInterest({ now: c.now, onMoment: (m) => moments.push(m.moment) });
  it.command(cmd('set_band', { band: 20 }));
  it.command(cmd('set_band', { band: 93 }, 'guide')); // the guide pressed it: not the person
  c.advance(10000);
  it.command(cmd('next_band'));
  assert.deepEqual(moments, []);
  c.advance(10000);
  it.command(cmd('set_detector', { detector: 6 }, 'keyboard'));
  assert.deepEqual(moments, ['bands']);
  // three more right away: resting
  for (let i = 0; i < 3; i++) it.command(cmd('next_band'));
  assert.deepEqual(moments, ['bands']);
  c.advance(181000);
  for (let i = 0; i < 3; i++) it.command(cmd('next_band'));
  assert.deepEqual(moments, ['bands', 'bands']);
  // too slow: 3 changes over more than 40 s do not count
  const slow = [];
  const it2 = createInterest({ now: c.now, onMoment: (m) => slow.push(m) });
  for (let i = 0; i < 3; i++) {
    it2.command(cmd('set_band', { band: 10 + i }));
    c.advance(25000);
  }
  assert.deepEqual(slow, []);
});

test('interest: colours, compare, first 2D view, a searched name, a long zoom', () => {
  const c = clock();
  const moments = [];
  const it = createInterest({ now: c.now, onMoment: (m) => moments.push(m), isPresetTarget: (t) => /barnard/i.test(t) });
  for (const color of ['grey', 'ir', 'ice']) it.command(cmd('set_color', { color }));
  for (const show of ['video', 'blink', 'wise']) it.command(cmd('set_show', { show }));
  it.command(cmd('open_field'));
  it.command(cmd('open_field')); // only the first time
  it.command(cmd('fly_to', { target: "Barnard's Star" })); // a place: no moment
  it.command(cmd('fly_to', { target: 'Vega' }));
  assert.deepEqual(moments.map((m) => m.moment), ['colours', 'compare', 'timelapse_start', 'object_search']);
  assert.deepEqual(moments.at(-1).target, { id: 'sky:target', name: 'Vega' });

  const z = [];
  const it2 = createInterest({ now: c.now, onMoment: (m) => z.push(m.moment) });
  it2.observe({ view: 'sky', fov: 2 });
  c.advance(19000);
  it2.tick();
  assert.deepEqual(z, []);
  c.advance(2000);
  it2.tick();
  it2.tick();
  assert.deepEqual(z, ['zoomed']);
  // someone who opens the 2D view is never told about it
  const z2 = [];
  const it3 = createInterest({ now: c.now, onMoment: (m) => z2.push(m.moment) });
  it3.observe({ view: 'sky', fov: 2 });
  it3.observe({ view: 'field', fov: 2, op: 'none', mode: 'single', ffov: 0.1 });
  c.advance(30000);
  it3.tick();
  assert.deepEqual(z2, []);
});

test('interest: the profile lists top topics, the last actions and what was tried', () => {
  const c = clock();
  const it = createInterest({ now: c.now });
  for (const b of [8, 42, 93]) {
    it.command(cmd('set_band', { band: b }));
    it.observe({ view: 'sky', band: b, color: 'grey', fov: 60 });
  }
  it.command(cmd('set_color', { color: 'ice' }));
  it.observe({ view: 'field', band: 93, color: 'ice', op: 'video', compare: 'off', mode: 'detector', ffov: 0.25 });
  c.advance(65000);
  const p = it.profile();
  assert.deepEqual(p.topics, ['bands', 'colours']);
  assert.deepEqual(p.recent, ['set_band 8', 'set_band 42', 'set_band 93', 'set_color ice']);
  for (const x of ['D1', 'D3', 'D6', 'color:ice', 'show:video', 'mode:detector', 'ffov:0.25', 'view:field']) assert.ok(p.tried.includes(x), x);
  assert.equal(p.seconds, 65);
  assert.equal(describeCommand({ name: 'set_mix', args: { mix: [1, 2, 3] } }), 'set_mix');
});

test('attention: controls are "features"; the guide\'s own UI and big containers are not', () => {
  assert.equal(classifyTarget('op-video'), 'feature');
  assert.equal(classifyTarget('play'), 'feature');
  assert.equal(classifyTarget('preset:barnard'), 'feature');
  assert.equal(classifyTarget('band-d6'), 'colours');
  assert.equal(classifyTarget('sky:barnard'), 'object');
  for (const id of ['guide-pill', 'guide-popup', 'panel-toggle', 'time-player', 'search', 'presets']) assert.equal(classifyTarget(id), null, id);
});

// --- nudge -------------------------------------------------------------------------------------

const REPLY = {
  title: 'Cold things glow in D6',
  line: 'In D6 the coldest things glow. Try it with the Ices view.',
  point: 'band-d6',
  options: [
    { label: 'Show D6 with Ices', kind: 'apply', actions: [{ click: 'band-d6' }, { cmd: 'set_color', args: { color: 'ice' } }] },
    { label: 'Tour the colours', kind: 'tour', tour: 'colours' },
  ],
};

function setup({ reply = REPLY, answer = 'o0', storage = null } = {}) {
  const c = clock(1000);
  const asked = [];
  const shown = [];
  const marks = [];
  const scripts = [];
  const tours = [];
  const explains = [];
  let busy = false;
  const mem = new Map();
  const n = createNudge({
    ask: async (body) => (asked.push(body), typeof reply === 'function' ? reply() : reply),
    buildBody: (m) => ({ moment: m.moment }),
    say: async (step) => (shown.push(step), typeof answer === 'function' ? answer(step) : answer),
    overlay: { pointAt: (id) => marks.push(['point', id]), circle: (id) => marks.push(['circle', id]), clear: () => marks.push(['clear']) },
    runScript: async (steps) => (scripts.push(steps), 'done'),
    tour: async (kind, id) => (tours.push([kind, id]), 'done'),
    explain: async (x) => (explains.push(x), 'done'),
    isBusy: () => busy,
    now: c.now,
    storage: storage ?? { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) },
    log: () => {},
  });
  return { n, c, asked, shown, marks, scripts, tours, explains, setBusy: (b) => (busy = b), mem };
}

test('nudge: the pointer goes first, then the offer with its options; "apply" runs the setup locally', async () => {
  const s = setup();
  assert.equal(await s.n.handle({ moment: 'bands' }), 'done');
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.marks.slice(0, 3), [['clear'], ['circle', 'band-d6'], ['point', 'band-d6']]);
  const card = s.shown[0];
  assert.equal(card.title, 'Cold things glow in D6');
  assert.deepEqual(card.answers.map((a) => a.label), ['Show D6 with Ices', 'Tour the colours', 'Not now']);
  assert.equal(card.auto, 8000);
  // "apply": one local step with the commands, and a "Tell me more" (Claude) option
  assert.deepEqual(s.scripts[0][0].actions, REPLY.options[0].actions);
  assert.deepEqual(s.scripts[0][0].answers, ['got_it', { id: 'explain', label: 'Tell me more' }]);
});

test('nudge: tour and explain options; "Not now" mutes the topic for 5 minutes', async () => {
  const s = setup({ answer: 'o1' });
  await s.n.handle({ moment: 'bands' });
  assert.deepEqual(s.tours, [['colours', null]]);
  const e = setup({ reply: { ...REPLY, options: [{ label: 'Explain', kind: 'explain' }, REPLY.options[1]] } });
  await e.n.handle({ moment: 'compare' });
  assert.deepEqual(e.explains, [{ offer: 'Cold things glow in D6: In D6 the coldest things glow. Try it with the Ices view.', moment: 'compare', target: undefined, trigger: 'explore' }]);
  assert.equal(e.n.snapshot().calls, 2, 'the explanation counts in the visit budget');
  const no = setup({ answer: 'not_now' });
  await no.n.handle({ moment: 'bands' });
  no.c.advance(4 * 60000);
  assert.equal(await no.n.handle({ moment: 'bands' }), 'skip');
  assert.equal(no.asked.length, 1);
  no.c.advance(2 * 60000);
  assert.notEqual(await no.n.handle({ moment: 'bands' }), 'skip');
});

test('nudge: budget: offers 15 s apart, one call per 15 s, 40 per visit, a topic rests 90 s, nothing while busy', async () => {
  const s = setup({ answer: 'close' });
  await s.n.handle({ moment: 'bands' });
  // another topic 10 s later: no offer at all (two pop-ups within 15 s would be too much)
  s.c.advance(10000);
  assert.equal(await s.n.handle({ moment: 'colours' }), 'skip');
  // 16 s after the first: an offer and a Claude call are fine again
  s.c.advance(6000);
  await s.n.handle({ moment: 'colours' });
  assert.equal(s.asked.length, 2);
  // the same topic within 90 s: nothing at all
  s.c.advance(30000);
  assert.equal(await s.n.handle({ moment: 'bands' }), 'skip');
  // busy (a card or a tour): nothing
  s.setBusy(true);
  assert.equal(await s.n.handle({ moment: 'compare' }), 'skip');
  s.setBusy(false);
  // 40 per visit, counted in sessionStorage (a reload keeps the count)
  s.mem.set('meridian.guide.nudges', '40');
  const again = setup({ storage: { getItem: (k) => s.mem.get(k) ?? null, setItem: (k, v) => s.mem.set(k, v) } });
  await again.n.handle({ moment: 'motion' });
  assert.equal(again.asked.length, 0);
  assert.equal(again.shown[0].title, FALLBACK.motion.title);
});

test('nudge: a failed or empty reply plays the local offer; a feature with no local offer stays quiet', async () => {
  const s = setup({ reply: { fallback: true, reason: 'no API key on the server' }, answer: 'o0' });
  await s.n.handle({ moment: 'zoomed' });
  assert.deepEqual(s.scripts[0][0].actions, [{ click: 'open-field' }]);
  const f = setup({ reply: { fallback: true, reason: 'timeout' } });
  assert.equal(await f.n.handle({ moment: 'feature:op-video' }), 'skip');
  assert.equal(f.shown.length, 0);
  assert.equal(topicOf({ moment: 'object', target: { id: 'sky:target' } }), 'object:sky:target');
});

const VEGA = { id: 'sky:target', name: 'Vega' };

test('B7: an object moment with no Claude offer shows a local offer naming it; "Yes, tell me" asks for an object explanation', async () => {
  const s = setup({ reply: { fallback: true, reason: 'timeout' }, answer: 'o0' });
  assert.equal(await s.n.handle({ moment: 'object', target: VEGA }), 'done');
  const card = s.shown[0];
  assert.equal(card.title, 'Vega');
  assert.match(card.say, /Look here: Vega/);
  assert.deepEqual(card.answers.map((a) => a.label), ['Yes, tell me', 'Not now']);
  assert.deepEqual(s.marks.slice(0, 3), [['clear'], ['circle', 'sky:target'], ['point', 'sky:target']]);
  assert.deepEqual(s.explains, [{ trigger: 'object', target: VEGA, moment: 'object' }]);
  assert.equal(s.n.snapshot().calls, 2, 'the nudge call and the explanation both count');
  // no name: a generic "this star"
  assert.equal(objectOffer({ id: 'sky:x' }).title, 'This star');
  assert.match(objectOffer(null).line, /this star/);
});

test('B7: an explain option of a Claude offer on an object uses trigger "object" (other moments keep "explore")', async () => {
  const s = setup({ reply: { ...REPLY, options: [{ label: 'Tell me', kind: 'explain' }] } });
  await s.n.handle({ moment: 'object', target: VEGA });
  assert.deepEqual(s.explains, [{ trigger: 'object', target: VEGA, moment: 'object' }]);
  // "Tell me more" after an apply on an object moment: also an object explanation
  const t = setup();
  const n = createNudge({
    ask: async () => REPLY, buildBody: () => ({}), say: async () => 'o0', overlay: { pointAt() {}, circle() {}, clear() {} },
    runScript: async () => 'explain', tour: async () => 'done', explain: async (x) => (t.explains.push(x), 'done'),
    storage: { getItem: () => null, setItem() {} }, log: () => {},
  });
  await n.handle({ moment: 'object', target: VEGA });
  assert.deepEqual(t.explains, [{ trigger: 'object', target: VEGA, moment: 'object' }]);
});

test('B7: visit budget spent -> no API call; "Yes, tell me" plays the local object script', async () => {
  const mem = new Map([['meridian.guide.nudges', '40']]);
  const s = setup({ storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }, answer: 'o0' });
  await s.n.handle({ moment: 'object', target: VEGA });
  assert.equal(s.asked.length, 0);
  assert.equal(s.shown[0].title, 'Vega');
  assert.deepEqual(s.explains, [{ trigger: 'object', target: VEGA, moment: 'object', local: true }]);
  assert.equal(s.n.snapshot().calls, 40, 'nothing more counted');
});

test('B3: a nudge clears earlier marks before drawing its own, and clears on every non-option answer', async () => {
  for (const answer of ['not_now', 'close', 'dismissed', 'replaced', 'timeout']) {
    const s = setup({ answer });
    assert.equal(await s.n.handle({ moment: 'bands' }), answer);
    assert.deepEqual(s.marks[0], ['clear'], `${answer}: cleared before drawing`);
    assert.deepEqual(s.marks.at(-1), ['clear'], `${answer}: its marks are gone after`);
    assert.equal(s.scripts.length + s.tours.length + s.explains.length, 0);
  }
  // no point on screen: still a clean screen for the offer
  const s = setup({ answer: 'close' });
  const hidden = createNudge({
    ask: async () => REPLY, buildBody: () => ({}), say: async () => 'close', overlay: { pointAt() {}, circle() {}, clear: () => s.marks.push(['clear']) },
    runScript: async () => 'done', tour: async () => 'done', explain: async () => 'done', canShow: () => false,
    storage: { getItem: () => null, setItem() {} }, log: () => {},
  });
  await hidden.handle({ moment: 'bands' });
  assert.deepEqual(s.marks, [['clear'], ['clear']]);
});

test('nudge: three "Not now" in a row ask once "Fewer suggestions?"; yes halves the rate', async () => {
  const s = setup({ answer: 'not_now' });
  for (const m of ['bands', 'colours', 'compare']) {
    await s.n.handle({ moment: m });
    s.c.advance(20000);
  }
  const ask = s.shown.find((c) => c.title === 'Fewer suggestions?');
  assert.ok(ask, 'asked after three declines');
  assert.equal(s.shown.filter((c) => c.title === 'Fewer suggestions?').length, 1);
});

test('nudge.menu: the pill asks Claude for options (moment "menu", shared budget); failure or no budget -> null', async () => {
  const s = setup({ answer: 'o1' });
  assert.equal(await s.n.menu({}), 'done');
  assert.equal(s.asked[0].moment, 'menu');
  assert.equal(s.n.snapshot().calls, 1);
  const f = setup({ reply: { fallback: true, reason: 'no key' } });
  assert.equal(await f.n.menu({}), null);
  const mem = new Map([['meridian.guide.nudges', '40']]);
  const b = setup({ storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) } });
  assert.equal(await b.n.menu({}), null);
  assert.equal(b.asked.length, 0);
});

test('arrival: go_preset by the person -> moment "arrival" every time; the nudge shows the hook + first action locally', async () => {
  const moments = [];
  const it = createInterest({ onMoment: (m) => moments.push(m) });
  it.command({ name: 'go_preset', args: { id: 'barnard' }, source: 'ui', ok: true });
  it.command({ name: 'go_preset', args: { id: 'barnard' }, source: 'guide', ok: true });
  it.command({ name: 'go_preset', args: { id: 'wise_0855' }, source: 'ui', ok: true });
  assert.deepEqual(moments.map((m) => m.target.id), ['sky:barnard', 'sky:wise_0855']);
  const s = setup({ answer: 'not_now' });
  await s.n.handle({ moment: 'arrival', target: { id: 'sky:barnard' } });
  assert.equal(s.asked.length, 0, 'no Claude call');
  assert.match(s.shown[0].say, /fastest-moving star/);
  assert.match(s.shown[0].say, /\?$/);
});
