// Smoke tests: the app loads every preset, every command runs, controls are reachable by
// keyboard, and a cached field opens its time-lapse.
import { test, expect } from '@playwright/test';

// Aladin's usage logger calls a CDS URL that may not resolve; that error is harmless.
const IGNORED = [/AladinLiteLogger|alasky\.unistra\.fr/, /tg\.log/, /net::ERR_NAME_NOT_RESOLVED/, /Failed to fetch/];

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // "Failed to load resource" console lines carry no URL; the response listener below does
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  return () => errors.filter((e) => !IGNORED.some((re) => re.test(e)));
}

async function ready(page) {
  await page.waitForFunction(() => window.meridian && document.querySelector('#controls'));
}

const PRESETS = ['milky_way', 'solar_system', 'barnard', 'eps_ind_b', 'wise_0855', 'rw_aur', 'r_dra'];

test('every preset flies somewhere without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await ready(page);
  for (const id of PRESETS) {
    const before = await page.evaluate(() => [meridian.store.get().ra, meridian.store.get().dec]);
    await page.evaluate((pid) => meridian.run('go_preset', { id: pid }).value, id);
    const after = await page.evaluate(() => [meridian.store.get().ra, meridian.store.get().dec]);
    expect(after, `preset ${id}`).not.toEqual(id === 'milky_way' ? [NaN, NaN] : before);
  }
  expect(errors()).toEqual([]);
});

test('every registered command runs once', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=133.7578&dec=-7.242&fov=0.5');
  await ready(page);
  const results = await page.evaluate(async () => {
    const args = {
      fly_to: { target: '133.7578 -7.242' },
      go_preset: { id: 'wise_0855' },
      set_projection: { proj: 'SIN' },
      set_band: { band: 72 },
      set_mode: { mode: 'single' },
      set_compare: { compare: 'off' },
      set_epochs: { t: [] },
      toggle_epoch: { index: 0 },
      toggle_layer: { layer: 'gaia' },
      set_field_fov: { fov: 0.1 },
      set_op: { op: 'none' },
    };
    // Field-only commands need the field view.
    const fieldOnly = new Set(['select_point']);
    const out = {};
    for (const c of meridian.commands.list()) {
      if (fieldOnly.has(c.name)) continue;
      const r = meridian.run(c.name, args[c.name] ?? {}, 'test');
      try {
        if (r.pending) await r.value;
        out[c.name] = r.ok ? 'ok' : r.error;
      } catch (e) {
        out[c.name] = String(e.message ?? e);
      }
    }
    meridian.run('close_field', {}, 'test');
    return out;
  });
  for (const [name, res] of Object.entries(results)) {
    // open_field is allowed to refuse when the view is too wide; nothing else may fail
    if (name === 'open_field' && /Zoom in/.test(res)) continue;
    expect(res, name).toBe('ok');
  }
  expect(errors()).toEqual([]);
});

test('main controls are reachable with the keyboard', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => {
      const el = document.activeElement;
      return el.id || el.dataset.preset || el.dataset.proj || el.textContent.trim().slice(0, 20);
    });
    seen.add(id);
  }
  for (const want of ['search-input', 'band', 'wise_0855', 'barnard', 'SIN', 'AIT']) {
    expect([...seen], `reach ${want} by Tab`).toContain(want);
  }
});

test('a cached field opens its time-lapse', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=133.7578&dec=-7.242&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('#player-caption')).toContainText('Detector D6', { timeout: 60_000 });
  await expect(page.locator('.epoch')).toHaveCount(4);
  // keyboard: Escape back to the sky
  await page.locator('#field-title').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#field')).toBeHidden();
  expect(errors()).toEqual([]);
});

test('zooming in replaces the blocky all-sky tiles with the full-resolution layer', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?ra=269.44627&dec=4.7682&fov=0.3&band=37');
  await ready(page);
  await expect(page.locator('#status')).toContainText('Full-resolution SPHEREx', { timeout: 200_000 });
  // zooming back out removes it
  await page.evaluate(() => meridian.run('set_projection', { proj: 'AIT' }));
  await expect(page.locator('#status')).not.toContainText('Full-resolution SPHEREx ·', { timeout: 10_000 });
});

test('three view types: globe, planetarium and whole sky', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Planetarium' }).click();
  await expect.poll(() => page.evaluate(() => aladin.getProjectionName())).toBe('STG');
  await expect(page).toHaveURL(/proj=STG/);
  expect(await page.evaluate(() => meridian.store.get().fov)).toBeLessThanOrEqual(160);
  await page.getByRole('button', { name: 'Whole sky' }).click();
  await expect.poll(() => page.evaluate(() => aladin.getProjectionName())).toBe('AIT');
  await page.getByRole('button', { name: '3D sphere' }).click();
  await expect.poll(() => page.evaluate(() => aladin.getProjectionName())).toBe('SIN');
});

