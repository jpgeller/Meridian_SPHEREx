// The AI guide as in wireframe v4: the pill and the card top right, the pointer that flies, circles and
// presses real buttons, and tours that drive the site (fly, open the time-lapse, play, trail, bands).
// API must be running (the time-lapse tour uses the warmed cache for Barnard's Star).
import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.waitForFunction(() => window.meridian && document.querySelector('#controls') && window.guide);
}
// the guide endpoint without the model: "use your local script"
const mockGuideApi = (page) => page.route('**/api/guide', (r) => r.fulfill({ json: { steps: [], fallback: true, reason: 'test' } }));
const card = (page) => page.locator('[data-guide="guide-popup"]');
const next = (page) => card(page).locator('.gp-answers button[data-answer="next"]');
const tipOf = (page) =>
  page.evaluate(() => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.querySelector('#guide-overlay .go-pointer').style.transform);
    return { x: Number(m[1]), y: Number(m[2]) };
  });
// commands the guide ran, with their source
const recordCommands = (page) =>
  page.evaluate(() => {
    window.__seen = [];
    addEventListener('meridian:command', (e) => e.detail.ok && __seen.push([e.detail.name, e.detail.source]));
  });

test('Something moving: the guide flies to Barnard\'s Star, opens the time-lapse, plays it, draws the trail, ends with its choices', async ({ page }) => {
  await page.goto('/?fov=60');
  await ready(page);
  await mockGuideApi(page);
  await recordCommands(page);
  await page.locator('[data-guide="guide-pill"]').click();
  await card(page).getByRole('button', { name: 'Something moving' }).click();
  // 1 / 5: it flies there (go_preset, as the guide)
  await expect(card(page)).toContainText("First I will take you to Barnard's Star");
  await expect(card(page).locator('.gp-step')).toHaveText('1 / 5');
  await expect.poll(() => page.evaluate(() => meridian.store.get().fov)).toBeLessThan(3); // zoomed to the sharp limit (about 2.3° at 1280 px)
  await next(page).click();
  // 2 / 5: it presses "Open time-lapse here" itself
  await expect(card(page)).toContainText('open its real pictures');
  await expect.poll(() => page.evaluate(() => meridian.store.get().view), { timeout: 20000 }).toBe('field');
  await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60000 });
  await next(page).click();
  // 3 / 5: the first picture
  await expect(card(page)).toContainText('This is the first picture');
  await expect.poll(() => page.evaluate(() => meridian.store.get().frameIndex)).toBe(0);
  await next(page).click();
  // 4 / 5: it presses Play; the target is circled
  await expect(card(page)).toContainText('watch the circled');
  await expect.poll(() => page.evaluate(() => meridian.store.get().playing)).toBe(true);
  expect(await page.evaluate(() => guide.overlay.active())).toContain('circle:field:target');
  await next(page).click();
  // 5 / 5: the change video, with the honest caveat; the last step carries the end choices itself (B2):
  // no Next, no separate "Is that clear?" card
  await expect(card(page)).toContainText('change video');
  await expect(card(page).locator('.gp-sub')).toContainText('hint, not proof');
  await expect.poll(() => page.evaluate(() => meridian.store.get().op)).toBe('video');
  await expect(card(page).locator('.gp-answers button')).toHaveText(['Got it', 'Show me again', 'Back to sky']);
  await expect(card(page)).not.toContainText('Is that clear?');
  // everything above went through the real buttons and commands, reported as the guide's
  const seen = await page.evaluate(() => __seen);
  for (const name of ['go_preset', 'open_field', 'set_frame', 'toggle_play', 'set_show']) {
    expect(seen.find(([n]) => n === name), name).toBeTruthy();
  }
  expect(seen.filter(([n]) => n !== 'open_guide').every(([, src]) => ['guide', 'preset'].includes(src))).toBe(true);
  await card(page).getByRole('button', { name: 'Back to sky' }).click();
  await expect.poll(() => page.evaluate(() => meridian.store.get().view)).toBe('sky');
  await expect(card(page)).toBeHidden();
  await expect(page.locator('[data-guide="guide-pill"]')).toBeVisible();
});

