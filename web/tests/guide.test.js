// AI guide (spec 1 + wireframe v4): the runner's `click` and tour flow, the bus's actingAs, the
// tours, what is in the middle of the view, and the resolver label fix. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunner, validateAction, refuseClick } from '../src/guide/runner.js';
import { centreTarget } from '../src/guide/menu.js';
import { menuCard, identifyTour, motionTour, changeTour, coloursTour, exampleTour, whereTour, presetIdOf, NOTES } from '../src/guide/tours.js';
import { PRESETS } from '../src/sky/presets.js';
import { createCommands } from '../src/core/commands.js';
import { registerDefaultCommands } from '../src/core/defaultCommands.js';
import { createStore, sanitize } from '../src/core/state.js';
import { displayName } from '../src/sky/presets.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake <button> whose click() runs a handler, like the real controls do. */
function fakeButton(onClick, { tag = 'BUTTON', attrs = {}, disabled = false, inCard = false } = {}) {
  const classes = new Set();
  const el = {
    tagName: tag,
    disabled,
    clicks: 0,
    getAttribute: (k) => attrs[k] ?? null,
    hasAttribute: (k) => k in attrs,
    closest: (sel) => (inCard && sel.includes('guide-popup') ? {} : null),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    click() {
      el.clicks++;
      onClick?.();
    },
  };
  return el;
}

function setup(controls = {}) {
  const events = new EventTarget();
  const store = createStore();
  const commands = createCommands({ target: events });
  registerDefaultCommands(commands, store);
  let answerFn = null;
  const marks = [];
  const logs = [];
  const seen = [];
  events.addEventListener('meridian:command', (e) => seen.push(e.detail));
  const runner = createRunner({
    say: () => new Promise((res) => (answerFn = res)),
    dismiss: () => answerFn?.('close'),
    overlay: {
      pointAt: (id) => marks.push(['point', id]),
      circle: (id) => marks.push(['circle', id]),
      highlight: () => {},
      trail: () => {},
      press: (id) => marks.push(['press', id]),
      clear: () => marks.push(['clear']),
    },
    run: commands.run,
    list: commands.list,
    sanitize,
    getState: store.get,
    events,
    log: (...a) => logs.push(a.join(' ')),
    findControl: (id) => controls[id] ?? null,
    actingAs: commands.actingAs,
    flyMs: () => 0,
  });
  return { store, commands, runner, marks, logs, seen, answer: (id) => answerFn(id) };
}

test('validateAction: click takes a control id, never a sky spot', () => {
  const c = { commands: [], sanitize, state: undefined };
  assert.deepEqual(validateAction({ click: 'band-d6' }, c), { ok: true, action: { click: 'band-d6' } });
  assert.equal(validateAction({ click: 'sky:barnard' }, c).ok, false);
  assert.equal(validateAction({ click: '' }, c).ok, false);
  assert.equal(validateAction({ click: 'band-d6', circle: 'band-d6' }, c).ok, false);
});

test('refuseClick: buttons and button-like [data-guide] controls only, enabled, not the guide card', () => {
  assert.equal(refuseClick(fakeButton()), null);
  assert.equal(refuseClick(fakeButton(null, { tag: 'DIV', attrs: { 'data-guide': 'x', role: 'button' } })), null);
  assert.match(refuseClick(fakeButton(null, { tag: 'SECTION', attrs: { 'data-guide': 'presets' } })), /not a button/);
  assert.match(refuseClick(fakeButton(null, { tag: 'DIV' })), /not a button/);
  assert.match(refuseClick(fakeButton(null, { disabled: true })), /disabled/);
  assert.match(refuseClick(fakeButton(null, { attrs: { 'aria-disabled': 'true' } })), /disabled/);
  assert.match(refuseClick(fakeButton(null, { inCard: true })), /own card/);
  assert.match(refuseClick(null), /no such control/);
});

test('click: the pointer flies to D6, presses it once, the button sets the band as the guide', async () => {
  let s;
  const d6 = fakeButton(() => s.commands.run('set_band', { band: 93 }, 'ui')); // the button's own handler
  s = setup({ 'band-d6': d6 });
  const done = s.runner.runScript([{ say: 'D6 holds the longest wavelengths.', actions: [{ click: 'band-d6' }] }]);
  await tick();
  await tick();
  assert.equal(d6.clicks, 1);
  assert.deepEqual(s.marks.filter((m) => m[0] !== 'clear'), [['point', 'band-d6'], ['press', 'band-d6']]);
  assert.equal(s.store.get().band, 93);
  // reported as the guide's command, so the script and its marks carry on
  assert.deepEqual(s.seen.map((d) => [d.name, d.source, d.ok]), [['set_band', 'guide', true]]);
  assert.equal(s.runner.isRunning(), true);
  s.answer('got_it');
  assert.equal(await done, 'done');
});

