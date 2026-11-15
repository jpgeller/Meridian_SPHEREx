// Field data: which SPHEREx frames exist at a position, and their aligned cutouts.
// Network results are memoised per position so moving between bands is instant.

const MAX_PARALLEL = 4; // IRSA's cutout service throttles (503) under heavier parallel load

// Cube bands 0, 50 and 51 are blank in the all-sky mosaic, so the band control skips them,
// but real images exist at those wavelengths. Fold them into the neighbouring band.
const FOLD = { 0: 1, 50: 49, 51: 52 };
export const displayBand = (b) => FOLD[b] ?? b;

const listCache = new Map(); // "ra,dec" -> Promise<frames/meta response>
const cutoutCache = new Map(); // "id|ra|dec|fov|ext" -> Promise<cutout>

const posKey = (ra, dec) => `${ra.toFixed(4)},${dec.toFixed(4)}`;

/** All frames covering (ra, dec), each with wavelength_um, band, detector, visit, mjd. */
export function loadFrameList(ra, dec) {
  const key = posKey(ra, dec);
  if (!listCache.has(key)) {
    const p = fetch(`/api/frames/meta?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `frame search failed (${r.status})`);
      return r.json();
    });
    p.catch(() => listCache.delete(key)); // let the user retry after a failure
    listCache.set(key, p);
  }
  return listCache.get(key);
}

/** Frames that saw this spot in cube band `band`, oldest first. */
export function framesForBand(list, band) {
  return list.frames
    .filter((f) => f.band != null && displayBand(f.band) === band && f.inside && !f.error)
    .sort((a, b) => a.mjd - b.mjd);
}

/** Bands with at least one usable frame here, nearest first to `band`. */
export function bandsWithData(list, band) {
  const set = new Set(list.frames.filter((f) => f.inside && !f.error && f.band != null).map((f) => displayBand(f.band)));
  return [...set].sort((a, b) => Math.abs(a - band) - Math.abs(b - band));
}

// --- cutouts ---------------------------------------------------------------------
let active = 0;
const queue = [];
function limited(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    active < MAX_PARALLEL ? run() : queue.push(run);
  });
}

/**
 * Aligned float32 cutout: { id, data: Float32Array (row 0 = south), w, h, meta }.
 * meta: wavelength_um, mjd, detector, bad_pct, coverage_pct, flags_pct, ...
 */
export function loadCutout(frame, ra, dec, fov, ext = 'image') {
  const key = `${frame.id}|${ra.toFixed(5)}|${dec.toFixed(5)}|${fov}|${ext}`;
  if (!cutoutCache.has(key)) {
    // `v` busts browser caches from before the API sent Cache-Control: no-cache.
    const url = `/api/cutout?id=${encodeURIComponent(frame.id)}&ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=${fov}&ext=${ext}&v=5`;
    const p = limited(async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `cutout failed (${r.status})`);
      const w = Number(r.headers.get('X-Width'));
      const h = Number(r.headers.get('X-Height'));
      const meta = JSON.parse(r.headers.get('X-Meta') ?? '{}');
      const data = new Float32Array(await r.arrayBuffer());
      if (data.length !== w * h) throw new Error('cutout size mismatch');
      // a value the server could not compute comes as null: keep the frame list's value then
      const known = Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null));
      return { id: frame.id, data, w, h, meta: { ...frame, ...known } };
    });
    p.catch(() => cutoutCache.delete(key));
    cutoutCache.set(key, p);
  }
  return cutoutCache.get(key);
}

/** Median of aligned frames, pixel by pixel, ignoring NaN (used for "one per visit"). */
export function medianStack(frames) {
  if (frames.length === 1) return frames[0];
  const { w, h } = frames[0];
  const out = new Float32Array(w * h);
  const vals = new Float32Array(frames.length);
  for (let i = 0; i < w * h; i++) {
    let n = 0;
    for (const f of frames) {
      const v = f.data[i];
      if (Number.isFinite(v) || v === Infinity) vals[n++] = v;
    }
    if (!n) {
      out[i] = NaN;
      continue;
    }
    const s = vals.subarray(0, n).sort();
    out[i] = n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  }
  const first = frames[0].meta;
  const last = frames.at(-1).meta;
  return {
    id: frames.map((f) => f.id).join('+'),
    data: out,
    w,
    h,
    meta: {
      ...first,
      mjd: frames.reduce((s, f) => s + f.meta.mjd, 0) / frames.length,
      date_iso: first.date_iso,
      date_end_iso: last.date_iso,
      wavelength_um: frames.reduce((s, f) => s + f.meta.wavelength_um, 0) / frames.length,
      n_combined: frames.length,
      bad_pct: Math.max(...frames.map((f) => f.meta.bad_pct ?? 0)),
    },
  };
}
