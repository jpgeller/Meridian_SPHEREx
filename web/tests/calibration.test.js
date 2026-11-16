import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationDots, buttonDots } from '../src/input/calibration.js';

test('calibration layer 1: 100 dots spread over 4-96 % of the screen, no two the same', () => {
  const d = calibrationDots(100);
  assert.equal(d.length, 100);
  for (const [x, y] of d) assert.ok(x >= 0.04 && x <= 0.96 && y >= 0.04 && y <= 0.96);
  assert.equal(new Set(d.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`)).size, 100);
  // every part of the screen gets dots: each quarter has at least 15
  const q = [0, 0, 0, 0];
  for (const [x, y] of d) q[(x > 0.5) + 2 * (y > 0.5)]++;
  assert.ok(q.every((n) => n >= 15), JSON.stringify(q));
  assert.deepEqual(calibrationDots(100), d, 'same order every time');
});

test('calibration layer 2: one dot per button centre, twice, overlapping rectangles counted once', () => {
  const rects = [
    { left: 0, top: 0, width: 64, height: 64 },
    { left: 100, top: 0, width: 80, height: 64 },
    { left: 101, top: 1, width: 80, height: 64 }, // the same button seen twice (nested elements)
    { left: 300, top: 0, width: 4, height: 4 }, // too small: not a target
  ];
  const d = buttonDots(rects, 2);
  assert.equal(d.length, 4);
  assert.deepEqual(new Set(d.map((x) => x.id)), new Set([0, 1]));
  assert.deepEqual(d.filter((x) => x.id === 1).map((x) => x.look).sort(), [0, 1]);
  assert.deepEqual(d.find((x) => x.id === 0).c, [32, 32]);
});
