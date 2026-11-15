// Face-tracking panel (UI plan U8): the pure part. No DOM, no CSS, so node:test can import it.
//   - the 68-point dlib layout and the lines of its mesh
//   - EAR (eye aspect ratio), MAR (mouth aspect ratio), a rough head pose from landmarks
//   - parseFace(msg): validates a `face` message from the tracker, fills in what is missing
//   - fitBox(): fits any landmark coordinates (camera pixels, 0..1, ...) into the canvas
//   - a neutral face template and demoFrame(t): the scripted "Simulated" loop
//   - createFaceFeed(): live vs demo, with fake time for tests
//
// Landmark convention (dlib 68): jaw 0-16, brows 17-21 / 22-26, nose bridge 27-30, nostrils 31-35,
// eyes 36-41 / 42-47, outer lips 48-59, inner lips 60-67. Points are [x, y] with y pointing DOWN
// (image rows), in any unit: the panel only draws the face's shape, fitted by its bounding box.
// `ear: [l, r]`: l = points 36-41 (the eye on the image's left), r = points 42-47.

export const N_LANDMARKS = 68;
export const EAR_BLINK = 0.16; // eye counts as closed below this
export const MAR_OPEN = 0.3; // mouth counts as open above this (inner lips)
export const LIVE_TIMEOUT_MS = 2000; // no tracker message for this long -> back to the demo
export const GAZE_STALE_MS = 500; // a gaze sample older than this counts as no gaze (as in U6)
export const GAZE_MIN_CONFIDENCE = 0.5;

/** Mesh lines: [first, last, closed, part]. */
export const MESH = [
  [0, 16, false, 'jaw'],
  [17, 21, false, 'brow'],
  [22, 26, false, 'brow'],
  [27, 30, false, 'nose'],
  [31, 35, false, 'nose'],
  [36, 41, true, 'eye'],
  [42, 47, true, 'eye'],
  [48, 59, true, 'mouth'],
  [60, 67, true, 'mouth'],
];

