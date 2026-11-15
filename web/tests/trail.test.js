import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resampleToGrid, normaliseFrame } from '../src/field/trail.js';

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
