// Guide attention detector (guide/attention.js): dwell and replay triggers with fake time and
// fake samples. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAttention, classifyTarget, triggerKey, DEFAULTS } from '../src/guide/attention.js';
import { createCooldown, offerKey } from '../src/guide/popup.js';

/** A world with one sky object at (100, 100), the band ribbon at (500, 700), a plain button at (300, 300). */
function setup({ quiet = null } = {}) {
  let t = 0;
  const now = () => t;
  const cooldown = createCooldown({ now });
  const fired = [];
  const rings = [];
  const world = { quiet };
  const targetAt = (x, y) => {
    if (Math.hypot(x - 100, y - 100) <= 48) return 'sky:barnard';
    if (Math.abs(x - 500) < 100 && Math.abs(y - 700) < 30) return 'band-ribbon';
    if (Math.abs(x - 300) < 40 && Math.abs(y - 300) < 20) return 'presets';
    return null;
  };
  const a = createAttention({
    now,
    targetAt,
    isQuiet: () => world.quiet,
    isCooling: (k) => cooldown.isCooling(k),
    // the pop-up marks the cool-down on every outcome
    onTrigger: (e) => {
      fired.push(e);
      cooldown.mark(e.key);
    },
    onRing: (r) => rings.push(r),
  });
  // hold the pointer at (x, y) for ms, one sample every 33 ms (30 Hz)
  const hold = (x, y, ms, extra = {}) => {
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + 33);
      a.feed({ x, y, t, confidence: 1, ...extra });
    }
  };
  const wait = (ms) => {
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + 100);
      a.tick();
    }
  };
  return { a, fired, rings, cooldown, world, hold, wait, at: () => t };
}

test('classifyTarget: objects, colour controls, and nothing for plain controls', () => {
  for (const id of ['sky:barnard', 'sky:target', 'field:target', 'field:mover:2']) assert.equal(classifyTarget(id), 'object', id);
  for (const id of ['band-ribbon', 'band-d1', 'band-d6', 'colour-views', 'trail-legend', 'colour:D3', 'colour:40', 'colour:trail'])
    assert.equal(classifyTarget(id), 'colours', id);
  for (const id of ['presets', 'search', 'time-player', 'face-panel', 'guide-popup', null, undefined]) assert.equal(classifyTarget(id), null, String(id));
  // our keys are the pop-up's own: object -> target id, others -> a fixed key
  assert.equal(triggerKey('object', 'sky:barnard'), offerKey({ target: 'sky:barnard', key: 'sky:barnard' }));
  assert.equal(triggerKey('colours', 'band-d3'), offerKey({ key: 'colours' }));
});

test('object: ring after 1.2 s, offer at 7 s, exactly once', () => {
  const { fired, rings, hold, a } = setup();
  hold(100, 100, 1100);
  assert.equal(a.snapshot().ring, null, 'no ring before 1.2 s');
  hold(101, 99, 200);
  const r = a.snapshot().ring;
  assert.equal(r.id, 'sky:barnard');
  assert.ok(r.progress >= 0 && r.progress < 0.05);
  hold(100, 100, 3000);
  assert.ok(a.snapshot().ring.progress > 0.5 && a.snapshot().ring.progress < 0.6);
  assert.equal(fired.length, 0);
  hold(100, 100, 2800);
  assert.deepEqual(fired, [{ trigger: 'object', target: 'sky:barnard', key: 'sky:barnard' }]);
  assert.equal(rings.at(-1), null, 'the ring goes when the offer comes');
  hold(100, 100, 10000);
  assert.equal(fired.length, 1, 'staying on it does not ask again');
});

test('a still mouse: tick() keeps the dwell running on the last sample', () => {
  let t = 0;
  const fired = [];
  const a = createAttention({ now: () => t, targetAt: () => 'sky:target', onTrigger: (e) => fired.push(e) });
  // the mouse source re-feeds its last position; a gaze stream that stops is "lost" after 0.5 s
  for (; t <= 7000; t += 100) a.feed({ x: 1, y: 1 });
  assert.equal(fired.length, 1);
  const b = createAttention({ now: () => t, targetAt: () => 'sky:target', onTrigger: (e) => fired.push(e) });
  b.feed({ x: 1, y: 1 });
  for (let end = t + 8000; t < end; t += 100) b.tick();
  assert.equal(fired.length, 1, 'no samples for 8 s: not a dwell');
});

