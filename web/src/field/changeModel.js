// Change video: a smooth, honest animation between the real images of a patch
// (WISE 2010–2024 + SPHEREx 2025–26). See docs/research/CHANGE_VIDEO.md, option C.
//
// The in-between frames are built from a simple model, never invented pixels:
//   1. every real image is scaled 0..1 on its own (normaliseFrame), on one common grid;
//   2. background B = the median of all dates: static stars stay, movers drop out;
//   3. movers come from catalogues (Gaia DR3, CatWISE2020) only as a first guess: their
//      position is MEASURED in each real image and a straight-line motion is fitted.
//      Candidates the images don't confirm are dropped;
//   4. a frame at time t cross-fades the two real images around it, except near each mover,
//      where the mover's own image (from those two dates) is slid to its fitted position at t.
// At a real date the output equals that real image exactly.
//
// Pure functions (no DOM). Arrays are row 0 = south (FITS order), like the player's frames.
import { normaliseFrame } from './trail.js';

/** Sky position -> array pixel (x east-left, row 0 = south), small-field gnomonic approximation. */
export function skyToArray(ra, dec, ra0, dec0, scaleArcsec, w, h) {
  let dra = ra - ra0;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  return {
    x: (w - 1) / 2 - (dra * Math.cos((dec0 * Math.PI) / 180) * 3600) / scaleArcsec,
    y: (h - 1) / 2 + ((dec - dec0) * 3600) / scaleArcsec,
  };
}

/** Catalogue position at a date. `m` = { ra, dec, pmra, pmdec (mas/yr) } at `epochMjd`. */
export function moveTo(m, epochMjd, mjd) {
  const years = (mjd - epochMjd) / 365.25;
  const cosd = Math.max(Math.cos((m.dec * Math.PI) / 180), 1e-6);
  return { ra: m.ra + (m.pmra * years) / 3.6e6 / cosd, dec: m.dec + (m.pmdec * years) / 3.6e6 };
}

/**
 * Brightest point within `r` px of (x, y), refined by a weighted centroid. Returns null if nothing stands out (peak < minPeak).
 */
export function measureAround(img, w, h, x, y, r, minPeak = 0.25) {
  let best = -Infinity;
  let bx = -1;
  let by = -1;
  const x0 = Math.max(1, Math.floor(x - r));
  const x1 = Math.min(w - 2, Math.ceil(x + r));
  const y0 = Math.max(1, Math.floor(y - r));
  const y1 = Math.min(h - 2, Math.ceil(y + r));
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      if ((i - x) ** 2 + (j - y) ** 2 > r * r) continue;
      const v = img[j * w + i];
      if (v > best) {
        best = v;
        bx = i;
        by = j;
      }
    }
  }
  if (bx < 0 || best < minPeak) return null;
  // Bright stars are clipped flat by the normalisation. A flat core of any size: its centre is
  // the star (a fixed box sticks to the core's edge). Flood-fill the connected flat pixels.
  const flat = [];
  const seen = new Set([by * w + bx]);
  const queue = [[bx, by]];
  while (queue.length && flat.length < 4000) {
    const [i, j] = queue.pop();
    flat.push([i, j]);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      const k = nj * w + ni;
      if (ni < 0 || nj < 0 || ni >= w || nj >= h || seen.has(k)) continue;
      seen.add(k);
      if (img[k] >= best * 0.97 && Math.hypot(ni - bx, nj - by) < 60) queue.push([ni, nj]);
    }
  }
  if (flat.length >= 6) {
    const touchesEdge = flat.some(([i, j]) => i === 0 || j === 0 || i === w - 1 || j === h - 1);
    if (touchesEdge) return null; // cut by the image edge: unreliable
    const cx = flat.reduce((a, [i]) => a + i, 0) / flat.length;
    const cy = flat.reduce((a, [, j]) => a + j, 0) / flat.length;
    return { x: cx, y: cy, peak: best };
  }
  // Ordinary star: weighted centroid in a 5x5 box above half the peak, re-centred twice.
  const hw = 2;
  if (bx < hw || by < hw || bx >= w - hw || by >= h - hw) return null;
  let cx = bx;
  let cy = by;
  for (let pass = 0; pass < 2; pass++) {
    const ix = Math.min(w - 1 - hw, Math.max(hw, Math.round(cx)));
    const iy = Math.min(h - 1 - hw, Math.max(hw, Math.round(cy)));
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (let dj = -hw; dj <= hw; dj++) {
      for (let di = -hw; di <= hw; di++) {
        const v = Math.max(0, img[(iy + dj) * w + ix + di] - best * 0.5);
        sw += v;
        sx += v * (ix + di);
        sy += v * (iy + dj);
      }
    }
    if (sw <= 0) break;
    cx = sx / sw;
    cy = sy / sw;
  }
  return { x: cx, y: cy, peak: best };
}

