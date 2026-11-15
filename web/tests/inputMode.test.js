import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeBehaviour, nextMode, parseMode, MODE_INFO, INPUTS } from '../src/input/inputMode.js';
import { createStore } from '../src/core/state.js';
import { parseQuery, toQuery } from '../src/core/url.js';
import { validateAction } from '../src/guide/runner.js';
import { buildRequest } from '../src/guide/client.js';

test('input modes: A mouse only, B gaze feeds the guide, C gaze presses and feeds the guide', () => {
  assert.deepEqual(INPUTS, ['mouse', 'assist', 'gaze']);
  assert.deepEqual(Object.values(MODE_INFO).map((i) => i.letter), ['A', 'B', 'C']);
  const a = modeBehaviour('mouse');
  assert.equal(a.press, false);
  assert.equal(a.attention, false); // gaze is ignored by the guide in A (the mouse may feed it with ?gaze=mouse)
  assert.equal(a.mouseAttention, true);
  assert.equal(a.autoHide, true);
  const b = modeBehaviour('assist');
  assert.equal(b.press, false); // never clicks
  assert.equal(b.attention, true);
  assert.equal(b.mouseAttention, false);
  assert.equal(b.autoHide, false); // offers wait for an answer
  const c = modeBehaviour('gaze');
  assert.equal(c.press, true);
  assert.equal(c.attention, true);
  assert.equal(c.autoHide, false);
  assert.equal(modeBehaviour('nonsense').mode, 'mouse');
});

test('input modes: cycle A -> B -> C -> A; letters and names both parse', () => {
  assert.equal(nextMode('mouse'), 'assist');
  assert.equal(nextMode('assist'), 'gaze');
  assert.equal(nextMode('gaze'), 'mouse'); // one press from full gaze turns eye control off
  assert.equal(parseMode('B'), 'assist');
  assert.equal(parseMode('c'), 'gaze');
  assert.equal(parseMode(' Gaze '), 'gaze');
  assert.equal(parseMode('x'), null);
  assert.equal(parseMode(undefined), null);
});

test('input mode lives in the store and the URL (default A is not written)', () => {
  const store = createStore();
  assert.equal(store.get().input, 'mouse');
  assert.doesNotMatch(toQuery(store.get()), /input=/);
  store.set({ input: 'assist' });
  assert.match(toQuery(store.get()), /input=assist/);
  store.set({ input: 'everything' }); // invalid: ignored
  assert.equal(store.get().input, 'assist');
  const s2 = createStore();
  s2.set(parseQuery('?input=gaze').patch);
  assert.equal(s2.get().input, 'gaze');
});

test('the guide can never change the input mode (personOnly commands)', () => {
  const commands = [
    { name: 'set_input_mode', args: { mode: '' }, personOnly: true },
    { name: 'set_band', args: { band: '' } },
  ];
  const r = validateAction({ cmd: 'set_input_mode', args: { mode: 'gaze' } }, { commands, sanitize: () => ({}), state: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /only the person/);
  const body = buildRequest({ trigger: 'colours', commands });
  assert.deepEqual(body.commands, ['set_band']);
});
