// Unit tests for field-view helpers (no DOM, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { percentiles, sharedStretch, normalise, divergingStretch } from '../src/field/render.js';
import { medianStack, framesForBand, bandsWithData, displayBand } from '../src/field/frames.js';
import { addFrames, subtractFrames, pickPair, pickForAdd, robustSigma } from '../src/field/compare.js';

const frame = (vals, meta = {}) => ({ id: meta.id ?? 'f', data: Float32Array.from(vals), w: vals.length, h: 1, meta: { mjd: 0, wavelength_um: 1, ...meta } });

test('percentiles ignore NaN and Infinity (saturated) values', () => {
  const [lo, hi] = percentiles([Float32Array.from([NaN, 1, 2, 3, Infinity, 4, 5])], [0, 100]);
  assert.equal(lo, 1);
  assert.equal(hi, 5);
});

test('shared stretch covers every frame of a sequence', () => {
  const s = sharedStretch([frame([0, 1, 2]), frame([10, 11, 12])], { lo: 0, hi: 100 });
  assert.equal(s.vmin, 0);
  assert.equal(s.vmax, 12);
  assert.equal(normalise(0, s), 0);
  assert.equal(normalise(12, s), 1);
  assert.equal(normalise(99, s), 1); // clipped
});

test('diverging stretch is symmetric around zero', () => {
  const s = divergingStretch(frame([-5, -1, 0, 1, 3]));
  assert.equal(s.vmin, -s.vmax);
});

test('median stack ignores NaN, keeps saturation, averages metadata', () => {
  const out = medianStack([
    frame([1, NaN, Infinity], { id: 'a', mjd: 10, wavelength_um: 1.0, date_iso: 'A' }),
    frame([3, 5, Infinity], { id: 'b', mjd: 20, wavelength_um: 2.0, date_iso: 'B' }),
    frame([2, NaN, 7], { id: 'c', mjd: 30, wavelength_um: 3.0, date_iso: 'C' }),
  ]);
  assert.deepEqual([...out.data], [2, 5, Infinity]);
  assert.equal(out.meta.mjd, 20);
  assert.equal(out.meta.n_combined, 3);
  assert.equal(out.meta.date_end_iso, 'C');
});

test('blank cube bands fold into neighbours for frame selection', () => {
  assert.equal(displayBand(0), 1);
  assert.equal(displayBand(50), 49);
  assert.equal(displayBand(51), 52);
  const list = {
    frames: [
      { id: 'x', band: 50, inside: true, mjd: 2 },
      { id: 'y', band: 49, inside: true, mjd: 1 },
      { id: 'z', band: 49, inside: false, mjd: 3 },
      { id: 'e', band: 49, inside: true, mjd: 4, error: 'boom' },
      { id: 'w', band: 60, inside: true, mjd: 5 },
    ],
  };
  assert.deepEqual(framesForBand(list, 49).map((f) => f.id), ['y', 'x']);
  assert.deepEqual(bandsWithData(list, 58), [60, 49]);
});


test('add: mean ignoring NaN; saturated only when most frames are', () => {
  const out = addFrames([frame([1, NaN, 5, Infinity], { date_iso: 'A' }), frame([3, 4, Infinity, Infinity], { date_iso: 'B' }), frame([2, 4, 5, Infinity], { date_iso: 'C' })]);
  assert.deepEqual([...out.data], [2, 4, 5, Infinity]);
  assert.equal(out.meta.n_combined, 3);
});

test('subtract: plain difference, or sigma with variances; non-finite gives NaN', () => {
  const a = frame([5, 1, Infinity]);
  const b = frame([1, NaN, 2]);
  assert.deepEqual([...subtractFrames(a, b).data].map((v) => (Number.isNaN(v) ? 'nan' : v)), [4, 'nan', 'nan']);
  const s = subtractFrames(frame([5]), frame([1]), frame([8]), frame([8]));
  assert.equal(s.data[0], 1); // 4 / sqrt(16)
});

test('pair and add selection fall back sensibly', () => {
  const seq = [0, 1, 2, 3].map((i) => frame([i]));
  assert.deepEqual(pickPair(seq, []), [0, 3]);
  assert.deepEqual(pickPair(seq, [2, 1]), [2, 1]);
  assert.deepEqual(pickPair(seq, [9]), [0, 3]);
  assert.deepEqual(pickForAdd(seq, [3]), [0, 1, 2, 3]);
  assert.deepEqual(pickForAdd(seq, [3, 1]), [1, 3]);
});

test('robust sigma matches a known spread and ignores outliers', () => {
  // median 0, median absolute deviation 1 -> sigma 1.4826; the 500 outlier and NaN don't matter
  const vals = Float32Array.from([0, 0, 0, 1, -1, 1, -1, 500, NaN]);
  assert.ok(Math.abs(robustSigma(vals) - 1.4826) < 1e-6);
});

import { toSignificance } from '../src/field/compare.js';
test('significance removes the background offset between dates', () => {
  const d = { data: Float32Array.from([10, 10, 11, 9, 10, 30]), meta: {} };
  toSignificance(d);
  assert.equal(d.data[0], 0); // offset 10 removed
  assert.ok(d.data[5] > 10); // the real change stands out
});

import { fluxScale, matchedDifference } from '../src/field/compare.js';
test('flux matching makes a static star cancel and keeps a mover', () => {
  // background 0 with noise ±1, a static star (100 -> 120: 1.2x brighter at the later
  // wavelength) and a mover that jumps from pixel 2 to pixel 3
  const noise = Array.from({ length: 40 }, (_, i) => [1, -1, 0][i % 3]); // background dominates
  const a = frame([...noise, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 50, 0]);
  const b = frame([...noise, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 0, 60]);
  const k = fluxScale(a, b, { minPixels: 5 });
  assert.ok(Math.abs(k - 1.2) < 1e-6);
  const d = matchedDifference(a, b).data;
  assert.ok(Math.abs(d[40]) < 1e-3); // static star cancels
  assert.ok(d[50] < -40 && d[51] > 40); // mover: negative where it was, positive where it went
});

import { differenceSignificance } from '../src/field/compare.js';
test('significance: a star that changes blur stays quiet; a mover stands out', () => {
  const bg = Array.from({ length: 60 }, (_, i) => [0.1, -0.1, 0][i % 3]);
  // static star: 100 -> 110 (blur/brightness wobble of 10%), mover: 80 at one pixel -> next pixel
  const a = frame([...bg, 100, 80, 0]);
  const b = frame([...bg, 110, 0, 80]);
  const d = differenceSignificance(a, b).data;
  assert.ok(Math.abs(d[60]) < 5, `static star at ${d[60]}σ`);
  assert.ok(d[61] < -5 && d[62] > 5, `mover at ${d[61]}σ / ${d[62]}σ`);
});

test('significance is symmetric for pure noise (no colour bias)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const n = 4000;
  const a = frame(Array.from({ length: n }, () => 3 * rnd())); // noisier image (few exposures)
  const b = frame(Array.from({ length: n }, () => rnd()));
  const d = differenceSignificance(a, b).data;
  let pos = 0, neg = 0;
  for (const v of d) { if (v > 1) pos++; if (v < -1) neg++; }
  assert.ok(Math.abs(pos - neg) < 0.25 * (pos + neg), `pos ${pos} vs neg ${neg}`);
});
