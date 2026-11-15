// WISE W2 (4.6 µm) images of a field, 2010–2024, as float frames on a north-up grid
// centred on the target at 2.75"/px (served by /api/context/wise/frame; see api/context.py).
// Used by the motion trail to extend the time line back to 2010.

export const WISE_PIXEL_ARCSEC = 2.75;
const cache = new Map();

async function pngToFrame(url, meta) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const w = bmp.width;
  const h = bmp.height;
  const out = new Float32Array(w * h);
  // PNG row 0 is north; our frames put row 0 at the south (FITS order), so flip.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[(h - 1 - y) * w + x] = data[(y * w + x) * 4];
  }
  return { id: `wise:${meta.index}`, data: out, w, h, meta: { ...meta, mission: 'WISE' } };
}

/** All WISE epochs of the field as frames, oldest first. Throws if WISE is unavailable. */
export function loadWiseFrames(ra, dec, fov) {
  const key = `${ra.toFixed(5)},${dec.toFixed(5)}|${fov}`;
  if (!cache.has(key)) {
    const p = (async () => {
      const q = `ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=${fov}&band=2`;
      const r = await fetch(`/api/context/wise?${q}`);
      if (!r.ok) throw new Error(`WISE images unavailable (${r.status})`);
      const info = await r.json();
      const frames = await Promise.all(info.frames.map((f) => pngToFrame(f.url, f)));
      return frames.sort((a, b) => a.meta.mjd - b.meta.mjd);
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}
