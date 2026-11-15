// Target registry (UI plan, U2): where is "X" on screen right now?
//
//   resolve(id)          -> { x, y, r } (a point) | { x, y, rect: {x, y, w, h} } (an element) | null
//   locate(id)           -> resolve(id), or { offscreen: true, from, dir, bounds } when the target is
//                           known but outside the view (for the overlay's edge arrow), or null
//   targetAt(x, y, pad)  -> id | null      (what is at this viewport point, within `pad` px)
//   list()               -> [{ id, label?, x, y, r? | rect? }]   everything on screen now
//
// All positions are viewport pixels (position: fixed). null = not on screen (hidden, scrolled away,
// behind the globe, covered by a panel). Resolve again every frame: the sky moves. Never throws.
//
// Ids (the gaze layer and the guide use the same ones):
//   <data-guide>        any element with data-guide="…" (search, presets, band-ribbon, band-d1…d6,
//                       colour-views, face-panel, time-player, video-line)
//   sky:<preset id>     a preset place (sky:barnard, sky:wise_0855, …)
//   sky:target          the last place flown to (search box, preset, URL, guide)
//   field:target        the target in the middle of the time-lapse image
//   field:mover:<n>     a catalogue mover in the time-lapse, at the date of the frame on screen
//   colour:D1…D6        a detector block on the ribbon
//   colour:<band>       a band's tick on the ribbon (1-101)
//
// Pure: everything outside (DOM, Aladin, the player) is passed in, so node tests can drive it.
import { parseCoordinates } from '../core/coords.js';
import { detectorOf, BAND_MIN, BAND_MAX } from '../core/bands.js';
import { PRESETS } from '../sky/presets.js';
import { skyToPixel } from '../field/context.js';
import { moveTo } from '../field/changeModel.js';

export const SKY_OBJECT_R = 24; // px: the catch size of a point on the sky (the dwell radius adds to it)
const FIELD_RING = 0.045; // the player's target ring: r = 4.5 in a 100-unit viewBox
const MIN_FIELD_R = 16;

// --- pure helpers (unit-tested) --------------------------------------------------------

/** A DOMRect-like box -> a registry answer, or null if empty or entirely outside the viewport. */
export function rectResult(b, viewport) {
  if (!b || !(b.width > 0) || !(b.height > 0)) return null;
  if (viewport && (b.right <= 0 || b.bottom <= 0 || b.left >= viewport.w || b.top >= viewport.h)) return null;
  const rect = { x: b.left, y: b.top, w: b.width, h: b.height };
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, rect };
}

/**
 * A sky position inside the field-view image -> viewport point, or null if outside the image.
 * geom = { ra0, dec0, scale (″/px), w, h } of the shown frame; box = the canvas's client rect.
 */
export function fieldToViewport(ra, dec, geom, box) {
  if (!geom || !box || !(geom.w > 0) || !(box.width > 0)) return null;
  const { x, y } = skyToPixel(ra, dec, geom.ra0, geom.dec0, geom.scale, geom.w); // square frames
  if (x < -0.5 || y < -0.5 || x > geom.w - 0.5 || y > geom.h - 0.5) return null;
  const sx = box.width / geom.w;
  const sy = box.height / geom.h;
  return { x: box.left + (x + 0.5) * sx, y: box.top + (y + 0.5) * sy };
}

/**
 * Pick what is at (x, y). Rules, in order:
 *   1. a point whose circle contains (x, y)            (a star beats the image it sits on)
 *   2. the smallest element containing (x, y)          (band-d3 beats band-ribbon)
 *   3. the nearest point within r + pad
 *   4. the nearest element within pad
 */
export function pickTarget(items, x, y, pad = 0) {
  let best = null;
  const consider = (rank, score, id) => {
    if (!best || rank < best.rank || (rank === best.rank && score < best.score)) best = { rank, score, id };
  };
  for (const it of items) {
    if (it.rect) {
      const { x: rx, y: ry, w, h } = it.rect;
      const dx = Math.max(rx - x, 0, x - (rx + w));
      const dy = Math.max(ry - y, 0, y - (ry + h));
      const d = Math.hypot(dx, dy);
      if (d === 0) consider(2, w * h, it.id);
      else if (d <= pad) consider(4, d, it.id);
    } else {
      const d = Math.hypot(it.x - x, it.y - y);
      const r = it.r ?? 0;
      if (d <= r) consider(1, d, it.id);
      else if (d <= r + pad) consider(3, d - r, it.id);
    }
  }
  return best?.id ?? null;
}

