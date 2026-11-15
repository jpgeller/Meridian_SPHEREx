// Spectral energy distribution (SED): Gaia DR3 (0.34–1.02 µm) and SPHEREx (0.75–5 µm) on one graph,
// in one unit (λF_λ, W/m²), aligned where both missions see the same light (0.75–1.02 µm), with a
// blackbody (Planck) fit for a temperature and reference curves at 3,000 / 5,800 / 10,000 K.
//
// Honest by design: stars are not blackbodies (cool stars have molecular bands), the two missions observed
// years apart (variable stars do not line up), and SPHEREx's aperture photometry reads 10–20 % low, which
// is exactly what the overlap scaling measures and shows. Pure functions; buildSedSvg returns SVG markup.

const H_PLANCK = 6.62607015e-34;
const C_LIGHT = 2.99792458e8;
const K_B = 1.380649e-23;
const WIEN_UM_K = 2897.77;

export const GAIA_WINDOW = [0.33, 1.05];
export const SPHEREX_WINDOW = [0.75, 5.0];
export const OVERLAP = [0.75, 1.02];
export const REFERENCE_T = [3000, 5800, 10000];

/** λ·B_λ(T) up to a constant (shape of λF_λ for a blackbody), λ in µm. */
export function planckLfl(um, T) {
  const lam = um * 1e-6;
  const x = (H_PLANCK * C_LIGHT) / (lam * K_B * T);
  if (x > 700) return 0;
  return 1 / (lam ** 4 * Math.expm1(x));
}

/** Wien's peak (µm) of B_λ. */
export const wienPeak = (T) => WIEN_UM_K / T;

/**
 * SPHEREx spectrum points (mJy) -> λF_λ (W/m²). Non-positive fluxes are dropped; saturated points are
 * kept apart as lower limits (the true brightness is at least that).
 */
export function spherexToLfl(points, { limits = false } = {}) {
  const out = [];
  for (const p of points ?? []) {
    if (!Number.isFinite(p.flux_mjy) || !Number.isFinite(p.wavelength_um) || p.flux_mjy <= 0) continue;
    if ((p.flag === 'saturated') !== limits) continue;
    const nuFnu = (v) => v * 1e-29 * (C_LIGHT / (p.wavelength_um * 1e-6)); // mJy -> W/m²/Hz, times ν
    out.push({ um: p.wavelength_um, lfl: nuFnu(p.flux_mjy), err: nuFnu(p.err_mjy ?? 0), detector: p.detector });
  }
  return out.sort((a, b) => a.um - b.um);
}

/** Linear interpolation of the Gaia XP spectrum at λ (µm), or null outside it. */
function xpAt(xp, um) {
  if (!xp?.length || um < xp[0].um || um > xp[xp.length - 1].um) return null;
  let i = 1;
  while (i < xp.length && xp[i].um < um) i++;
  const a = xp[i - 1];
  const b = xp[Math.min(i, xp.length - 1)];
  const t = b.um === a.um ? 0 : (um - a.um) / (b.um - a.um);
  return a.lfl + (b.lfl - a.lfl) * t;
}

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * SPHEREx scale to match Gaia in the overlap: median of Gaia/SPHEREx over SPHEREx points in 0.75–1.02 µm
 * (Gaia XP interpolated there). { factor, n, spread } or null when there is no overlap to compare.
 */
export function overlapScale(spherex, xp) {
  const r = [];
  for (const p of spherex) {
    if (p.um < OVERLAP[0] || p.um > OVERLAP[1]) continue;
    const g = xpAt(xp, p.um);
    if (g > 0 && p.lfl > 0) r.push(g / p.lfl);
  }
  if (r.length < 3) return null;
  const factor = median(r);
  const spread = median(r.map((v) => Math.abs(Math.log(v / factor)))) * 1.4826; // in ln units
  return { factor, n: r.length, spread };
}

/** Median-bin points in log λ (so Gaia's 343 samples do not outweigh SPHEREx's ~100 points). */
export function binLog(points, perDex = 25) {
  const bins = new Map();
  for (const p of points) {
    if (!(p.lfl > 0)) continue;
    const k = Math.round(Math.log10(p.um) * perDex);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(p);
  }
  return [...bins.values()].map((b) => ({ um: median(b.map((p) => p.um)), lfl: median(b.map((p) => p.lfl)), n: b.length }));
}

