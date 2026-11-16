// "Not in Gaia": sources SPHEREx sees that the Gaia DR3 catalogue does not have.
//
// Gaia measures visible light (0.33–1.05 µm) down to G ≈ 21. Things too cold, red or dusty for it (brown
// dwarfs like WISE 0855, newborn stars inside dust, many galaxies) can still glow in SPHEREx's infrared.
// So: stack the SPHEREx images of the patch, find point sources, move every Gaia star to the images'
// dates, and list the sources with no Gaia star nearby. These are CANDIDATES, never discoveries: noise,
// image artefacts, a star's glare, galaxies (Gaia misses most) or chance alignments all happen, so each
// candidate carries how significant it is and in how many single images it shows.
//
// Pure functions (no DOM). Frames: { data: Float32Array (row 0 = south), w, h, meta: { mjd } }, north up,
// east left, centred on (ra0, dec0) at `scale` arcsec per pixel (skyToArray in changeModel.js).

import { skyToArray } from './changeModel.js';

export const DEFAULTS = {
  nsigma: 5, // detection threshold on the 3x3-summed deep image
  // A Gaia star explains a source when it is within the source's position error: about the star image's
  // width (~9") over the signal-to-noise, plus 2.5" for registration. So 9" for a 5-sigma source, ~5" at 12
  // sigma. One fixed 9" let a G = 16 star 6.8" from WISE 0855 (12 sigma, centred on it) hide it (16 Nov 2026).
  matchArcsec: 9, // the widest match radius (faint sources)
  minMatchArcsec: 3.5, // the narrowest (bright sources)
  edgePx: 2, // ignore sources this close to the border (their 3x3 box is cut)
  minSeenFraction: 0.5, // a candidate must show (> 2 sigma) in at least this share of the single images
};

const GAIA_EPOCH_MJD = 57388.5; // 2016.0

const median = (vals) => {
  if (!vals.length) return NaN;
  const s = Float64Array.from(vals).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Background and noise of an image: median and 1.4826 x median absolute deviation (finite pixels). */
export function backgroundStats(data) {
  const vals = [];
  for (const v of data) if (Number.isFinite(v)) vals.push(v);
  const bg = median(vals);
  const sigma = 1.4826 * median(vals.map((v) => Math.abs(v - bg)));
  return { bg, sigma: sigma > 0 ? sigma : 1e-12 };
}

/**
 * The deep image: per-pixel median of the frames (moving things and one-off hits drop out). Saturated
 * pixels (+Infinity) count as very bright; missing (NaN) are skipped.
 */
export function stackFrames(frames) {
  const { w, h } = frames[0];
  const out = new Float32Array(w * h);
  const col = [];
  for (let i = 0; i < w * h; i++) {
    col.length = 0;
    for (const f of frames) {
      const v = f.data[i];
      if (v === Infinity || Number.isFinite(v)) col.push(v);
    }
    out[i] = col.length ? median(col) : NaN;
  }
  return { data: out, w, h };
}

/** 3x3 sum around (x, y) minus the background; Infinity counts as the brightest finite value seen. */
function box(data, w, h, x, y, bg, cap) {
  let s = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      let v = data[yy * w + xx];
      if (v === Infinity) v = cap;
      if (!Number.isFinite(v)) continue;
      s += v - bg;
      n++;
    }
  }
  return n >= 6 ? (s * 9) / n : NaN;
}

