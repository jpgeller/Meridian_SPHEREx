import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, renderAt, bracket, fitLine, skyToArray, moveTo } from '../src/field/changeModel.js';

// 41x41 images at 2.75"/px. A still star at (10, 30); a mover going from x=8 to x=32 along
// row 15 over 10 years (2.4 px/yr, ~6.6"/yr, westwards = x grows). Small noise everywhere.
const W = 41;
const SCALE = 2.75;
const RA0 = 100;
const DEC0 = 0;
const T0 = 55000;
const YEARS = [0, 1, 2, 5, 6, 9, 10];
function blob(data, cx, cy, amp) {
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) data[y * W + x] += amp * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 2);
}
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
const moverX = (yr) => 8 + 2.4 * yr;
const frames = YEARS.map((yr) => {
  const data = new Float32Array(W * W).map(rnd);
  blob(data, 10, 30, 1);
  blob(data, moverX(yr), 15, 1);
  return { data, w: W, h: W, meta: { mjd: T0 + yr * 365.25 } };
});
// catalogue entry: right motion, position ~4" off (like CatWISE), given at T0
const centre = (x, y) => ({ ra: RA0 - ((x - 20) * SCALE) / 3600, dec: DEC0 + ((y - 20) * SCALE) / 3600 });
const p0 = centre(8 + 1.2, 15 + 0.8);
const mover = { id: 'test', catalog: 'test', ...p0, pmra: (-2.4 * SCALE) * 1000, pmdec: 0, mag: 15 };
const grid = { ra0: RA0, dec0: DEC0, scale: SCALE };

test('sky positions map onto the array (east left, north up) and move with proper motion', () => {
  const p = skyToArray(RA0, DEC0, RA0, DEC0, SCALE, W, W);
  assert.deepEqual([p.x, p.y], [20, 20]);
  const east = skyToArray(RA0 + 10 / 3600, DEC0, RA0, DEC0, 1, W, W);
  assert.ok(east.x < 20);
  const q = moveTo({ ra: 0, dec: 0, pmra: 0, pmdec: 3600e3 }, 0, 365.25);
  assert.ok(Math.abs(q.dec - 1) < 1e-9);
  assert.deepEqual(fitLine([0, 1, 2], [1, 3, 5]), { a: 1, b: 2 });
});

test('the mover is measured in the images and its motion fitted, despite the catalogue offset', () => {
  const model = buildModel(frames, [mover], grid, T0);
  assert.equal(model.tracks.length, 1);
  const t = model.tracks[0];
  const mid = t.at(T0 + 3.5 * 365.25);
  assert.ok(Math.abs(mid.x - moverX(3.5)) < 0.5 && Math.abs(mid.y - 15) < 0.5, JSON.stringify(mid));
});

test('a catalogue "mover" the images do not show is rejected; duplicates are merged', () => {
  const ghost = { ...mover, id: 'ghost', dec: mover.dec + (12 * SCALE) / 3600 }; // nothing there (row 27)
  const twin = { ...mover, id: 'twin', ra: mover.ra - 0.5 * SCALE / 3600 };
  const model = buildModel(frames, [mover, ghost, twin], grid, T0);
  assert.deepEqual(model.tracks.map((t) => t.id), ['test']);
  assert.deepEqual(model.rejected, ['ghost']);
});

test('real dates are shown untouched; in between, the mover sits on its path, not at both ends', () => {
  const model = buildModel(frames, [mover], grid, T0);
  const real = renderAt(model, T0 + 365.25);
  assert.deepEqual(Array.from(real), Array.from(model.images[1]));
  // halfway between year 2 (x = 12.8) and year 5 (x = 20): expect the star at x ≈ 16.4
  const img = renderAt(model, T0 + 3.5 * 365.25);
  const row = (x) => img[15 * W + x];
  assert.ok(row(16) > 0.6, `mover at 16: ${row(16)}`);
  assert.ok(row(13) < 0.3 && row(20) < 0.3, `no ghosts at the ends: ${row(13)}, ${row(20)}`);
  // the still star just cross-fades: stays bright
  assert.ok(img[30 * W + 10] > 0.8);
  assert.deepEqual(bracket(model.mjds, T0 - 5), { k: 0, u: 0 });
});

test('a saturated star with a wide flat core is measured at its centre, not its edge', async () => {
  const { measureAround } = await import('../src/field/changeModel.js');
  const w = 80;
  const img = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) img[y * w + x] = Math.min(1, 3 * Math.exp(-((x - 40.5) ** 2 + (y - 37) ** 2) / 200));
  const m = measureAround(img, w, w, 38, 33, 5);
  assert.ok(Math.abs(m.x - 40.5) < 0.6 && Math.abs(m.y - 37) < 0.6, JSON.stringify(m));
});

test('steady background: still stars are identical at every time, the mover still moves', () => {
  const model = buildModel(frames, [mover], grid, T0);
  const a = renderAt(model, T0 + 1.3 * 365.25, undefined, { steady: true });
  const b = renderAt(model, T0 + 7.7 * 365.25, undefined, { steady: true });
  assert.equal(a[30 * W + 10], b[30 * W + 10]); // the still star: same value
  assert.equal(a[35 * W + 35], b[35 * W + 35]); // empty sky: same noise
  const peakX = (img) => { let bx = 0; for (let x = 0; x < W; x++) if (img[15 * W + x] > img[15 * W + bx]) bx = x; return bx; };
  assert.ok(Math.abs(peakX(a) - moverX(1.3)) <= 1 && Math.abs(peakX(b) - moverX(7.7)) <= 1, `${peakX(a)} ${peakX(b)}`);
});