/**
 * Blackbody fit in log space: T on a log grid (300–50,000 K), the scale solved exactly for each T.
 * Returns { T, scale, rms (dex) } or null.
 */
export function fitBlackbody(points) {
  const pts = points.filter((p) => p.lfl > 0 && p.um > 0);
  if (pts.length < 3) return null;
  const ly = pts.map((p) => Math.log10(p.lfl));
  let best = null;
  const tryT = (T) => {
    const lm = pts.map((p) => Math.log10(planckLfl(p.um, T) || 1e-300));
    let s = 0;
    for (let i = 0; i < pts.length; i++) s += ly[i] - lm[i];
    const a = s / pts.length;
    let e = 0;
    for (let i = 0; i < pts.length; i++) e += (ly[i] - lm[i] - a) ** 2;
    const rms = Math.sqrt(e / pts.length);
    if (!best || rms < best.rms) best = { T, scale: 10 ** a, rms };
  };
  for (let lt = Math.log10(300); lt <= Math.log10(50000); lt += 0.005) tryT(10 ** lt);
  // refine around the best
  const t0 = best.T;
  for (let f = 0.97; f <= 1.03; f += 0.001) tryT(t0 * f);
  return best;
}

/**
 * Everything the graph needs. gaia: the /api/context/gaia_sed answer (or null); spectrum: the
 * /api/spectrum answer (or null).
 */
export function buildSed(gaia, spectrum) {
  const raw = spherexToLfl(spectrum?.points);
  const rawLimits = spherexToLfl(spectrum?.points, { limits: true });
  const xp = gaia?.found ? gaia.xp ?? [] : [];
  const phot = gaia?.found ? gaia.photometry ?? [] : [];
  const scale = xp.length ? overlapScale(raw, xp) : null;
  const k = scale && scale.factor > 0.33 && scale.factor < 3 ? scale.factor : 1;
  const spherex = raw.map((p) => ({ ...p, lfl: p.lfl * k, err: p.err * k }));
  const limits = rawLimits.map((p) => ({ ...p, lfl: p.lfl * k }));
  // other Gaia stars inside SPHEREx's measuring circle (12"): their light is in the SPHEREx points
  const matchedId = gaia?.found ? gaia.source_id : null;
  const blends = (spectrum?.blends ?? []).filter((b) => b.source_id !== matchedId);
  // with no Gaia star at the point and a neighbour inside the circle, the short-wavelength light is the
  // neighbour's (WISE 0855 and a G = 16.3 star 6.6" away): a blackbody fit would describe the wrong thing
  const neighbourDominated = !gaia?.found && blends.some((b) => b.g_mag != null && b.g_mag < 19);
  // fit the photosphere: Gaia + SPHEREx up to 2.5 µm when Gaia has the star (longer wavelengths may hold
  // dust emission, which is what we want to see, not fit); SPHEREx alone otherwise
  const gaiaPts = xp.length ? xp : phot.filter((p) => p.band !== 'G'); // G is too broad for a red star's colour
  const fitPts = gaiaPts.length
    ? [...binLog(gaiaPts), ...binLog(spherex.filter((p) => p.um <= 2.5))]
    : binLog(spherex);
  const fit = neighbourDominated ? null : fitBlackbody(fitPts);
  let excess = null;
  if (fit && gaiaPts.length) {
    const model = (p) => fit.scale * planckLfl(p.um, fit.T);
    const long = spherex.filter((p) => p.um >= 3);
    const longLim = limits.filter((p) => p.um >= 3);
    if (long.length >= 5) excess = { ratio: median(long.map((p) => p.lfl / model(p))), n: long.length, limits: false };
    else if (longLim.length >= 5) excess = { ratio: median(longLim.map((p) => p.lfl / model(p))), n: longLim.length, limits: true };
  }
  // 4.5 um against 3.4 um, like WISE's W2/W1 colour: methane absorbs near 3.3 um in the coldest brown
  // dwarfs, which give off most of their light near 4.5 um. A normal star's lambda F_lambda at 4.5 um is
  // about half its value at 3.4 um (Rayleigh-Jeans), so a ratio above 1.5 stands out.
  const band = (a, b) => spherex.filter((p) => p.um >= a && p.um < b).map((p) => p.lfl);
  const w1 = band(3.15, 3.7);
  const w2 = band(4.2, 4.8);
  const rise = w1.length >= 3 && w2.length >= 3 && median(w1) > 0 ? median(w2) / median(w1) : null;
  return {
    spherex, limits, xp, phot, scale, appliedScale: k, fit, excess, rise, blends, neighbourDominated,
    gaia: gaia?.found ? gaia : null, nSpherex: raw.length, nLimits: rawLimits.length,
  };
}

