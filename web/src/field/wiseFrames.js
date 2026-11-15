// WISE W2 (4.6 µm) images of a field, 2010–2024, as float frames on a north-up grid
// centred on the target at 2.75"/px (served by /api/context/wise/frame; see api/context.py).
// Used by the change video to extend the time line back to 2010.

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
  return { id: `wise:${meta.index}`, data: out, w, h, meta: { ...meta, mission: 'WISE', saturatedFraction: saturatedFraction(out) } };
}

// WiseView's PNGs use one fixed brightness scale, so a bright star can turn most of a small field
// white (255): RA 127.42°, Dec −6.32° at 6′, 15 Nov 2026. Such a frame shows only glare.
export const WISE_SATURATED_MAX = 0.4;
export function saturatedFraction(data) {
  let n = 0;
  for (const v of data) if (v >= 254.5) n++;
  return data.length ? n / data.length : 0;
}

/**
 * All WISE epochs of the field as frames, oldest first (frames.saturated = how many were left out because
 * glare fills them, see WISE_SATURATED_MAX). Throws if WISE is unavailable.
 */
export function loadWiseFrames(ra, dec, fov) {
  const key = `${ra.toFixed(5)},${dec.toFixed(5)}|${fov}`;
  if (!cache.has(key)) {
    const p = (async () => {
      const q = `ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&fov=${fov}&band=2`;
      const r = await fetch(`/api/context/wise?${q}`);
      if (!r.ok) throw new Error(`WISE images unavailable (${r.status})`);
      const info = await r.json();
      const all = await Promise.all(info.frames.map((f) => pngToFrame(f.url, f)));
      const frames = all.filter((f) => f.meta.saturatedFraction <= WISE_SATURATED_MAX).sort((a, b) => a.meta.mjd - b.meta.mjd);
      frames.saturated = all.length - frames.length;
      return frames;
    })();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}
