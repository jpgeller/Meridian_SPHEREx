// Accessibility (UI plan U10), end to end:
//   axe on the main screen, with the guide card open, and in the field view: no serious or critical issues;
//   the whole guide flow "offer, Yes, explanation, Got it" with the keyboard only (Tab / Enter / Space);
//   the same flow with dwell only (full gaze mode, no mouse, no keys).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const FIELD = '/?ra=133.7578&dec=-7.242&fov=0.5&band=92&mode=detector&ffov=0.1';
const STEP = { steps: [{ say: 'The ring marks WISE 0855, a cold brown dwarf.', actions: [{ circle: 'field:target' }] }], source: 'claude' };

async function ready(page) {
  await page.waitForFunction(() => window.meridian && window.guide?.attention && document.querySelector('#controls'));
}
const card = (page) => page.locator('[data-guide="guide-popup"]');
const quiet = (page) => expect.poll(() => page.evaluate(() => guide.attention.snapshot().quiet), { timeout: 30000 }).toBeNull();

// Aladin Lite draws the sky into its own DOM (canvases, its top-left buttons, the zoom buttons, the
// logo, context menu and status line). Those widgets come from the npm package (aladin-lite 3.8.2)
// and we cannot change their markup, so axe skips everything inside `.aladin-container`. Our own
// panels are siblings of it (#controls, the guide card, the face panel, the field view), and axe
// checks them in full.
const ALADIN = '.aladin-container';

async function serious(page, label) {
  const { violations } = await new AxeBuilder({ page }).exclude(ALADIN).analyze();
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = bad.map((v) => `${label}: [${v.impact}] ${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ') + ' :: ' + n.failureSummary?.split('\n').slice(0, 3).join(' | ')).join('\n  ')}`);
  return report;
}

test('axe: no serious or critical issues on the main screen, with the guide card open, and in the field view', async ({ page }) => {
  await page.route('**/api/guide', (route) => route.fulfill({ json: STEP }));
  await page.goto('/?fov=60&band=40');
  await ready(page);
  await page.waitForTimeout(1500); // let the panels fill (band label, face panel)
  const issues = [];
  issues.push(...(await serious(page, 'sky')));
  await page.evaluate(() => void guide.offer({ text: 'Want help identifying this?', target: 'sky:barnard' }));
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(300); // after the card's entrance animation
  issues.push(...(await serious(page, 'offer')));
  await page.evaluate(() => guide.dismiss());
  await page.evaluate(() => void guide.say({ say: 'SPHEREx splits infrared light into 102 bands.', answers: ['got_it', 'more', 'close'] }));
  await page.waitForTimeout(300);
  issues.push(...(await serious(page, 'step')));
  await page.evaluate(() => guide.dismiss());
  await page.goto(`${FIELD}&view=field`);
  await ready(page);
  await expect(page.locator('.epoch')).toHaveCount(4, { timeout: 60_000 });
  await page.waitForTimeout(800);
  issues.push(...(await serious(page, 'field')));
  expect(issues).toEqual([]);
});

// The guide's own live region (the pop-up's), and the eye-control one (input/gaze.js).
const guideLive = (page) => page.locator('[role="status"][aria-live="polite"]').filter({ hasText: /^Guide:/ });

test('keyboard only (Tab + Space / Enter): replays bring the offer, Yes, the tour step by step, Got it', async ({ page }) => {
  await page.route('**/api/guide', async (route) => {
    await new Promise((r) => setTimeout(r, 500)); // long enough to hear "Thinking…"
    await route.fulfill({ json: STEP }).catch(() => {});
  });
  await page.goto(`${FIELD}&view=field`);
  await ready(page);
  await expect(page.locator('.epoch')).toHaveCount(4, { timeout: 60_000 });
  await quiet(page);
  // the offer comes from the keyboard too: stepping back and forth through the visits
  for (const k of ['.', '.', ',', '.', ',']) await page.keyboard.press(k);
  await expect(card(page)).toContainText('Trying to spot what changed?');
  await expect(guideLive(page)).toHaveText(/^Guide: Trying to spot what changed\?/);
  // a single "next" key (Tab) reaches the card's answers first; a single "press" key answers
  // (the field view had put the focus on its title, far from the card in the Tab order)
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.dataset.answer)).toBe('yes');
  // focus on the card pauses its auto-hide (mode A): no fast reaction needed
  await page.waitForTimeout(500);
  await page.keyboard.press('Space');
  // the tour: each step is read out, and the keyboard stays on its first answer (Next), visibly
  await expect(card(page)).toContainText('This is the first picture');
  await expect(guideLive(page)).toHaveText(/^Guide: This is the first picture/);
  await expect.poll(() => page.evaluate(() => document.activeElement.dataset.answer)).toBe('next');
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  expect(ring).not.toBe('none');
  for (const text of ['watch the circled', 'motion trail']) {
    await page.keyboard.press('Enter');
    await expect(card(page)).toContainText(text);
    await expect.poll(() => page.evaluate(() => document.activeElement.dataset.answer)).toBe('next');
  }
  await page.keyboard.press('Enter');
  await expect(card(page)).toContainText('Is that clear?');
  await expect.poll(() => page.evaluate(() => document.activeElement.dataset.answer)).toBe('got_it');
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeHidden();
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(false);
  await expect(page.locator('#field')).toBeVisible(); // answering the card never left the time-lapse
});

