// Unit tests for field-view helpers (no DOM, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { percentiles, sharedStretch, normalise, divergingStretch } from '../src/field/render.js';
import { medianStack, framesForBand, bandsWithData, displayBand } from '../src/field/frames.js';

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