/** Which part a landmark index belongs to (for colouring the dots). */
export function partOf(i) {
  for (const [a, b, , part] of MESH) if (i >= a && i <= b) return part;
  return null;
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** EAR of one eye from its six points p1..p6: (|p2-p6| + |p3-p5|) / (2 |p1-p4|). */
export function eyeAspect(p) {
  const w = dist(p[0], p[3]);
  return w > 0 ? (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * w) : 0;
}

/** [l, r] EAR from 68 landmarks. */
export function earOf(lm) {
  return [eyeAspect(lm.slice(36, 42)), eyeAspect(lm.slice(42, 48))];
}

/** MAR from the inner lips: (|61-67| + |62-66| + |63-65|) / (2 |60-64|). About 0 closed, 0.5+ wide open. */
export function marOf(lm) {
  const w = dist(lm[60], lm[64]);
  return w > 0 ? (dist(lm[61], lm[67]) + dist(lm[62], lm[66]) + dist(lm[63], lm[65])) / (2 * w) : 0;
}

/**
 * A rough head pose (degrees) from 2D landmarks, used only when the tracker sends none.
 * roll = angle of the line between the eye centres; yaw = how far the nose tip sits off the middle
 * of the eyes, relative to the eye spacing; pitch = how far the nose tip sits from its usual height
 * between the eyes and the mouth. Signs: yaw > 0 = nose towards the image's right, pitch > 0 = nose
 * down, roll > 0 = clockwise on screen. Good to ~10°; a tracker with a 3D model does better.
 */
export function estimatePose(lm) {
  const mean = (a, b) => {
    let x = 0;
    let y = 0;
    for (let i = a; i <= b; i++) {
      x += lm[i][0];
      y += lm[i][1];
    }
    const n = b - a + 1;
    return [x / n, y / n];
  };
  const eL = mean(36, 41);
  const eR = mean(42, 47);
  const mouth = [(lm[48][0] + lm[54][0]) / 2, (lm[48][1] + lm[54][1]) / 2]; // corners: still when the mouth opens
  const nose = lm[30];
  const dx = eR[0] - eL[0];
  const dy = eR[1] - eL[1];
  const eyeDist = Math.hypot(dx, dy) || 1;
  const roll = (Math.atan2(dy, dx) * 180) / Math.PI;
  // undo the roll, then measure the nose in the face's own axes
  const c = Math.cos((-roll * Math.PI) / 180);
  const s = Math.sin((-roll * Math.PI) / 180);
  const rot = (p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  const [ex, ey] = rot([(eL[0] + eR[0]) / 2, (eL[1] + eR[1]) / 2]);
  const [nx, ny] = rot(nose);
  const [, my] = rot(mouth);
  const yaw = (Math.asin(Math.max(-1, Math.min(1, ((nx - ex) / eyeDist) * 1.4))) * 180) / Math.PI;
  const span = my - ey || 1;
  const pitch = ((((ny - ey) / span - PITCH_REST) * 180) / Math.PI) * 1.7;
  return { yaw: round(yaw, 1), pitch: round(pitch, 1), roll: round(roll, 1) };
}

// nose tip height between the eyes (0) and the mouth corners (1) of a level face
const PITCH_REST = 0.48;

function readPoint(p) {
  if (Array.isArray(p) && finite(p[0]) && finite(p[1])) return [p[0], p[1]];
  if (p && typeof p === 'object' && finite(p.x) && finite(p.y)) return [p.x, p.y];
  return null;
}

/**
 * Validate a `face` message. Returns { ok: true, face } or { ok: false, error }.
 * face = { landmarks, ear: [l, r], mar, pose: {yaw, pitch, roll}, confidence, computed: {ear, mar, pose} }
 * Landmarks may be [x, y] pairs or {x, y} objects. ear / mar / pose are computed from the landmarks
 * when missing or not numbers (`computed` says which); confidence defaults to 1, clamped to 0..1.
 */
export function parseFace(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'not an object' };
  if (!Array.isArray(msg.landmarks) || msg.landmarks.length !== N_LANDMARKS)
    return { ok: false, error: `landmarks must be ${N_LANDMARKS} points` };
  const landmarks = msg.landmarks.map(readPoint);
  if (landmarks.some((p) => !p)) return { ok: false, error: 'every landmark must be [x, y] numbers' };
  const computed = { ear: false, mar: false, pose: false };
  let ear = msg.ear;
  if (!(Array.isArray(ear) && ear.length === 2 && ear.every(finite))) {
    ear = earOf(landmarks);
    computed.ear = true;
  } else ear = [ear[0], ear[1]];
  let mar = msg.mar;
  if (!finite(mar)) {
    mar = marOf(landmarks);
    computed.mar = true;
  }
  let pose = msg.pose;
  if (!(pose && finite(pose.yaw) && finite(pose.pitch) && finite(pose.roll))) {
    pose = estimatePose(landmarks);
    computed.pose = true;
  } else pose = { yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll };
  const confidence = finite(msg.confidence) ? Math.max(0, Math.min(1, msg.confidence)) : 1;
  return { ok: true, face: { landmarks, ear, mar, pose, confidence, computed } };
}

/** Readout flags. Blink = both eyes below EAR_BLINK (one eye = a wink, reported separately). */
export function faceFlags(face) {
  const [l, r] = face.ear;
  const closedL = l < EAR_BLINK;
  const closedR = r < EAR_BLINK;
  return { blink: closedL && closedR, wink: closedL !== closedR, mouthOpen: face.mar > MAR_OPEN };
}

/**
 * Fit points into a w x h box with `pad` px around, keeping the aspect ratio and centring.
 * Returns { points, scale, ox, oy } (screen = p * scale + [ox, oy]). Works for any input units.
 */
export function fitBox(points, w, h, pad = 8) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const bw = x1 - x0 || 1;
  const bh = y1 - y0 || 1;
  const scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  const ox = (w - bw * scale) / 2 - x0 * scale;
  const oy = (h - bh * scale) / 2 - y0 * scale;
  return { points: points.map(([x, y]) => [x * scale + ox, y * scale + oy]), scale, ox, oy };
}

// --- neutral face template (unit space, y down, z towards the camera) ----------------------

function eyePoints(cx, cy, w, h) {
  // dlib order for both eyes: left corner, two top points, right corner, two bottom points (back)
  return [
    [cx - w / 2, cy],
    [cx - w / 6, cy - h / 2],
    [cx + w / 6, cy - h / 2],
    [cx + w / 2, cy],
    [cx + w / 6, cy + h / 2],
    [cx - w / 6, cy + h / 2],
  ];
}

/**
 * A face's 68 3D points for given expression parameters (unit space, about -1..1).
 * blinkL / blinkR / mouth: 0 (open eye / closed mouth) to 1 (closed eye / wide open mouth).
 */