test('dwell only (full gaze mode): offer, Yes, explanation and Got it on the sky; offers wait; answers are big and apart', async ({ page }) => {
  await page.route('**/api/guide', (route) =>
    route.fulfill({ json: { steps: [{ say: "Barnard's Star moves fast across the sky.", actions: [{ circle: 'sky:barnard' }] }], source: 'claude' } }),
  );
  await page.goto('/?ra=269.45&dec=4.74&fov=20&input=gaze');
  await ready(page);
  await page.evaluate(() => {
    window.__gaze = async (x, y, ms) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        postMessage({ type: 'gaze', x, y, confidence: 0.9, t: performance.now() }, location.origin);
        await new Promise((r) => setTimeout(r, 33));
      }
    };
    window.__answer = (label) => {
      const b = [...document.querySelectorAll('[data-guide="guide-popup"] button')].find((el) => el.textContent.includes(label));
      const r = b.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
  });
  // the mode is announced, and offers do not hide themselves in gaze modes
  expect(await page.evaluate(() => guide.popup.autoHide())).toBe(false);
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard')), { timeout: 15000 }).not.toBeNull();
  await quiet(page);
  await page.evaluate(() => guide.attention.configure({ ringDelayMs: 200, dwellMs: 1500 }));
  const star = await page.evaluate(() => guide.resolve('sky:barnard'));
  await page.evaluate(({ x, y }) => __gaze(x, y, 2200), star);
  await expect(card(page)).toContainText('Want to know what this is?');
  // answers: at least 64 px high, at least 16 px apart
  const boxes = await card(page).locator('.gp-answers button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(64);
  expect(boxes[1].left - boxes[0].right).toBeGreaterThanOrEqual(16);
  // looking away for a while: the offer stays (no step needs a fast reaction)
  await page.evaluate(() => __gaze(640, 420, 1500));
  await expect(card(page)).toBeVisible();
  await page.evaluate(() => __gaze(...__answer('Yes'), 1200));
  await expect(card(page)).toContainText('Red dwarf star'); // the guide's own notes on this place
  await page.evaluate(() => __gaze(640, 420, 400)); // the eyes leave the spot where Yes was
  await page.evaluate(() => __gaze(...__answer('Stop'), 1200));
  await expect(card(page)).toBeHidden();
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(false);
  // eye control can be switched off at any time: by a look at its button, and the change is spoken
  await page.evaluate(() => {
    const r = document.querySelector('#input-mode').getBoundingClientRect();
    return __gaze(r.left + r.width / 2, r.top + r.height / 2, 1200);
  });
  await expect.poll(() => page.evaluate(() => meridian.store.get().input)).toBe('mouse');
  await expect(page.locator('[role="status"]').filter({ hasText: /^Eye control:/ })).toHaveText('Eye control: off.');
  await expect(page.locator('#input-mode')).toHaveAccessibleName(/Eye control\s*Off/);
});

test('reduced motion: the card, the ring and the face panel do not animate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?fov=60');
  await ready(page);
  await page.evaluate(() => void guide.offer({ text: 'Want help identifying this?', key: 'rm' }));
  await expect(card(page)).toBeVisible();
  const anim = await page.evaluate(() =>
    ['[data-guide="guide-popup"]', '#guide-attention', '#input-mode', '.face-panel'].map((s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return [s, cs.animationName, cs.transitionDuration];
    }),
  );
  for (const [, name, dur] of anim) {
    expect(name).toBe('none');
    expect(dur.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
  }
  // Esc closes at once (no leave animation)
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
});