/** Least-squares straight line v = a + b·t. */
export function fitLine(ts, vs) {
  const n = ts.length;
  const mt = ts.reduce((s, t) => s + t, 0) / n;
  const mv = vs.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ts[i] - mt) * (vs[i] - mv);
    den += (ts[i] - mt) ** 2;
  }
  const b = den > 0 ? num / den : 0;
  return { a: mv - b * mt, b };
}

/**
 * Measure a mover in each image near its predicted path and fit a straight-line motion.
 * Two passes: a wide search around the catalogue guess, then a tight one around the first fit.
 * Returns { at(mjd) -> {x, y}, rms, nDet, n } or null when the images don't confirm it.
 */
export function fitTrack(images, mjds, w, h, predict, { search = 5, tight = 2, minFrac = 0.6, maxRms = 1.3 } = {}) {
  let guess = predict;
  let fit = null;
  for (const r of [search, tight]) {
    const ts = [];
    const xs = [];
    const ys = [];
    images.forEach((img, k) => {
      const p = guess(mjds[k]);
      const m = measureAround(img, w, h, p.x, p.y, r);
      if (m) {
        ts.push(mjds[k]);
        xs.push(m.x);
        ys.push(m.y);
      }
    });
    if (ts.length < Math.max(3, Math.ceil(minFrac * images.length))) return null;
    const fx = fitLine(ts, xs);
    const fy = fitLine(ts, ys);
    const at = (t) => ({ x: fx.a + fx.b * t, y: fy.a + fy.b * t });
    const rms = Math.sqrt(ts.reduce((s, t, i) => s + (xs[i] - at(t).x) ** 2 + (ys[i] - at(t).y) ** 2, 0) / ts.length);
    fit = { at, rms, nDet: ts.length, n: images.length, vx: fx.b, vy: fy.b };
    guess = at;
  }
  return fit && fit.rms <= maxRms ? fit : null;
}

/** 0..1 weight: 1 inside r - 2 px, fading to 0 at r + 1 px. */
const taper = (d, r) => (d <= r - 2 ? 1 : d >= r + 1 ? 0 : (r + 1 - d) / 3);

function bilinear(img, w, h, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return NaN; // beyond the image: unknown
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return (
    img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy) + img[i + w] * (1 - fx) * fy + img[i + w + 1] * fx * fy
  );
}

/**
 * How far a mover's light reaches in EACH image: the radius where its ring-averaged brightness
 * falls to the background, plus a margin. Bright stars with glare and diffraction spikes get a big
 * radius (WISE's saturated glare is much wider than SPHEREx's), faint brown dwarfs a small one.
 * Per image, so a cut-out never drags along more of that image's background than it needs to.
 */
export function measureRadii(images, mjds, w, h, at, { floor = 0.08, min = 4, max = 45 } = {}) {
  return images.map((img, k) => {
    const c = at(mjds[k]);
    // the outermost ring still above the background: scanning outwards would stop inside the
    // hollow core WISE gives saturated stars
    let edge = 0;
    for (let r = 1; r <= max; r++) {
      let sum = 0;
      let n = 0;
      for (let a = 0; a < 24; a++) {
        const x = Math.round(c.x + r * Math.cos((a * Math.PI) / 12));
        const y = Math.round(c.y + r * Math.sin((a * Math.PI) / 12));
        if (x < 0 || y < 0 || x >= w || y >= h) continue; // part of the ring may be off the image
        sum += img[y * w + x];
        n++;
      }
      if (n && sum / n >= floor) edge = r;
    }
    return Math.min(max, Math.max(min, edge + 2));
  });
}

/** The widest a mover gets on any date. */
export const measureRadius = (...args) => Math.max(...measureRadii(...args));

