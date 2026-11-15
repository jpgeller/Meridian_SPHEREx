// Writes face-sample.json: 40 recorded-like `face` messages (camera pixels, 640x480 frame) for
// face.spec.js and meridian.face.replay(). Turn right, blink, open the mouth. The first half sends
// ear/mar/pose like a tracker would; the second half sends landmarks only (the panel computes them).
//   node tests-e2e/fixtures/make-face-sample.mjs
import { writeFileSync } from 'node:fs';
import { posedLandmarks, earOf, marOf } from '../../src/ui/faceCore.js';

const frames = [];
for (let i = 0; i < 40; i++) {
  const u = i / 39;
  const p = {
    yaw: 30 * Math.sin(u * Math.PI),
    roll: -6 * Math.sin(u * Math.PI),
    blinkL: i >= 12 && i <= 14 ? 1 : 0,
    blinkR: i >= 12 && i <= 14 ? 1 : 0,
    mouth: i >= 24 && i <= 32 ? 1 : 0,
    size: 130,
    cx: 300 + 10 * Math.sin(u * 6),
    cy: 250,
  };
  const landmarks = posedLandmarks(p);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  frames.push(
    i < 20
      ? { landmarks, ear: earOf(landmarks).map(r3), mar: r3(marOf(landmarks)), pose: { yaw: r3(p.yaw), pitch: 0, roll: r3(p.roll) }, confidence: 0.93 }
      : { landmarks, confidence: 0.9 },
  );
}
writeFileSync(new URL('./face-sample.json', import.meta.url), JSON.stringify({ fps: 15, frames }) + '\n');
console.log(`wrote ${frames.length} frames`);