test('click: refused for a missing, hidden or non-button control (logged, nothing pressed)', async () => {
  const section = fakeButton(null, { tag: 'SECTION', attrs: { 'data-guide': 'presets' } });
  const s = setup({ presets: section });
  const done = s.runner.runScript([{ say: 'Hi.', actions: [{ click: 'presets' }, { click: 'band-d6' }] }]);
  await tick();
  assert.equal(section.clicks, 0);
  assert.equal(s.marks.some((m) => m[0] === 'point' || m[0] === 'press'), false);
  assert.equal(s.logs.filter((l) => /click .* refused/.test(l)).length, 2);
  s.answer('got_it');
  assert.equal(await done, 'done');
});

test('click: waits for an async command the press starts before the next action', async () => {
  const events = new EventTarget();
  const store = createStore();
  const commands = createCommands({ target: events });
  let release;
  commands.register('slow', () => new Promise((r) => (release = r)), { label: 'slow' });
  const btn = fakeButton(() => commands.run('slow', {}, 'ui'));
  const marks = [];
  let answerFn;
  const runner = createRunner({
    say: () => new Promise((res) => (answerFn = res)),
    overlay: { pointAt: () => {}, circle: (id) => marks.push(id), highlight() {}, trail() {}, clear() {} },
    run: commands.run,
    list: commands.list,
    sanitize,
    getState: store.get,
    events,
    log: () => {},
    findControl: () => btn,
    actingAs: commands.actingAs,
    flyMs: () => 0,
  });
  const done = runner.runScript([{ say: 'Watch.', actions: [{ click: 'b' }, { circle: 'band-d6' }] }]);
  await tick();
  assert.deepEqual(marks, []); // still waiting for "slow"
  release();
  await tick();
  await tick();
  assert.deepEqual(marks, ['band-d6']);
  answerFn('got_it');
  assert.equal(await done, 'done');
});

test('actingAs: reports its source for runs inside it, and personOnly commands refuse', () => {
  const events = new EventTarget();
  const commands = createCommands({ target: events });
  const seen = [];
  events.addEventListener('meridian:command', (e) => seen.push(e.detail.source));
  commands.register('a', () => {}, {});
  commands.register('mine', () => {}, { personOnly: true });
  commands.actingAs('guide', () => commands.run('a', {}, 'ui'));
  commands.run('a', {}, 'ui');
  assert.deepEqual(seen, ['guide', 'ui']);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(commands.actingAs('guide', () => commands.run('mine', {}, 'ui')).ok, false);
  } finally {
    console.warn = warn;
  }
  assert.equal(commands.run('mine', {}, 'ui').ok, true);
});

test('centreTarget: the named place in the middle of the view beats sky:target; controls ignored', () => {
  const items = [
    { id: 'sky:target', label: "Barnard's Star", x: 500, y: 400, r: 24 },
    { id: 'sky:barnard', label: "Barnard's Star", x: 501, y: 401, r: 24 },
    { id: 'band-d6', x: 500, y: 400, rect: { x: 480, y: 380, w: 40, h: 40 } },
    { id: 'sky:r_dra', x: 900, y: 100, r: 24 },
  ];
  assert.deepEqual(centreTarget(items, { x: 500, y: 400 }, 80), { id: 'sky:barnard', name: "Barnard's Star" });
  assert.equal(centreTarget(items, { x: 100, y: 100 }, 80), null);
});

// every tour must survive the runner's whitelist: real commands, valid args, known action shapes
const tourCtx = () => {
  const store = createStore();
  const commands = createCommands({ target: new EventTarget() });
  registerDefaultCommands(commands, store);
  // registered by the sky and the UI in the app
  commands.register('toggle_panel', () => {}, { args: { open: 'true or false' } });
  commands.register('go_preset', () => {}, { args: { id: 'preset id' } });
  return { commands: commands.list(), sanitize, state: store.get() };
};
function assertClean(script, label) {
  const c = tourCtx();
  for (const [i, step] of script.steps.entries()) {
    assert.ok(step.say?.trim(), `${label} step ${i + 1} has text`);
    for (const a of step.actions) assert.equal(validateAction(a, c).ok, true, `${label} step ${i + 1}: ${JSON.stringify(a)} ${validateAction(a, c).reason ?? ''}`);
  }
}

