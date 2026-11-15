// Face-tracking panel (ui/faceCore.js): EAR/MAR, pose estimate, message validation, mesh fitting,
// the demo loop, live vs demo with fake time, and the bridge's `face` message. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  N_LANDMARKS,
  EAR_BLINK,
  MAR_OPEN,
  LIVE_TIMEOUT_MS,
  MESH,
  partOf,
  eyeAspect,
  earOf,
  marOf,
  estimatePose,
  parseFace,
  faceFlags,
  fitBox,
  templatePoints,
  posedLandmarks,
  demoFrame,
  DEMO_SCRIPT,
  DEMO_PERIOD_MS,
  createFaceFeed,
} from '../src/ui/faceCore.js';
import { startMessages } from '../src/core/messages.js';

test('mesh covers the 68 dlib points once, in the right parts', () => {
  const seen = new Set();
  for (const [a, b] of MESH) for (let i = a; i <= b; i++) seen.add(i);
  assert.equal(seen.size, N_LANDMARKS);
  assert.equal(partOf(0), 'jaw');
  assert.equal(partOf(16), 'jaw');
  assert.equal(partOf(17), 'brow');
  assert.equal(partOf(30), 'nose');
  assert.equal(partOf(36), 'eye');
  assert.equal(partOf(47), 'eye');
  assert.equal(partOf(48), 'mouth');
  assert.equal(partOf(67), 'mouth');
  assert.equal(templatePoints().length, N_LANDMARKS);
});

test('EAR: open eye about 0.3, closed eye below the blink line; degenerate eye is 0', () => {
  const eye = (h) => [
    [0, 0],
    [1, -h / 2],
    [2, -h / 2],
    [3, 0],
    [2, h / 2],
    [1, h / 2],
  ];
  assert.ok(Math.abs(eyeAspect(eye(0.9)) - 0.3) < 1e-9);
  assert.ok(eyeAspect(eye(0.2)) < EAR_BLINK);
  assert.equal(eyeAspect([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]), 0);
  const open = earOf(posedLandmarks());
  const shut = earOf(posedLandmarks({ blinkL: 1, blinkR: 1 }));
  const wink = earOf(posedLandmarks({ blinkL: 1 }));
  assert.ok(open.every((v) => v > 0.25 && v < 0.4), `open ${open}`);
  assert.ok(shut.every((v) => v < EAR_BLINK), `shut ${shut}`);
  assert.ok(wink[0] < EAR_BLINK && wink[1] > EAR_BLINK, 'blinkL closes points 36-41 (ear[0])');
});

test('MAR (inner lips): closed near 0, open above 0.30', () => {
  assert.ok(marOf(posedLandmarks()) < 0.1);
  assert.ok(marOf(posedLandmarks({ mouth: 1 })) > MAR_OPEN);
});

test('estimatePose recovers yaw / pitch / roll of the template within a few degrees', () => {
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
  const p0 = estimatePose(posedLandmarks());
  near(p0.yaw, 0, 1, 'yaw 0');
  near(p0.pitch, 0, 1, 'pitch 0');
  near(p0.roll, 0, 0.5, 'roll 0');
  near(estimatePose(posedLandmarks({ yaw: 24 })).yaw, 24, 3, 'yaw +24');
  near(estimatePose(posedLandmarks({ yaw: -24 })).yaw, -24, 3, 'yaw -24');
  near(estimatePose(posedLandmarks({ pitch: 15 })).pitch, 15, 3, 'pitch +15');
  near(estimatePose(posedLandmarks({ roll: 16 })).roll, 16, 0.5, 'roll +16');
  // scale and position in the frame do not matter
  near(estimatePose(posedLandmarks({ yaw: 20, size: 40, cx: 10, cy: 900 })).yaw, 20, 3, 'small face');
});

