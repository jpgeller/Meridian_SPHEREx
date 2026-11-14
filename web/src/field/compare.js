// Comparing frames from different dates. Pure functions on aligned frames
// ({ data: Float32Array, w, h, meta }); NaN = no data, +Infinity = saturated.

/**
 * Mean of aligned frames per pixel (deeper image). A pixel counts as saturated only if
 * most frames covering it are saturated; a stray flagged pixel in one frame must not
 * punch a hole in the sum (seen on detector D6, 14 Nov 2026).
 */
export function addFrames(frames) {
  const { w, h } = frames[0];
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let sum = 0;
    let n = 0;
    let nSat = 0;
    for (const f of frames) {
      const v = f.data[i];
      if (v === Infinity) nSat++;
      else if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    out[i] = nSat > n ? Infinity : n ? sum / n : NaN;
  }
  const mjds = frames.map((f) => f.meta.mjd);
  return {
    id: `add(${frames.map((f) => f.id).join(',')})`,
    data: out,
    w,
    h,
    meta: {
      ...frames[0].meta,
      mjd: mjds.reduce((a, b) => a + b, 0) / mjds.length,
      date_iso: frames[0].meta.date_iso,
      date_end_iso: frames.at(-1).meta.date_iso,
      n_combined: frames.length,
      wavelength_um: frames.reduce((s, f) => s + f.meta.wavelength_um, 0) / frames.length,
      kind: 'add',
    },
  };
}

/**
 * Difference a − b. With variances, the result is a significance map:
 * (a − b) / sqrt(var_a + var_b), i.e. "how many sigma did this pixel change".
 * Saturated or missing in either frame -> NaN (no trustworthy difference).
 */
export function subtractFrames(a, b, varA = null, varB = null) {
  const n = a.w * a.h;
  const out = new Float32Array(n);
  const sigma = Boolean(varA && varB);
  for (let i = 0; i < n; i++) {
    const x = a.data[i];
    const y = b.data[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      out[i] = NaN;
      continue;
    }
    if (sigma) {
      const v = varA.data[i] + varB.data[i];
      out[i] = Number.isFinite(v) && v > 0 ? (x - y) / Math.sqrt(v) : NaN;
    } else {
      out[i] = x - y;
    }
  }
  return {
    id: `sub(${a.id},${b.id})`,
    data: out,
    w: a.w,
    h: a.h,
    meta: { ...a.meta, kind: 'subtract', units: sigma ? 'sigma' : a.meta.bunit, a: a.meta, b: b.meta },
  };
}

/** The two frames to blink/subtract: the chosen epochs, else first and last. */
export function pickPair(seq, t) {
  const valid = (t ?? []).filter((i) => i >= 0 && i < seq.length);
  if (valid.length >= 2) return [valid[0], valid[1]];
  return seq.length >= 2 ? [0, seq.length - 1] : [0, 0];
}

/** Frames to add: the chosen epochs (if 2+), else all. */
export function pickForAdd(seq, t) {
  const valid = [...new Set((t ?? []).filter((i) => i >= 0 && i < seq.length))].sort((x, y) => x - y);
  return valid.length >= 2 ? valid : seq.map((_, i) => i);
}

/**
 * Robust noise of an image: 1.4826 × median absolute deviation of the finite pixels.
 * Used to express a difference image in sigma without needing variance maps.
 */
export function robustStats(data) {
  const vals = [];
  for (const v of data) if (Number.isFinite(v)) vals.push(v);
  if (vals.length < 3) return { median: 0, sigma: 1 };
  vals.sort((a, b) => a - b);
  const median = vals[vals.length >> 1];
  const dev = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = dev[dev.length >> 1];
  return { median, sigma: mad > 0 ? 1.4826 * mad : 1 };
}

export const robustSigma = (data) => robustStats(data).sigma;

/**
 * Brightness scale k so that b ≈ k·a for real sources (photometric matching). Frames from
 * different dates are taken at slightly different wavelengths, so stars differ a little in
 * brightness; matching them first lets static stars cancel. Uses pixels well above the noise
 * in both frames; falls back to 1 when there are too few.
 */
export function fluxScale(a, b, { minSigma = 5, minPixels = 8 } = {}) {
  const sa = robustStats(a.data);
  const sb = robustStats(b.data);
  const ratios = [];
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i] - sa.median;
    const y = b.data[i] - sb.median;
    if (Number.isFinite(x) && Number.isFinite(y) && x > minSigma * sa.sigma && y > minSigma * sb.sigma) ratios.push(y / x);
  }
  if (ratios.length < minPixels) return 1;
  ratios.sort((p, q) => p - q);
  return ratios[ratios.length >> 1];
}

/**
 * Brightness-matched difference in units of its uncertainty. The error per pixel is the
 * background noise plus a fraction of the local brightness: images from different dates
 * have slightly different blur (SPHEREx pixels are coarse), so static stars never cancel
 * perfectly. With SYSTEMATIC_FRACTION = 0.15 a static star stays near 0, while an object
 * that moved (all of its light leaves one spot and lands on another) still stands out.
 */
export const SYSTEMATIC_FRACTION = 0.15;
export function differenceSignificance(a, b, { fraction = SYSTEMATIC_FRACTION } = {}) {
  const diff = matchedDifference(a, b);
  const k = diff.meta.scale;
  const sa = robustStats(a.data);
  const sb = robustStats(b.data);
  const { median, sigma } = robustStats(diff.data);
  // Only real sources (>3σ in their own image) add the brightness term; using noisy
  // pixel values here would shrink one sign of the difference and bias the colours.
  const real = (v, st) => (v - st.median > 3 * st.sigma ? v - st.median : 0);
  for (let i = 0; i < diff.data.length; i++) {
    const d = diff.data[i];
    if (!Number.isFinite(d)) continue;
    const bright = Math.max(k * real(a.data[i], sa), real(b.data[i], sb));
    diff.data[i] = (d - median) / Math.sqrt(sigma * sigma + (fraction * bright) ** 2);
  }
  diff.meta.units = 'sigma';
  diff.meta.fraction = fraction;
  return diff;
}

/** b − k·a after removing each frame's background, k from fluxScale (difference imaging). */
export function matchedDifference(a, b) {
  const k = fluxScale(a, b);
  const ma = robustStats(a.data).median;
  const mb = robustStats(b.data).median;
  const out = subtractFrames(
    { ...b, data: b.data.map((v) => v - mb) },
    { ...a, data: a.data.map((v) => k * (v - ma)) },
  );
  out.meta.scale = k;
  return out;
}

/**
 * Express a difference image in sigma: remove the background offset between the two
 * dates (zodiacal-light model residuals differ), then divide by the robust noise.
 */
export function toSignificance(diff) {
  const { median, sigma } = robustStats(diff.data);
  for (let i = 0; i < diff.data.length; i++) diff.data[i] = (diff.data[i] - median) / sigma;
  diff.meta.units = 'sigma';
  return diff;
}
