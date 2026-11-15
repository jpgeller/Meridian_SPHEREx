import test from 'node:test';
import assert from 'node:assert/strict';
import { findNotInGaia, detectSources, stackFrames, arrayToSky } from '../src/field/notInGaia.js';
import { skyToArray } from '../src/field/changeModel.js';

const W = 41;
const RA0 = 133.76;
const DEC0 = -7.24;
const SCALE = 6.15;

// a noisy frame (deterministic) with Gaussian stars at pixel positions
function frame(stars, seed, mjd) {
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2;
  const data = new Float32Array(W * W);
  for (let i = 0; i < data.length; i++) data[i] = 1 + 0.05 * rnd();
  for (const { x, y, f } of stars) {
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) data[j * W + i] += f * Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * 0.8 ** 2));
  }
  return { data, w: W, h: W, meta: { mjd } };
}
const sky = (x, y) => arrayToSky(x, y, RA0, DEC0, SCALE, W, W);

test('not in Gaia: a source without a Gaia star is a candidate; one with a star is matched', () => {
  const stars = [
    { x: 10, y: 12, f: 3 }, // in Gaia
    { x: 30, y: 25, f: 1.5 }, // not in Gaia
    { x: 20, y: 33, f: 2 }, // in Gaia
  ];
  const frames = [1, 2, 3, 4].map((k) => frame(stars, k * 7, 60800 + k * 90));
  const gaia = [stars[0], stars[2]].map((s) => ({ ...sky(s.x, s.y), pmra: 0, pmdec: 0, g_mag: 16 }));
  const res = findNotInGaia(frames, gaia, { ra0: RA0, dec0: DEC0, scale: SCALE });
  assert.equal(res.sources.length, 3);
  assert.equal(res.matched.length, 2);
  assert.equal(res.candidates.length, 1);
  const c = res.candidates[0];
  assert.ok(Math.hypot(c.x - 30, c.y - 25) < 0.3);
  assert.equal(c.seen, 4);
  assert.equal(c.n, 1);
});

test('not in Gaia: a strong source with a Gaia star 6.6" away is still a candidate (WISE 0855 case)', () => {
  const stars = [{ x: 20, y: 20, f: 2 }, { x: 8, y: 8, f: 3 }, { x: 32, y: 10, f: 3 }, { x: 10, y: 32, f: 3 }];
  const frames = [1, 2, 3].map((k) => frame(stars, k * 11, 60800 + k));
  const near = sky(20 + 6.6 / SCALE, 20); // a Gaia star 6.6" east of the source
  const gaia = [{ ...near, pmra: 0, pmdec: 0, g_mag: 16.3 }, ...stars.slice(1).map((s) => ({ ...sky(s.x, s.y), pmra: 0, pmdec: 0, g_mag: 15 }))];
  const res = findNotInGaia(frames, gaia, { ra0: RA0, dec0: DEC0, scale: SCALE });
  assert.equal(res.candidates.length, 1);
  assert.ok(Math.abs(res.candidates[0].nearestGaiaArcsec - 6.6) < 0.5);
});

test('not in Gaia: Gaia stars are moved to the images\' date with their proper motion', () => {
  const stars = [{ x: 20, y: 20, f: 2 }];
  const mjd = 57388.5 + 10 * 365.25; // 10 years after Gaia's epoch
  const frames = [frame(stars, 3, mjd), frame(stars, 5, mjd)];
  // the star was 3 pixels south in 2016 and moves north 1.845"/yr (18.45" in 10 years = 3 px)
  const then = sky(20, 17);
  const gaia = [{ ...then, pmra: 0, pmdec: 1845, g_mag: 15 }];
  const res = findNotInGaia(frames, gaia, { ra0: RA0, dec0: DEC0, scale: SCALE });
  assert.equal(res.matched.length, 1);
  assert.equal(res.candidates.length, 0);
});

test('stack and detect: the median drops a one-off hit; sky <-> pixel round trip', () => {
  const frames = [1, 2, 3].map((k) => frame([{ x: 20, y: 20, f: 2 }], k, 60000));
  frames[1].data[5 * W + 5] = 50; // a cosmic-ray hit in one image only
  const deep = stackFrames(frames);
  const found = detectSources(deep);
  assert.equal(found.length, 1);
  const p = skyToArray(sky(12.3, 30.7).ra, sky(12.3, 30.7).dec, RA0, DEC0, SCALE, W, W);
  assert.ok(Math.abs(p.x - 12.3) < 1e-6 && Math.abs(p.y - 30.7) < 1e-6);
});
