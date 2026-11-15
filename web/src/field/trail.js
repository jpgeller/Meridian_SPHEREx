// Motion trail: one still picture of all the dates of a patch, each date tinted by when it
// was taken (oldest blue → newest red) and stacked. Objects that stay put collect every
// colour and come out white; objects that move leave a rainbow streak whose direction and
// length show the motion; variable stars get a coloured fringe.
//
// Pure functions (no DOM); frames are { data: Float32Array (row 0 = south), w, h, meta: { mjd } }.

/** Colour for a time fraction t in [0, 1]: blue → cyan → green → yellow → red. */
export function timeColour(t) {
  const stops = [
    [0.0, [0.25, 0.45, 1.0]],
    [0.25, [0.1, 0.85, 1.0]],
    [0.5, [0.35, 1.0, 0.35]],
    [0.75, [1.0, 0.9, 0.15]],
    [1.0, [1.0, 0.25, 0.15]],
  ];
  const x = Math.min(1, Math.max(0, t));
  let k = 0;
  while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
  const [t0, c0] = stops[k];
  const [t1, c1] = stops[k + 1];
  const u = (x - t0) / (t1 - t0);
  return c0.map((v, j) => v + (c1[j] - v) * u);
}

/** Robust 0..1 scaling of one frame: background → 0, bright sources → 1 (asinh-softened). */
export function normaliseFrame(data, { lo = 50, hi = 99.5 } = {}) {
  const vals = [];
  for (const v of data) if (Number.isFinite(v)) vals.push(v);
  const out = new Float32Array(data.length);
  if (vals.length < 3) return out;
  vals.sort((a, b) => a - b);
  const pick = (p) => vals[Math.min(vals.length - 1, Math.round((p / 100) * (vals.length - 1)))];
  const bg = pick(lo);
  const top = Math.max(pick(hi), bg + 1e-12);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    // saturated cores count as fully bright; missing data counts as background
    const x = v === Infinity ? 1 : Number.isFinite(v) ? Math.min(1, Math.max(0, (v - bg) / (top - bg))) : 0;
    out[i] = Math.asinh(6 * x) / Math.asinh(6);
  }
  return out;
}

/**
 * Resample a frame onto another north-up grid with the same centre (nearest pixel).
 * `scale` = this frame's pixel size / the target's pixel size (e.g. 6.15″ / 2.75″).
 */
export function resampleToGrid(frame, size, scale) {
  if (frame.w === size && frame.h === size && Math.abs(scale - 1) < 1e-9) return frame;
  const out = new Float32Array(size * size);
  const cOut = (size - 1) / 2;
  const cx = (frame.w - 1) / 2;
  const cy = (frame.h - 1) / 2;
  for (let y = 0; y < size; y++) {
    const sy = Math.round(cy + (y - cOut) / scale);
    for (let x = 0; x < size; x++) {
      const sx = Math.round(cx + (x - cOut) / scale);
      out[y * size + x] = sx >= 0 && sy >= 0 && sx < frame.w && sy < frame.h ? frame.data[sy * frame.w + sx] : NaN;
    }
  }
  return { ...frame, data: out, w: size, h: size };
}

/**
 * Build the trail from aligned frames (same grid). Returns { r, g, b } (Float32Array 0..1),
 * plus the date range and each frame's colour, for the legend.
 */
export function motionTrail(frames) {
  const { w, h } = frames[0];
  const n = w * h;
  const mjds = frames.map((f) => f.meta.mjd);
  const t0 = Math.min(...mjds);
  const t1 = Math.max(...mjds);
  const colours = frames.map((f) => timeColour(t1 > t0 ? (f.meta.mjd - t0) / (t1 - t0) : 0.5));
  // Normalise by the summed colour so that something present on every date is white.
  const norm = [0, 1, 2].map((j) => colours.reduce((s, c) => s + c[j], 0));
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  frames.forEach((f, k) => {
    const x = normaliseFrame(f.data);
    const c = colours[k];
    for (let i = 0; i < n; i++) {
      const v = x[i];
      if (v === 0) continue;
      out[0][i] += (v * c[0]) / norm[0];
      out[1][i] += (v * c[1]) / norm[1];
      out[2][i] += (v * c[2]) / norm[2];
    }
  });
  // A mover is present on one date only, so its colour is faint after normalising; lift it
  // (gamma) so streaks stay visible next to static stars.
  for (const ch of out) for (let i = 0; i < n; i++) ch[i] = Math.min(1, Math.pow(ch[i], 0.6) * 1.15);
  return { r: out[0], g: out[1], b: out[2], w, h, t0, t1, colours, mjds };
}