/** [east, north] direction from sky position c to t ([ra, dec] degrees); right for any separation < 180°. */
export function tangentDir(c, t) {
  const d = Math.PI / 180;
  const dra = (t[0] - c[0]) * d;
  return [
    Math.cos(t[1] * d) * Math.sin(dra),
    Math.cos(c[1] * d) * Math.sin(t[1] * d) - Math.sin(c[1] * d) * Math.cos(t[1] * d) * Math.cos(dra),
  ];
}

/**
 * Which way is `target` on screen? `right` and `up` are the sky positions a few pixels right of and
 * above the view centre `centre` (they carry the view's orientation and flip). -> unit {x, y}, y down.
 */
export function screenDirection(centre, right, up, target) {
  const R = tangentDir(centre, right);
  const U = tangentDir(centre, up);
  const T = tangentDir(centre, target);
  const det = R[0] * U[1] - R[1] * U[0];
  if (!det) return null;
  const a = (T[0] * U[1] - T[1] * U[0]) / det; // T = a·R + b·U
  const b = (R[0] * T[1] - R[1] * T[0]) / det;
  const len = Math.hypot(a, b);
  return len > 0 && Number.isFinite(len) ? { x: a / len, y: -b / len } : null;
}

// --- the registry ----------------------------------------------------------------------

/**
 * @param {Object} o
 * @param {Document|Element} o.root      where to look for [data-guide] elements
 * @param {Function} o.getState          store.get
 * @param {Function} o.world2pix         (ra, dec) -> { pageX, pageY, inView } | null  (sky/skyCoords.js)
 * @param {Function} [o.pix2world]       (x, y) inside the sky view -> { ra, dec } | null (off-screen directions)
 * @param {Function} [o.skyRect]         () -> the sky view's client rect
 * @param {Function} [o.isSkyVisible]    (x, y) -> false when a panel covers that point of the sky
 * @param {Object}   [o.field]           { canvas, getGeometry, getMovers } (field/player.js)
 * @param {Function} [o.fetchJson]       url -> Promise<json>, to look up preset names
 * @param {Function} [o.viewport]        () -> { w, h }
 * @param {EventTarget} [o.events]       where `meridian:command` arrives (window)
 */