export function templatePoints({ blinkL = 0, blinkR = 0, mouth = 0 } = {}) {
  const pts = [];
  const drop = 0.22 * mouth; // the chin goes down when the mouth opens
  // jaw 0-16: from the left temple round the chin to the right temple
  for (let i = 0; i <= 16; i++) {
    const t = (i / 16) * Math.PI;
    const s = Math.sin(t);
    const x = -0.92 * Math.cos(t) * (1 - 0.12 * s * s);
    const y = -0.2 + 1.18 * Math.pow(s, 0.85) + drop * s * s;
    pts.push([x, y, 0.35 - 0.55 * Math.abs(Math.cos(t))]);
  }
  // brows 17-21, 22-26
  // dlib: 17 (outer) -> 21 (inner) on the image's left, 22 (inner) -> 26 (outer) on its right
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const u = side < 0 ? i / 4 : 1 - i / 4; // 0 = outer end, 1 = inner end
      pts.push([side * (0.78 - 0.6 * u), -0.56 - 0.1 * Math.sin(u * Math.PI * 0.9 + 0.2), 0.35]);
    }
  }
  // nose bridge 27-30 (30 = tip), nostrils 31-35
  for (let i = 0; i < 4; i++) pts.push([0, -0.4 + 0.17 * i, 0.45 + 0.13 * i]);
  for (let i = 0; i < 5; i++) {
    const x = -0.2 + 0.1 * i;
    pts.push([x, 0.22 + 0.04 * (1 - Math.abs(x) / 0.2), 0.62 - 0.6 * Math.abs(x)]);
  }
  // eyes 36-41, 42-47
  const eh = 0.105;
  for (const [cx, blink] of [
    [-0.42, blinkL],
    [0.42, blinkR],
  ])
    for (const [x, y] of eyePoints(cx, -0.3, 0.32, eh * (1 - 0.93 * blink))) pts.push([x, y, 0.3]);
  // outer lips 48-59: left corner, top lip to the right corner (54), bottom lip back
  const my = 0.55;
  const mw = 0.31;
  const open = 0.2 * mouth;
  const top = [0, -0.06, -0.09, -0.07, -0.09, -0.06, 0];
  for (let i = 0; i <= 6; i++) pts.push([-mw + (2 * mw * i) / 6, my + top[i] - open * 0.15 * Math.sin((i / 6) * Math.PI), 0.4]);
  for (let i = 1; i <= 5; i++) {
    const u = 1 - i / 6;
    pts.push([-mw + 2 * mw * u, my + 0.1 * Math.sin(u * Math.PI) + open * Math.sin(u * Math.PI) * 1.1, 0.38]);
  }
  // inner lips 60-67: left corner, three top, right corner (64), three bottom back
  const iw = 0.22;
  for (let i = 0; i <= 4; i++) pts.push([-iw + (2 * iw * i) / 4, my - open * 0.2 * Math.sin((i / 4) * Math.PI), 0.4]);
  for (let i = 3; i >= 1; i--) pts.push([-iw + (2 * iw * i) / 4, my + open * 1.05 * Math.sin((i / 4) * Math.PI) + 0.005, 0.4]);
  return pts;
}

/**
 * 2D landmarks of a posed face, like a tracker would send: rotate by yaw / pitch / roll (degrees),
 * project (orthographic) and place in a `size`-pixel frame centred at (cx, cy).
 */
export function posedLandmarks({ yaw = 0, pitch = 0, roll = 0, blinkL = 0, blinkR = 0, mouth = 0, size = 160, cx = 320, cy = 240 } = {}) {
  const r = Math.PI / 180;
  const [cyw, syw] = [Math.cos(yaw * r), Math.sin(yaw * r)];
  const [cp, sp] = [Math.cos(pitch * r), Math.sin(pitch * r)];
  const [cr, sr] = [Math.cos(roll * r), Math.sin(roll * r)];
  return templatePoints({ blinkL, blinkR, mouth }).map(([x, y, z]) => {
    // yaw about the vertical axis: nose (z > 0) moves towards +x for yaw > 0
    const x1 = x * cyw + z * syw;
    const z1 = -x * syw + z * cyw;
    // pitch about the horizontal axis: nose moves down (+y) for pitch > 0
    const y2 = y * cp + z1 * sp;
    // roll in the image plane, clockwise on screen for roll > 0
    const x3 = x1 * cr - y2 * sr;
    const y3 = x1 * sr + y2 * cr;
    return [round(cx + x3 * size, 2), round(cy + y3 * size, 2)];
  });
}

// --- the scripted demo loop -----------------------------------------------------------------