/**
 * Median over dates, leaving out each date's pixels near a mover (at that date). Without this a
 * bright, slow-ish star sits on some pixels for most dates and leaves a ghost in the background.
 */
export function maskedMedian(images, mjds, w, h, tracks) {
  const masks = images.map((_, k) => {
    const m = new Uint8Array(w * h);
    for (const t of tracks) {
      const c = t.at(mjds[k]);
      const r = (t.radii?.[k] ?? t.radius) + 2;
      for (let y = Math.max(0, Math.floor(c.y - r)); y <= Math.min(h - 1, Math.ceil(c.y + r)); y++) {
        for (let x = Math.max(0, Math.floor(c.x - r)); x <= Math.min(w - 1, Math.ceil(c.x + r)); x++) {
          if ((x - c.x) ** 2 + (y - c.y) ** 2 <= r * r) m[y * w + x] = 1;
        }
      }
    }
    return m;
  });
  const out = new Float32Array(w * h);
  const vals = new Float32Array(images.length);
  for (let i = 0; i < w * h; i++) {
    let n = 0;
    for (let k = 0; k < images.length; k++) if (!masks[k][i]) vals[n++] = images[k][i];
    if (!n) {
      // covered by a mover on every date: take the faintest value
      let lo = Infinity;
      for (const img of images) lo = Math.min(lo, img[i]);
      out[i] = lo;
      continue;
    }
    const v = vals.subarray(0, n).sort();
    out[i] = n % 2 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
  }
  return out;
}

/**
 * frames: aligned { data, w, h, meta: { mjd, mission } } (any order).
 * movers: [{ id, catalog, ra, dec, pmra, pmdec, mag }] at epochMjd.
 * grid: { ra0, dec0, scale (arcsec/px) }.
 */
export function buildModel(frames, movers, grid, epochMjd) {
  const sorted = [...frames].sort((a, b) => a.meta.mjd - b.meta.mjd);
  const { w, h } = sorted[0];
  const mjds = sorted.map((f) => f.meta.mjd);
  const images = sorted.map((f) => normaliseFrame(f.data));
  const t0 = mjds[0];
  const t1 = mjds.at(-1);
  const mid = (t0 + t1) / 2;

  const tracks = [];
  const rejected = [];
  // brightest first, so the fragments catalogues list in a bright star's glare merge into it
  const byBrightness = [...movers].sort((a, b) => (a.mag ?? 99) - (b.mag ?? 99));
  for (const m of byBrightness) {
    const predict = (mjd) => {
      const p = moveTo(m, epochMjd, mjd);
      return skyToArray(p.ra, p.dec, grid.ra0, grid.dec0, grid.scale, w, h);
    };
    const a = predict(t0);
    const b = predict(t1);
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const inside = [a, b].some((p) => p.x > -5 && p.y > -5 && p.x < w + 5 && p.y < h + 5);
    if (!inside || span < 1.5) continue; // off the patch, or moves less than ~a pixel: nothing to animate
    const fit = fitTrack(images, mjds, w, h, predict);
    if (!fit) {
      rejected.push(m.id);
      continue;
    }
    // Same object twice (CatWISE lists very fast movers more than once), or a piece of a brighter
    // mover's glare: close to an existing track and moving roughly with it.
    const dup = tracks.some((t) => {
      const near = [t0, (t0 + mid) / 2, mid, (mid + t1) / 2, t1].some((tt) => {
        const p = t.at(tt);
        const q = fit.at(tt);
        return Math.hypot(p.x - q.x, p.y - q.y) < Math.max(3, 1.5 * t.radius);
      });
      const speedT = Math.hypot(t.vx, t.vy);
      const speedF = Math.hypot(fit.vx, fit.vy);
      const cos = (t.vx * fit.vx + t.vy * fit.vy) / (speedT * speedF || 1);
      return near && cos > 0.85 && speedF / speedT > 0.5 && speedF / speedT < 2;
    });
    if (dup) continue;
    // Gaia's motions are far more precise than a centroid on WISE's 2.75" pixels (bright stars are
    // saturated there): use Gaia's path, the images only confirm the star is there. CatWISE
    // positions can be off by several arcseconds over 16 years: use the path fitted to the images.
    const useCatalogue = m.catalog === 'Gaia DR3';
    const at = useCatalogue ? predict : fit.at;
    const vx = useCatalogue ? (b.x - a.x) / (t1 - t0) : fit.vx;
    const vy = useCatalogue ? (b.y - a.y) / (t1 - t0) : fit.vy;
    const track = {
      ...fit,
      at,
      vx,
      vy,
      path: useCatalogue ? 'catalogue' : 'fitted',
      id: m.id,
      catalog: m.catalog,
      radii: measureRadii(images, mjds, w, h, at),
      arcsecPerYear: Math.hypot(vx, vy) * 365.25 * grid.scale,
    };
    track.radius = Math.max(...track.radii);
    tracks.push(track);
  }
  const background = maskedMedian(images, mjds, w, h, tracks);
  const residuals = images.map((img) => img.map((v, i) => v - background[i]));
  return { w, h, mjds, frames: sorted, images, residuals, background, tracks, rejected, t0, t1 };
}