test('colours tour: the pointer presses D1, then D6; the band changes through the buttons', async ({ page }) => {
  await page.goto('/?fov=60&band=40');
  await ready(page);
  await page.keyboard.press('a');
  await card(page).getByRole('button', { name: 'What the colours mean' }).click();
  await expect(card(page)).toContainText('102 bands');
  await expect(card(page).locator('.gp-step')).toHaveText('1 / 4');
  await next(page).click();
  await expect(card(page).locator('.gp-title')).toHaveText('D1');
  await expect.poll(() => page.evaluate(() => meridian.store.get().band)).toBe(8);
  // the pointer is on D1 (above the button, pointing down at it)
  const d1 = await page.evaluate(() => guide.resolve('band-d1'));
  const t1 = await tipOf(page);
  expect(Math.abs(t1.x - d1.x)).toBeLessThan(d1.rect.w / 2 + 2);
  await next(page).click();
  await expect(card(page).locator('.gp-title')).toHaveText('D6');
  await expect.poll(() => page.evaluate(() => meridian.store.get().band)).toBe(93);
  await next(page).click();
  // 4 / 4: the last step shows the end choices itself (B2); the colours flow never offers itself again (B1)
  await expect(card(page)).toContainText('display choice');
  await expect(card(page).locator('.gp-answers button')).toHaveText(['Got it', 'Show me an example']);
  await expect(card(page)).not.toContainText('Is that clear?');
  await card(page).getByRole('button', { name: 'Got it' }).click();
  await expect(card(page)).toBeHidden();
});

test('a click on a sky object asks the guide: name, kind, then facts with "Want to see how it moves?"', async ({ page }) => {
  await page.goto('/?ra=269.45&dec=4.74&fov=3');
  await ready(page);
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard')), { timeout: 15000 }).not.toBeNull();
  await page.waitForTimeout(800);
  const star = await page.evaluate(() => guide.resolve('sky:barnard'));
  await page.mouse.click(star.x, star.y);
  await expect(card(page).locator('.gp-title')).toHaveText("Barnard's Star");
  await expect(card(page).locator('.gp-sub')).toHaveText('Red dwarf star');
  // the pointer lands beside the star, and the star is circled
  await page.waitForTimeout(700);
  const tip = await tipOf(page);
  expect(Math.hypot(tip.x - star.x, tip.y - star.y)).toBeLessThan(60);
  expect(await page.evaluate(() => guide.overlay.active().sort())).toEqual(['circle:sky:barnard', 'pointer']);
  await next(page).click();
  // 2 / 2: the facts; the last step asks the end question in its sub line and shows its answers (B2)
  await expect(card(page).locator('.gp-facts')).toContainText('5.96 light-years');
  await expect(card(page).locator('.gp-sub')).toHaveText('Want to see how it moves?');
  await expect(card(page).locator('.gp-answers button')).toHaveText(['Show me', 'Got it']);
  // Esc ends it; the pointer flies home beside the pill
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => guide.overlay.active())).toEqual([]);
});

test('Stop or Esc in the middle of a step ends the tour at once', async ({ page }) => {
  await page.goto('/?fov=60');
  await ready(page);
  await page.evaluate(() => {
    window.__how = null;
    guide.tour('motion', 'barnard').then((h) => (window.__how = h));
  });
  await expect(card(page)).toContainText('First I will take you');
  await card(page).getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => page.evaluate(() => window.__how)).toBe('closed');
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(false);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => meridian.store.get().view)).toBe('sky'); // it did not go on to open the time-lapse
});

test('click step: the pointer flies to D6 and presses it; the band changes through the button, the script goes on', async ({ page }) => {
  await page.goto('/?band=20');
  await ready(page);
  await recordCommands(page);
  await page.evaluate(() => {
    window.__how = guide.run([{ say: 'D6 holds the longest wavelengths.', actions: [{ click: 'band-d6' }] }]);
  });
  await expect(page.locator('#guide-overlay .go-pointer')).not.toHaveClass(/is-hidden/);
  await expect.poll(() => page.evaluate(() => meridian.store.get().band)).toBe(93);
  expect(await page.evaluate(() => __seen)).toEqual([['set_band', 'guide']]);
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(true);
  await card(page).getByRole('button', { name: 'Got it' }).click();
  expect(await page.evaluate(() => __how)).toBe('done');
});

test('click step: gaze ids work (preset:barnard); a hidden or non-button target is refused', async ({ page }) => {
  await page.goto('/?band=20&fov=60');
  await ready(page);
  await page.evaluate(() => void guide.run([{ say: 'Hi.', actions: [{ click: 'presets' }, { click: 'time-player' }] }]));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => meridian.store.get().band)).toBe(20);
  expect(await page.evaluate(() => guide.overlay.active())).toEqual([]);
  await page.evaluate(() => void guide.run([{ say: 'Barnard.', actions: [{ click: 'preset:barnard' }] }]));
  await expect.poll(() => page.evaluate(() => meridian.store.get().fov), { timeout: 15000 }).toBeLessThan(3);
});

test('status line: "Showing Barnard\'s Star", without the resolver\'s NAME prefix', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.evaluate(() => meridian.run('fly_to', { target: "Barnard's Star" }, 'test').value);
  await expect(page.locator('#status')).toContainText("Showing Barnard's Star");
  await expect(page.locator('#status')).not.toContainText('NAME');
});

test('no text box or history anywhere in the guide', async ({ page }) => {
  await page.goto('/?fov=60');
  await ready(page);
  await page.keyboard.press('a');
  expect(await card(page).locator('input, textarea, [contenteditable]').count()).toBe(0);
});
