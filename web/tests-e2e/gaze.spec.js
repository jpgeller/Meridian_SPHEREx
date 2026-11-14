// Eye-tracking path, end to end: gaze samples arrive by window.postMessage exactly as the
// tracker will send them; the app must press buttons on dwell, ignore glances, pan at sky
// edges, pause in the rest zone, and tell the tracker where its targets are.
import { test, expect } from '@playwright/test';

async function setup(page, url = '/') {
  await page.goto(url);
  await page.waitForFunction(() => window.meridian?.gaze && document.querySelector('#controls'));
  // Helpers inside the page: send samples at 30 Hz like a tracker.
  await page.evaluate(() => {
    window.__targets = [];
    addEventListener('message', (e) => {
      if (e.data?.type === 'targets') window.__targets.push(e.data.items);
    });
    window.__gaze = async (x, y, ms) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        postMessage({ type: 'gaze', x, y, confidence: 1, t: performance.now() }, location.origin);
        await new Promise((r) => setTimeout(r, 33));
      }
    };
    window.__centre = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
  });
}

const pos = (page) => page.evaluate(() => [meridian.store.get().ra, meridian.store.get().dec]);

test('a glance does nothing; a dwell presses the button', async ({ page }) => {
  await setup(page);
  const start = await pos(page);
  await page.evaluate(async () => {
    await __gaze(...__centre('[data-preset="barnard"]'), 300);
    await __gaze(640, 400, 200);
  });
  expect(await pos(page)).toEqual(start);
  await page.evaluate(async () => {
    await __gaze(...__centre('[data-preset="rw_aur"]'), 1100);
  });
  await expect.poll(async () => (await pos(page))[0], { timeout: 15_000 }).toBeCloseTo(76.96, 1);
});

test('the app tells the tracker where its targets are', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => __gaze(640, 400, 300));
  const items = await page.evaluate(() => __targets.at(-1));
  expect(items.length).toBeGreaterThan(8);
  const wise = items.find((t) => t.label === 'WISE 0855');
  expect(wise).toBeTruthy();
  expect(wise.w).toBeGreaterThan(20);
});

test('looking at a sky edge pans; looking at the panel edge does not', async ({ page }) => {
  await setup(page, '/?ra=100&dec=0&fov=10');
  const before = await pos(page);
  await page.evaluate(() => __gaze(1265, 450, 2000)); // right edge, over the sky
  const after = await pos(page);
  expect(after[0]).toBeLessThan(before[0]); // pan right = towards smaller RA
  const panelLeft = await page.evaluate(() => {
    const r = document.querySelector('#controls').getBoundingClientRect();
    return [r.left + 20, r.top + 30]; // inside the panel, within the left edge band
  });
  await page.evaluate(([x, y]) => __gaze(x, y, 2000), panelLeft);
  expect(await pos(page)).toEqual(after);
});

test('rest zone pauses gaze and resumes it', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => __gaze(1240, 40, 1300)); // top-right rest zone
  await expect(page.locator('#gaze-rest-text')).toContainText('paused');
  const start = await pos(page);
  await page.evaluate(async () => {
    await __gaze(...__centre('[data-preset="r_dra"]'), 1500);
  });
  await page.waitForTimeout(1500);
  expect(await pos(page)).toEqual(start); // nothing happened while paused
  await page.evaluate(async () => {
    await __gaze(640, 400, 200);
    await __gaze(1240, 40, 1300);
  });
  await expect(page.locator('#gaze-rest-text')).not.toContainText('paused');
});

test('dwell time can be changed by command', async ({ page }) => {
  await setup(page);
  expect(await page.evaluate(() => meridian.run('set_dwell', { ms: 500 }).value)).toBe(500);
  expect(await page.evaluate(() => meridian.run('set_dwell', { ms: 99 }).value)).toBe(400);
});
