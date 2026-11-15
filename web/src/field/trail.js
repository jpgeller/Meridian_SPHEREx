// Frame helpers for the change video (changeModel.js): robust 0..1 scaling of one image and
// resampling onto another north-up grid. (This file once also built the motion trail, removed
// on 16 Nov 2026: the change video shows motion better.)
//
// Pure functions (no DOM); frames are { data: Float32Array (row 0 = south), w, h, meta: { mjd } }.

/** Robust 0..1 scaling of one frame: background → 0, bright sources → 1 (asinh-softened). */
export function normaliseFrame(data, { lo = 50, hi = 99.5 } = {}) {
  const vals = [];
  for (const v of data) if (Number.isFinite(v)) vals.push(v);
  const out = new Float32Array(data.length);
  if (vals.length < 3) return out;
  vals.sort((a, b) => a - b);
  const pick = (p) => vals[Math.min(vals.length - 1, Math.round((p / 100) * (vals.length - 1)))];
  let bg = pick(lo);
  let top = pick(hi);
  // A frame mostly at one value (glare filling a WISE image) has no range between its median and its
  // top: scaling by it turned the whole frame black. Use its full range instead.
  if (!(top - bg > 1e-6 * Math.max(1, Math.abs(top)))) {
    bg = vals[0];
    top = vals[vals.length - 1];
  }
  top = Math.max(top, bg + 1e-12);
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