test('parseFace: rejects bad shapes, accepts [x,y] or {x,y}, fills missing ear/mar/pose', () => {
  assert.equal(parseFace(null).ok, false);
  assert.equal(parseFace({}).ok, false);
  assert.equal(parseFace({ landmarks: [[0, 0]] }).ok, false);
  const lm = posedLandmarks({ mouth: 1 });
  const bad = lm.slice();
  bad[5] = [1, 'x'];
  assert.match(parseFace({ landmarks: bad }).error, /landmark/);
  bad[5] = [1, NaN];
  assert.equal(parseFace({ landmarks: bad }).ok, false);

  const bare = parseFace({ landmarks: lm });
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.face.computed, { ear: true, mar: true, pose: true });
  assert.ok(bare.face.mar > MAR_OPEN);
  assert.equal(bare.face.confidence, 1);

  const objs = parseFace({ landmarks: lm.map(([x, y]) => ({ x, y })), confidence: 7 });
  assert.equal(objs.ok, true);
  assert.deepEqual(objs.face.landmarks, lm);
  assert.equal(objs.face.confidence, 1, 'clamped');

  const full = parseFace({ landmarks: lm, ear: [0.1, 0.12], mar: 0.05, pose: { yaw: 5, pitch: -3, roll: 2 }, confidence: 0.4 });
  assert.deepEqual(full.face.ear, [0.1, 0.12]);
  assert.equal(full.face.mar, 0.05, "the tracker's values win over the landmarks");
  assert.deepEqual(full.face.pose, { yaw: 5, pitch: -3, roll: 2 });
  assert.deepEqual(full.face.computed, { ear: false, mar: false, pose: false });
  // half-valid fields are recomputed, not trusted
  const half = parseFace({ landmarks: lm, ear: [0.2], mar: '0.4', pose: { yaw: 1 } });
  assert.deepEqual(half.face.computed, { ear: true, mar: true, pose: true });
});

test('faceFlags: blink needs both eyes, one eye is a wink; mouth open above 0.30', () => {
  const f = (ear, mar) => faceFlags({ ear, mar });
  assert.deepEqual(f([0.1, 0.1], 0.5), { blink: true, wink: false, mouthOpen: true });
  assert.deepEqual(f([0.1, 0.3], 0.3), { blink: false, wink: true, mouthOpen: false });
  assert.deepEqual(f([0.3, 0.3], 0.1), { blink: false, wink: false, mouthOpen: false });
});

test('fitBox: any units fit inside the canvas, centred, aspect kept', () => {
  const pts = [
    [1000, 2000],
    [1400, 2000],
    [1200, 2200],
  ];
  const { points, scale } = fitBox(pts, 100, 100, 10);
  for (const [x, y] of points) assert.ok(x >= 10 - 1e-9 && x <= 90 + 1e-9 && y >= 10 - 1e-9 && y <= 90 + 1e-9);
  assert.equal(scale, 80 / 400);
  assert.deepEqual(points[0], [10, 30]); // 400 x 200 box -> 80 x 40, centred vertically
  assert.deepEqual(points[1], [90, 30]);
  // normalised 0..1 input gives the same picture
  const norm = fitBox(pts.map(([x, y]) => [x / 2000, y / 2000]), 100, 100, 10).points;
  norm.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(v - points[i][k]) < 1e-9)));
  // one point does not divide by zero
  assert.ok(fitBox([[5, 5]], 50, 50).points[0].every(Number.isFinite));
});

test('demoFrame: loops through every phase, blinks, opens the mouth, turns the head', () => {
  const seen = new Map();
  for (let t = 0; t < DEMO_PERIOD_MS; t += 50) {
    const d = demoFrame(t);
    assert.equal(d.face.landmarks.length, N_LANDMARKS);
    const flags = faceFlags(d.face);
    const s = seen.get(d.phase) ?? { blink: false, open: false, maxYaw: 0, minYaw: 0, maxRoll: 0, maxPitch: 0 };
    s.blink ||= flags.blink;
    s.open ||= flags.mouthOpen;
    s.maxYaw = Math.max(s.maxYaw, d.face.pose.yaw);
    s.minYaw = Math.min(s.minYaw, d.face.pose.yaw);
    s.maxRoll = Math.max(s.maxRoll, d.face.pose.roll);
    s.maxPitch = Math.max(s.maxPitch, Math.abs(d.face.pose.pitch));
    seen.set(d.phase, s);
  }
  assert.deepEqual([...seen.keys()], DEMO_SCRIPT.map(([l]) => l));
  assert.ok(seen.get('Blink').blink);
  assert.ok(seen.get('Mouth open').open);
  assert.ok(seen.get('Looking left').minYaw < -15);
  assert.ok(seen.get('Looking right').maxYaw > 15);
  assert.ok(seen.get('Head tilt').maxRoll > 10);
  assert.ok(seen.get('Head down').maxPitch > 10);
  assert.ok(!seen.get('Looking ahead').blink && !seen.get('Looking ahead').open);
  // looping and negative times
  assert.deepEqual(demoFrame(1234).face.landmarks, demoFrame(1234 + 3 * DEMO_PERIOD_MS).face.landmarks);
  assert.equal(demoFrame(-1).phase, DEMO_SCRIPT.at(-1)[0]);
  // gaze follows the look
  const leftStart = DEMO_SCRIPT[0][1] * 1000;
  assert.ok(demoFrame(leftStart + 1000).gaze.x < 0.3);
});

