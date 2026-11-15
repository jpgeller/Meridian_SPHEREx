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

/** RA/Dec degrees -> '17h57m47.1s +04°46′06″' */
export function formatSexagesimal(ra, dec) {
  const h = ra / 15;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  const sign = dec < 0 ? '−' : '+';
  const d = Math.abs(dec);
  const dd = Math.floor(d), dm = Math.floor((d - dd) * 60), ds = ((d - dd) * 60 - dm) * 60;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(hh)}h${p(mm)}m${ss.toFixed(1).padStart(4, '0')}s ${sign}${p(dd)}°${p(dm)}′${ds.toFixed(0).padStart(2, '0')}″`;
}

// --- readable coordinates in the URL: ra=17h57m47.105s & dec=4d46m06.05s (or -29d00m28.08s) ---
// No '+' (a URL turns it into a space). Precision keeps the 5-decimal degrees the state and the
// API cache use: 1 ms of RA time and 0.01" of Dec are both below 5e-6 degrees, so a round trip
// gives back exactly the same 5-decimal value.
const pad2 = (n) => String(n).padStart(2, '0');

/** RA degrees -> '17h57m47.105s' */
export function raToUrl(ra) {
  const ms = Math.round((((ra % 360) + 360) % 360) / 15 * 3600 * 1000) % (24 * 3600 * 1000);
  const h = Math.floor(ms / 3.6e6);
  const m = Math.floor((ms % 3.6e6) / 6e4);
  const sec = (ms % 6e4) / 1000;
  return `${pad2(h)}h${pad2(m)}m${sec.toFixed(3).padStart(6, '0')}s`;
}

/** Dec degrees -> '4d46m06.05s' or '-29d00m28.08s' */
export function decToUrl(dec) {
  const cas = Math.round(Math.abs(dec) * 3600 * 100); // centi-arcseconds
  const d = Math.floor(cas / 360000);
  const m = Math.floor((cas % 360000) / 6000);
  const sec = (cas % 6000) / 100;
  return `${dec < 0 && cas > 0 ? '-' : ''}${d}d${pad2(m)}m${sec.toFixed(2).padStart(5, '0')}s`;
}

/** URL value -> RA degrees: '17h57m47.105s' or plain degrees '269.44627'. NaN if neither. */
export function raFromUrl(text) {
  const t = String(text ?? '').trim();
  const m = /^(\d{1,2})h(\d{1,2})m(\d{1,2}(?:\.\d+)?)s?$/i.exec(t);
  if (m) return ((Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * 15) % 360;
  return t === '' ? NaN : Number(t);
}

/** URL value -> Dec degrees: '-29d00m28.08s', '+4d46m06s' (a '+' may arrive as a space) or plain degrees. */
export function decFromUrl(text) {
  const t = String(text ?? '').trim();
  const m = /^([+-]?)(\d{1,2})d(\d{1,2})m(\d{1,2}(?:\.\d+)?)s?$/i.exec(t);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600);
  return t === '' ? NaN : Number(t);
}
