// Target registry (guide/registry.js): DOM ids, sky and field positions, picking. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRegistry, rectResult, fieldToViewport, pickTarget, SKY_OBJECT_R } from '../src/guide/registry.js';
import { skyToPixel } from '../src/field/context.js';

const VIEW = { w: 1440, h: 900 };
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

// A tiny fake DOM: elements with a data-guide id, a box, optional ticks, optional hidden ancestor.
function fakeDom(specs) {
  const els = specs.map(({ id, rect, hidden = false, ticks = [] }) => ({
    dataset: { guide: id },
    getBoundingClientRect: () => rect,
    closest: (sel) => (sel === '[hidden]' && hidden ? {} : null),
    querySelectorAll: (sel) => (sel === '.det-ticks i' ? ticks.map((r) => ({ getBoundingClientRect: () => r })) : []),
  }));
  return {
    querySelector: (sel) => els.find((e) => sel === `[data-guide="${e.dataset.guide}"]`) ?? null,
    querySelectorAll: (sel) => (sel === '[data-guide]' ? els : []),
  };
}

function setup({ state = {}, dom = [], world2pix = () => null, field = null, fetchJson = null, isSkyVisible } = {}) {
  const s = { view: 'sky', ra: 0, dec: 0, ...state };
  const events = new EventTarget();
  const reg = createRegistry({
    root: fakeDom(dom),
    getState: () => s,
    world2pix,
    isSkyVisible,
    field,
    fetchJson,
    viewport: () => VIEW,
    events,
  });
  return { reg, s, events };
}

const flyTo = (events, target) =>
  events.dispatchEvent(new CustomEvent('meridian:command', { detail: { name: 'fly_to', args: { target }, ok: true } }));

// --- pure helpers ---

test('rectResult: centre + rect; null for empty or off-screen boxes', () => {
  assert.deepEqual(rectResult(box(10, 20, 100, 50), VIEW), { x: 60, y: 45, rect: { x: 10, y: 20, w: 100, h: 50 } });
  assert.equal(rectResult(box(10, 20, 0, 0), VIEW), null); // display: none
  assert.equal(rectResult(box(-200, 20, 100, 50), VIEW), null); // scrolled out to the left
  assert.equal(rectResult(box(10, 950, 100, 50), VIEW), null); // below the fold
  assert.equal(rectResult(null, VIEW), null);
});

test('fieldToViewport: centre, north up / east left, inverse of the click mapping, null outside', () => {
  const geom = { ra0: 269.45, dec0: 4.74, scale: 6.15, w: 59, h: 59 };
  const canvas = box(100, 50, 590, 590); // 10 screen px per image px
  const c = fieldToViewport(269.45, 4.74, geom, canvas);
  assert.ok(Math.abs(c.x - 395) < 1e-6 && Math.abs(c.y - 345) < 1e-6);
  const north = fieldToViewport(269.45, 4.74 + 10 * (6.15 / 3600), geom, canvas);
  assert.ok(Math.abs(north.y - (345 - 100)) < 1e-6, 'ten pixels north = 100 screen px up');
  const east = fieldToViewport(269.45 + (10 * 6.15) / 3600 / Math.cos((4.74 * Math.PI) / 180), 4.74, geom, canvas);
  assert.ok(east.x < c.x, 'east is to the left');
  // inverse of the click handler in field/spectrum.js (screen -> sky)
  const px = ((east.x - canvas.left) / canvas.width) * 59 - 0.5;
  const ra = 269.45 + ((29 - px) * (6.15 / 3600)) / Math.cos((4.74 * Math.PI) / 180);
  assert.ok(Math.abs(ra - (269.45 + (10 * 6.15) / 3600 / Math.cos((4.74 * Math.PI) / 180))) < 1e-9);
  assert.equal(fieldToViewport(269.45, 4.74 + 0.1, geom, canvas), null, 'outside the 0.1° field');
  assert.equal(fieldToViewport(269.45, 4.74, null, canvas), null);
  assert.equal(fieldToViewport(269.45, 4.74, geom, box(0, 0, 0, 0)), null);
  // RA wraps across 0h
  const g0 = { ...geom, ra0: 0.001, dec0: 0 };
  assert.ok(fieldToViewport(359.999, 0, g0, canvas), 'wraps across RA 0');
});

test('pickTarget: a star beats the image, smallest box wins, then nearest within pad', () => {
  const items = [
    { id: 'band-ribbon', rect: { x: 0, y: 800, w: 600, h: 80 } },
    { id: 'band-d1', rect: { x: 0, y: 800, w: 100, h: 80 } },
    { id: 'time-player', rect: { x: 100, y: 100, w: 500, h: 500 } },
    { id: 'field:target', x: 350, y: 350, r: 20 },
    { id: 'sky:barnard', x: 900, y: 300, r: 24 },
  ];
  assert.equal(pickTarget(items, 50, 840), 'band-d1');
  assert.equal(pickTarget(items, 300, 840), 'band-ribbon');
  assert.equal(pickTarget(items, 355, 345), 'field:target');
  assert.equal(pickTarget(items, 200, 200), 'time-player');
  assert.equal(pickTarget(items, 900, 340), null, '40 px away, no pad');
  assert.equal(pickTarget(items, 900, 340, 48), 'sky:barnard', 'inside the catch radius');
  assert.equal(pickTarget(items, 620, 840, 48), 'band-ribbon');
  assert.equal(pickTarget([], 1, 1, 48), null);
});

