// Guide script runner (guide/runner.js) and fallback scripts (guide/fallback.js), with a fake
// pop-up and overlay and the real command bus. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunner, validateAction, validateScript, defaultAnswers, mergeEnd } from '../src/guide/runner.js';
import { NOTES, identifyTour, motionTour, changeTour, coloursTour, exampleTour, whereTour } from '../src/guide/tours.js';
import { fallbackScript, TRIGGERS } from '../src/guide/fallback.js';
import { createCommands } from '../src/core/commands.js';
import { registerDefaultCommands } from '../src/core/defaultCommands.js';
import { createStore, sanitize } from '../src/core/state.js';

const quiet = (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// A real bus and store, a fake pop-up that records steps and lets the test answer, a fake overlay.
function setup() {
  const events = new EventTarget();
  const store = createStore();
  const commands = createCommands({ target: events });
  registerDefaultCommands(commands, store);
  const shown = [];
  let answerFn = null;
  const say = (step) =>
    new Promise((res) => {
      shown.push(step);
      answerFn = res;
    });
  const marks = [];
  const overlay = {
    pointAt: (id, label) => marks.push(['point', id, label]),
    circle: (id) => marks.push(['circle', id]),
    highlight: (id) => marks.push(['highlight', id]),
    trail: (a, b) => marks.push(['trail', a, b]),
    clear: () => marks.push(['clear']),
  };
  const dismissed = [];
  const logs = [];
  const runner = createRunner({
    say,
    dismiss: (r) => {
      dismissed.push(r);
      answerFn?.('close');
    },
    overlay,
    run: commands.run,
    list: commands.list,
    sanitize,
    getState: store.get,
    events,
    log: (...a) => logs.push(a.join(' ')),
  });
  const answer = async (id) => {
    await tick();
    answerFn(id);
    await tick();
  };
  return { store, commands, runner, shown, marks, dismissed, logs, answer, events };
}

const ctx = () => {
  const store = createStore();
  const commands = createCommands({ target: new EventTarget() });
  registerDefaultCommands(commands, store);
  return { commands: commands.list(), sanitize, state: store.get() };
};

test('validateAction: overlay shapes, whitelisted commands, args checked by the store sanitiser', () => {
  const c = ctx();
  quiet(() => {
    assert.deepEqual(validateAction({ point: 'band-d6', label: 'Long' }, c), { ok: true, action: { point: 'band-d6', label: 'Long' } });
    assert.deepEqual(validateAction({ circle: 'sky:barnard' }, c).action, { circle: 'sky:barnard' });
    assert.deepEqual(validateAction({ trail: ['a', 'b'] }, c).action, { trail: ['a', 'b'] });
    assert.deepEqual(validateAction({ cmd: 'set_band', args: { band: 93 } }, c).action, { cmd: 'set_band', args: { band: 93 } });
    assert.deepEqual(validateAction({ cmd: 'toggle_video' }, c).action, { cmd: 'toggle_video', args: {} });
    assert.ok(validateAction({ cmd: 'fly_to', args: { target: "Barnard's Star", fov: 0.5 } }, c).ok);
    assert.ok(validateAction({ cmd: 'toggle_layer', args: { layer: 'gaia' } }, c).ok);
    assert.ok(validateAction({ cmd: 'set_op', args: { op: 'video' } }, c).ok);

    const bad = [
      { cmd: 'delete_everything' }, // not on the whitelist
      { cmd: 'select_point' }, // a stub
      { cmd: 'set_band', args: { band: 'red' } }, // sanitize rejects it
      { cmd: 'set_op', args: { op: 'explode' } },
      { cmd: 'toggle_layer', args: { layer: 'nope' } },
      { cmd: 'set_color', args: { color: 'pink' } },
      { cmd: 'set_band', args: { band: 40, extra: 1 } }, // arg not in the command's spec
      { cmd: 'set_band', args: [40] },
      { cmd: 'fly_to', args: { target: { $gt: '' } } },
      { cmd: 'fly_to', args: { target: 'x'.repeat(500) } },
      { point: '<img onerror=1>' },
      { circle: 42 },
      { trail: ['a'] },
      { point: 'a', cmd: 'zoom_in' }, // two shapes
      { speak: 'hi' }, // unknown shape
      null,
      'zoom_in',
    ];
    for (const a of bad) assert.equal(validateAction(a, c).ok, false, JSON.stringify(a));
  });
});

test('validateScript: empty steps dropped, bad actions dropped with a log, text kept', () => {
  const logs = [];
  const steps = quiet(() =>
    validateScript(
      [
        { say: 'One', actions: [{ cmd: 'nope' }, { circle: 'band-d6' }] },
        { say: '   ', actions: [{ cmd: 'zoom_in' }] },
        { say: 'All bad', actions: [{ cmd: 'nope' }, { weird: 1 }] },
        'Plain text step',
        null,
      ],
      { ...ctx(), log: (m) => logs.push(m) },
    ),
  );
  assert.deepEqual(steps, [
    { say: 'One', actions: [{ circle: 'band-d6' }] },
    { say: 'All bad', actions: [] },
    { say: 'Plain text step', actions: [] },
  ]);
  assert.equal(logs.length, 5); // nope, empty text, nope, weird, null
  assert.deepEqual(quiet(() => validateScript({ steps: [{ say: 'Wrapped' }] }, { ...ctx(), log() {} })), [{ say: 'Wrapped', actions: [] }]);
  assert.deepEqual(validateScript('nonsense', { ...ctx(), log() {} }), []);
});

test('runner: a bad command is skipped, the good steps and actions run with source "guide"', async () => {
  const t = setup();
  const sources = [];
  t.events.addEventListener('meridian:command', (e) => sources.push([e.detail.name, e.detail.source]));
  const done = quiet(() =>
    t.runner.runScript([
      { say: 'Step one', actions: [{ cmd: 'set_band', args: { band: 93 } }, { circle: 'band-d6' }] },
      { say: 'Step two', actions: [{ cmd: 'rm_rf' }, { cmd: 'set_band', args: { band: 'x' } }] },
      { say: 'Step three', actions: [{ cmd: 'set_color', args: { color: 'ir' } }] },
    ]),
  );
  assert.equal(t.runner.isRunning(), true);
  await t.answer('more');
  await t.answer('more');
  await t.answer('got_it');
  assert.equal(await done, 'done');
  assert.equal(t.runner.isRunning(), false);
  assert.deepEqual(t.shown.map((s) => s.say), ['Step one', 'Step two', 'Step three']);
  assert.deepEqual(t.shown.map((s) => s.answers), [defaultAnswers(false), defaultAnswers(false), defaultAnswers(true)]);
  assert.equal(t.shown[0].target, 'band-d6', 'the card is told what the step marks, so it can avoid it');
  assert.equal(t.store.get().band, 93);
  assert.equal(t.store.get().color, 'ir');
  assert.deepEqual(sources, [['set_band', 'guide'], ['set_color', 'guide']]);
  assert.ok(t.marks.some((m) => m[0] === 'circle' && m[1] === 'band-d6'));
  assert.deepEqual(t.marks.at(-1), ['clear'], 'marks cleared when the script ends');
  assert.equal(t.logs.length, 2);
});

test('runner: a manual command ends the script at once and dismisses the card', async () => {
  const t = setup();
  const done = t.runner.runScript([{ say: 'One' }, { say: 'Two' }]);
  await tick();
  t.commands.run('set_band', { band: 40 }, 'ui'); // the person pressed a button
  assert.equal(await done, 'interrupted');
  assert.deepEqual(t.dismissed, ['close']);
  assert.equal(t.shown.length, 1);
  assert.equal(t.runner.isRunning(), false);

  // guide and preset sources, and failed commands, do not interrupt
  const t2 = setup();
  const done2 = t2.runner.runScript([{ say: 'One' }, { say: 'Two' }]);
  await tick();
  t2.commands.run('zoom_in', {}, 'guide');
  t2.commands.run('zoom_in', {}, 'preset');
  quiet(() => t2.commands.run('no_such_command', {}, 'ui'));
  assert.equal(t2.runner.isRunning(), true);
  await t2.answer('more');
  await t2.answer('got_it');
  assert.equal(await done2, 'done');
});

test('runner: Close ends the script; stop() and a newer script end it too', async () => {
  const t = setup();
  const done = t.runner.runScript([{ say: 'One' }, { say: 'Two' }]);
  await t.answer('close');
  assert.equal(await done, 'closed');
  assert.equal(t.shown.length, 1);

  const a = t.runner.runScript([{ say: 'A' }, { say: 'A2' }]);
  await tick();
  t.runner.stop();
  assert.equal(await a, 'stopped');

  const b = t.runner.runScript([{ say: 'B' }]);
  const c = t.runner.runScript([{ say: 'C' }]);
  assert.equal(await b, 'replaced');
  await t.answer('got_it');
  assert.equal(await c, 'done');

  assert.equal(await t.runner.runScript([{ say: '' }]), 'empty');
});

test('fallback scripts: 2-4 steps with text, only whitelisted commands and valid args, for every trigger and view', () => {
  const c = ctx();
  const targets = [undefined, 'sky:barnard', { id: 'sky:wise_0855', name: 'WISE 0855' }, { id: 'field:target' }];
  for (const trigger of [...TRIGGERS, 'colors', 'unknown']) {
    for (const view of ['sky', 'field']) {
      for (const target of targets) {
        const script = fallbackScript(trigger, target, { view });
        assert.ok(script.length >= 2 && script.length <= 4, `${trigger} length`);
        const actions = script.flatMap((s) => s.actions);
        for (const a of actions) assert.equal(validateAction(a, c).ok, true, `${trigger}/${view}: ${JSON.stringify(a)}`);
        for (const s of script) {
          assert.ok(s.say.trim().length > 0);
          assert.ok(s.say.split(/\s+/).length <= 45, `too long: ${s.say}`);
          assert.doesNotMatch(s.say, /discover/i);
        }
        assert.equal(validateScript(script, { ...c, log: () => assert.fail('nothing dropped') }).length, script.length);
      }
    }
  }
  assert.match(fallbackScript('object', 'sky:barnard')[0].say, /Barnard's Star/);
  assert.deepEqual(fallbackScript('object', 'sky:barnard')[0].actions, [{ point: 'sky:barnard' }, { circle: 'sky:barnard' }]);
  assert.ok(fallbackScript('change', null, { view: 'field' }).some((s) => s.actions.some((a) => a.cmd === 'set_op' && a.args.op === 'video')));
  assert.ok(fallbackScript('colours').some((s) => s.actions.some((a) => a.circle === 'band-d6')));
});

test('fallback: the change script turns the change video on in the field view', async () => {
  const t = setup();
  t.store.set({ view: 'field' }, 'test');
  const done = t.runner.runScript(fallbackScript('change', null, t.store.get()));
  await t.answer('more');
  assert.equal(t.store.get().op, 'video');
  await t.answer('more');
  await t.answer('got_it');
  assert.equal(await done, 'done');
});

// ---- B2: the last step never says "Next" ----

const ids = (answers) => answers.map((a) => a?.id ?? a);

test('B2: with an end card, the last step shows its answers and question; answering resolves, no extra card', async () => {
  const t = setup();
  const done = t.runner.runScript({
    steps: [{ say: 'One' }, { say: 'Two' }],
    end: { title: 'Want to see it move?', answers: [{ id: 'show', label: 'Show me' }, 'got_it'] },
  });
  await t.answer('next');
  await tick();
  const last = t.shown.at(-1);
  assert.equal(last.step, '2 / 2');
  assert.deepEqual(ids(last.answers), ['show', 'got_it']);
  assert.ok(!ids(last.answers).includes('next'));
  assert.equal(last.sub, 'Want to see it move?');
  assert.equal(last.auto, 0, 'waits for a choice');
  await t.answer('show');
  assert.equal(await done, 'show');
  assert.equal(t.shown.length, 2, 'no separate end card');

  // got_it -> 'done'; Close -> 'closed'
  const a = t.runner.runScript({ steps: [{ say: 'A' }], end: { title: 'Is that clear?', answers: ['got_it', 'again'] } });
  await tick();
  assert.equal(t.shown.at(-1).sub, undefined, 'the generic question is dropped');
  await t.answer('got_it');
  assert.equal(await a, 'done');
  const b = t.runner.runScript({ steps: [{ say: 'B' }], end: { answers: ['got_it', 'again'] } });
  await t.answer('close');
  assert.equal(await b, 'closed');
});

test('B2: no end -> last step is Got it; custom answers untouched; a question goes before an existing sub', async () => {
  const t = setup();
  const done = t.runner.runScript([{ say: 'One' }, { say: 'Two' }]);
  await t.answer('next');
  await tick();
  assert.deepEqual(t.shown.at(-1).answers, ['got_it']);
  await t.answer('got_it');
  assert.equal(await done, 'done');

  const custom = t.runner.runScript({ steps: [{ say: 'Only', answers: ['got_it', 'moving'] }], end: { title: 'Q?', answers: ['again'] } });
  await tick();
  assert.deepEqual(t.shown.at(-1).answers, ['got_it', 'moving']);
  await t.answer('moving');
  assert.equal(await custom, 'moving');

  assert.equal(mergeEnd({ say: 'x', sub: 'A caveat.' }, { title: 'Want more?', answers: ['got_it'] }).sub, 'Want more? A caveat.');
  assert.equal(mergeEnd({ say: 'x', answers: ['a'] }, { answers: ['b'] }), null);
  assert.equal(mergeEnd({ say: 'x' }, null), null);
});

test('B2: no tour shows "Next" on its last step', async () => {
  const tours = [];
  for (const id of Object.keys(NOTES)) {
    for (const inField of [false, true]) {
      tours.push([`identify ${id} ${inField}`, identifyTour(id, { inField })]);
      for (const atTarget of [false, true]) tours.push([`motion ${id} ${inField} ${atTarget}`, motionTour(id, { inField, atTarget })]);
      tours.push([`colours ${id} ${inField}`, coloursTour({ inField, id })]);
    }
  }
  tours.push(['change', changeTour()], ['colours', coloursTour()], ['example', exampleTour()]);
  tours.push(['where wide', whereTour({ fov: 180 })], ['where patch', whereTour({ fov: 2, detector: 6 })]);
  let checked = 0;
  for (const [name, script] of tours) {
    if (!script) continue;
    const shown = [];
    const runner = createRunner({
      // answer Next whenever it is offered, else end with the first answer
      say: (step) => {
        shown.push(step);
        const a = ids(step.answers);
        return Promise.resolve(a.includes('next') ? 'next' : a[0]);
      },
      overlay: { pointAt() {}, circle() {}, highlight() {}, trail() {}, clear() {} },
      run: () => ({}),
      list: createCommandsList(),
      sanitize,
      getState: () => createStore().get(),
      log: () => {},
      flyMs: () => 0,
    });
    await runner.runScript(script);
    const steps = Array.isArray(script) ? script : script.steps;
    assert.equal(shown.length, steps.length, `${name}: one card per step, no extra end card`);
    const last = shown.at(-1);
    assert.ok(!ids(last.answers).includes('next'), `${name}: last step (${last.step}) shows Next`);
    checked++;
  }
  assert.ok(checked > 20);
});

function createCommandsList() {
  const store = createStore();
  const commands = createCommands({ target: new EventTarget() });
  registerDefaultCommands(commands, store);
  return commands.list;
}

test('B3: every runScript outcome clears the overlay', async () => {
  const clears = (t) => t.marks.filter((m) => m[0] === 'clear').length;
  const last = (t) => t.marks.at(-1);
  const S = [{ say: 'One', actions: [{ circle: 'band-d6' }, { point: 'band-d6', label: 'D6' }] }, { say: 'Two', actions: [{ circle: 'band-d6' }] }];
  const END = { steps: S, end: { title: 'Want more?', answers: [{ id: 'again', label: 'Again' }, 'got_it'] } };

  // done (Got it), an end-card answer, closed, dismissed, stop
  for (const [script, answers, outcome] of [
    [S, ['next', 'got_it'], 'done'],
    [END, ['next', 'again'], 'again'],
    [S, ['close'], 'closed'],
    [S, ['dismissed'], 'closed'],
    [S, ['next', 'stop'], 'closed'],
  ]) {
    const t = setup();
    const done = t.runner.runScript(script);
    for (const a of answers) await t.answer(a);
    assert.equal(await done, outcome);
    assert.deepEqual(last(t), ['clear'], `${outcome}: cleared at the end`);
  }
  // stopped, replaced
  const t = setup();
  const a = t.runner.runScript(S);
  await tick();
  t.runner.stop();
  assert.equal(await a, 'stopped');
  assert.deepEqual(last(t), ['clear']);
  const b = t.runner.runScript(S);
  await tick();
  const n = clears(t);
  const c = t.runner.runScript([{ say: 'C' }]);
  assert.equal(await b, 'replaced');
  assert.ok(clears(t) > n, 'replaced: cleared');
  await t.answer('got_it');
  await c;
  // the card was replaced by a newer card (popup answers 'replaced')
  const r = setup();
  const rd = r.runner.runScript(S);
  await r.answer('replaced');
  assert.equal(await rd, 'replaced');
  assert.deepEqual(last(r), ['clear']);
  // interrupted by the person's own command
  const i = setup();
  const id = i.runner.runScript(S);
  await tick();
  i.commands.run('zoom_in', {}, 'ui');
  assert.equal(await id, 'interrupted');
  assert.deepEqual(last(i), ['clear']);
  // empty: nothing to play still leaves a clean screen
  const e = setup();
  assert.equal(await e.runner.runScript([{ say: '' }]), 'empty');
  assert.deepEqual(e.marks, [['clear']]);
  // a script error (the pop-up throws) ends 'stopped' and clears
  const cleared = [];
  const broken = createRunner({
    say: () => {
      throw new Error('pop-up broke');
    },
    overlay: { pointAt() {}, circle() {}, highlight() {}, trail() {}, clear: () => cleared.push(1) },
    run: () => ({ ok: true }),
    list: () => [],
    sanitize,
    getState: () => createStore().get(),
    log: () => {},
  });
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await broken.runScript([{ say: 'One' }]), 'stopped');
  } finally {
    console.error = err;
  }
  assert.ok(cleared.length >= 2, 'cleared at the step and at the end');
});

test('B3: a closing card after custom answers shows no marks from the last step', async () => {
  const t = setup();
  const done = t.runner.runScript({
    steps: [{ say: 'Pick', actions: [{ circle: 'band-d6' }, { point: 'band-d6', label: 'D6' }], answers: ['more', 'got_it'] }],
    end: { title: 'Is that clear?', answers: ['got_it'] },
  });
  await t.answer('more');
  assert.equal(t.shown.length, 2, 'the closing card is shown');
  assert.deepEqual(t.marks.at(-1), ['clear'], 'its marks went before the closing card');
  await t.answer('got_it');
  assert.equal(await done, 'done');
});