/** Point sources in an image: local maxima of the 3x3 sum above nsigma, with centroids (pixels). */
export function detectSources({ data, w, h }, { nsigma = DEFAULTS.nsigma, edgePx = DEFAULTS.edgePx } = {}) {
  const { bg, sigma } = backgroundStats(data);
  let cap = bg;
  for (const v of data) if (Number.isFinite(v) && v > cap) cap = v;
  const noise = 3 * sigma; // noise of a 3x3 sum
  const sums = new Float32Array(w * h).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sums[y * w + x] = box(data, w, h, x, y, bg, cap);
  const out = [];
  for (let y = edgePx; y < h - edgePx; y++) {
    for (let x = edgePx; x < w - edgePx; x++) {
      const s = sums[y * w + x];
      if (!(s / noise >= nsigma)) continue;
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && sums[(y + dy) * w + x + dx] > s) {
            peak = false;
            break;
          }
          // equal neighbours (flat saturated cores): keep only the first in scan order
          if ((dy < 0 || (dy === 0 && dx < 0)) && sums[(y + dy) * w + x + dx] === s) {
            peak = false;
            break;
          }
        }
      }
      if (!peak) continue;
      // flux-weighted centroid in the 3x3 box
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          let v = data[(y + dy) * w + x + dx];
          if (v === Infinity) v = cap;
          if (!Number.isFinite(v) || v <= bg) continue;
          sx += (x + dx) * (v - bg);
          sy += (y + dy) * (v - bg);
          sw += v - bg;
        }
      }
      out.push({ x: sw ? sx / sw : x, y: sw ? sy / sw : y, snr: s / noise, flux: s });
    }
  }
  return out.sort((a, b) => b.snr - a.snr);
}

/** Match radius (arcsec) for a source of this signal-to-noise. */
export function matchRadius(snr, o = DEFAULTS) {
  return Math.min(o.matchArcsec, Math.max(o.minMatchArcsec, 2.5 + 32 / Math.max(snr, 1)));
}

/** Pixel -> sky (inverse of skyToArray). */
export function arrayToSky(x, y, ra0, dec0, scale, w, h) {
  const dec = dec0 + ((y - (h - 1) / 2) * scale) / 3600;
  const ra = ra0 - ((x - (w - 1) / 2) * scale) / 3600 / Math.cos((dec0 * Math.PI) / 180);
  return { ra: ((ra % 360) + 360) % 360, dec };
}

/** How many of the single frames show something (> 2 sigma, 3x3 sum) at (x, y). */
function seenIn(frames, x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  let n = 0;
  for (const f of frames) {
    const { bg, sigma } = f.stats ?? (f.stats = backgroundStats(f.data));
    let cap = bg;
    if (f.data.some((v) => v === Infinity)) for (const v of f.data) if (Number.isFinite(v) && v > cap) cap = v;
    if (box(f.data, f.w, f.h, xi, yi, bg, cap) / (3 * sigma) > 2) n++;
  }
  return n;
}

/**
 * Find SPHEREx sources with no Gaia DR3 star nearby.
 * @param frames  the SPHEREx frames of one band / detector (same grid)
 * @param gaia    Gaia sources { ra, dec, pmra, pmdec (mas/yr), g_mag } at epoch 2016.0
 * @returns { sources, candidates, matched, gaiaInField, mjd, chance, deep }
 */