// --- registry: DOM ids ---

test('resolve: data-guide elements, hidden -> null, unknown -> null, never throws', () => {
  const { reg } = setup({
    dom: [
      { id: 'band-d6', rect: box(700, 820, 100, 64) },
      { id: 'face-panel', rect: box(16, 100, 200, 0), hidden: true },
      { id: 'trail-legend', rect: box(100, 600, 300, 20), hidden: true },
    ],
  });
  assert.deepEqual(reg.resolve('band-d6'), { x: 750, y: 852, rect: { x: 700, y: 820, w: 100, h: 64 } });
  assert.equal(reg.resolve('face-panel'), null);
  assert.equal(reg.resolve('trail-legend'), null);
  assert.equal(reg.resolve('nope'), null);
  assert.equal(reg.resolve('sky:nope'), null);
  assert.equal(reg.resolve('weird:thing'), null);
  assert.equal(reg.resolve(''), null);
  assert.equal(reg.resolve(42), null);
  assert.equal(reg.resolve(undefined), null);
});

test('resolve: colour ids map to detector blocks and band ticks', () => {
  const ticks = Array.from({ length: 17 }, (_, i) => box(200 + i * 5, 870, 4, 8));
  const { reg } = setup({
    dom: [
      { id: 'band-d3', rect: box(200, 820, 100, 64), ticks },
      { id: 'band-d6', rect: box(700, 820, 100, 64) },
      { id: 'trail-legend', rect: box(100, 600, 300, 20) },
    ],
  });
  assert.deepEqual(reg.resolve('colour:D6'), reg.resolve('band-d6'));
  assert.deepEqual(reg.resolve('colour:d6'), reg.resolve('band-d6'));
  // band 40 = D3, channel 7 -> tick index 6
  assert.deepEqual(reg.resolve('colour:40').rect, { x: 230, y: 870, w: 4, h: 8 });
  // band 101 is on D6 but this fake D6 has no ticks: falls back to the block
  assert.deepEqual(reg.resolve('colour:101'), reg.resolve('band-d6'));
  assert.equal(reg.resolve('colour:0'), null);
  assert.equal(reg.resolve('colour:102'), null);
  assert.equal(reg.resolve('colour:D7'), null);
  assert.deepEqual(reg.resolve('colour:trail'), reg.resolve('trail-legend'));
});

// --- registry: sky objects ---

// A fake projection: 10 px per degree around (ra 260, dec 0), x grows to the east (as on the sky seen from inside).
const flatSky = (ra, dec) => {
  const x = 720 - (ra - 260) * 10;
  const y = 450 - dec * 10;
  return { x, y, pageX: x, pageY: y, inView: x >= 0 && y >= 0 && x < VIEW.w && y < VIEW.h };
};

test('sky objects: preset names looked up once, positioned, null when off screen or covered', async () => {
  const asked = [];
  const fetchJson = async (url) => {
    asked.push(url);
    if (url.includes('Barnard')) return { ra: 269.45, dec: 4.74 };
    throw new Error('offline');
  };
  let covered = false;
  const { reg } = setup({ world2pix: flatSky, fetchJson, isSkyVisible: () => !covered });
  assert.equal(reg.resolve('sky:barnard'), null, 'not known until the lookup answers');
  await new Promise((r) => setTimeout(r, 0));
  const b = reg.resolve('sky:barnard');
  assert.ok(Math.abs(b.x - 625.5) < 1e-6 && Math.abs(b.y - 402.6) < 1e-6);
  assert.equal(b.r, SKY_OBJECT_R);
  // coordinate presets need no lookup: the Milky Way centre (266.4°) is on this fake sky
  assert.ok(reg.resolve('sky:milky_way'));
  assert.equal(reg.resolve('sky:solar_system'), null, 'dec 66.6° is off this fake screen');
  covered = true;
  assert.equal(reg.resolve('sky:barnard'), null, 'behind a panel');
  covered = false;
  assert.equal(asked.filter((u) => u.includes('Barnard')).length, 1, 'each name looked up once');
  assert.ok(!asked.some((u) => u.includes('266.4168')), 'coordinates are never looked up');
});

