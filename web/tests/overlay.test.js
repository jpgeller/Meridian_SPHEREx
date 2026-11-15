// Guide overlay (guide/overlay.js): the pure geometry behind the pointer, rings, edge arrow and label. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { easeOutCubic, flyPoint, aimFor, ringFor, edgePoint, placeLabel, hits, trailPath } from '../src/guide/overlay.js';

const VIEW = { w: 1440, h: 900 };
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('easeOutCubic: 0 -> 0, 1 -> 1, fast start, clamped', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.8, 'most of the way by half time');
  assert.equal(easeOutCubic(-1), 0);
  assert.equal(easeOutCubic(2), 1);
});

test('flyPoint: starts and ends on the endpoints and arcs off the straight line', () => {
  const a = { x: 1200, y: 100 };
  const b = { x: 300, y: 600 };
  assert.deepEqual(flyPoint(a, b, 0), a);
  assert.deepEqual(flyPoint(a, b, 1), b);
  const m = flyPoint(a, b, 0.5);
  const cross = (b.x - a.x) * (m.y - a.y) - (b.y - a.y) * (m.x - a.x);
  assert.ok(Math.abs(cross) > 1000, 'the middle is off the chord');
});

test('aimFor / ringFor: sky objects get the rim and a ring; controls get an edge and a padded box', () => {
  const upLeft = Math.atan2(-1, -1);
  const star = { x: 500, y: 400, r: 24 };
  const { tip, angle } = aimFor(star, VIEW);
  assert.ok(close(angle, upLeft));
  assert.ok(tip.x > 500 && tip.y > 400, 'lower-right of the star');
  assert.ok(close(Math.hypot(tip.x - 500, tip.y - 400), 24 * 0.7));
  assert.deepEqual(ringFor(star, 10), { x: 500, y: 400, r: 34 });
  // near the right / bottom edges the arrow mirrors and the tip moves to the matching rim
  const r = aimFor({ x: 1430, y: 400, r: 24 }, VIEW);
  assert.ok(close(r.angle, Math.atan2(-1, 1)) && r.tip.x < 1430, 'points up-right from the lower-left rim');
  const b = aimFor({ x: 500, y: 880, r: 24 }, VIEW);
  assert.ok(close(b.angle, Math.atan2(1, -1)) && b.tip.y < 880, 'points down-left from the upper-right rim');
  // a dock button: tip on its top edge, pointing down (the arrow sits above it)
  const btn = { x: 150, y: 820, rect: { x: 100, y: 790, w: 100, h: 60 } };
  const a = aimFor(btn, VIEW);
  assert.deepEqual(a.tip, { x: 150, y: 798 });
  assert.ok(Math.sin(a.angle) > 0, 'points down');
  // the search box at the top: tip on its bottom edge, pointing up
  const s = aimFor({ x: 700, y: 40, rect: { x: 600, y: 20, w: 200, h: 40 } }, VIEW);
  assert.deepEqual(s.tip, { x: 700, y: 52 });
  assert.ok(Math.sin(s.angle) < 0, 'points up');
  assert.deepEqual(ringFor(btn, 8), { rect: { x: 96, y: 786, w: 108, h: 68 } });
  assert.equal(aimFor(null, VIEW), null);
  assert.equal(ringFor(null), null);
});

test('edgePoint: the ray from the centre meets the inset edge; outside starts are clamped', () => {
  const b = { x: 0, y: 0, w: 1440, h: 900 };
  const c = { x: 720, y: 450 };
  assert.deepEqual(edgePoint(c, { x: 1, y: 0 }, b, 36), { x: 1404, y: 450 });
  assert.deepEqual(edgePoint(c, { x: 0, y: -1 }, b, 36), { x: 720, y: 36 });
  const d = edgePoint(c, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, b, 36);
  assert.ok(close(d.y, 864) && close(d.x, 720 + 414), 'diagonal hits the bottom first');
  // a start outside the box still lands on the edge
  const o = edgePoint({ x: -500, y: 450 }, { x: -1, y: 0 }, b, 36);
  assert.deepEqual(o, { x: 36, y: 450 });
  // image bounds (field view)
  assert.deepEqual(edgePoint({ x: 395, y: 345 }, { x: 0, y: -1 }, { x: 100, y: 50, w: 590, h: 590 }, 20), { x: 395, y: 70 });
  assert.equal(edgePoint(c, { x: 0, y: 0 }, b), null);
  assert.equal(edgePoint(c, { x: 1, y: 0 }, { x: 0, y: 0, w: 40, h: 40 }), null, 'box smaller than the margins');
});

test('placeLabel: behind the arrow when free, never off screen, steps around the dwell ring', () => {
  const size = { w: 160, h: 30 };
  const up = Math.atan2(-1, -1);
  const tip = { x: 600, y: 400 };
  const p = placeLabel(tip, up, size, VIEW);
  assert.ok(p.x + size.w / 2 > tip.x && p.y + size.h / 2 > tip.y, 'down-right, behind the arrow body');
  // a dwell ring sitting exactly there -> the label moves elsewhere and does not touch it
  const ring = { x: p.x + size.w / 2, y: p.y + size.h / 2, r: 60 };
  const q = placeLabel(tip, up, size, VIEW, [ring]);
  assert.equal(hits({ ...q, ...size }, ring), false);
  // bottom-dock target: the label stays on screen
  const low = aimFor({ x: 1300, y: 870, r: 24 }, VIEW);
  const r = placeLabel(low.tip, low.angle, size, VIEW);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + size.w <= VIEW.w && r.y + size.h <= VIEW.h);
  // the target itself is avoided
  const target = { x: 600, y: 400, r: 30 };
  assert.equal(hits({ ...placeLabel(tip, up, size, VIEW, [target]), ...size }, target), false);
});

test('hits: rect vs circle and rect vs box', () => {
  const r = { x: 0, y: 0, w: 100, h: 50 };
  assert.ok(hits(r, { x: 120, y: 25, r: 30 }));
  assert.ok(!hits(r, { x: 140, y: 25, r: 30 }));
  assert.ok(hits(r, { rect: { x: 90, y: 40, w: 20, h: 20 } }));
  assert.ok(!hits(r, { rect: { x: 101, y: 0, w: 20, h: 20 } }));
  assert.ok(!hits(r, null));
});

test('trailPath: a quadratic curve from a to b', () => {
  assert.match(trailPath({ x: 0, y: 0 }, { x: 100, y: 0 }), /^M0\.0,0\.0 Q50\.0,-20\.0 100\.0,0\.0$/);
});