export function findNotInGaia(frames, gaia, { ra0, dec0, scale }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!frames?.length) return null;
  const { w, h } = frames[0];
  const deep = stackFrames(frames);
  const sources = detectSources(deep, o);
  const mjds = frames.map((f) => f.meta?.mjd).filter(Number.isFinite);
  const mjd = mjds.length ? mjds.reduce((a, b) => a + b, 0) / mjds.length : GAIA_EPOCH_MJD;
  const years = (mjd - GAIA_EPOCH_MJD) / 365.25;
  // every Gaia star where it was when SPHEREx looked (proper motion from 2016.0)
  const stars = [];
  for (const g of gaia ?? []) {
    let { ra, dec } = g;
    if (Number.isFinite(g.pmra) && Number.isFinite(g.pmdec)) {
      const cosd = Math.max(Math.cos((dec * Math.PI) / 180), 1e-6);
      ra += (g.pmra * years) / 3.6e6 / cosd;
      dec += (g.pmdec * years) / 3.6e6;
    }
    const p = skyToArray(ra, dec, ra0, dec0, scale, w, h);
    if (p.x >= -2 && p.y >= -2 && p.x <= w + 1 && p.y <= h + 1) stars.push({ ...p, g: g.g_mag, id: g.source_id });
  }
  const rPx = o.matchArcsec / scale; // widest radius, for the crowding estimate
  const nearest = (x, y) => {
    let best = null;
    let bestD = Infinity;
    for (const st of stars) {
      const d = Math.hypot(st.x - x, st.y - y);
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    return { best, d: bestD };
  };
  // Registration: the cutouts and Gaia can disagree by a few arcsec (pointing). Measure the shift from
  // clear pairs (strong source, Gaia star within the widest radius), take it out, and keep the scatter.
  const pairs = [];
  for (const src of sources) {
    if (src.snr < 8) continue;
    const { best, d } = nearest(src.x, src.y);
    if (best && d <= rPx && (best.g ?? 99) < 19.5) pairs.push([src.x - best.x, src.y - best.y]);
  }
  const shift = pairs.length >= 3 ? { x: median(pairs.map((p) => p[0])), y: median(pairs.map((p) => p[1])) } : { x: 0, y: 0 };
  const resid = pairs.map(([dx, dy]) => Math.hypot(dx - shift.x, dy - shift.y) * scale);
  // typical leftover error of a good match (arcsec); at least 1.5" (centroids of 6" pixels)
  const scatter = pairs.length >= 3 ? Math.max(1.5, median(resid)) : 2.5;
  // a Gaia star bright enough for a source of this significance, within a radius that grows with it:
  // G < 15 within 9" from 30 sigma, up to G < 13 within 25" for the brightest (saturated) stars
  const brightGaiaNear = (x, y, snr) => {
    const big = snr >= 300;
    const rr = (big ? 25 : 9) / scale;
    const gmax = big ? 13 : 15;
    let hit = null;
    for (const st of stars) {
      const dd = Math.hypot(st.x - x, st.y - y);
      if (dd <= rr && (st.g ?? 99) < gmax && (!hit || dd < hit.d)) hit = { d: dd, g: st.g };
    }
    return hit;
  };
  const matched = [];
  const candidates = [];
  for (const src of sources) {
    const { best, d } = nearest(src.x - shift.x, src.y - shift.y);
    const sky = arrayToSky(src.x - shift.x, src.y - shift.y, ra0, dec0, scale, w, h);
    const item = { ...src, ...sky, nearestGaiaArcsec: best ? d * scale : null, gaiaG: best?.g ?? null };
    item.matchArcsec = Math.min(o.matchArcsec, Math.max(o.minMatchArcsec, 2.5 * scatter + 32 / Math.max(src.snr, 1)));
    // Bright sources: saturated cores and glare move the measured centre by several arcsec, so a bright Gaia
    // star a little further out still explains them (Barnard's Star in D1, R Dra, 16 Nov 2026).
    const bright = src.snr >= 30 ? brightGaiaNear(src.x - shift.x, src.y - shift.y, src.snr) : null;
    if (best && d * scale <= item.matchArcsec) matched.push(item);
    else if (bright) matched.push({ ...item, nearestGaiaArcsec: bright.d * scale, gaiaG: bright.g, bright: true });
    else {
      item.seen = seenIn(frames, src.x, src.y);
      item.ofFrames = frames.length;
      if (frames.length < 3 || item.seen / frames.length >= o.minSeenFraction) candidates.push(item);
    }
  }
  candidates.forEach((c, i) => (c.n = i + 1));
  // chance that a random spot has a Gaia star within the match radius (crowded fields hide candidates)
  const areaPx = w * h;
  const chance = Math.min(1, (stars.length * Math.PI * rPx * rPx) / areaPx);
  return { sources, candidates, matched, gaiaInField: stars.length, mjd, chance, deep, matchArcsec: o.matchArcsec,
    shiftArcsec: { x: shift.x * scale, y: shift.y * scale }, scatterArcsec: scatter, calibrators: pairs.length };
}
