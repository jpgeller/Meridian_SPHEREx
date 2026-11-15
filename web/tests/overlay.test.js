// Guide overlay (guide/overlay.js): the pure geometry behind the pointer, rings, edge arrow and label. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { easeOutCubic, flyPoint, aimFor, ringFor, edgePoint, placeLabel, hits, trailPath, createOverlay, boxOf, unionBox, arrowBox, LABEL_GAP } from '../src/guide/overlay.js';

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

// B5: below -> above -> right -> left of the target (its ring + the arrow), clear of every control
test('B5 placeLabel: below the target when free, then above, right, left; never on a button when a free spot exists', () => {
  const size = { w: 140, h: 30 };
  const target = { x: 700, y: 400, rect: { x: 650, y: 370, w: 100, h: 60 } };
  const { tip, angle } = aimFor(target, VIEW);
  const ring = ringFor(target, 6);
  const anchor = unionBox(boxOf(ring), arrowBox(tip, angle));
  const base = [ring];
  const lab = (p) => ({ ...p, ...size });
  const below = (p) => p.y >= anchor.y + anchor.h;
  const above = (p) => p.y + size.h <= anchor.y;
  const right = (p) => p.x >= anchor.x + anchor.w;
  const left = (p) => p.x + size.w <= anchor.x;

  const p1 = placeLabel(tip, angle, size, VIEW, base, anchor);
  assert.ok(below(p1), 'below when free');
  assert.equal(p1.y, anchor.y + anchor.h + LABEL_GAP);
  assert.ok(close(p1.x + size.w / 2, anchor.x + anchor.w / 2), 'centred under the target');
  assert.ok(!hits(lab(p1), ring), 'off the target itself');

  // a button right below -> above
  const btnBelow = { rect: { x: 560, y: anchor.y + anchor.h, w: 280, h: 80 } };
  const p2 = placeLabel(tip, angle, size, VIEW, [...base, btnBelow], anchor);
  assert.ok(above(p2), 'above when below hits a button');
  assert.ok(!hits(lab(p2), btnBelow));

  // buttons below and above -> right
  const btnAbove = { rect: { x: 560, y: anchor.y - 80, w: 280, h: 80 } };
  const p3 = placeLabel(tip, angle, size, VIEW, [...base, btnBelow, btnAbove], anchor);
  assert.ok(right(p3), 'right next');
  // and a button on the right too -> left
  const btnRight = { rect: { x: anchor.x + anchor.w, y: anchor.y - 100, w: 300, h: anchor.h + 200 } };
  const p4 = placeLabel(tip, angle, size, VIEW, [...base, btnBelow, btnAbove, btnRight], anchor);
  assert.ok(left(p4), 'left after that');
  for (const b of [btnBelow, btnAbove, btnRight]) assert.ok(!hits(lab(p4), b));

  // a dense row of buttons: whatever spot it picks, it never covers one while a free spot exists
  const row = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ rect: { x: 400 + i * 72, y: anchor.y + anchor.h, w: 64, h: 64 } }));
  const p5 = placeLabel(tip, angle, size, VIEW, [...base, ...row, btnAbove], anchor);
  assert.ok(row.every((b) => !hits(lab(p5), b)) && !hits(lab(p5), btnAbove), 'no button covered');
  // still on screen near the bottom edge: below is off screen, so it goes above
  const low = { x: 700, y: 850, rect: { x: 650, y: 830, w: 100, h: 60 } };
  const la = aimFor(low, VIEW);
  const lAnchor = unionBox(boxOf(ringFor(low, 6)), arrowBox(la.tip, la.angle));
  const p6 = placeLabel(la.tip, la.angle, size, VIEW, [ringFor(low, 6)], lAnchor);
  assert.ok(p6.y + size.h <= VIEW.h && p6.y >= 0, 'on screen');
});