/** Phases of the "Simulated" loop: [label, seconds, peak parameters]. */
export const DEMO_SCRIPT = [
  ['Looking ahead', 1.5, {}],
  ['Looking left', 2, { yaw: -24, gaze: [0.15, 0.5] }],
  ['Looking right', 2, { yaw: 24, gaze: [0.85, 0.5] }],
  ['Blink', 1, { blinkL: 1, blinkR: 1 }],
  ['Mouth open', 2, { mouth: 1 }],
  ['Head up', 1.5, { pitch: -16, gaze: [0.5, 0.2] }],
  ['Head down', 1.5, { pitch: 16, gaze: [0.5, 0.8] }],
  ['Head tilt', 2, { roll: 16 }],
];
export const DEMO_PERIOD_MS = DEMO_SCRIPT.reduce((s, [, sec]) => s + sec * 1000, 0);

const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));

/**
 * The demo face at time `tMs` (looping): { face (as parseFace gives), phase, gaze: {x, y} in 0..1 }.
 * Smooth: each phase rises to its peak and falls back (a blink is a quick close-open).
 * reduced (prefers-reduced-motion): the peak is held for the whole phase, no in-between poses.
 */
export function demoFrame(tMs, { reduced = false } = {}) {
  let t = ((tMs % DEMO_PERIOD_MS) + DEMO_PERIOD_MS) % DEMO_PERIOD_MS;
  let phase = DEMO_SCRIPT[0];
  let u = 0;
  for (const p of DEMO_SCRIPT) {
    const len = p[1] * 1000;
    if (t < len) {
      phase = p;
      u = t / len;
      break;
    }
    t -= len;
  }
  const [label, , peak] = phase;
  // rise over the first 35 %, hold, fall over the last 35 % (Blink: two quick close-opens of 0.3 s)
  let k = reduced ? 1 : label === 'Blink' ? (u % 0.5 < 0.3 ? Math.sin(((u % 0.5) / 0.3) * Math.PI) : 0) : ease(u / 0.35) * ease((1 - u) / 0.35);
  if (reduced && label === 'Blink') k = 1;
  const p = {};
  for (const key of ['yaw', 'pitch', 'roll', 'blinkL', 'blinkR', 'mouth']) p[key] = (peak[key] ?? 0) * k;
  const g = peak.gaze ?? [0.5, 0.5];
  const gaze = { x: 0.5 + (g[0] - 0.5) * k, y: 0.5 + (g[1] - 0.5) * k };
  const landmarks = posedLandmarks(p);
  const { face } = parseFace({ landmarks, pose: { yaw: round(p.yaw, 1), pitch: round(p.pitch, 1), roll: round(p.roll, 1) }, confidence: 1 });
  return { face, phase: label, gaze };
}

// --- live vs demo -----------------------------------------------------------------------------

/**
 * Keeps the latest tracker face and decides what the panel shows.
 * mode(): 'live' while a valid face arrived in the last `timeoutMs` and demo is not forced, else 'demo'.
 */
export function createFaceFeed({ now = () => Date.now(), timeoutMs = LIVE_TIMEOUT_MS } = {}) {
  let last = null;
  let lastAt = -Infinity;
  let forced = false;
  let count = 0;
  let gaze = null;
  return {
    /** Feed a raw message; returns parseFace's result. Invalid messages change nothing. */
    push(msg) {
      const r = parseFace(msg);
      if (r.ok) {
        last = r.face;
        lastAt = now();
        count++;
      }
      return r;
    },
    mode: () => (!forced && last && now() - lastAt < timeoutMs ? 'live' : 'demo'),
    latest: () => last,
    lastAt: () => lastAt,
    count: () => count,
    forceDemo(on) {
      forced = Boolean(on);
    },
    isForced: () => forced,
    /** Gaze from the tracker (U9): viewport pixels. null clears it. */
    setGaze(g) {
      gaze = g && finite(g.x) && finite(g.y) ? { x: g.x, y: g.y, confidence: finite(g.confidence) ? g.confidence : 1, at: now() } : null;
      return gaze;
    },
    /** The gaze dot in 0..1 of the viewport, or null ("no gaze": none, stale or unsure). */
    gazeDot(viewW, viewH) {
      if (!gaze || now() - gaze.at > GAZE_STALE_MS || gaze.confidence < GAZE_MIN_CONFIDENCE || !(viewW > 0 && viewH > 0)) return null;
      return { x: Math.max(0, Math.min(1, gaze.x / viewW)), y: Math.max(0, Math.min(1, gaze.y / viewH)) };
    },
  };
}

/** Short text for the readouts. */
export const fmt = {
  ear: (v) => v.toFixed(2),
  mar: (v) => v.toFixed(2),
  deg: (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))}°`,
};