test('sky objects: behind the globe (world2pix null) -> null; targetAt finds them with the catch radius', async () => {
  const { reg } = setup({ world2pix: () => null, fetchJson: async () => ({ ra: 269.45, dec: 4.74 }) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(reg.resolve('sky:barnard'), null);

  const { reg: reg2 } = setup({
    world2pix: flatSky,
    fetchJson: async (u) => (u.includes('Barnard') ? { ra: 269.45, dec: 4.74 } : Promise.reject(new Error('x'))),
    dom: [{ id: 'band-d6', rect: box(700, 820, 100, 64) }],
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(reg2.targetAt(625, 402), 'sky:barnard');
  assert.equal(reg2.targetAt(625, 402 + 60), null);
  assert.equal(reg2.targetAt(625, 402 + 60, 48), 'sky:barnard');
  assert.equal(reg2.targetAt(750, 850), 'band-d6');
  assert.equal(reg2.targetAt(NaN, 1), null);
  const ids = reg2.list().map((t) => t.id);
  assert.ok(ids.includes('sky:barnard') && ids.includes('band-d6'));
  assert.equal(reg2.list().find((t) => t.id === 'sky:barnard').label, "Barnard's Star");
});

test('sky:target and presets are learnt from fly_to (works offline)', () => {
  const { reg, s, events } = setup({ world2pix: flatSky });
  assert.equal(reg.resolve('sky:target'), null);
  Object.assign(s, { ra: 262, dec: 1 }); // fly_to put the target at the centre
  flyTo(events, '262 1');
  assert.deepEqual(reg.resolve('sky:target'), { x: 700, y: 440, r: SKY_OBJECT_R });
  Object.assign(s, { ra: 269.45, dec: 4.74 });
  flyTo(events, "Barnard's Star");
  assert.ok(reg.resolve('sky:barnard'), 'the preset is known now, without the API');
  // failed fly_to and other commands are ignored
  events.dispatchEvent(new CustomEvent('meridian:command', { detail: { name: 'fly_to', args: { target: 'x' }, ok: false } }));
  events.dispatchEvent(new CustomEvent('meridian:command', { detail: { name: 'zoom_in', args: {}, ok: true } }));
  assert.equal(reg.list().find((t) => t.id === 'sky:target').label, "Barnard's Star");
});

// --- registry: field view ---

test('field view: target in the ring, sky objects on the image, movers at the frame date', () => {
  const geom = { ra0: 269.45, dec0: 4.74, scale: 6.15, w: 59, h: 59, mjd: 61041 };
  const movers = {
    epoch_mjd: 61041 - 365.25, // one year before the frame
    movers: [{ id: 'Gaia DR3 1', ra: 269.45, dec: 4.74 - 0.005, pmra: 0, pmdec: 10000 }], // +10″/yr north
  };
  const { reg, events } = setup({
    state: { view: 'field', ra: 269.45, dec: 4.74 },
    world2pix: () => { throw new Error('the globe is not used in the field view'); },
    field: { canvas: { getBoundingClientRect: () => box(100, 50, 590, 590) }, getGeometry: () => geom, getMovers: () => movers },
    dom: [{ id: 'time-player', rect: box(80, 30, 700, 800) }],
  });
  const t = reg.resolve('field:target');
  assert.ok(Math.abs(t.x - 395) < 1e-6 && Math.abs(t.y - 345) < 1e-6);
  assert.ok(Math.abs(t.r - 590 * 0.045) < 1e-6);
  flyTo(events, "Barnard's Star");
  assert.deepEqual(reg.resolve('sky:barnard'), t, 'a sky object in the field view sits on the image');

  const m = reg.resolve('field:mover:0');
  const expected = skyToPixel(269.45, 4.74 - 0.005 + 10 / 3600, 269.45, 4.74, 6.15, 59);
  assert.ok(Math.abs(m.y - (50 + (expected.y + 0.5) * 10)) < 1e-6, 'moved 10″ north since its epoch');
  assert.equal(reg.resolve('field:mover:1'), null);
  assert.equal(reg.resolve('field:other'), null);
  assert.equal(reg.targetAt(396, 346), 'field:target', 'the ring beats the player box');
  assert.equal(reg.targetAt(90, 700), 'time-player');
  assert.equal(reg.list().find((x) => x.id === 'field:mover:0').label, 'Gaia DR3 1');
  assert.equal(reg.list().find((x) => x.id === 'field:target').label, "Barnard's Star");
  assert.ok(!reg.list().some((x) => x.id.startsWith('sky:')), 'no duplicate ids on the same spot');
});

test('field ids are null in the sky view and before an image is shown', () => {
  const field = { canvas: { getBoundingClientRect: () => box(100, 50, 590, 590) }, getGeometry: () => null, getMovers: () => null };
  assert.equal(setup({ field }).reg.resolve('field:target'), null);
  assert.equal(setup({ field, state: { view: 'field' } }).reg.resolve('field:target'), null);
  assert.equal(setup({ field, state: { view: 'field' } }).reg.resolve('field:mover:0'), null);
});
