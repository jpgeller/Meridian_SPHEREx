// Sky <-> screen positions, for overlays drawn on top of the sky (an AI guide, a gaze layer...).
//
//   meridian.world2pix(ra, dec) -> { x, y, pageX, pageY, inView } | null
//   meridian.pix2world(x, y)    -> { ra, dec } | null
//
// x, y are pixels inside the sky view (#sky, origin top-left); pageX, pageY are the same point
// in page coordinates (for position: fixed overlays). null = not on screen (e.g. behind the globe).
// RA/Dec are always ICRS degrees.
//
// Aladin 3.8.2 quirks worked around here (found 15 Nov 2026):
//   - world2pix(lon, lat, frame) throws for ANY frame argument ("string is not defined").
//   - Without a frame, pix2world returns correct ICRS, but in the galactic (whole-sky) view
//     world2pix and getRaDec are off by a double conversion: they take ICRS numbers as galactic
//     l/b. So there we hand world2pix galacticToIcrs(ra, dec), and check every answer by
//     converting it back with pix2world.
import { galacticToIcrs } from '../core/coords.js';

const sepDeg = (a, b) => {
  const cosd = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  let dra = Math.abs(a[0] - b[0]) % 360;
  if (dra > 180) dra = 360 - dra;
  return Math.hypot(dra * cosd, a[1] - b[1]);
};

export function createSkyCoords(aladin, el = document.querySelector('#sky')) {
  function scale() {
    const [w, h] = aladin.getSize();
    const r = el.getBoundingClientRect();
    return { w, h, r, sx: r.width / w || 1, sy: r.height / h || 1 };
  }

  // Aladin pixel -> ICRS (no frame argument: see above)
  function rawPix2world(px, py) {
    try {
      const p = aladin.pix2world(px, py);
      return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [((p[0] % 360) + 360) % 360, p[1]] : null;
    } catch {
      return null; // outside the projected sky
    }
  }

  function rawWorld2pix(lon, lat) {
    try {
      const p = aladin.world2pix(lon, lat);
      return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
    } catch {
      return null;
    }
  }

  function world2pix(ra, dec) {
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
    const { w, h, r, sx, sy } = scale();
    const tol = Math.max(1e-4, (aladin.getFov()[0] / w) * 2); // two screen pixels
    const tries = aladin.getFrame?.() === 'GAL' ? [galacticToIcrs([ra, dec]), [ra, dec]] : [[ra, dec], galacticToIcrs([ra, dec])];
    for (const [lon, lat] of tries) {
      const p = rawWorld2pix(lon, lat);
      if (!p) continue;
      const back = rawPix2world(p[0], p[1]);
      if (!back || sepDeg(back, [ra, dec]) > tol) continue; // wrong frame guess, or the far side of the globe
      const x = p[0] * sx;
      const y = p[1] * sy;
      return { x, y, pageX: r.left + x, pageY: r.top + y, inView: p[0] >= 0 && p[1] >= 0 && p[0] < w && p[1] < h };
    }
    return null;
  }

  function pix2world(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const { sx, sy } = scale();
    const p = rawPix2world(x / sx, y / sy);
    return p ? { ra: p[0], dec: p[1] } : null;
  }

  /** The ICRS point at the middle of the view (getRaDec is wrong in the galactic view). */
  function centre() {
    const [w, h] = aladin.getSize();
    return rawPix2world(w / 2, h / 2);
  }

  return { world2pix, pix2world, centre };
}
