// Guide overlay (UI plan, U3): the guide's pointer, circles, highlights and trails, drawn over the
// sky and the field view. Nothing here takes a click: the layer is pointer-events: none, so mouse
// clicks and gaze presses go straight through to the app.
//
//   pointAt(id, label?)   the guide's arrow cursor flies from the pop-up card to the target (~600 ms,
//                         ease-out), then idles with a small pulse. One pointer: a new pointAt moves it.
//   circle(id)            a ring drawn around the target
//   highlight(id)         a soft glow on the target (a box for controls, a disc for sky objects)
//   trail(idFrom, idTo)   a dashed arrow from one target to another
//   clear()               everything fades out
//
// Each call returns a handle { remove() }. Every frame each annotation follows registry.locate(id):
// it moves with the sky, fades out when the target is hidden or covered, and when the target is known
// but off screen the pointer (or a small chevron) waits at the screen edge, aimed at it.
// Annotations clear on their own when the person runs any command (the guide's own do not count),
// and when the runner (U5) calls clear() at the end of a step. prefers-reduced-motion: no flight, no pulse.

export const FLY_MS = 600;
export const GLIDE_MS = 250; // on screen <-> edge
export const EDGE_MARGIN = 36;
const FADE_MS = 220;
const ARROW_REST = Math.atan2(-1, -1); // the cursor shape points up-left
const ARROW_LEN = 30; // px from the tip to the far end of the arrow
// commands whose source does not mean "the person did something"
export const QUIET_SOURCES = new Set(['guide', 'preset']); // 'preset' = the fly_to inside go_preset

// --- pure helpers (unit-tested) --------------------------------------------------------

export const easeOutCubic = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** A point along a gently curved flight from `a` to `b`, t in [0, 1] (already eased). */
export function flyPoint(a, b, t) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // control point: 15% of the distance off to one side (an arc, not a straight slide)
  const cx = mx - dy * 0.15;
  const cy = my + dx * 0.15;
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
}

/**
 * Where the arrow's tip goes for a registry answer, and which way it points (radians, y down).
 * Sky objects: up-left like a cursor, the tip on the rim so the arrow does not hide the object.
 * Controls: the tip on the top edge pointing down, the arrow above the box (on the bottom edge,
 * pointing up, for controls near the top of the screen), so the button's text stays readable.
 * Mirrored near the right edge (and, for sky objects, the bottom) so the arrow stays on screen.
 */
export function aimFor(target, viewport) {
  if (!target) return null;
  if (target.rect) {
    const { y, h } = target.rect;
    const inset = Math.min(8, h / 4);
    const down = y > ARROW_LEN + 40;
    const sx = target.x + ARROW_LEN + 8 > viewport.w ? 1 : -1;
    return { tip: { x: target.x, y: down ? y + inset : y + h - inset }, angle: Math.atan2(down ? 1 : -1, sx) };
  }
  const k = (target.r ?? 0) * 0.7;
  const sx = target.x + k + ARROW_LEN + 8 > viewport.w ? 1 : -1;
  const sy = target.y + k + ARROW_LEN + 16 > viewport.h ? 1 : -1;
  const angle = Math.atan2(sy, sx);
  return { tip: { x: target.x - Math.cos(angle) * k, y: target.y - Math.sin(angle) * k }, angle };
}

/** The ring (or box) drawn around a target by circle() and highlight(). */
export function ringFor(target, pad = 10) {
  if (!target) return null;
  if (target.rect) {
    const { x, y, w, h } = target.rect;
    return { rect: { x: x - pad / 2, y: y - pad / 2, w: w + pad, h: h + pad } };
  }
  return { x: target.x, y: target.y, r: (target.r ?? 16) + pad };
}

/**
 * Off-screen target: the point where the ray from `from` along `dir` meets `bounds` shrunk by
 * `margin`. `from` outside the shrunk box is clamped into it first. -> {x, y} | null
 */
export function edgePoint(from, dir, bounds, margin = EDGE_MARGIN) {
  if (!from || !dir || !bounds) return null;
  const x0 = bounds.x + margin;
  const x1 = bounds.x + bounds.w - margin;
  const y0 = bounds.y + margin;
  const y1 = bounds.y + bounds.h - margin;
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const fx = clamp(from.x, x0, x1);
  const fy = clamp(from.y, y0, y1);
  let t = Infinity;
  if (dir.x > 0) t = Math.min(t, (x1 - fx) / dir.x);
  if (dir.x < 0) t = Math.min(t, (x0 - fx) / dir.x);
  if (dir.y > 0) t = Math.min(t, (y1 - fy) / dir.y);
  if (dir.y < 0) t = Math.min(t, (y0 - fy) / dir.y);
  if (!Number.isFinite(t)) return null;
  return { x: fx + dir.x * t, y: fy + dir.y * t };
}