test('demoFrame reduced motion: the peak pose is held for the whole phase (no in-between frames)', () => {
  const blinkStart = DEMO_SCRIPT.slice(0, 3).reduce((s, [, sec]) => s + sec * 1000, 0);
  for (const dt of [10, 500, 990]) assert.ok(faceFlags(demoFrame(blinkStart + dt, { reduced: true }).face).blink, `blink at +${dt}`);
  const leftStart = DEMO_SCRIPT[0][1] * 1000;
  assert.equal(demoFrame(leftStart + 20, { reduced: true }).face.pose.yaw, demoFrame(leftStart + 1900, { reduced: true }).face.pose.yaw);
  assert.notEqual(demoFrame(leftStart + 20).face.pose.yaw, demoFrame(leftStart + 1000).face.pose.yaw, 'smooth without it');
});

test('createFaceFeed: demo until a valid face arrives, live for 2 s, demo again; forced demo; gaze dot', () => {
  let now = 0;
  const feed = createFaceFeed({ now: () => now });
  assert.equal(feed.mode(), 'demo');
  assert.equal(feed.push({ landmarks: [] }).ok, false);
  assert.equal(feed.mode(), 'demo', 'invalid messages do not switch to live');
  assert.equal(feed.push({ landmarks: posedLandmarks() }).ok, true);
  assert.equal(feed.mode(), 'live');
  assert.equal(feed.count(), 1);
  now = LIVE_TIMEOUT_MS - 1;
  assert.equal(feed.mode(), 'live');
  now = LIVE_TIMEOUT_MS;
  assert.equal(feed.mode(), 'demo', 'silence -> demo');
  feed.push({ landmarks: posedLandmarks() });
  assert.equal(feed.mode(), 'live');
  feed.forceDemo(true);
  assert.equal(feed.mode(), 'demo');
  feed.forceDemo(false);
  assert.equal(feed.mode(), 'live');

  assert.equal(feed.gazeDot(1000, 500), null, 'no gaze yet');
  feed.setGaze({ x: 250, y: 400, confidence: 0.9 });
  assert.deepEqual(feed.gazeDot(1000, 500), { x: 0.25, y: 0.8 });
  feed.setGaze({ x: 5000, y: -3 });
  assert.deepEqual(feed.gazeDot(1000, 500), { x: 1, y: 0 }, 'clamped to the screen');
  now += 501;
  assert.equal(feed.gazeDot(1000, 500), null, 'stale');
  feed.setGaze({ x: 1, y: 1, confidence: 0.2 });
  assert.equal(feed.gazeDot(1000, 500), null, 'unsure');
  feed.setGaze(null);
  assert.equal(feed.gazeDot(1000, 500), null);
});

test('replay fixture: every frame is valid, with and without ear/mar, a blink and an open mouth', () => {
  const { frames } = JSON.parse(readFileSync(new URL('../tests-e2e/fixtures/face-sample.json', import.meta.url)));
  assert.ok(frames.length >= 20);
  const parsed = frames.map((f) => parseFace(f));
  assert.ok(parsed.every((r) => r.ok));
  assert.ok(parsed.some((r) => r.face.computed.ear) && parsed.some((r) => !r.face.computed.ear));
  assert.ok(parsed.some((r) => faceFlags(r.face).blink));
  assert.ok(parsed.some((r) => faceFlags(r.face).mouthOpen));
});

test('bridge: `face` from an allowed origin becomes the `meridian:face` event; others are ignored', () => {
  const target = new EventTarget();
  target.location = { origin: 'http://localhost:5173' };
  const got = [];
  target.addEventListener('meridian:face', (e) => got.push(e.detail));
  const commands = { run: () => ({ ok: true }), list: () => [] };
  const stop = startMessages(commands, { target });
  const send = (origin, data) => target.dispatchEvent(Object.assign(new Event('message'), { origin, data }));
  const msg = { type: 'face', landmarks: posedLandmarks() };
  send('http://localhost:5173', msg);
  send('http://127.0.0.1:9000', msg);
  const warn = console.warn;
  console.warn = () => {};
  send('https://evil.example', msg);
  console.warn = warn;
  assert.equal(got.length, 2);
  assert.equal(got[0], msg);
  stop();
  send('http://localhost:5173', msg);
  assert.equal(got.length, 2);
});
