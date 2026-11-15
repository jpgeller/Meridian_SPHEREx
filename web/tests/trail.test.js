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

test('normalising a frame filled by glare (median = top) keeps its range instead of turning black', async () => {
  const { normaliseFrame } = await import('../src/field/trail.js');
  const data = new Float32Array(100).fill(255);
  for (let i = 0; i < 10; i++) data[i] = 20 + i * 10; // a dark saturated core, as in WiseView PNGs
  const out = normaliseFrame(data);
  assert.ok(out[99] > 0.99, 'the glare stays bright');
  assert.ok(out[0] < 0.01, 'the darkest pixel is dark');
});

test('WISE frames: the share of saturated (255) pixels', async () => {
  const { saturatedFraction, WISE_SATURATED_MAX } = await import('../src/field/wiseFrames.js');
  const d = new Float32Array(10).fill(255);
  d[0] = 3;
  assert.equal(saturatedFraction(d), 0.9);
  assert.ok(saturatedFraction(d) > WISE_SATURATED_MAX);
  assert.equal(saturatedFraction(new Float32Array(4)), 0);
});
