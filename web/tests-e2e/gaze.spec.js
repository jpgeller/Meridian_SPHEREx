// Eye-tracker contract and input modes (UI plan U9), end to end. Gaze samples arrive by
// window.postMessage exactly as the tracker sends them ({ type: 'gaze', x, y, t, confidence }).
//   A (mouse)  : works with no tracker; gaze presses nothing and does not feed the guide
//   B (assist) : a replay of recorded-like samples drives the guide's dwell ring and offer, no presses
//   C (gaze)   : 0.8 s dwell presses buttons: open the time-lapse and answer the guide with eyes only
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SAMPLES = JSON.parse(readFileSync(new URL('./fixtures/gaze-sample.json', import.meta.url), 'utf8'));
const IGNORED = [/AladinLiteLogger|alasky\.unistra\.fr/, /tg\.log/, /net::ERR_NAME_NOT_RESOLVED/, /Failed to fetch/];

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  return () => errors.filter((e) => !IGNORED.some((re) => re.test(e)));
}

async function setup(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.meridian?.gaze && window.guide?.attention && document.querySelector('#controls'));
  // Inside the page: a tracker that posts samples at 30 Hz and records the `targets` replies.
  await page.evaluate(() => {
    window.__targets = [];
    addEventListener('message', (e) => {
      if (e.data?.type === 'targets') window.__targets.push(e.data.items);
    });
    window.__gaze = async (x, y, ms) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        postMessage({ type: 'gaze', x, y, confidence: 0.9, t: performance.now() }, location.origin);
        await new Promise((r) => setTimeout(r, 33));
      }
    };
    window.__centre = (sel, text) => {
      const els = [...document.querySelectorAll(sel)].filter((el) => !text || el.textContent.includes(text));
      const r = els[0].getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
  });
}

const quiet = (page) => expect.poll(() => page.evaluate(() => guide.attention.snapshot().quiet), { timeout: 30000 }).toBeNull();
const card = (page) => page.locator('[data-guide="guide-popup"]');

