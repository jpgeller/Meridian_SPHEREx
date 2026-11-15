import test from 'node:test';
import assert from 'node:assert/strict';
import { planckLfl, wienPeak, spherexToLfl, overlapScale, fitBlackbody, buildSed, buildSedSvg, describeSed } from '../src/field/sed.js';

const um = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

test('Planck: lambda B_lambda peaks where Wien says (B_lambda peak; lambda*B_lambda peaks a little redder)', () => {
  for (const T of [3000, 5800]) {
    const grid = um(0.1, 5, 4000);
    let best = grid[0];
    for (const x of grid) if (planckLfl(x, T) / x > planckLfl(best, T) / best) best = x; // B_lambda itself
    assert.ok(Math.abs(best - wienPeak(T)) / wienPeak(T) < 0.01, `${T} K: ${best} vs ${wienPeak(T)}`);
  }
});

test('SPHEREx mJy -> lambda F_lambda: 1 mJy at 1 um is 3.0e-15 W/m^2; saturated points become lower limits', () => {
  const pts = [
    { wavelength_um: 1, flux_mjy: 1, err_mjy: 0.1, flag: '', detector: 1 },
    { wavelength_um: 2, flux_mjy: 5, err_mjy: 0.1, flag: 'saturated', detector: 3 },
    { wavelength_um: 3, flux_mjy: -1, err_mjy: 0.1, flag: '', detector: 4 },
  ];
  const v = spherexToLfl(pts);
  assert.equal(v.length, 1);
  assert.ok(Math.abs(v[0].lfl - 2.998e-15) / 2.998e-15 < 1e-3);
  assert.equal(spherexToLfl(pts, { limits: true }).length, 1);
});

// a synthetic star: Gaia XP over 0.34-1.02 um and SPHEREx over 0.75-5 um, SPHEREx 15 % low (aperture)
function star(T, { spherexLow = 0.85, excess = 1 } = {}) {
  const s = 1e-30;
  const xp = um(0.34, 1.02, 120).map((x) => ({ um: x, lfl: s * planckLfl(x, T), err: 0 }));
  const points = um(0.76, 4.95, 100).map((x, i) => {
    const lfl = s * planckLfl(x, T) * spherexLow * (x > 3 ? excess : 1);
    return { wavelength_um: x, flux_mjy: (lfl / (2.99792458e8 / (x * 1e-6))) / 1e-29, err_mjy: 0, flag: '', detector: 1 + Math.min(5, Math.floor(i / 17)) };
  });
  return { gaia: { found: true, source_id: '1', sep_arcsec: 0.1, g: 10, xp, photometry: [], teff_gspphot: T }, spectrum: { points, blends: [] } };
}

test('SED: the overlap measures how far SPHEREx is from Gaia and aligns it; the fit finds the temperature', () => {
  const { gaia, spectrum } = star(4000);
  const sed = buildSed(gaia, spectrum);
  assert.ok(Math.abs(sed.scale.factor - 1 / 0.85) < 0.01, `factor ${sed.scale.factor}`);
  assert.ok(Math.abs(sed.fit.T - 4000) < 80, `T ${sed.fit.T}`);
  assert.ok(Math.abs(sed.excess.ratio - 1) < 0.05);
  const { ok, svg } = buildSedSvg(sed);
  assert.ok(ok && svg.includes('sed-fit') && svg.includes('sed-xp'));
  assert.match(describeSed(sed), /Aligned: .* scaled ×1\.18/);
});

test('SED: extra infrared beyond 3 um is reported as a candidate', () => {
  const { gaia, spectrum } = star(4500, { excess: 3 });
  const sed = buildSed(gaia, spectrum);
  assert.ok(sed.excess.ratio > 2.5);
  assert.match(describeSed(sed), /Above the curve beyond 3 µm: ×3\.0.*candidate, not a discovery/);
});

test('SED: no Gaia star and a neighbour in the aperture -> no fit; a 4.5/3.4 um rise is pointed out', () => {
  const points = um(0.76, 4.95, 120).map((x) => ({
    wavelength_um: x,
    flux_mjy: x < 4.1 ? 0.5 / x : 2, // falling (a neighbour's light), then bright at 4.5 um
    err_mjy: 0,
    flag: '',
    detector: 1 + Math.min(5, Math.floor((x - 0.75) / 0.72)),
  }));
  const sed = buildSed({ found: false }, { points, blends: [{ source_id: '9', sep_arcsec: 6.8, g_mag: 16.3 }] });
  assert.equal(sed.fit, null);
  assert.ok(sed.rise > 1.5);
  const text = describeSed(sed);
  assert.match(text, /No blackbody fit/);
  assert.match(text, /Much brighter at 4\.5 µm than at 3\.4 µm/);
  assert.match(text, /another Gaia star \(G = 16\.3 at 6\.8″\): its light/);
});

test('fitBlackbody: needs 3 points; recovers T from photometry alone', () => {
  assert.equal(fitBlackbody([{ um: 1, lfl: 1 }]), null);
  const pts = [0.5, 0.8, 1.2, 2.0, 3.0].map((x) => ({ um: x, lfl: 2e-20 * planckLfl(x, 6000) }));
  assert.ok(Math.abs(fitBlackbody(pts).T - 6000) < 100);
  assert.equal(overlapScale([], []), null);
});
