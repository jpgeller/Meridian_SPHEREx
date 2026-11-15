import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGazeCore } from '../src/input/gazeCore.js';
import { buildTargets, boxOf, buttonId, createTargetSender } from '../src/input/targets.js';

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

test('a new button in the spot just pressed waits until the gaze leaves (no chain of presses)', () => {
  const core = setup();
  assert.equal(types(look(core, 440, 320, 0, 900), 'activate').length, 1); // press "zoom"
  core.setTargets([{ id: 'next', x: 400, y: 300, w: 80, h: 40 }]); // the page swapped it for another button
  assert.equal(types(look(core, 440, 320, 933, 4000), 'activate').length, 0); // still staring: nothing
  look(core, 700, 600, 4033, 4300); // look away
  assert.deepEqual(types(look(core, 440, 320, 4333, 5300), 'activate').map((e) => e.id), ['next']);
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

test('rest zone (bottom-left, clear of the guide pop-up and the Aladin logo) pauses everything and resumes', () => {
  const corners = setup();
  assert.equal(types(look(corners, 950, 40, 0, 1100), 'rest').length, 0); // top-right: the guide pop-up's corner
  assert.equal(types(look(corners, 950, 785, 1133, 2300), 'rest').length, 0); // bottom-right: Aladin's logo
  const core = setup();
  const r1 = look(core, 40, 785, 0, 1100); // bottom-left corner
  assert.deepEqual(types(r1, 'rest'), [{ type: 'rest', paused: true }]);
  assert.equal(types(look(core, 440, 320, 1133, 2500), 'activate').length, 0); // paused: no presses
  look(core, 500, 500, 2533, 2600); // leave the rest zone first
  const r2 = look(core, 40, 785, 2633, 3800);
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
  assert.equal(core.setDwellMs(NaN), 1500); // a bad value keeps the current one
  core.setDwellMs(400);
  assert.equal(types(look(core, 440, 320, 0, 500), 'activate').length, 1);
});

test('edges do not pan when the page says the gaze is over a panel', () => {
  const core = setup({ canPan: (p) => p.y > 200 }); // pretend a panel covers the top
  assert.equal(types(look(core, 20, 100, 0, 1600), 'pan').length, 0);
  assert.ok(types(look(core, 20, 400, 1633, 3200), 'pan').length >= 2);
});

// --- the `targets` reply (U9) ---

test('targets: buttons first, then named things from the registry, as rounded boxes', () => {
  const items = buildTargets(
    [{ id: 'band-d6', label: 'Detector D6', x: 10.4, y: 20.6, w: 100, h: 64 }, { id: 'preset:barnard', label: "Barnard's Star", x: 0, y: 0, w: 0, h: 0 }],
    [
      { id: 'band-d6', x: 60, y: 52, rect: { x: 10, y: 20, w: 100, h: 64 } }, // already a button
      { id: 'sky:barnard', label: "Barnard's Star", x: 300, y: 200, r: 14 },
      { id: 'sky:target', x: 5, y: 5 }, // a point without a radius
      { id: 'nowhere' },
    ],
  );
  assert.deepEqual(items, [
    { id: 'band-d6', x: 10, y: 21, w: 100, h: 64, kind: 'button', label: 'Detector D6' },
    { id: 'sky:barnard', x: 286, y: 186, w: 28, h: 28, kind: 'target', label: "Barnard's Star" },
    { id: 'sky:target', x: -7, y: -7, w: 24, h: 24, kind: 'target' },
  ]);
  assert.equal(boxOf(null), null);
});

test('targets: button ids come from data-guide, then the data attribute that names the button', () => {
  assert.equal(buttonId({ guide: 'band-d6', detector: '6' }), 'band-d6');
  assert.equal(buttonId({ preset: 'barnard' }), 'preset:barnard');
  assert.equal(buttonId({ cmd: 'brighter' }), 'cmd:brighter');
  assert.equal(buttonId({}), null);
});

test('targets: sent only when the list changes, at most 4 per second; a new tracker gets the list at once', () => {
  const sent = [];
  const s = createTargetSender({ minMs: 250 });
  const a = [{ id: 'x', x: 0, y: 0, w: 10, h: 10 }];
  const b = [{ id: 'x', x: 5, y: 0, w: 10, h: 10 }];
  assert.equal(s.update(a, 0), false); // nobody to send to yet
  const winA = {};
  s.setSend((m) => sent.push(['A', m]), winA);
  assert.equal(s.update(a, 0), true);
  assert.equal(s.update(a, 1000), false); // unchanged
  assert.equal(s.update(b, 1100), true);
  assert.equal(s.update(a, 1200), false); // changed, but only 100 ms later
  assert.equal(s.update(a, 1350), true); // the waiting change goes out
  s.setSend((m) => sent.push(['A2', m]), winA); // the same window, a new reply function: no reset
  assert.equal(s.update(a, 1400), false);
  s.setSend((m) => sent.push(['B', m]), {}); // another tracker
  assert.equal(s.update(a, 1401), true);
  assert.deepEqual(sent.map(([who, m]) => [who, m.type, m.items[0].x]), [['A', 'targets', 0], ['A', 'targets', 5], ['A', 'targets', 0], ['B', 'targets', 0]]);
  // 30 Hz of changing lists for 2 s -> no more than 4 per second
  const s2 = createTargetSender({ minMs: 250 });
  let n = 0;
  s2.setSend(() => n++, 1);
  for (let t = 0; t < 2000; t += 33) s2.update([{ id: 'x', x: t, y: 0, w: 1, h: 1 }], t);
  assert.ok(n <= 8 && n >= 7, String(n));
});

test('bridge: gaze messages from allowed origins become meridian:gaze events with a reply to the sender', async () => {
  const { startMessages } = await import('../src/core/messages.js');
  const target = new EventTarget();
  target.location = { origin: 'http://localhost:5173' };
  const got = [];
  target.addEventListener('meridian:gaze', (e) => got.push(e.detail));
  const stop = startMessages({ run: () => ({ ok: true }), list: () => [] }, { target });
  const posted = [];
  const source = { postMessage: (data, opts) => posted.push([data, opts.targetOrigin]) };
  const send = (origin, data) => target.dispatchEvent(Object.assign(new Event('message'), { origin, data, source }));
  send('http://127.0.0.1:9000', { type: 'gaze', x: 10, y: 20, t: 5, confidence: 0.8 });
  send('http://localhost:5173', { type: 'gaze', x: 'a', y: 20 }); // not a position: dropped
  const warn = console.warn;
  console.warn = () => {};
  send('https://evil.example', { type: 'gaze', x: 1, y: 1 });
  console.warn = warn;
  assert.equal(got.length, 1);
  assert.deepEqual({ ...got[0], reply: undefined }, { x: 10, y: 20, t: 5, confidence: 0.8, reply: undefined, source });
  got[0].reply({ type: 'targets', items: [] });
  assert.deepEqual(posted, [[{ type: 'targets', items: [] }, 'http://127.0.0.1:9000']]);
  send('http://localhost:5173', { type: 'gaze', x: 1, y: 2 });
  assert.equal(got[1].confidence, 1); // no confidence given: trusted
  stop();
});