test('mode A (default): mouse and keyboard work with no tracker; gaze presses nothing, only answers with targets', async ({ page }) => {
  const errors = collectErrors(page);
  await setup(page, '/?fov=60&band=40');
  const btn = page.locator('#input-mode');
  await expect(btn).toBeVisible();
  await expect(btn).toContainText('Off');
  expect(await btn.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(64);
  expect(await page.evaluate(() => meridian.store.get().input)).toBe('mouse');
  // the mouse still runs everything
  await page.getByRole('button', { name: /Detector D6/ }).click();
  await expect(page).toHaveURL(/band=93/);
  await page.getByRole('button', { name: /Detector D3/ }).click();
  await expect(page).toHaveURL(/band=42/); // the middle of D3
  // gaze on D6 for 1.5 s: no press, no guide dwell; but the tracker is told where things are
  await quiet(page);
  await page.evaluate(() => __gaze(...__centre('[data-guide="band-d6"]'), 1500));
  expect(await page.evaluate(() => meridian.store.get().band)).toBe(42);
  expect(await page.evaluate(() => guide.attention.snapshot().dwell)).toBeNull();
  await expect(page.locator('.gaze-dot')).toBeHidden();
  const items = await page.evaluate(() => __targets.at(-1));
  const d6 = items.find((t) => t.id === 'band-d6');
  expect(d6).toMatchObject({ kind: 'button' });
  expect(d6.w).toBeGreaterThan(60);
  expect(items.find((t) => t.id === 'preset:barnard')).toMatchObject({ kind: 'button', label: "Barnard's Star" });
  expect(items.find((t) => t.id === 'guide-pill')).toMatchObject({ kind: 'button', label: 'AI Guide' });
  expect(items.some((t) => t.kind === 'target')).toBe(true); // named things from the registry too
  // replies are throttled: 1.5 s of samples at 30 Hz -> a handful of lists, not 45
  expect(await page.evaluate(() => __targets.length)).toBeLessThanOrEqual(7);
  // the face panel's gaze dot follows gaze in every mode
  const face = await page.evaluate(() => meridian.face?.snapshot?.().gaze ?? null);
  if (face) expect(face.source).toBe('tracker');
  // the button cycles A -> B -> C -> A; the key G does the same
  await btn.click();
  await expect(btn).toContainText('Guide only');
  await expect(page).toHaveURL(/input=assist/);
  await page.keyboard.press('g');
  await expect(btn).toContainText('Full control');
  await expect(page).toHaveURL(/input=gaze/);
  await btn.click();
  await expect(btn).toContainText('Off');
  await expect(page).not.toHaveURL(/input=/);
  expect(await page.evaluate(() => meridian.run('set_input_mode', { mode: 'B' }).value)).toBe('assist');
  expect(errors()).toEqual([]);
});

test('mode B: a replay of recorded-like samples drives the dwell ring and the colours offer, and never presses', async ({ page }) => {
  const errors = collectErrors(page);
  await setup(page, '/?fov=60&band=40&input=assist');
  await quiet(page);
  expect(await page.evaluate(() => guide.attention.source)).toBe('gaze');
  expect(await page.evaluate(() => guide.popup.autoHide())).toBe(false); // offers wait for an answer
  await page.evaluate(() => guide.attention.configure({ ringDelayMs: 300, dwellMs: 3000 }));
  const ring = page.locator('#guide-attention');
  // the fixture fixates where D6 sat in an older layout (~1062, 715): move the saccade and fixation
  // onto D6's centre today, so the test follows the layout instead of pinning it
  const d6 = await page.locator('[data-guide="band-d6"]').boundingBox();
  const dx = d6.x + d6.width / 2 - 1062;
  const dy = d6.y + d6.height / 2 - 715;
  const moved = { ...SAMPLES, samples: SAMPLES.samples.map((p) => (p.x > 700 ? { ...p, x: p.x + dx, y: p.y + dy } : p)) };
  await page.evaluate((data) => {
    window.__replay = meridian.gaze.replay(data);
  }, moved);
  await expect(ring).toHaveClass(/is-on/, { timeout: 4000 });
  await expect(ring).toHaveAttribute('data-target', 'band-d6');
  await expect(page.locator('.gaze-dot')).toBeVisible();
  await expect(card(page)).toContainText('Wondering about these colours?', { timeout: 5000 });
  expect(await page.evaluate(() => meridian.store.get().band)).toBe(40); // looked at D6 for seconds: not pressed
  expect(await page.evaluate(() => window.__replay)).toBe('done');
  // gaze never answers in B: the card stays until the person answers
  await page.waitForTimeout(500);
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: 'Not now' }).click();
  await expect(card(page)).toBeHidden();
  expect(errors()).toEqual([]);
});

