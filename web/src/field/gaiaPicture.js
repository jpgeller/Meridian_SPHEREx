// A picture of a patch drawn from the Gaia DR3 catalogue.
//
// Gaia does not publish images: it measures stars. Its catalogue has, for each star, a position
// (moved here to the chosen date with its proper motion), a brightness (G, 0.33–1.05 µm) and a
// colour (BP − RP). This paints each star as a small soft dot of that brightness and colour, so
// the patch can be compared with SPHEREx and WISE. The UI labels it as drawn, not photographed.
//
// Pure functions (no DOM) except drawGaiaPicture. Output rows: row 0 = north (screen order).

const GAIA_EPOCH_MJD = 57388.5; // 2016.0

/** Star colour (0..1 RGB) from Gaia BP − RP: hot stars blue-white, cool stars orange-red. */
export function starColour(bpRp) {
  if (bpRp == null || !Number.isFinite(bpRp)) return [1, 1, 1];
  const stops = [
    [-0.4, [0.62, 0.72, 1.0]],
    [0.0, [0.76, 0.84, 1.0]],
    [0.5, [0.95, 0.96, 1.0]],
    [0.8, [1.0, 0.97, 0.9]],
    [1.2, [1.0, 0.86, 0.66]],
    [2.0, [1.0, 0.72, 0.46]],
    [3.2, [1.0, 0.56, 0.34]],
  ];
  const x = Math.min(stops.at(-1)[0], Math.max(stops[0][0], bpRp));
  let k = 0;
  while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
  const [t0, c0] = stops[k];
  const [t1, c1] = stops[k + 1];
  const u = (x - t0) / (t1 - t0);
  return c0.map((v, j) => v + (c1[j] - v) * u);
}

/** Star position at a date (Gaia positions are at 2016.0; motions in mas/yr). */
export function gaiaPosition(star, mjd) {
  if (star.pmra == null || star.pmdec == null) return { ra: star.ra, dec: star.dec };
  const years = (mjd - GAIA_EPOCH_MJD) / 365.25;
  const cosd = Math.max(Math.cos((star.dec * Math.PI) / 180), 1e-6);
  return { ra: star.ra + (star.pmra * years) / 3.6e6 / cosd, dec: star.dec + (star.pmdec * years) / 3.6e6 };
}

/**
 * Render { r, g, b } (Float32Array, 0..1, row 0 = north) of size × size pixels at `scale`″/px,
 * centred on (ra0, dec0), stars moved to `mjd`.
 */
export function renderGaia(sources, { ra0, dec0, mjd, size, scale }) {
  const n = size * size;
  const acc = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const c = (size - 1) / 2;
  const cosd0 = Math.cos((dec0 * Math.PI) / 180);
  let drawn = 0;
  for (const star of sources) {
    if (star.g_mag == null) continue;
    const p = gaiaPosition(star, mjd);
    let dra = p.ra - ra0;
    if (dra > 180) dra -= 360;
    if (dra < -180) dra += 360;
    const x = c - (dra * cosd0 * 3600) / scale; // east left
    const y = c - ((p.dec - dec0) * 3600) / scale; // north up
    // brighter stars get wider dots, like a photograph's halo
    const sigma = 0.75 + Math.max(0, 15 - star.g_mag) * 0.22;
    const reach = Math.ceil(sigma * 3.5);
    if (x < -reach || y < -reach || x > size + reach || y > size + reach) continue;
    drawn++;
    const flux = Math.pow(10, -0.4 * (star.g_mag - 15));
    const col = starColour(star.bp_rp);
    const norm = flux / (2 * Math.PI * sigma * sigma);
    for (let j = Math.max(0, Math.floor(y - reach)); j <= Math.min(size - 1, Math.ceil(y + reach)); j++) {
      for (let i = Math.max(0, Math.floor(x - reach)); i <= Math.min(size - 1, Math.ceil(x + reach)); i++) {
        const v = norm * Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sigma * sigma));
        const k = j * size + i;
        acc[0][k] += v * col[0];
        acc[1][k] += v * col[1];
        acc[2][k] += v * col[2];
      }
    }
  }
  // asinh stretch: a G = 20 star is just visible, a G = 10 star is near white
  const soft = Math.pow(10, -0.4 * (20 - 15)) / (2 * Math.PI * 0.75 * 0.75);
  const top = Math.asinh(Math.pow(10, -0.4 * (10 - 15)) / (2 * Math.PI * 2 * 2) / soft);
  for (const ch of acc) for (let k = 0; k < n; k++) ch[k] = Math.min(1, Math.asinh(ch[k] / soft) / top);
  return { r: acc[0], g: acc[1], b: acc[2], size, drawn };
}

/** Paint a render into a canvas (one canvas pixel per grid pixel; CSS scales it). */
export function drawGaiaPicture(canvas, pic) {
  if (canvas.width !== pic.size || canvas.height !== pic.size) {
    canvas.width = pic.size;
    canvas.height = pic.size;
  }
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(pic.size, pic.size);
  for (let k = 0; k < pic.size * pic.size; k++) {
    img.data[k * 4] = Math.round(pic.r[k] * 255);
    img.data[k * 4 + 1] = Math.round(pic.g[k] * 255);
    img.data[k * 4 + 2] = Math.round(pic.b[k] * 255);
    img.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