test('tours: every place has notes; every tour uses only whitelisted actions', () => {
  for (const p of PRESETS) assert.ok(NOTES[p.id], `notes for ${p.id}`);
  for (const p of PRESETS) {
    for (const inField of [false, true]) {
      assertClean(identifyTour(p.id, { inField }), `identify ${p.id}`);
      for (const atTarget of [false, true]) assertClean(motionTour(p.id, { inField, atTarget }), `motion ${p.id}`);
    }
  }
  assertClean(changeTour(), 'change');
  assertClean(coloursTour({ inField: true }), 'colours');
  assertClean(exampleTour(), 'example');
  assertClean(whereTour({ fov: 180, detector: 3 }), 'where');
  assert.equal(identifyTour('nowhere'), null);
  assert.equal(presetIdOf('sky:barnard'), 'barnard');
  assert.equal(presetIdOf('sky:target'), null);
});

test('tours: the motion tour flies, opens the time-lapse, starts at the first picture, plays, then trails', () => {
  const t = motionTour('barnard', { inField: false, atTarget: false });
  const flat = t.steps.flatMap((s) => s.actions);
  const order = ['go_preset', 'open-field', 'set_frame', 'play', 'op-trail'].map((k) => flat.findIndex((a) => a.cmd === k || a.click === k));
  assert.ok(order.every((i, j) => i >= 0 && (j === 0 || i > order[j - 1])), JSON.stringify(order));
  assert.deepEqual(t.end.answers.map((a) => a.id ?? a), ['got_it', 'again', 'back']);
  // already in the time-lapse of that place: straight to the pictures
  const here = motionTour('barnard', { inField: true, atTarget: true }).steps.flatMap((s) => s.actions);
  assert.equal(here.some((a) => a.cmd === 'go_preset' || a.click === 'open-field'), false);
  // a changing star blinks instead; R Dra says it saturates
  const rdra = motionTour('r_dra', { inField: true, atTarget: true });
  assert.ok(rdra.steps.some((s) => s.actions.some((a) => a.click === 'op-blink')));
  assert.ok(rdra.steps.some((s) => /saturates/.test(s.sub ?? '')));
});

test('tours: colours presses D1 then D6; WISE 0855 puts the band on D6; the menu offers three things', () => {
  const c = coloursTour().steps.flatMap((s) => s.actions).filter((a) => a.click).map((a) => a.click);
  assert.deepEqual(c, ['band-d1', 'band-d6']);
  assert.ok(identifyTour('wise_0855').steps.some((s) => s.actions.some((a) => a.click === 'band-d6')));
  assert.equal(identifyTour('barnard').steps.some((s) => s.actions.some((a) => a.click)), false);
  assert.deepEqual(menuCard().answers.map((a) => a.label), ['What am I looking at?', 'Something moving', 'What the colours mean']);
});

test('runner: tour steps show "i / n", Next/Stop and auto-advance; the end card answer is returned', async () => {
  const events = new EventTarget();
  const store = createStore();
  const commands = createCommands({ target: events });
  registerDefaultCommands(commands, store);
  const shown = [];
  let answerFn;
  const runner = createRunner({
    say: (step) => new Promise((res) => (shown.push(step), (answerFn = res))),
    overlay: { pointAt() {}, circle() {}, highlight() {}, trail() {}, clear() {} },
    run: commands.run,
    list: commands.list,
    sanitize,
    getState: store.get,
    events,
    log: () => {},
  });
  const done = runner.runScript({ steps: [{ say: 'One.', ms: 3000 }, { say: 'Two.', title: 'T', facts: [['a', 'b']] }], end: { title: 'Is that clear?', answers: ['got_it', { id: 'again', label: 'Show me again' }] } });
  await tick();
  assert.equal(shown[0].step, '1 / 2');
  assert.deepEqual(shown[0].answers, ['next', 'stop']);
  assert.equal(shown[0].auto, 3000);
  answerFn('auto'); // the bar ran out
  await tick();
  assert.equal(shown[1].step, '2 / 2');
  assert.equal(shown[1].title, 'T');
  assert.deepEqual(shown[1].facts, [['a', 'b']]);
  answerFn('next');
  await tick();
  assert.equal(shown[2].title, 'Is that clear?');
  answerFn('again');
  assert.equal(await done, 'again');
  // Stop ends it
  const two = runner.runScript({ steps: [{ say: 'One.' }, { say: 'Two.' }] });
  await tick();
  answerFn('stop');
  assert.equal(await two, 'closed');
});

test('displayName: no "NAME " prefix, tidy case, preset labels win', () => {
  assert.equal(displayName("NAME Barnard's star", "Barnard's Star"), "Barnard's Star");
  assert.equal(displayName("NAME Barnard's star", 'something else'), "Barnard's Star");
  assert.equal(displayName('NAME Polaris', 'polaris x'), 'Polaris');
  assert.equal(displayName('RW Aur', 'RW Aur'), 'RW Aurigae');
  assert.equal(displayName('V* AB Dor', 'AB Dor'), 'V* AB Dor');
  assert.equal(displayName(undefined, '133.7578 -7.242'), '133.7578 -7.242');
});