export function createRegistry({
  root,
  getState,
  world2pix,
  pix2world = null,
  skyRect = null,
  isSkyVisible = () => true,
  field = null,
  fetchJson = null,
  viewport = () => ({ w: globalThis.innerWidth ?? Infinity, h: globalThis.innerHeight ?? Infinity }),
  events = null,
}) {
  // sky objects: id -> { label, ra, dec } once the position is known
  const places = new Map();
  const pending = new Set();

  for (const p of PRESETS) {
    const c = parseCoordinates(p.target);
    if (c) places.set(`sky:${p.id}`, { label: p.label, ra: c.ra, dec: c.dec });
  }

  /** Look up the presets that are names (once each; the API applies proper motion to 2026.0). */
  function lookUpPresets() {
    if (!fetchJson) return;
    for (const p of PRESETS) {
      const id = `sky:${p.id}`;
      if (places.has(id) || pending.has(id)) continue;
      pending.add(id);
      Promise.resolve()
        .then(() => fetchJson(`/api/resolve?name=${encodeURIComponent(p.target)}`))
        .then((b) => {
          if (Number.isFinite(b?.ra) && Number.isFinite(b?.dec)) places.set(id, { label: p.label, ra: b.ra, dec: b.dec });
        })
        .catch(() => {}) // offline: learnt later from fly_to
        .finally(() => pending.delete(id));
    }
  }

  /** fly_to puts the target at the centre of the view; remember it (and the preset it was). */
  function learnFlyTo(detail) {
    if (detail?.name !== 'fly_to' || !detail.ok) return;
    const target = String(detail.args?.target ?? '').trim();
    if (!target) return;
    const s = getState();
    const where = { label: target, ra: s.ra, dec: s.dec };
    places.set('sky:target', where);
    const preset = PRESETS.find((p) => p.target === target);
    if (preset) places.set(`sky:${preset.id}`, { ...where, label: preset.label });
  }
  events?.addEventListener?.('meridian:command', (e) => learnFlyTo(e.detail));

  // --- resolvers ---

  function element(name) {
    const el = root?.querySelector?.(`[data-guide="${name}"]`);
    if (!el || el.closest?.('[hidden]')) return null;
    return rectResult(el.getBoundingClientRect(), viewport());
  }

  function fieldBox() {
    const box = field?.canvas?.getBoundingClientRect?.();
    return box && box.width > 0 ? box : null;
  }

  function inField(ra, dec) {
    if (getState().view !== 'field') return null;
    const p = fieldToViewport(ra, dec, field?.getGeometry?.(), fieldBox());
    return p ? { ...p, r: Math.max(MIN_FIELD_R, (fieldBox()?.width ?? 0) * FIELD_RING) } : null;
  }

  function skyObject(id) {
    const place = places.get(id);
    if (!place) return null;
    if (getState().view === 'field') return inField(place.ra, place.dec);
    const p = world2pix(place.ra, place.dec);
    if (!p?.inView) return null;
    const x = p.pageX;
    const y = p.pageY;
    const { w, h } = viewport();
    if (x < 0 || y < 0 || x >= w || y >= h || !isSkyVisible(x, y)) return null;
    return { x, y, r: SKY_OBJECT_R };
  }

  function fieldObject(rest) {
    const s = getState();
    if (s.view !== 'field') return null;
    if (rest === 'target') return inField(s.ra, s.dec);
    const m = /^mover:(\d+)$/.exec(rest);
    if (!m) return null;
    const cat = field?.getMovers?.();
    const mover = cat?.movers?.[Number(m[1])];
    const geom = field?.getGeometry?.();
    if (!mover || !geom) return null;
    const at = Number.isFinite(geom.mjd) && Number.isFinite(mover.pmra)
      ? moveTo(mover, cat.epoch_mjd, geom.mjd)
      : { ra: mover.ra, dec: mover.dec };
    return inField(at.ra, at.dec);
  }

  function colour(rest) {
    const d = /^D([1-6])$/i.exec(rest);
    if (d) return element(`band-d${d[1]}`);
    const band = Number(rest);
    if (!Number.isInteger(band) || band < BAND_MIN || band > BAND_MAX) return null;
    const { detector, channel } = detectorOf(band);
    const det = root?.querySelector?.(`[data-guide="band-d${detector}"]`);
    if (!det || det.closest?.('[hidden]')) return null;
    const tick = det.querySelectorAll?.('.det-ticks i')?.[channel - 1];
    return rectResult(tick?.getBoundingClientRect?.(), viewport()) ?? element(`band-d${detector}`);
  }

  function resolve(id) {
    try {
      if (typeof id !== 'string' || !id) return null;
      const i = id.indexOf(':');
      if (i < 0) return element(id);
      const kind = id.slice(0, i);
      const rest = id.slice(i + 1);
      if (kind === 'sky') {
        if (!places.has(id)) lookUpPresets();
        return skyObject(id);
      }
      if (kind === 'field') return fieldObject(rest);
      if (kind === 'colour' || kind === 'color') return colour(rest);
      return null;
    } catch (err) {
      console.warn('[guide] resolve failed', id, err);
      return null;
    }
  }

  /** Every id that could be on screen now (cheap enough to call per frame or per gaze sample). */
  function ids() {
    const out = [];
    root?.querySelectorAll?.('[data-guide]')?.forEach?.((el) => out.push(el.dataset?.guide ?? el.getAttribute('data-guide')));
    if (getState().view !== 'field') out.push(...places.keys());
    else {
      // sky:* still resolve here (onto the image), but field:target / field:mover:<n> name these spots
      out.push('field:target');
      const n = field?.getMovers?.()?.movers?.length ?? 0;
      for (let k = 0; k < n; k++) out.push(`field:mover:${k}`);
    }
    return out;
  }

  function label(id) {
    if (places.has(id)) return places.get(id).label;
    if (id === 'field:target') return places.get('sky:target')?.label;
    if (id.startsWith('field:mover:')) return field?.getMovers?.()?.movers?.[Number(id.slice(12))]?.id;
    return undefined;
  }

  function list() {
    const out = [];
    for (const id of ids()) {
      const r = resolve(id);
      if (r) out.push({ id, ...(label(id) ? { label: label(id) } : {}), ...r });
    }
    return out;
  }

  // --- off-screen directions (overlay edge arrow) ---

  /** Where a sky id or field id is on the sky, or null. */
  function skyPosition(id) {
    if (id.startsWith('sky:')) {
      const p = places.get(id);
      return p ? [p.ra, p.dec] : null;
    }
    const s = getState();
    if (id === 'field:target') return [s.ra, s.dec];
    const m = /^field:mover:(\d+)$/.exec(id);
    if (!m) return null;
    const cat = field?.getMovers?.();
    const mover = cat?.movers?.[Number(m[1])];
    if (!mover) return null;
    const mjd = field?.getGeometry?.()?.mjd;
    const at = Number.isFinite(mjd) && Number.isFinite(mover.pmra) ? moveTo(mover, cat.epoch_mjd, mjd) : mover;
    return [at.ra, at.dec];
  }

  function offscreenInField([ra, dec]) {
    const geom = field?.getGeometry?.();
    const box = fieldBox();
    if (!geom || !box || !(geom.w > 0)) return null;
    const { x, y } = skyToPixel(ra, dec, geom.ra0, geom.dec0, geom.scale, geom.w);
    const dx = x - (geom.w - 1) / 2;
    const dy = y - (geom.h - 1) / 2;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return null;
    const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    return { offscreen: true, from, dir: { x: dx / len, y: dy / len }, bounds: { x: box.left, y: box.top, w: box.width, h: box.height } };
  }

  function offscreenInSky([ra, dec]) {
    const { w, h } = viewport();
    const bounds = { x: 0, y: 0, w, h };
    const r = skyRect?.() ?? { left: 0, top: 0, width: w, height: h };
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const p = world2pix(ra, dec);
    if (p) {
      const inside = p.inView && p.pageX >= 0 && p.pageY >= 0 && p.pageX < w && p.pageY < h;
      if (inside) return null; // on screen but covered by a panel: not an edge case
      const dx = p.pageX - from.x;
      const dy = p.pageY - from.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) return { offscreen: true, from, dir: { x: dx / len, y: dy / len }, bounds };
    }
    // behind the globe (no projection): use the view's orientation at the centre
    if (!pix2world) return null;
    const cx = r.width / 2;
    const cy = r.height / 2;
    const c = pix2world(cx, cy);
    const right = pix2world(cx + 20, cy);
    const up = pix2world(cx, cy - 20);
    if (!c || !right || !up) return null;
    const dir = screenDirection([c.ra, c.dec], [right.ra, right.dec], [up.ra, up.dec], [ra, dec]);
    return dir ? { offscreen: true, from, dir, bounds } : null;
  }

  /** resolve(id), or which way the target lies when it is off screen (sky and field objects only). */
  function locate(id) {
    const on = resolve(id);
    if (on) return on;
    try {
      if (typeof id !== 'string' || !(id.startsWith('sky:') || id.startsWith('field:'))) return null;
      const s = getState();
      if (id.startsWith('field:') && s.view !== 'field') return null;
      const at = skyPosition(id);
      if (!at || !at.every(Number.isFinite)) return null;
      return s.view === 'field' ? offscreenInField(at) : offscreenInSky(at);
    } catch (err) {
      console.warn('[guide] locate failed', id, err);
      return null;
    }
  }

  function targetAt(x, y, pad = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    try {
      return pickTarget(list(), x, y, pad);
    } catch (err) {
      console.warn('[guide] targetAt failed', err);
      return null;
    }
  }

  lookUpPresets();
  return { resolve, locate, targetAt, list, learnFlyTo };
}