test('the band label shows the wavelength once it is known', async ({ page }) => {
  await page.goto('/?band=40');
  await ready(page);
  await expect(page.locator('#band-label')).toContainText('1.905 µm', { timeout: 20_000 });
});

test('colour views: tinted band follows the detector; presets and custom mixes swap the map', async ({ page }) => {
  await page.goto('/?band=40');
  await ready(page);
  // While the map swaps between the band cube and a colour mix there is briefly no base layer.
  const cmap = () => page.evaluate(() => aladin.getBaseImageLayer()?.getColorCfg?.().getColormap() ?? null);
  const base = () => page.evaluate(() => { const l = aladin.getBaseImageLayer(); return l ? (l.url ?? l.id) : ''; });
  await expect.poll(cmap, { timeout: 20_000 }).toBe('meridian-d3'); // band 40 = detector D3
  await page.evaluate(() => meridian.run('set_band', { band: 90 }));
  await expect.poll(cmap).toBe('meridian-d6');
  await page.getByRole('radio', { name: 'Dust glow' }).click();
  await expect.poll(base).toContain('/api/hips/mix/62-46-22');
  await expect(page).toHaveURL(/color=dust/);
  // the band slider stays free: choosing a band leaves the mix for that band, tinted
  await page.keyboard.press(']');
  await expect.poll(base, { timeout: 20_000 }).toContain('spherex_allsky_cube');
  await expect(page).not.toHaveURL(/color=dust/);
  await page.getByRole('radio', { name: 'Grey' }).click();
  await expect.poll(cmap).toBe('grey');
});

test('brightness: buttons, keys and the right-drag gesture all show in the panel and reset', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const cuts = () => page.evaluate(() => aladin.getBaseImageLayer()?.getCuts?.());
  await expect.poll(cuts, { timeout: 20_000 }).toEqual([0, 255]);
  await page.getByRole('button', { name: 'Brighter' }).click();
  await page.keyboard.press('>');
  await expect(page).toHaveURL(/level=2,0/);
  await expect(page.locator('#level-label')).toContainText('brightness +2');
  expect((await cuts())[1]).toBeLessThan(255);
  // Aladin's own gesture: right-button drag sideways on the sky
  await page.getByRole('button', { name: /Reset/ }).click();
  await expect(page.locator('#level-label')).toContainText('as served');
  const box = await page.locator('#sky').boundingBox();
  const x = box.x + box.width * 0.6;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + 250, y, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Escape'); // close Aladin's context menu if it opened
  await expect(page.locator('#level-label')).toContainText('(changed)');
  await page.keyboard.press('\\');
  await expect(page.locator('#level-label')).toContainText('as served');
  await expect.poll(cuts).toEqual([0, 255]);
});

test('motion trail: WISE 0855 leaves a rainbow streak over 2010–2026', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await page.goto('/?ra=133.7578&dec=-7.242&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('.epoch')).toHaveCount(4, { timeout: 60_000 });
  await page.keyboard.press('r');
  await expect(page).toHaveURL(/op=trail/);
  const caption = page.locator('#player-caption');
  await expect(caption).toContainText(/WISE 4\.6 µm images \+ 4 SPHEREx visits, 2010–2026/, { timeout: 180_000 });
  await expect(page.locator('#trail-legend')).toBeVisible();
  await page.getByLabel('Include WISE 2010–2024').uncheck();
  await expect(caption).toContainText('Motion trail: 4 SPHEREx visits, 2025–2026');
  expect(errors()).toEqual([]);
});

test('change video: WISE 0855 found and tracked; real dates and model frames are labelled', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await page.goto('/?ra=133.7578&dec=-7.242&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('.epoch')).toHaveCount(4, { timeout: 60_000 });
  await page.keyboard.press('v');
  await expect(page).toHaveURL(/op=video/);
  const caption = page.locator('#player-caption');
  await expect(caption).toContainText(/Moving: CatWISE2020 object at 8\.\d″\/yr/, { timeout: 180_000 });
  await expect(page.locator('#video-badge')).toBeVisible();
  await page.keyboard.press(' '); // pause
  await page.keyboard.press('.'); // next real image
  await expect(caption).toContainText('Real image');
  await expect(page.locator('#video-badge')).toHaveText(/^REAL/);
  await page.locator('#p-scrub').fill('333');
  await expect(caption).toContainText('Model frame');
  await expect(page.locator('#video-badge')).toHaveText(/^MODEL/);
  await expect(page.locator('#video-marks circle')).toHaveCount(1);
  expect(errors()).toEqual([]);
});