/** How much of `rect` lies outside `bounds`, as a fraction of its area. */
function overflow(rect, bounds) {
  const ix = Math.max(0, Math.min(rect.x + rect.w, bounds.x + bounds.w) - Math.max(rect.x, bounds.x));
  const iy = Math.max(0, Math.min(rect.y + rect.h, bounds.y + bounds.h) - Math.max(rect.y, bounds.y));
  return 1 - (ix * iy) / (rect.w * rect.h || 1);
}

/** Does `rect` touch a shape: a circle {x, y, r} or a box {rect}? */
export function hits(rect, shape) {
  if (!shape) return false;
  if (shape.rect) {
    const b = shape.rect;
    return rect.x < b.x + b.w && rect.x + rect.w > b.x && rect.y < b.y + b.h && rect.y + rect.h > b.y;
  }
  const dx = Math.max(rect.x - shape.x, 0, shape.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - shape.y, 0, shape.y - (rect.y + rect.h));
  return Math.hypot(dx, dy) < (shape.r ?? 0);
}

/**
 * Place the pointer's label: try eight spots around the tip, starting on the side away from where
 * the arrow points (behind its body), and take the first that stays on screen and touches nothing
 * in `avoid` (the target, the arrow, the dwell ring). Otherwise the least bad one.
 * -> { x, y } top-left of the label.
 */
export function placeLabel(tip, angle, size, viewport, avoid = []) {
  const { w, h } = size;
  const back = angle + Math.PI;
  const order = [0, 1, -1, 2, -2, 3, -3, 4].map((k) => back + (k * Math.PI) / 4);
  const bounds = { x: 4, y: 4, w: viewport.w - 8, h: viewport.h - 8 };
  let best = null;
  order.forEach((a, i) => {
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const d = ARROW_LEN + 10 + Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
    const rect = { x: tip.x + ux * d - w / 2, y: tip.y + uy * d - h / 2, w, h };
    const score = overflow(rect, bounds) * 10 + avoid.filter((s) => hits(rect, s)).length * 3 + i * 0.01;
    if (!best || score < best.score) best = { score, x: rect.x, y: rect.y };
  });
  return { x: best.x, y: best.y };
}

