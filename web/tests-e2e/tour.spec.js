// The guided tour (tutorial/tour.js): the welcome offer on opening the page, and the tour itself, where a
// drawn cursor shows each control in mouse mode. Automated browsers are never offered it unless ?tour=1.
// The 2D part needs the API and the warmed cache for Barnard's Star.
import { test, expect } from '@playwright/test';

const ready = (page) => page.waitForFunction(() => window.meridian?.tour && window.guide && document.querySelector('#controls'));
const step = (page) => page.evaluate(() => meridian.tour.step());
const card = (page) => page.locator('.tour-step');

// a gaze-pressable button: 64 px (or the page's --hit) and not within 6 % of the screen edges
async function gazeFriendly(page, sel) {
  const bad = await page.evaluate((sel) => {
    const hit = parseFloat(getComputedStyle(document.body).getPropertyValue('--hit')) || 64;
    const w = innerWidth;
    const h = innerHeight;
    return [...document.querySelectorAll(sel)]
      .filter((b) => b.checkVisibility())
      .map((b) => [b.textContent.trim(), b.getBoundingClientRect()])
      .filter(([, r]) => r.width < hit - 0.5 || r.height < hit - 0.5 || r.left < w * 0.06 || r.top < h * 0.06 || r.right > w * 0.94 || r.bottom > h * 0.94)
      .map(([t]) => t);
  }, sel);
  expect(bad).toEqual([]);
}

test('tour: offered on opening with ?tour=1 (never otherwise in tests); "No thanks" hides it and remembers', async ({ page }) => {
  await page.goto('/?fov=60');
  await ready(page);
  await page.waitForTimeout(1200);
  await expect(page.locator('.tour-welcome')).toBeHidden(); // automated browser: not offered

  await page.goto('/?fov=60&tour=1');
  await ready(page);
  const welcome = page.locator('.tour-welcome');
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText('Welcome to Meridian');
  await gazeFriendly(page, '.tour-welcome button');
  await welcome.getByRole('button', { name: 'No thanks' }).click();
  await expect(welcome).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('meridian.tour'))).toBe('skipped');
});

test('tour: key H starts it in mouse mode; the cursor rings each control; the person taking over pauses it; Esc ends it', async ({ page }) => {
  await page.goto('/?fov=60&input=gaze');
  await ready(page);
  await page.keyboard.press('h');
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText('1 / 20');
  await expect.poll(() => page.evaluate(() => meridian.store.get().input)).toBe('mouse'); // the tour is the eye-control-off version
  expect(await page.evaluate(() => guide.isHeld())).toBe(true); // no guide offers during the tour
  await expect(page.locator('.tour-cursor')).toBeVisible();
  await gazeFriendly(page, '.tour-step button');

  await card(page).getByRole('button', { name: 'Next' }).click();
  await expect(card(page)).toContainText('2 / 20');
  await expect(card(page)).toContainText('Controls');
  // the cursor glides to the Controls button and the ring goes round it
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = document.querySelector('#panel-toggle').getBoundingClientRect();
        const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.querySelector('.tour-cursor').style.transform);
        const [x, y] = [Number(m[1]) + 3, Number(m[2]) + 3];
        const ring = document.querySelector('.tour-ring').getBoundingClientRect();
        return x > r.left && x < r.right && y > r.top && y < r.bottom && ring.left < r.left && ring.right > r.right;
      }),
    )
    .toBe(true);
  // the card never covers the control it is about
  const covers = await page.evaluate(() => {
    const a = document.querySelector('.tour-step').getBoundingClientRect();
    const b = document.querySelector('#panel-toggle').getBoundingClientRect();
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  });
  expect(covers).toBe(false);

  await page.keyboard.press(']'); // the person does something themselves
  await expect(card(page)).toContainText('Paused');
  await card(page).getByRole('button', { name: 'Continue' }).click();
  await expect(card(page)).not.toContainText('Paused');

  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
  await expect(page.locator('.tour-cursor')).toBeHidden();
  expect(await page.evaluate(() => [meridian.tour.running(), guide.isHeld(), meridian.store.get().view])).toEqual([false, false, 'sky']);
});

test('tour: it flies to Barnard\'s Star, opens the time-lapse, and Back from the 2D view returns to the sky', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/?fov=60');
  await ready(page);
  await page.evaluate(() => meridian.run('start_tour'));
  const next = card(page).getByRole('button', { name: 'Next' });
  // step 4 (Places) presses Barnard's Star itself
  for (let i = 0; i < 3; i++) await next.click();
  await expect(card(page)).toContainText('4 / 20');
  await expect.poll(() => page.evaluate(() => meridian.store.get().fov), { timeout: 20000 }).toBeLessThan(5);
  // on to "Open the time-lapse" (12): the cursor presses it
  const open = await page.evaluate(() => meridian.tour.steps.findIndex((s) => s.id === 'open'));
  while ((await step(page)) < open) await next.click();
  await expect.poll(() => page.evaluate(() => meridian.store.get().view), { timeout: 20000 }).toBe('field');
  await expect.poll(() => step(page), { timeout: 60000 }).toBe(open + 1); // the frames came, the tour moved on
  await card(page).getByRole('button', { name: 'Back' }).click();
  await expect.poll(() => page.evaluate(() => meridian.store.get().view), { timeout: 20000 }).toBe('sky');
  await expect.poll(() => step(page)).toBe(open);
  await card(page).getByRole('button', { name: 'Stop' }).click();
  await expect(card(page)).toBeHidden();
});
