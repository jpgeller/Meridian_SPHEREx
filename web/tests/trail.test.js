import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeColour, motionTrail, resampleToGrid, normaliseFrame } from '../src/field/trail.js';

// 9x9 frames: background 0 with a little noise, a static star at the centre, a mover on row 1
function frame(mjd, moverX) {
  const w = 9;
  const data = new Float32Array(w * w).map((_, i) => (i % 3) * 0.01);
  data[4 * w + 4] = 100; // static star
  data[1 * w + moverX] = 100; // mover
  return { data, w, h: w, meta: { mjd } };
}

test('time colours run from blue (oldest) to red (newest)', () => {
  const [r0, , b0] = timeColour(0);
  const [r1, , b1] = timeColour(1);
  assert.ok(b0 > r0 && r1 > b1);
});

test('a star present on every date comes out white; a mover leaves different colours along its path', () => {
  const t = motionTrail([frame(0, 1), frame(100, 4), frame(200, 7)]);
  const c = 4 * 9 + 4;
  const white = [t.r[c], t.g[c], t.b[c]];
  assert.ok(white.every((v) => v > 0.9), `static star ${white}`);
  const first = 1 * 9 + 1;
  const last = 1 * 9 + 7;
  assert.ok(t.b[first] > t.r[first], 'oldest position is bluish');
  assert.ok(t.r[last] > t.b[last], 'newest position is reddish');
  assert.equal(t.colours.length, 3);
});

test('normalising ignores missing data and treats saturation as bright', () => {
  const x = normaliseFrame(Float32Array.from([0, 0, 0, 0, 10, NaN, Infinity]));
  assert.equal(x[5], 0);
  assert.equal(x[6], 1);
});

test('resampling onto a finer grid keeps the centre in the centre', () => {
  const f = { data: new Float32Array(9).fill(0), w: 3, h: 3, meta: { mjd: 0 } };
  f.data[4] = 1; // centre
  const r = resampleToGrid(f, 7, 2.236); // 6.15" -> 2.75"
  assert.equal(r.data[3 * 7 + 3], 1);
  assert.equal(r.w, 7);
});
