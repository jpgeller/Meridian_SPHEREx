import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGazeCore } from '../src/input/gazeCore.js';

// Feed a steady gaze at (x, y) from t0 to t1 every 33 ms (30 Hz); collect events.
function look(core, x, y, t0, t1, extra = {}) {
  const out = [];
  for (let t = t0; t <= t1; t += 33) out.push(...core.update({ x, y, t, confidence: 1, ...extra }));
  return out;
}
const types = (ev, type) => ev.filter((e) => e.type === type);

function setup(opts) {
  const core = createGazeCore(opts);
  core.setViewport(1000, 800);
  core.setTargets([
    { id: 'zoom', x: 400, y: 300, w: 80, h: 40 },
    { id: 'play', x: 600, y: 300, w: 80, h: 40 },
  ]);
  return core;
}

test('a quick glance does nothing; a dwell presses once', () => {
  const core = setup();
  assert.equal(types(look(core, 440, 320, 0, 500), 'activate').length, 0);
  const ev = look(core, 440, 320, 533, 1400);
  assert.deepEqual(types(ev, 'activate').map((e) => e.id), ['zoom']);
  const prog = types(ev, 'progress').filter((e) => e.p > 0).map((e) => e.p);
  assert.ok(prog.every((p, i) => i === 0 || p >= prog[i - 1] || p === 0)); // grows, visible
});

test('no double press: the same target needs the refractory time plus a new dwell', () => {
  const core = setup();
  const ev = look(core, 440, 320, 0, 2300); // 0.8 s press, then 1 s refractory, then 0.8 s again
  const presses = types(ev, 'activate').length;
  assert.equal(presses, 1);
  const more = look(core, 440, 320, 2333, 3000);
  assert.equal(types(more, 'activate').length, 1); // second press only after ~2.6 s total
});

test('snap: gaze just outside a button still counts; far away does not', () => {
  const core = setup();
  assert.equal(types(look(core, 400 - 20, 320, 0, 900), 'activate').length, 1); // 20 px left of the box
  const core2 = setup();
  assert.equal(types(look(core2, 400 - 40, 320, 0, 900), 'activate').length, 0); // 40 px: too far
});

test('moving to another target restarts the dwell', () => {
  const core = setup();
  look(core, 440, 320, 0, 600); // 0.6 s on zoom
  const ev = look(core, 640, 320, 633, 1200); // 0.57 s on play
  assert.equal(types(ev, 'activate').length, 0);
  assert.ok(types(ev, 'progress').some((e) => e.id === 'zoom' && e.p === 0)); // zoom bar cleared
});

test('edges pan after a delay, then repeat; not when disabled', () => {
  const core = setup();
  const ev = look(core, 20, 400, 0, 1600);
  const pans = types(ev, 'pan');
  assert.ok(pans.length >= 2 && pans.every((p) => p.dir === 'left'), JSON.stringify(pans));
  assert.ok(types(look(core, 20, 400, 1633, 1700), 'pan').length <= 1);
  const core2 = setup();
  core2.setEdgePanning(false);
  assert.equal(types(look(core2, 20, 400, 0, 1600), 'pan').length, 0);
});

test('rest zone pauses everything and resumes', () => {
  const core = setup();
  const r1 = look(core, 950, 40, 0, 1100); // top-right corner
  assert.deepEqual(types(r1, 'rest'), [{ type: 'rest', paused: true }]);
  assert.equal(types(look(core, 440, 320, 1133, 2500), 'activate').length, 0); // paused: no presses
  look(core, 500, 500, 2533, 2600); // leave the rest zone first
  const r2 = look(core, 950, 40, 2633, 3800);
  assert.deepEqual(types(r2, 'rest'), [{ type: 'rest', paused: false }]);
  assert.equal(types(look(core, 440, 320, 3833, 4800), 'activate').length, 1);
});

test('low confidence samples are ignored; a tracking gap resets the dwell', () => {
  const core = setup();
  assert.equal(types(look(core, 440, 320, 0, 1200, { confidence: 0.2 }), 'activate').length, 0);
  look(core, 440, 320, 1300, 1800); // 0.5 s
  const ev = look(core, 440, 320, 2600, 2900); // after a 0.8 s gap: must start again
  assert.equal(types(ev, 'activate').length, 0);
  assert.ok(types(ev, 'lost').length === 1);
});

test('dwell time is adjustable within 400–1500 ms', () => {
  const core = setup();
  assert.equal(core.setDwellMs(100), 400);
  assert.equal(core.setDwellMs(5000), 1500);
  core.setDwellMs(400);
  assert.equal(types(look(core, 440, 320, 0, 500), 'activate').length, 1);
});

test('edges do not pan when the page says the gaze is over a panel', () => {
  const core = setup({ canPan: (p) => p.y > 200 }); // pretend a panel covers the top
  assert.equal(types(look(core, 20, 100, 0, 1600), 'pan').length, 0);
  assert.ok(types(look(core, 20, 400, 1633, 3200), 'pan').length >= 2);
});