test('reset after 0.6 s off target; a shorter glance away keeps the dwell', () => {
  const { fired, hold, a } = setup();
  hold(100, 100, 4000);
  hold(400, 500, 500); // a glance away
  assert.equal(a.snapshot().dwell.id, 'sky:barnard');
  hold(100, 100, 2600);
  assert.equal(fired.length, 1, 'the glance did not reset it (4 + 0.5 + 2.6 s > 7 s)');

  const s = setup();
  s.hold(100, 100, 6000);
  s.hold(400, 500, 700); // off for longer than 0.6 s
  assert.equal(s.a.snapshot().dwell, null);
  s.hold(100, 100, 6000);
  assert.equal(s.fired.length, 0, 'the clock started again');
  s.hold(100, 100, 1100);
  assert.equal(s.fired.length, 1);
});

test('moving to another target hands the dwell over after the grace period', () => {
  const { fired, hold, a } = setup();
  hold(100, 100, 3000);
  hold(500, 700, 700);
  assert.equal(a.snapshot().dwell.id, 'band-ribbon');
  hold(500, 700, 6400); // counted from when the ribbon was first seen
  assert.deepEqual(fired.map((f) => f.trigger), ['colours']);
  assert.equal(fired[0].key, 'colours');
});

test('colours: dwell on the band ribbon offers once; plain buttons offer nothing', () => {
  const { fired, hold } = setup();
  hold(300, 300, 20000);
  assert.equal(fired.length, 0, 'over a plain control (presets) there is no guide trigger');
  hold(500, 700, 7100);
  assert.deepEqual(fired, [{ trigger: 'colours', target: 'band-ribbon', key: 'colours' }]);
});

test('low confidence samples do not count as looking', () => {
  const { fired, hold } = setup();
  hold(100, 100, 10000, { confidence: 0.2 });
  assert.equal(fired.length, 0);
});

test('never during busy states: the dwell resets and resumes from zero', () => {
  const { fired, hold, world, a } = setup();
  for (const reason of ['dragging', 'sky loading', 'frames loading', 'pop-up open', 'guide running']) {
    world.quiet = reason;
    hold(100, 100, 10000);
    assert.equal(fired.length, 0, reason);
    assert.equal(a.snapshot().ring, null, `${reason}: no ring`);
    assert.equal(a.snapshot().quiet, reason);
  }
  world.quiet = null;
  hold(100, 100, 6900);
  assert.equal(fired.length, 0, 'the time spent while busy does not count');
  hold(100, 100, 200);
  assert.equal(fired.length, 1);
});

test('a pending fly_to keeps it quiet until the command settles (or 15 s pass)', () => {
  const { fired, hold, a } = setup();
  a.commandStart({ name: 'fly_to', args: {}, source: 'ui' });
  a.commandStart({ name: 'set_band', args: {}, source: 'ui' }); // not a move
  hold(100, 100, 8000);
  assert.equal(fired.length, 0);
  assert.equal(a.snapshot().quiet, 'fly_to pending');
  a.command({ name: 'fly_to', ok: true, source: 'ui' });
  assert.equal(a.snapshot().quiet, null);
  hold(100, 100, 7100);
  assert.equal(fired.length, 1);

  const s = setup();
  s.a.commandStart({ name: 'go_preset' }); // never settles
  s.hold(100, 100, 15000);
  assert.equal(s.fired.length, 0);
  s.hold(100, 100, 7100);
  assert.equal(s.fired.length, 1, 'a lost settle event does not silence the guide for ever');
});

test('never again inside the cool-down; again after it', () => {
  const { fired, hold, wait, cooldown } = setup();
  hold(100, 100, 7100);
  assert.equal(fired.length, 1);
  hold(400, 500, 1000); // look away, come back
  hold(100, 100, 20000);
  assert.equal(fired.length, 1, 'cooling: no second offer');
  wait(40000); // 60 s since the offer
  assert.equal(cooldown.isCooling('sky:barnard'), false);
  hold(400, 500, 1000);
  hold(100, 100, 7100);
  assert.equal(fired.length, 2);
});

test('no ring for a target that is cooling', () => {
  const { hold, cooldown, a } = setup();
  cooldown.mark('sky:barnard');
  hold(100, 100, 3000);
  assert.equal(a.snapshot().ring, null);
});

// ---- change trigger ----
const field = (patch = {}) => ({ view: 'field', frameIndex: 0, op: 'none', ...patch });