// --- the graph ------------------------------------------------------------------------------
const DET = ['#6aa8ff', '#5fd0c4', '#9be07a', '#f2d16b', '#f59a6b', '#ef7aa7'];

export function buildSedSvg(sed, { W = 520, H = 280 } = {}) {
  const M = { l: 58, r: 14, t: 16, b: 38 };
  const xMin = 0.3;
  const xMax = 5.5;
  const all = [...sed.spherex, ...(sed.limits ?? []), ...sed.xp, ...sed.phot].map((p) => p.lfl).filter((v) => v > 0);
  if (!all.length) return { svg: '', ok: false };
  const curve = (T, scale) => {
    const out = [];
    for (let lu = Math.log10(xMin); lu <= Math.log10(xMax) + 1e-9; lu += 0.01) out.push([10 ** lu, scale * planckLfl(10 ** lu, T)]);
    return out;
  };
  const fitCurve = sed.fit ? curve(sed.fit.T, sed.fit.scale) : [];
  const top = Math.max(...all, ...fitCurve.map((c) => c[1])) * 2;
  const yMax = Math.log10(top);
  const yMin = Math.log10(Math.max(Math.min(...all) / 2, top / 1e4));
  const X = (um) => M.l + ((Math.log10(um) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * (W - M.l - M.r);
  const Y = (v) => H - M.b - ((Math.log10(Math.max(v, 1e-300)) - yMin) / (yMax - yMin)) * (H - M.t - M.b);
  const inY = (v) => v > 0 && Math.log10(v) >= yMin - 0.05;
  const path = (pts) =>
    pts
      .filter(([, v]) => inY(v))
      .map(([u, v], i) => `${i ? 'L' : 'M'}${X(u).toFixed(1)},${Y(v).toFixed(1)}`)
      .join('');
  const p = [];
  // mission windows
  p.push(`<rect x="${X(GAIA_WINDOW[0])}" y="${M.t}" width="${X(GAIA_WINDOW[1]) - X(GAIA_WINDOW[0])}" height="${H - M.t - M.b}" class="sed-gaia-win"/>`);
  p.push(`<rect x="${X(SPHEREX_WINDOW[0])}" y="${M.t}" width="${X(SPHEREX_WINDOW[1]) - X(SPHEREX_WINDOW[0])}" height="${H - M.t - M.b}" class="sed-spherex-win"/>`);
  const lb = H - M.b - 5;
  p.push(`<text x="${(X(GAIA_WINDOW[0]) + X(OVERLAP[0])) / 2}" y="${lb}" text-anchor="middle" class="sed-label gaia">Gaia</text>`);
  p.push(`<text x="${(X(OVERLAP[1]) + X(SPHEREX_WINDOW[1])) / 2}" y="${lb}" text-anchor="middle" class="sed-label spherex">SPHEREx</text>`);
  p.push(`<text x="${(X(OVERLAP[0]) + X(OVERLAP[1])) / 2}" y="${lb}" text-anchor="middle" class="sed-label">both</text>`);
  // axes
  for (let e = Math.ceil(yMin); e <= Math.floor(yMax); e++) {
    p.push(`<line x1="${M.l}" x2="${W - M.r}" y1="${Y(10 ** e)}" y2="${Y(10 ** e)}" class="grid"/>`);
    p.push(`<text x="${M.l - 6}" y="${Y(10 ** e) + 4}" text-anchor="end" class="axis">10<tspan dy="-5" font-size="8">${e}</tspan></text>`);
  }
  for (const um of [0.3, 0.5, 1, 2, 3, 5]) {
    p.push(`<line x1="${X(um)}" x2="${X(um)}" y1="${M.t}" y2="${H - M.b}" class="grid"/>`);
    p.push(`<text x="${X(um)}" y="${H - M.b + 15}" text-anchor="middle" class="axis">${um}</text>`);
  }
  p.push(`<text x="${(M.l + W - M.r) / 2}" y="${H - 5}" text-anchor="middle" class="axis">Wavelength (µm)</text>`);
  p.push(`<text x="13" y="${(M.t + H - M.b) / 2}" text-anchor="middle" class="axis" transform="rotate(-90 13 ${(M.t + H - M.b) / 2})">λF<tspan dy="3" font-size="8">λ</tspan><tspan dy="-3"> (W/m²)</tspan></text>`);
  // reference blackbodies, each scaled to the fitted curve's peak height (shape and peak position only)
  if (sed.fit) {
    const peakOf = (T, s) => s * planckLfl(wienPeak(T) * 1.0, T);
    const fitPeak = peakOf(sed.fit.T, sed.fit.scale);
    REFERENCE_T.forEach((T, i) => {
      const s = fitPeak / planckLfl(wienPeak(T), T);
      p.push(`<path d="${path(curve(T, s))}" class="sed-ref"/>`);
      // label where the curve leaves the right edge of the plot, staggered so they never overlap
      const yr = Y(s * planckLfl(xMax, T));
      const y = Math.min(H - M.b - 18, Math.max(M.t + 10, yr)) + i * 0;
      p.push(`<text x="${W - M.r - 2}" y="${(y - 3).toFixed(1)}" text-anchor="end" class="sed-ref-label">${T.toLocaleString('en')} K</text>`);
    });
    p.push(`<text x="${M.l + 6}" y="${M.t + 11}" class="sed-fit-label">fit ${(Math.round(sed.fit.T / 10) * 10).toLocaleString('en')} K</text>`);
    p.push(`<path d="${path(fitCurve)}" class="sed-fit"/>`);
    const pk = wienPeak(sed.fit.T);
    if (pk >= xMin && pk <= xMax) {
      p.push(`<line x1="${X(pk)}" x2="${X(pk)}" y1="${M.t}" y2="${H - M.b}" class="sed-peak"/>`);
    }
  }
  // Gaia: XP spectrum as a line, G/BP/RP as diamonds
  if (sed.xp.length) p.push(`<path d="${path(sed.xp.map((q) => [q.um, q.lfl]))}" class="sed-xp"/>`);
  for (const q of sed.phot) {
    const x = X(q.um);
    const y = Y(q.lfl);
    p.push(`<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" transform="rotate(45 ${x} ${y})" class="sed-phot"><title>Gaia ${q.band} = ${q.mag.toFixed(2)} mag (broad band: approximate)</title></rect>`);
  }
  // SPHEREx saturated points: lower limits, hollow up-triangles
  for (const q of sed.limits ?? []) {
    if (!inY(q.lfl)) continue;
    const x = X(q.um);
    const y = Y(q.lfl);
    p.push(`<path d="M${(x - 3).toFixed(1)},${(y + 2).toFixed(1)}L${x.toFixed(1)},${(y - 3).toFixed(1)}L${(x + 3).toFixed(1)},${(y + 2).toFixed(1)}Z" fill="none" stroke="${DET[(q.detector ?? 1) - 1]}"><title>SPHEREx ${q.um.toFixed(3)} µm: saturated, at least this bright</title></path>`);
  }
  // SPHEREx points by detector
  for (const q of sed.spherex) {
    if (!inY(q.lfl)) continue;
    p.push(`<circle cx="${X(q.um).toFixed(1)}" cy="${Y(q.lfl).toFixed(1)}" r="2.4" fill="${DET[(q.detector ?? 1) - 1]}"><title>SPHEREx ${q.um.toFixed(3)} µm (D${q.detector})</title></circle>`);
  }
  return { svg: p.join(''), ok: true };
}

/** The plain-language summary under the graph. */
export function describeSed(sed) {
  const g = sed.gaia;
  const parts = [];
  if (g) {
    parts.push(
      `Gaia DR3 ${g.source_id} (G = ${g.g?.toFixed(2)}, ${g.sep_arcsec}″ from the point${g.distance_pc ? `, ${formatDistance(g.distance_pc)}` : ''}): ` +
        (sed.xp.length ? 'its BP/RP spectrum (blue line) and' : 'no BP/RP spectrum, only') +
        ' its BP, G, RP brightness (diamonds; broad bands, approximate for red stars).',
    );
  } else {
    parts.push('No Gaia DR3 star at this point: the SED is SPHEREx only (often the case for cold objects; see "Not in Gaia").');
  }
  if (!sed.nSpherex) {
    parts.push(
      sed.nLimits
        ? `Every SPHEREx measurement here is saturated: shown as hollow triangles, "at least this bright".`
        : 'No usable SPHEREx measurement here yet.',
    );
  } else if (sed.nLimits) {
    parts.push(`${sed.nLimits} saturated SPHEREx points are hollow triangles: "at least this bright", not used in the fit.`);
  }
  if (sed.blends?.length) {
    const list = sed.blends.map((b) => `G = ${b.g_mag} at ${b.sep_arcsec}″`).join(', ');
    parts.push(`SPHEREx's 12″ measuring circle also holds ${sed.blends.length === 1 ? 'another Gaia star' : `${sed.blends.length} other Gaia stars`} (${list}): ${sed.blends.length === 1 ? 'its' : 'their'} light is in the SPHEREx points, mostly at short wavelengths.`);
  }
  if (sed.neighbourDominated) {
    parts.push('No blackbody fit: with no Gaia star at the point itself, the short-wavelength light is mostly that neighbour\'s.');
  }
  if (sed.scale) {
    const f = sed.scale.factor;
    const pct = Math.round(Math.abs(f - 1) * 100);
    parts.push(
      sed.appliedScale !== 1
        ? `Aligned: in 0.75–1.02 µm, where both missions see the same light, SPHEREx is ${f > 1 ? 'fainter' : 'brighter'} than Gaia by ${pct}% (${sed.scale.n} points), so SPHEREx is scaled ×${f.toFixed(2)} (its aperture photometry reads 10–20 % low).`
        : `In the overlap SPHEREx and Gaia differ by ×${f.toFixed(2)}: too far apart to align (a blend, variability, or a wrong match), so they are shown as measured.`,
    );
  } else if (g && sed.nSpherex) {
    parts.push('Not aligned: without a Gaia spectrum there is nothing to compare SPHEREx with in the overlap.');
  }
  if (sed.fit) {
    const T = Math.round(sed.fit.T / 10) * 10;
    const pk = wienPeak(sed.fit.T);
    parts.push(
      `Blackbody fit: about ${T.toLocaleString('en')} K (solid curve), peak at ${pk.toFixed(2)} µm by Wien's law` +
        `${pk > 5 ? ', beyond SPHEREx: only its short-wavelength side is seen, so the temperature is rough' : ''}.` +
        (g?.teff_gspphot ? ` Gaia's own estimate: ${Math.round(g.teff_gspphot).toLocaleString('en')} K.` : ''),
    );
    parts.push('Stars are not perfect blackbodies (cool ones have molecular bands), so the fit is a guide, not a measurement.');
  }
  if (sed.excess) {
    const r = sed.excess.ratio;
    const lim = sed.excess.limits ? ' (even as lower limits: saturated points)' : '';
    if (r > 1.5) parts.push(`Above the curve beyond 3 µm: ×${r.toFixed(1)}${lim}, more infrared than the star alone should give. Warm dust around it is one explanation (a candidate, not a discovery).`);
    else if (!sed.excess.limits) parts.push(`Beyond 3 µm SPHEREx follows the curve (×${r.toFixed(1)}): no sign of extra infrared.`);
  }
  if (sed.rise && sed.rise > 1.5) {
    parts.push(`Much brighter at 4.5 µm than at 3.4 µm (×${sed.rise.toFixed(1)}; a normal star is about ×0.5): the coldest brown dwarfs look like this, with methane absorbing near 3.3 µm and most of their light near 4.5 µm. This is the colour WISE used to find them.`);
  }
  parts.push('The missions observed years apart (Gaia 2014–2017, SPHEREx 2025–26), so variable stars may not line up.');
  return parts.join(' ');
}

function formatDistance(pc) {
  const ly = pc * 3.26156;
  return ly < 100 ? `${ly.toFixed(1)} light-years` : `${Math.round(ly).toLocaleString('en')} light-years`;
}