test('mode C: a glance does nothing, a 0.8 s look opens the time-lapse, and the guide is answered with eyes only', async ({ page }) => {
  const errors = collectErrors(page);
  await setup(page, '/?ra=133.7578&dec=-7.242&fov=0.5&band=92&mode=detector&ffov=0.1&input=gaze');
  await page.route('**/api/guide', (route) =>
    route.fulfill({ json: { steps: [{ say: 'The ring marks WISE 0855, a cold brown dwarf.', actions: [{ circle: 'field:target' }] }], source: 'claude' } }),
  );
  await expect(page.locator('#open-field')).toBeVisible();
  // a glance at the hand-off button: nothing
  await page.evaluate(() => __gaze(...__centre('#open-field'), 400));
  await page.evaluate(() => __gaze(640, 300, 300));
  expect(await page.evaluate(() => meridian.store.get().view)).toBe('sky');
  // a look: the progress bar fills under it, then it is pressed
  await page.evaluate(() => __gaze(...__centre('#open-field'), 1200));
  await expect.poll(() => page.evaluate(() => meridian.store.get().view)).toBe('field');
  await expect(page.locator('.epoch')).toHaveCount(4, { timeout: 60_000 });
  // the eye-control button stays on screen in the field view
  await expect(page.locator('#input-mode')).toBeVisible();
  await expect(page.locator('#input-mode')).toHaveClass(/is-floating/);
  await quiet(page);
  // a (shortened) look at the target brings the offer; eyes press Yes, then Got it
  await page.evaluate(() => guide.attention.configure({ ringDelayMs: 200, dwellMs: 1500 }));
  const t = await page.evaluate(() => guide.resolve('field:target'));
  await page.evaluate(({ x, y }) => __gaze(x, y, 2200), t);
  await expect(card(page)).toContainText('Want to know what this is?');
  const yes = await page.evaluate(() => __centre('[data-guide="guide-popup"] .gp-answers button', 'Yes'));
  await page.evaluate(([x, y]) => __gaze(x, y, 1200), yes);
  // the time-lapse of WISE 0855: the guide knows the place and tells its own notes
  await expect(card(page).locator('.gp-title')).toHaveText('WISE 0855');
  await expect(card(page)).toContainText('Brown dwarf');
  // still looking where Yes was: whatever button is there now (Next) is not pressed until the eyes leave
  await page.evaluate(([x, y]) => __gaze(x, y, 1500), yes);
  await expect(card(page).locator('.gp-step')).toHaveText('1 / 2');
  await page.evaluate(() => __gaze(640, 300, 300));
  await page.evaluate(() => __gaze(...__centre('[data-guide="guide-popup"] .gp-answers button', 'Stop'), 1200));
  await expect(card(page)).toBeHidden();
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(false);
  // one look at the eye-control button turns eye control off
  await page.evaluate(() => __gaze(...__centre('#input-mode'), 1200));
  await expect.poll(() => page.evaluate(() => meridian.store.get().input)).toBe('mouse');
  expect(errors()).toEqual([]);
});

test('mode C: sky edges pan (panels stay 6% clear of them), a colour button presses and still asks about colours, the rest zone pauses and resumes, dwell time is a command', async ({ page }) => {
  const errors = collectErrors(page);
  await setup(page, '/?ra=100&dec=0&fov=10&input=gaze');
  const pos = () => page.evaluate(() => [meridian.store.get().ra, meridian.store.get().dec]);
  await quiet(page);
  const before = await pos();
  await page.evaluate(() => __gaze(1265, 450, 2000)); // right edge, over the sky (the readout has the bottom right)
  const after = await pos();
  expect(after[0]).toBeLessThan(before[0]); // pan right = towards smaller RA
  // panels are 6% clear of the screen edges, so the edge band is always sky: the left edge pans left
  await page.evaluate(() => __gaze(20, 300, 2000));
  const afterLeft = await pos();
  expect(afterLeft[0]).toBeGreaterThan(after[0]); // pan left = towards larger RA
  // a colour control is a button: pressed at 0.8 s, and the guide's dwell keeps counting -> colours offer
  await page.evaluate(() => guide.attention.configure({ ringDelayMs: 300, dwellMs: 2500 }));
  await page.evaluate(() => __gaze(...__centre('[data-guide="band-d6"]'), 3200));
  expect(await page.evaluate(() => meridian.store.get().band)).toBe(93);
  await expect(card(page)).toContainText('Wondering about these colours?');
  await card(page).getByRole('button', { name: 'Not now' }).click();
  // rest zone: bottom-left corner (the guide card has the top right, Aladin's logo the bottom right)
  await page.evaluate(() => __gaze(30, 790, 1300));
  await expect(page.locator('.gaze-rest')).toContainText('Paused');
  await page.evaluate(() => __gaze(...__centre('[data-preset="r_dra"]'), 1500));
  await page.waitForTimeout(800);
  expect(await pos()).toEqual(afterLeft); // nothing pressed while paused
  await page.evaluate(async () => {
    await __gaze(640, 400, 200);
    await __gaze(30, 790, 1300);
  });
  await expect(page.locator('.gaze-rest')).not.toContainText('Paused');
  expect(await page.evaluate(() => meridian.run('set_dwell', { ms: 500 }).value)).toBe(500);
  expect(await page.evaluate(() => meridian.run('set_dwell', { ms: 99 }).value)).toBe(400);
  expect(errors()).toEqual([]);
});
