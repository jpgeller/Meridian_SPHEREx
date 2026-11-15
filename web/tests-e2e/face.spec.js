// Face-tracking panel (UI plan U8): demo by default, recorded `face` messages drive it live,
// silence goes back to the demo, buttons are real gaze-sized buttons that run commands.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/face-sample.json', import.meta.url)));

async function ready(page) {
  await page.waitForFunction(() => window.meridian?.face && document.querySelector('#controls'));
}

test('face panel: simulated by default, live from recorded messages, back to simulated after silence', async ({ page }) => {
  const errors = [];
  // Aladin's usage logger (tg.log) may fail to fetch; that error is harmless (see smoke.spec.js)
  page.on('pageerror', (e) => !/Failed to fetch|tg\.log/.test(String(e)) && errors.push(String(e)));
  await page.goto('/');
  await ready(page);
  const panel = page.locator('[data-guide="face-panel"]');
  await expect(panel).toBeVisible();
  // folded by default in the side panel; open it
  await expect(panel.locator('#face-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => meridian.run('toggle_face_panel', { open: true }));
  await expect(panel.locator('#face-mode')).toHaveText('Simulated');
  await expect(panel).toContainText('Video stays on this computer.');
  // the guide's registry (U2) now finds the panel
  const r = await page.evaluate(() => guide.resolve('face-panel'));
  expect(r?.rect?.w).toBeGreaterThan(200);
  await expect(panel.locator('#face-phase')).toContainText('Simulated');
  // the demo animates: the readouts change over time
  const pose1 = await panel.locator('#face-pose').textContent();
  await expect.poll(() => panel.locator('#face-pose').textContent(), { timeout: 8000 }).not.toBe(pose1);

  // replay through the real postMessage bridge
  const n = await page.evaluate((s) => meridian.face.replay(s.frames, { fps: 40 }), SAMPLE);
  expect(n).toBe(SAMPLE.frames.length);
  await expect(panel.locator('#face-mode')).toHaveText('Live');
  const snap = await page.evaluate(() => meridian.face.snapshot());
  expect(snap.mode).toBe('live');
  expect(snap.frames).toBe(SAMPLE.frames.length);
  expect(snap.computed).toEqual({ ear: true, mar: true, pose: true }); // the last frames carry landmarks only
  await expect(panel.locator('#face-phase')).toContainText('Tracker');

  // blink and mouth flags light up for matching frames
  const lm = SAMPLE.frames[13].landmarks; // a blink frame
  await page.evaluate((landmarks) => window.postMessage({ type: 'face', landmarks }, location.origin), lm);
  await expect(panel.locator('#face-blink')).toHaveClass(/on/);
  await page.evaluate((landmarks) => window.postMessage({ type: 'face', landmarks }, location.origin), SAMPLE.frames[28].landmarks);
  await expect(panel.locator('#face-open')).toHaveClass(/on/);
  await expect(panel.locator('#face-blink')).not.toHaveClass(/on/);

  // an invalid message is ignored and does not throw
  await page.evaluate(() => window.postMessage({ type: 'face', landmarks: [[1, 2]] }, location.origin));

  // silence (> 2 s) -> simulated again
  await expect(panel.locator('#face-mode')).toHaveText('Simulated', { timeout: 5000 });
  expect(errors).toEqual([]);
});

test('face panel: gaze dot, forced demo and collapse are commands behind 64 px buttons', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const panel = page.locator('[data-guide="face-panel"]');
  const sizes = await panel.locator('button').evaluateAll((bs) => bs.map((b) => b.offsetHeight));
  expect(sizes.length).toBe(2);
  for (const h of sizes) expect(h).toBeGreaterThanOrEqual(64);
  await page.evaluate(() => meridian.run('toggle_face_panel', { open: true })); // folded by default

  // gaze from the tracker (U9 will call this)
  await page.evaluate(() => {
    window.__gaze = setInterval(() => meridian.face.setGaze({ x: innerWidth * 0.75, y: innerHeight * 0.25, confidence: 0.9 }), 100);
  });
  await expect(panel.locator('#face-gaze-text')).toHaveText('live');
  const g = await page.evaluate(() => meridian.face.snapshot().gaze);
  expect(g.source).toBe('tracker');
  expect(g.x).toBeCloseTo(0.75, 2);
  await page.evaluate(() => {
    clearInterval(window.__gaze);
    meridian.face.setGaze(null);
  });
  await expect(panel.locator('#face-gaze-text')).not.toHaveText('live');

  // forced demo wins over a live tracker
  await page.evaluate((s) => meridian.face.replay(s.frames.slice(0, 5), { fps: 50 }), SAMPLE);
  await expect(panel.locator('#face-mode')).toHaveText('Live');
  await panel.getByRole('button', { name: 'Demo' }).click();
  await expect(panel.getByRole('button', { name: 'Demo' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('#face-mode')).toHaveText('Simulated');
  await page.evaluate(() => meridian.run('toggle_face_demo', { on: false }));
  await expect(panel.getByRole('button', { name: 'Demo' })).toHaveAttribute('aria-pressed', 'false');

  // collapse: the body hides and the animation loop stops; expand: it runs again
  await panel.getByRole('button', { name: /Face tracking/ }).click();
  await expect(panel.locator('#face-canvas')).toBeHidden();
  await expect(panel.locator('#face-toggle')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => meridian.face.snapshot().running)).toBe(false);
  await page.evaluate(() => meridian.run('toggle_face_panel', { open: true }));
  await expect(panel.locator('#face-canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => meridian.face.snapshot().running)).toBe(true);
});
