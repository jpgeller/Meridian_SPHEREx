// Drawing aligned float32 frames onto a canvas. Pure helpers (stretch, colormaps) are
// exported for tests and for the compare modes.

// --- colormaps: 256-entry RGB lookup tables -----------------------------------------
function lut(stops) {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    for (let j = 0; j < 3; j++) out[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
  }
  return out;
}

export const COLORMAPS = {
  grey: lut([[0, [0, 0, 0]], [1, [255, 255, 255]]]),
  inferno: lut([
    [0, [0, 0, 4]], [0.25, [87, 16, 110]], [0.5, [188, 55, 84]], [0.75, [249, 142, 9]], [1, [252, 255, 164]],
  ]),
  // diverging (blue - black - orange) for difference images; 0.5 = zero
  diverging: lut([[0, [80, 160, 255]], [0.5, [0, 0, 0]], [1, [255, 170, 60]]]),
};
const NO_DATA_RGB = [28, 34, 52]; // NaN: no data; distinct from black so it is visible
// +Infinity marks saturated pixels (bright star cores): drawn at the top of the colormap.

// --- stretch -------------------------------------------------------------------------
/** Percentile of finite values in one or more arrays (sampled for speed). */
export function percentiles(arrays, ps, maxSamples = 200000) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const step = Math.max(1, Math.floor(total / maxSamples));
  const vals = [];
  for (const a of arrays) for (let i = 0; i < a.length; i += step) if (Number.isFinite(a[i])) vals.push(a[i]);
  if (!vals.length) return ps.map(() => 0);
  vals.sort((x, y) => x - y);
  return ps.map((p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))]);
}

/** One stretch shared by every frame of a sequence: blinking must not change brightness. */
export function sharedStretch(frames, { lo = 1, hi = 99.7 } = {}) {
  const [vmin, vmax] = percentiles(frames.map((f) => f.data), [lo, hi]);
  return { vmin, vmax: vmax > vmin ? vmax : vmin + 1, kind: 'asinh' };
}

/** Symmetric stretch around zero for difference images. */
export function divergingStretch(frame) {
  const [a, b] = percentiles([frame.data], [0.5, 99.5]);
  const m = Math.max(Math.abs(a), Math.abs(b)) || 1;
  return { vmin: -m, vmax: m, kind: 'linear' };
}

const ASINH_SOFT = 10;
export function normalise(v, { vmin, vmax, kind }) {
  let t = (v - vmin) / (vmax - vmin);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return kind === 'asinh' ? Math.asinh(ASINH_SOFT * t) / Math.asinh(ASINH_SOFT) : t;
}

/**
 * Draw a frame (row 0 = south) north-up into `canvas` at its native size; CSS scales it
 * with `image-rendering: pixelated`.
 */
export function drawFrame(canvas, frame, stretch, colormap = 'grey') {
  const { w, h, data } = frame;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const map = COLORMAPS[colormap] ?? COLORMAPS.grey;
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w; // flip: FITS row 0 is south, canvas row 0 is the top
    for (let x = 0; x < w; x++) {
      const v = data[src + x];
      const o = (y * w + x) * 4;
      if (v === Infinity) {
        const k = 255 * 3;
        img.data[o] = map[k];
        img.data[o + 1] = map[k + 1];
        img.data[o + 2] = map[k + 2];
      } else if (!Number.isFinite(v)) {
        img.data[o] = NO_DATA_RGB[0];
        img.data[o + 1] = NO_DATA_RGB[1];
        img.data[o + 2] = NO_DATA_RGB[2];
      } else {
        const k = Math.round(normalise(v, stretch) * 255) * 3;
        img.data[o] = map[k];
        img.data[o + 1] = map[k + 1];
        img.data[o + 2] = map[k + 2];
      }
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
