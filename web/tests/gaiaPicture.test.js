import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGaia, starColour, gaiaPosition } from '../src/field/gaiaPicture.js';

test('star colours: hot stars bluish, cool stars reddish, unknown white', () => {
  const [r0, , b0] = starColour(-0.2);
  const [r1, , b1] = starColour(2.5);
  assert.ok(b0 > r0 && r1 > b1);
  assert.deepEqual(starColour(null), [1, 1, 1]);
});

test('a star is drawn at its position on the date (proper motion), north up and east left', () => {
  const star = { ra: 10, dec: 0, pmra: 0, pmdec: 36000, g_mag: 12, bp_rp: 0.8 }; // 36"/yr north
  const pic = renderGaia([star], { ra0: 10, dec0: 0, mjd: 57388.5 + 365.25, size: 41, scale: 3 });
  // after one year it is 36" = 12 px north of centre: row 20 - 12 = 8 (row 0 = north)
  let best = 0;
  let at = -1;
  pic.g.forEach((v, k) => v > best && ((best = v), (at = k)));
  assert.deepEqual([at % 41, Math.floor(at / 41)], [20, 8]);
  assert.equal(pic.drawn, 1);
  const east = renderGaia([{ ...star, pmdec: 0, ra: 10 + 9 / 3600 }], { ra0: 10, dec0: 0, mjd: 57388.5, size: 41, scale: 3 });
  let eb = 0, ea = -1;
  east.g.forEach((v, k) => v > eb && ((eb = v), (ea = k)));
  assert.equal(ea % 41, 17); // 9" east = 3 px to the left
  assert.ok(gaiaPosition(star, 57388.5).dec === 0);
});