/** Index k of the real image at or before mjd, and the fraction u towards image k + 1. */
export function bracket(mjds, mjd) {
  if (mjd <= mjds[0]) return { k: 0, u: 0 };
  const last = mjds.length - 1;
  if (mjd >= mjds[last]) return { k: last, u: 0 };
  let k = 0;
  while (k < last - 1 && mjds[k + 1] <= mjd) k++;
  return { k, u: (mjd - mjds[k]) / (mjds[k + 1] - mjds[k]) };
}

/**
 * The model image at a date (Float32Array, 0..1, row 0 = south).
 * steady: what doesn't move is the background (all dates averaged), so it stays still instead of
 * changing with each image's noise, sharpness and scaling; only the movers' own images change.
 */
export function renderAt(model, mjd, out = new Float32Array(model.w * model.h), { steady = false } = {}) {
  const { w, h, images, residuals, background: B, mjds, tracks } = model;
  const { k, u } = bracket(mjds, mjd);
  const k1 = Math.min(k + 1, mjds.length - 1);
  const A = images[k];
  const C = images[k1];
  if (steady) out.set(B);
  else {
    for (let i = 0; i < out.length; i++) out[i] = A[i] * (1 - u) + C[i] * u;
    if (u === 0) return out; // a real date: the real image, untouched
  }
  for (const t of tracks) {
    const pa = t.at(mjds[k]);
    const pc = t.at(mjds[k1]);
    const pt = t.at(mjd);
    const ra = t.radii[k];
    const rc = t.radii[k1];
    const pad = Math.max(ra, rc) + 2;
    // 1. clear the mover from where it was / will be (background there), with soft edges
    for (const [p, r] of steady ? [] : [[pa, ra], [pc, rc]]) {
      for (let y = Math.max(0, Math.floor(p.y - r - 2)); y <= Math.min(h - 1, Math.ceil(p.y + r + 2)); y++) {
        for (let x = Math.max(0, Math.floor(p.x - r - 2)); x <= Math.min(w - 1, Math.ceil(p.x + r + 2)); x++) {
          const m = taper(Math.hypot(x - p.x, y - p.y), r);
          if (m > 0) out[y * w + x] = out[y * w + x] * (1 - m) + B[y * w + x] * m;
        }
      }
    }
    // 2. paste its own image from both dates, slid to where the fitted motion puts it now
    for (let y = Math.max(0, Math.floor(pt.y - pad)); y <= Math.min(h - 1, Math.ceil(pt.y + pad)); y++) {
      for (let x = Math.max(0, Math.floor(pt.x - pad)); x <= Math.min(w - 1, Math.ceil(pt.x + pad)); x++) {
        const d = Math.hypot(x - pt.x, y - pt.y);
        // each date's cut-out at its own size
        const ma = taper(d, ra);
        const mc = taper(d, rc);
        if (!ma && !mc) continue;
        const dx = x - pt.x;
        const dy = y - pt.y;
        // near the image edge one date may not have this part of the mover: use the other
        const sa = ma ? bilinear(residuals[k], w, h, pa.x + dx, pa.y + dy) : 0;
        const sc = mc ? bilinear(residuals[k1], w, h, pc.x + dx, pc.y + dy) : 0;
        const okA = Number.isFinite(sa);
        const okC = Number.isFinite(sc);
        if (!okA && !okC) continue;
        const s = okA && okC ? (1 - u) * ma * sa + u * mc * sc : okA ? ma * sa : mc * sc;
        out[y * w + x] += s;
      }
    }
  }
  return out;
}