/** A gently curved path from a to b (SVG d), bowing to the left of the direction of travel. */
export function trailPath(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const cx = mx + (b.y - a.y) * 0.2;
  const cy = my - (b.x - a.x) * 0.2;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

/** A point at distance `d` short of a target's edge, on the line from `from` (trail ends). */
function shortOf(target, from, d) {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const r = target.rect ? Math.min(target.rect.w, target.rect.h) / 2 : target.r ?? 0;
  const k = Math.max(0, len - r - d) / len;
  return { x: from.x + dx * k, y: from.y + dy * k };
}

// --- the overlay -----------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';
const ARROW_PATH = 'M0,0 L0,26 L6.5,19.5 L11,29.5 L15.5,27.5 L11,18 L19.5,18 Z'; // tip at 0,0, drawn pointing up-left

/**
 * @param {Object}   o
 * @param {Function} o.locate            registry.locate(id)
 * @param {Document} [o.doc]
 * @param {EventTarget} [o.events]       where `meridian:command` arrives
 * @param {Function} [o.getOrigin]       () -> {x, y}: where the pointer starts (the pop-up card)
 */
export function createOverlay({ locate, doc = document, events = window, getOrigin } = {}) {
  const win = doc.defaultView;
  const viewport = () => ({ w: win.innerWidth, h: win.innerHeight });
  const reduced = () => !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // the pop-up card (U4), wherever it has moved to; null when hidden
  const cardBox = () => {
    const card = doc.querySelector('[data-guide="guide-popup"]');
    const b = card && !card.closest('[hidden]') ? card.getBoundingClientRect() : null;
    return b && b.width > 0 ? b : null;
  };
  const origin =
    getOrigin ??
    (() => {
      const b = cardBox();
      return b ? { x: b.left + b.width / 2, y: b.bottom } : { x: win.innerWidth - 180, y: 96 };
    });

  const root = doc.createElement('div');
  root.id = 'guide-overlay';
  root.setAttribute('aria-hidden', 'true'); // the pop-up (U4) carries the words for screen readers
  const svg = doc.createElementNS(SVG, 'svg');
  svg.classList.add('go-svg');
  svg.innerHTML =
    '<defs><marker id="go-arrowhead" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" /></marker></defs>';
  root.append(svg);
  doc.body.append(root);

  let avoidFn = () => [];
  const items = new Map(); // key -> annotation
  let frame = 0;

  // ---- helpers ----
  const svgEl = (tag, cls) => {
    const el = doc.createElementNS(SVG, tag);
    if (cls) el.setAttribute('class', cls);
    svg.append(el);
    return el;
  };
  const show = (el, on) => el.classList.toggle('is-hidden', !on);

  /** A small chevron at the screen edge, aimed at an off-screen target (circle, highlight). */
  function edgeMarker() {
    const el = svgEl('path', 'go-edge is-hidden');
    el.setAttribute('d', 'M-9,-11 L9,0 L-9,11 L-4,0 Z');
    return {
      el,
      update(at) {
        const p = at?.offscreen ? edgePoint(at.from, at.dir, at.bounds) : null;
        show(el, !!p);
        if (p) el.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)}) rotate(${((Math.atan2(at.dir.y, at.dir.x) * 180) / Math.PI).toFixed(1)})`);
      },
    };
  }

  // ---- annotations: each has update(now) and els (removed on clear) ----

  function makeRing(id, kind) {
    const edge = edgeMarker();
    let shape = null; // svg circle or rect, swapped when the target changes kind
    return {
      els: [edge.el],
      update() {
        const at = locate(id);
        edge.update(at);
        const ring = at && !at.offscreen ? ringFor(at, kind === 'circle' ? 14 : 8) : null;
        const want = ring?.rect ? 'rect' : 'circle';
        if (ring && shape?.tagName !== want) {
          shape?.remove();
          shape = svgEl(want, `go-${kind}`);
          shape.setAttribute('pathLength', '100');
          this.els.push(shape);
        }
        if (!shape) return;
        show(shape, !!ring);
        if (!ring) return;
        if (ring.rect) {
          const { x, y, w, h } = ring.rect;
          shape.setAttribute('x', x.toFixed(1));
          shape.setAttribute('y', y.toFixed(1));
          shape.setAttribute('width', w.toFixed(1));
          shape.setAttribute('height', h.toFixed(1));
          shape.setAttribute('rx', '12');
        } else {
          shape.setAttribute('cx', ring.x.toFixed(1));
          shape.setAttribute('cy', ring.y.toFixed(1));
          shape.setAttribute('r', ring.r.toFixed(1));
        }
      },
    };
  }

  function makeTrail(a, b) {
    const path = svgEl('path', 'go-trail');
    path.setAttribute('marker-end', 'url(#go-arrowhead)');
    return {
      els: [path],
      update() {
        const pa = locate(a);
        const pb = locate(b);
        const ok = pa && pb && !pa.offscreen && !pb.offscreen;
        show(path, !!ok);
        if (ok) path.setAttribute('d', trailPath(shortOf(pa, pb, 6), shortOf(pb, pa, 10)));
      },
    };
  }

  function makePointer() {
    const el = doc.createElement('div');
    el.className = 'go-pointer is-hidden';
    el.innerHTML = `<svg viewBox="-4 -4 28 38" width="28" height="38" aria-hidden="true"><path d="${ARROW_PATH}" /></svg>`;
    const label = doc.createElement('div');
    label.className = 'go-label is-hidden';
    root.append(el, label);

    const p = {
      els: [el, label],
      id: null,
      pos: null, // where the tip is now
      flight: null, // { from, start }
      glide: null, // { from, start }
      offscreen: false,
      labelSize: null,
      aim(id, text) {
        const fresh = !p.pos || el.classList.contains('is-hidden');
        p.id = id;
        label.textContent = text ?? '';
        p.labelSize = null;
        const start = fresh ? origin() : p.pos;
        p.flight = reduced() ? null : { from: start, start: performance.now() };
        p.glide = null;
        if (!p.flight) p.pos = null; // jump
      },
      update(now) {
        const at = locate(p.id);
        const vp = viewport();
        let want = null;
        let angle = ARROW_REST;
        const off = !!at?.offscreen;
        if (at && !off) {
          ({ tip: want, angle } = aimFor(at, vp));
        } else if (off) {
          want = edgePoint(at.from, at.dir, at.bounds);
          angle = Math.atan2(at.dir.y, at.dir.x);
        }
        if (!want) {
          show(el, false);
          show(label, false);
          p.flight = null; // a target that vanishes mid-flight: reappear in place, no flight
          return;
        }
        if (off !== p.offscreen && p.pos && !p.flight && !reduced()) p.glide = { from: p.pos, start: now };
        p.offscreen = off;

        let pos = want;
        if (p.flight) {
          const t = (now - p.flight.start) / FLY_MS;
          if (t >= 1) p.flight = null;
          else pos = flyPoint(p.flight.from, want, easeOutCubic(t));
        } else if (p.glide) {
          const t = (now - p.glide.start) / GLIDE_MS;
          if (t >= 1) p.glide = null;
          else {
            const k = easeOutCubic(t);
            pos = { x: p.glide.from.x + (want.x - p.glide.from.x) * k, y: p.glide.from.y + (want.y - p.glide.from.y) * k };
          }
        }
        p.pos = pos;
        const deg = ((angle - ARROW_REST) * 180) / Math.PI;
        el.style.transform = `translate(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px) rotate(${deg.toFixed(1)}deg)`;
        el.classList.toggle('is-flying', !!p.flight);
        el.classList.toggle('is-edge', off);
        show(el, true);

        const hasText = !!label.textContent;
        show(label, hasText && !p.flight);
        if (!hasText || p.flight) return;
        if (!p.labelSize) {
          const b = label.getBoundingClientRect();
          p.labelSize = { w: b.width || 120, h: b.height || 28 };
        }
        const avoid = [...(at && !off ? [ringFor(at, 6)] : []), { x: pos.x + Math.cos(angle + Math.PI) * 16, y: pos.y + Math.sin(angle + Math.PI) * 16, r: 20 }];
        const cb = cardBox(); // the card sits above the overlay: a label under it is unreadable
        if (cb) avoid.push({ rect: { x: cb.left, y: cb.top, w: cb.width, h: cb.height } });
        try {
          avoid.push(...(avoidFn() ?? []));
        } catch {
          /* a broken avoid hook must not stop the pointer */
        }
        const lp = placeLabel(pos, angle, p.labelSize, vp, avoid);
        label.style.transform = `translate(${lp.x.toFixed(1)}px, ${lp.y.toFixed(1)}px)`;
      },
    };
    return p;
  }

  // ---- the frame loop: runs only while something is shown ----
  function tick(now) {
    frame = 0;
    for (const it of items.values()) {
      try {
        it.update(now);
      } catch (err) {
        console.warn('[guide] overlay update failed', err);
      }
    }
    if (items.size) frame = win.requestAnimationFrame(tick);
  }
  function wake() {
    if (!frame) frame = win.requestAnimationFrame(tick);
  }

  function add(key, make) {
    drop(key, false);
    const it = make();
    items.set(key, it);
    it.update(performance.now());
    wake();
    return handle(key, it);
  }

  function handle(key, it) {
    return { remove: () => items.get(key) === it && drop(key) };
  }

  function drop(key, fade = true) {
    const it = items.get(key);
    if (!it) return;
    items.delete(key);
    if (!fade) return it.els.forEach((e) => e.remove());
    it.els.forEach((e) => e.classList.add('is-hidden'));
    win.setTimeout(() => it.els.forEach((e) => e.remove()), FADE_MS);
  }

  // ---- public API ----
  function pointAt(id, label) {
    if (typeof id !== 'string' || !id) return null;
    let p = items.get('pointer');
    if (!p) {
      p = makePointer();
      items.set('pointer', p);
    }
    p.aim(id, label);
    p.update(performance.now());
    wake();
    return handle('pointer', p);
  }
  const circle = (id) => (typeof id === 'string' && id ? add(`circle:${id}`, () => makeRing(id, 'circle')) : null);
  const highlight = (id) => (typeof id === 'string' && id ? add(`highlight:${id}`, () => makeRing(id, 'highlight')) : null);
  const trail = (a, b) => (typeof a === 'string' && typeof b === 'string' && a && b ? add(`trail:${a}>${b}`, () => makeTrail(a, b)) : null);
  function clear() {
    [...items.keys()].forEach((k) => drop(k));
  }
  /** Shapes the pointer's label must not cover, e.g. the dwell ring (U6): () => [{x, y, r}]. */
  function setAvoid(fn) {
    avoidFn = typeof fn === 'function' ? fn : () => [];
  }
  const active = () => [...items.keys()];

  // the person did something: the guide's marks belong to a view that is gone
  events?.addEventListener?.('meridian:command', (e) => {
    const d = e.detail;
    if (d?.ok && !QUIET_SOURCES.has(d.source) && items.size) clear();
  });

  return { pointAt, circle, highlight, trail, clear, setAvoid, active, element: root };
}
