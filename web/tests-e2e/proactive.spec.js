// The proactive guide: interests -> one short offer written by Claude (POST /api/guide/nudge, mocked
// here), pointer first, buttons that apply a setup or start a tour; local tutorials for the places.
import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.waitForFunction(() => window.meridian && document.querySelector('#controls') && window.guide?.nudge);
}
const card = (page) => page.locator('[data-guide="guide-popup"]');

const REPLY = {
  title: 'Cold things glow in D6',
  line: 'You are exploring bands. In D6 the coldest dust and brown dwarfs glow; try it with the Ices view.',
  point: 'band-d6',
  options: [
    { label: 'Show D6 with Ices', kind: 'apply', actions: [{ click: 'band-d6' }, { cmd: 'set_color', args: { color: 'ice' } }] },
    { label: 'Tour the colours', kind: 'tour', tour: 'colours' },
  ],
  source: 'claude',
};

/** Mock the nudge endpoint; returns the list of request bodies it received. */
async function mockNudge(page, reply = REPLY) {
  const bodies = [];
  await page.route('**/api/guide/nudge', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: reply });
  });
  return bodies;
}

test('three band changes: the pointer flies to D6, Claude\'s offer shows its buttons, "apply" sets D6 + Ices', async ({ page }) => {
  await page.goto('/?fov=60&band=40&gaze=off');
  await ready(page);
  const bodies = await mockNudge(page);
  for (const d of [1, 3, 5]) await page.locator(`[data-guide="band-d${d}"]`).click();
  await expect(card(page)).toContainText('Cold things glow in D6');
  expect(bodies).toHaveLength(1);
  // what Claude was told: the moment, the profile of what the person did, no gaze, no position
  expect(bodies[0].moment).toBe('bands');
  expect(bodies[0].profile.topics[0]).toBe('bands');
  expect(bodies[0].profile.recent).toHaveLength(3);
  expect(JSON.stringify(bodies[0])).not.toMatch(/confidence|gaze/);
  // the pointer went first and the thing is circled
  expect((await page.evaluate(() => guide.overlay.active())).sort()).toEqual(['circle:band-d6', 'pointer']);
  await expect(card(page).locator('.gp-answers button')).toHaveText(['Show D6 with Ices', 'Tour the colours', 'Not now']);
  await card(page).getByRole('button', { name: 'Show D6 with Ices' }).click();
  await expect.poll(() => page.evaluate(() => [meridian.store.get().band, meridian.store.get().color])).toEqual([93, 'ice']);
  await expect(card(page).locator('.gp-title')).toHaveText('Show D6 with Ices');
  await card(page).getByRole('button', { name: 'Got it' }).click();
  await expect(card(page)).toBeHidden();
  // more band changes right away: no new call (the topic rests, and 45 s between calls)
  for (const d of [2, 4, 6]) await page.locator(`[data-guide="band-d${d}"]`).click();
  await page.waitForTimeout(800);
  expect(bodies).toHaveLength(1);
  await expect(card(page)).toBeHidden();
});

test('"Not now" blocks the topic; with no key on the server the local offer appears instead', async ({ page }) => {
  await page.goto('/?fov=60&band=40&gaze=off');
  await ready(page);
  await page.route('**/api/guide/nudge', (r) => r.fulfill({ json: { steps: [], fallback: true, reason: 'no API key on the server' } }));
  for (const c of ['grey', 'ir', 'dust']) await page.locator(`[data-color="${c}"]`).click();
  await expect(card(page)).toContainText('Colours are a choice'); // the local offer
  await card(page).getByRole('button', { name: 'Not now' }).click();
  await expect(card(page)).toBeHidden();
  expect(await page.evaluate(() => Object.keys(guide.nudge.snapshot().blocked))).toEqual(['colours']);
});

test('a 5 s mouse rest on a 2D control (no ?gaze= needed) brings a Claude offer about that feature', async ({ page }) => {
  await page.goto('/?ra=133.7578&dec=-7.242&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  const bodies = await mockNudge(page, {
    title: 'Follow the motion',
    line: 'The change video slides from WISE 2010 to SPHEREx 2026. Moving objects crawl; still stars stay put.',
    point: 'op-video',
    options: [{ label: 'Play the change video', kind: 'apply', actions: [{ click: 'op-video' }, { click: 'play' }] }],
    source: 'claude',
  });
  await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60000 });
  expect(await page.evaluate(() => guide.attention.source)).toBe('mouse');
  await expect.poll(() => page.evaluate(() => guide.attention.snapshot().quiet), { timeout: 30000 }).toBeNull();
  const b = await page.locator('[data-guide="op-video"]').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(card(page)).toContainText('Follow the motion', { timeout: 9000 });
  expect(bodies[0].moment).toBe('feature:op-video');
  expect(bodies[0].state.view).toBe('field');
  // no dwell ring over a button (it would follow every hover)
  await expect(page.locator('#guide-attention')).not.toHaveClass(/is-on/);
});

test('resting the mouse on Barnard\'s Star keeps the local tutorial (no Claude call)', async ({ page }) => {
  await page.goto('/?ra=269.45&dec=4.74&fov=3');
  await ready(page);
  const bodies = await mockNudge(page);
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard')), { timeout: 15000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => guide.attention.snapshot().quiet), { timeout: 30000 }).toBeNull();
  const s = await page.evaluate(() => guide.resolve('sky:barnard'));
  await page.mouse.move(s.x + 8, s.y + 4);
  await expect(card(page)).toContainText(/fastest-moving star|Notice this object/, { timeout: 9000 });
  await expect(card(page)).toContainText('looking at it for 5 seconds');
  await card(page).getByRole('button', { name: 'Yes, tell me' }).click();
  await expect(card(page).locator('.gp-title')).toHaveText("Barnard's Star");
  expect(bodies).toHaveLength(0);
});

test('"Explain" asks Claude for a short tour about the accepted offer', async ({ page }) => {
  await page.goto('/?fov=60&band=40&gaze=off');
  await ready(page);
  await mockNudge(page, { ...REPLY, options: [{ label: 'Explain the bands', kind: 'explain' }, REPLY.options[1]] });
  let sent = null;
  await page.route('**/api/guide', async (r) => {
    sent = r.request().postDataJSON();
    await r.fulfill({ json: { steps: [{ title: 'D6', say: 'D6 sees the coldest things.', actions: [{ circle: 'band-d6' }] }], source: 'claude' } });
  });
  for (const d of [1, 3, 5]) await page.locator(`[data-guide="band-d${d}"]`).click();
  await card(page).getByRole('button', { name: 'Explain the bands' }).click();
  await expect(card(page)).toContainText('D6 sees the coldest things.');
  expect(sent.trigger).toBe('explore');
  expect(sent.offer).toContain('Cold things glow in D6');
  expect(sent.moment).toBe('bands');
});
