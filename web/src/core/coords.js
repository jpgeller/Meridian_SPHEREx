// Parse user-typed coordinates. Pure: no DOM. Returns {ra, dec} in degrees, or null if
// the text is not coordinates (then it is treated as a name).
//
// Accepted:  "133.795 -7.245"   "133.795, -7.245"
//            "08h55m10.831s -07d14m42.53s"   "08 55 10.831 -07 14 42.53"   "08:55:10.8 -07:14:42"

const NUM = String.raw`[+-]?\d+(?:\.\d+)?`;

function sexagesimal(parts) {
  const [a, b = 0, c = 0] = parts.map(Number);
  const sign = String(parts[0]).trim().startsWith('-') ? -1 : 1;
  return sign * (Math.abs(a) + b / 60 + c / 3600);
}

export function parseCoordinates(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');

  // Decimal degrees: exactly two numbers
  let m = t.match(new RegExp(`^(${NUM})\\s+(${NUM})$`));
  if (m) return check(Number(m[1]), Number(m[2]));

  // h m s / d m s with letters
  m = t.match(
    new RegExp(`^(\\d+)h\\s*(\\d+)m\\s*(${NUM})s?\\s+([+-]?\\d+)d\\s*(\\d+)m\\s*(${NUM})s?$`, 'i'),
  );
  if (m) return check(sexagesimal([m[1], m[2], m[3]]) * 15, sexagesimal([m[4], m[5], m[6]]));

  // Six space- or colon-separated fields
  const f = t.replace(/:/g, ' ').split(' ');
  if (f.length === 6 && f.every((x) => new RegExp(`^${NUM}$`).test(x))) {
    return check(sexagesimal(f.slice(0, 3)) * 15, sexagesimal(f.slice(3)));
  }
  return null;
}

function check(ra, dec) {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) return null;
  return { ra, dec };
}

// --- ICRS <-> galactic (IAU, J2000 rotation) -----------------------------------------
const ICRS_TO_GAL = [
  [-0.0548755604162154, -0.873437090234885, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];
const D2R = Math.PI / 180;
function rotate(m, [lon, lat], transpose) {
  const v = [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)];
  const r = [0, 1, 2].map((i) => [0, 1, 2].reduce((s, j) => s + (transpose ? m[j][i] : m[i][j]) * v[j], 0));
  const lon2 = Math.atan2(r[1], r[0]) / D2R;
  return [((lon2 % 360) + 360) % 360, Math.asin(Math.max(-1, Math.min(1, r[2]))) / D2R];
}
/** [ra, dec] (ICRS degrees) -> [l, b] (galactic degrees) */
export const icrsToGalactic = (radec) => rotate(ICRS_TO_GAL, radec, false);
/** [l, b] (galactic degrees) -> [ra, dec] (ICRS degrees) */
export const galacticToIcrs = (lb) => rotate(ICRS_TO_GAL, lb, true);