test('B5: the dwell ring from setAvoid still applies alongside the control boxes read from the page', () => {
  const d = fakeDom();
  const target = { x: 700, y: 400, rect: { x: 650, y: 370, w: 100, h: 60 } };
  const ring = ringFor(target, 6);
  const { tip, angle } = aimFor(target, VIEW);
  const anchor = unionBox(boxOf(ring), arrowBox(tip, angle));
  // a page button right above the target, the dwell ring right below it
  const btn = { left: 600, top: anchor.y - 70, width: 200, height: 64 };
  btn.right = btn.left + btn.width;
  btn.bottom = btn.top + btn.height;
  const button = { getBoundingClientRect: () => btn, closest: () => null };
  const target2 = { getBoundingClientRect: () => ({ left: 650, top: 370, width: 100, height: 60, right: 750, bottom: 430 }), closest: () => null };
  d.doc.querySelectorAll = () => [button, target2];
  const o = createOverlay({ locate: (id) => (id === 'btn' ? target : null), doc: d.doc, events: new EventTarget() });
  const dwell = { x: 700, y: anchor.y + anchor.h + 40, r: 60 };
  o.setAvoid(() => [dwell]);
  const label = () => d.visible((e) => e.classList.contains('go-label') && e.textContent)[0];
  o.pointAt('btn', 'Colour views');
  d.frame(performance.now() + 10000);
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(label().style.transform);
  const box = { x: Number(m[1]), y: Number(m[2]), w: 120, h: 28 }; // the fake DOM measures labels as 120 x 28
  assert.ok(!hits(box, dwell), 'clear of the dwell ring (setAvoid)');
  assert.ok(!hits(box, { rect: { x: btn.left, y: btn.top, w: btn.width, h: btn.height } }), 'clear of the page button');
  assert.ok(!hits(box, ring), 'clear of the target');
  assert.ok(box.x >= anchor.x + anchor.w || box.x + box.w <= anchor.x, 'so it goes to the side');
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

// A tiny DOM fake: enough for createOverlay (elements with classes, attributes, children, style).
function fakeDom() {
  const all = [];
  const el = (tag) => {
    const cls = new Set();
    const e = {
      tagName: tag,
      children: [],
      parent: null,
      style: {},
      attrs: {},
      textContent: '',
      set innerHTML(_) {},
      set className(v) {
        cls.clear();
        String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c));
      },
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: (c, on) => (on ?? !cls.has(c) ? cls.add(c) : cls.delete(c), cls.has(c)),
      },
      setAttribute(k, v) {
        e.attrs[k] = String(v);
        if (k === 'class') e.className = v;
      },
      getAttribute: (k) => e.attrs[k] ?? null,
      append(...kids) {
        for (const k of kids) {
          k.parent = e;
          e.children.push(k);
        }
      },
      remove() {
        if (e.parent) e.parent.children = e.parent.children.filter((k) => k !== e);
        e.parent = null;
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 28, bottom: 28 }),
      get connected() {
        let p = e;
        while (p.parent) p = p.parent;
        return p === body;
      },
      get hidden() {
        return cls.has('is-hidden');
      },
    };
    all.push(e);
    return e;
  };
  const body = el('body');
  const frames = [];
  const timers = [];
  const win = {
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (f) => (frames.push(f), frames.length),
    setTimeout: (f, ms) => (timers.push({ f, ms }), timers.length),
  };
  const doc = { defaultView: win, body, createElement: el, createElementNS: (_, t) => el(t), querySelector: () => null };
  const frame = (t) => frames.splice(0).forEach((f) => f(t));
  const flushTimers = () => timers.splice(0).forEach(({ f }) => f());
  // what a person would see: in the document, not faded out, and (a label) with text
  const visible = (sel) => all.filter((e) => e.connected && !e.hidden && sel(e));
  return { doc, win, frame, flushTimers, visible };
}

test('B3: overlay.clear() leaves no visible ring or label; the pointer goes home with no text', () => {
  const d = fakeDom();
  const spots = { 'sky:milky_way': { x: 500, y: 400, r: 20 }, 'band-d6': { x: 800, y: 820, rect: { x: 770, y: 800, w: 64, h: 64 } } };
  const o = createOverlay({ locate: (id) => spots[id] ?? null, doc: d.doc, events: new EventTarget(), getHome: () => ({ x: 1200, y: 60 }) });
  const isLabel = (e) => e.classList.contains('go-label') && e.textContent;
  const isRing = (e) => e.classList.contains('go-circle') || e.classList.contains('go-highlight');
  o.circle('sky:milky_way');
  o.highlight('band-d6');
  o.pointAt('sky:milky_way', 'Milky Way centre');
  d.frame(performance.now() + 10000); // the flight has landed: the label shows
  assert.equal(d.visible(isLabel).length, 1);
  assert.equal(d.visible(isRing).length, 2);

  o.clear();
  // at once, before any frame or the fade timeout: nothing readable or ringed is left
  assert.equal(d.visible(isLabel).length, 0, 'no label right after clear()');
  assert.equal(d.visible(isRing).length, 0, 'no ring right after clear()');
  assert.equal(d.visible((e) => e.classList.contains('go-label')).length, 0, 'no empty label box either, even if no frame runs (background tab)');
  assert.deepEqual(o.active(), [], 'only the parked pointer');
  d.frame(performance.now() + 10000);
  d.flushTimers();
  assert.equal(d.visible(isLabel).length, 0);
  assert.equal(d.visible((e) => e.classList.contains('go-label')).length, 0, 'the label box itself is hidden');
  assert.equal(d.visible(isRing).length, 0);

  // a ring re-added under the same key during the fade is the new one, not a stale one
  o.circle('sky:milky_way');
  o.clear();
  o.circle('sky:milky_way');
  d.flushTimers();
  assert.equal(d.visible(isRing).length, 1);
  o.clear();
  d.flushTimers();
  assert.equal(d.visible(isRing).length, 0);
});