test('change: the player looping three times offers "what changed" once', () => {
  const { fired, a, wait, cooldown } = setup();
  a.observe(field(), ['view'], 'command');
  const play = (loops) => {
    for (let k = 0; k < loops; k++)
      for (const i of [1, 2, 3, 0]) {
        wait(500);
        a.observe(field({ frameIndex: i }), ['frameIndex'], 'player');
      }
  };
  play(2);
  assert.equal(fired.length, 0, 'two loops are not enough');
  play(1);
  assert.deepEqual(fired, [{ trigger: 'change', target: null, key: 'change' }]);
  play(5);
  assert.equal(fired.length, 1, 'cooling');
  wait(60000);
  assert.equal(cooldown.isCooling('change'), false);
  play(3);
  assert.equal(fired.length, 2);
});

test('change: stepping back and forth (turns) counts; stepping straight through does not', () => {
  const { fired, a, wait } = setup();
  a.observe(field(), ['view'], 'command');
  for (const i of [1, 2, 3]) {
    wait(800);
    a.observe(field({ frameIndex: i }), ['frameIndex'], 'command');
  }
  assert.equal(fired.length, 0);
  // 3 -> 2 -> 3 -> 2: three turns
  for (const i of [2, 3, 2]) {
    wait(800);
    a.observe(field({ frameIndex: i }), ['frameIndex'], 'ui');
  }
  assert.equal(fired.length, 1);
  assert.equal(fired[0].trigger, 'change');
});

test('change: replays expire after 30 s, a new patch starts again, the guide and the video do not count', () => {
  const s = setup();
  s.a.observe(field(), ['view'], 'command');
  const loop = (src = 'player', op = 'none') => s.a.observe(field({ frameIndex: 0, op }), ['frameIndex'], src);
  const to = (i, op = 'none') => s.a.observe(field({ frameIndex: i, op }), ['frameIndex'], 'player');
  to(3); loop(); to(3); loop();
  s.wait(31000);
  to(3); loop();
  assert.equal(s.fired.length, 0, 'old replays expired');
  s.a.observe(field({ frameIndex: 0 }), ['band'], 'command'); // another band: another sequence
  assert.equal(s.a.snapshot().replays, 0);
  to(3); loop('guide'); to(3); loop('guide'); to(3); loop('guide');
  assert.equal(s.fired.length, 0, "the guide's own stepping");
  to(3, 'video'); loop('player', 'video'); to(3, 'video'); loop('player', 'video'); to(3, 'video'); loop('player', 'video');
  assert.equal(s.fired.length, 0, 'the change video loops by design');
  s.a.observe({ view: 'sky', frameIndex: 0, op: 'none' }, ['view'], 'command');
  assert.equal(s.a.snapshot().replays, 0, 'leaving the field view starts again');
});

test('change: blink running for 6 s offers; replays while busy are ignored', () => {
  const { fired, a, wait, world } = setup();
  a.observe(field(), ['view'], 'command');
  world.quiet = 'pop-up open';
  a.observe(field({ op: 'blink' }), ['op'], 'command');
  wait(10000);
  assert.equal(fired.length, 0, 'blink under an open card does not count');
  world.quiet = null;
  wait(5900);
  assert.equal(fired.length, 0);
  wait(200);
  assert.equal(fired.length, 1);

  // loops while a script runs do not count; the ones before and after it do (inside the window)
  const s = setup();
  s.a.observe(field(), ['view'], 'command');
  for (const i of [3, 0, 3, 0]) s.a.observe(field({ frameIndex: i }), ['frameIndex'], 'player');
  assert.equal(s.fired.length, 0);
  s.world.quiet = 'guide running';
  s.a.observe(field({ frameIndex: 3 }), ['frameIndex'], 'player');
  s.a.observe(field({ frameIndex: 0 }), ['frameIndex'], 'player'); // while busy: ignored
  s.world.quiet = null;
  s.a.observe(field({ frameIndex: 3 }), ['frameIndex'], 'player');
  s.a.observe(field({ frameIndex: 0 }), ['frameIndex'], 'player');
  assert.equal(s.fired.length, 1);
});

test('configure: dwell times can be tuned; defaults are 1.2 s / 7 s / 0.6 s / 48 px', () => {
  assert.equal(DEFAULTS.ringDelayMs, 1200);
  assert.equal(DEFAULTS.dwellMs, 7000);
  assert.equal(DEFAULTS.graceMs, 600);
  assert.equal(DEFAULTS.catchPx, 48);
  const { a, fired, hold } = setup();
  a.configure({ dwellMs: 2000, ringDelayMs: 300, nonsense: 5, graceMs: -1 });
  assert.equal(a.options().dwellMs, 2000);
  assert.equal(a.options().graceMs, 600, 'invalid values are ignored');
  assert.equal('nonsense' in a.options(), false);
  hold(100, 100, 2100);
  assert.equal(fired.length, 1);
});
