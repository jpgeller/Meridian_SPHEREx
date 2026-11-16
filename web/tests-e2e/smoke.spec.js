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

// The guide endpoint (U7) without the model: the server's "use your local script" marker, or a given reply.
const GUIDE_FALLBACK = { steps: [], fallback: true, reason: 'test' };
async function mockGuideApi(page, body = GUIDE_FALLBACK, { delayMs = 0, onRequest } = {}) {
  await page.route('**/api/guide', async (route) => {
    onRequest?.(route.request().postDataJSON());
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({ json: body }).catch(() => {}); // the page may have moved on
  });
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

test('the Places panel has a button for the five challenge targets only', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const ids = await page.evaluate(() => [...document.querySelectorAll('#controls [data-preset]')].map((b) => b.dataset.preset));
  expect(ids).toEqual(['barnard', 'eps_ind_b', 'wise_0855', 'rw_aur', 'r_dra']);
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
      set_detector: { detector: 6 },
      set_show: { show: 'timelapse' },
    };
    // Field-only commands need the field view.
    const fieldOnly = new Set(['select_point', 'set_spectrum_view', 'show_sed']);
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
  for (const want of ['search-input', 'band', 'wise_0855', 'barnard', 'SIN', 'STG']) {
    expect([...seen], `reach ${want} by Tab`).toContain(want);
  }
});

test('shell: Tab reaches every control, detector buttons set the band, tools fold away', async ({ page }) => {
  await page.goto('/?band=40');
  await ready(page);
  const want = await page.evaluate(() =>
    [...document.querySelectorAll('#controls button, #controls input')]
      .filter((el) => el.offsetParent && !el.disabled)
      .map((el, i) => (el.dataset.tabId = String(i))),
  );
  const seen = new Set();
  for (let i = 0; i < 80 && seen.size < want.length; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement.dataset.tabId);
    if (id) seen.add(id);
  }
  expect([...seen].sort()).toEqual([...want].sort());
  // every dock and preset target is gaze-sized
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('#controls .det, #controls [data-preset]')].filter((el) => el.offsetHeight < 64).length,
  );
  expect(small).toBe(0);
  await page.getByRole('button', { name: /Detector D6/ }).click();
  await expect(page).toHaveURL(/band=93/);
  await expect(page.locator('[data-detector="6"]')).toHaveAttribute('aria-pressed', 'true');
  // one side panel holds every setting; its gaze-sized button folds it away
  await expect(page.getByRole('button', { name: 'Whole sky' })).toHaveCount(0);
  const toggle = page.getByRole('button', { name: 'Controls' });
  expect(await toggle.evaluate((el) => el.offsetHeight)).toBeGreaterThanOrEqual(64);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Planetarium' })).toBeHidden();
  await expect(page.locator('[data-preset]').first()).toBeHidden();
  await page.evaluate(() => meridian.run('toggle_panel'));
  await expect(page.getByRole('button', { name: 'Planetarium' })).toBeVisible();
  // panel buttons are medium-sized for gaze
  const thin = await page.evaluate(() =>
    [...document.querySelectorAll('#side-panel button.big')].filter((el) => el.offsetHeight < 56).length,
  );
  expect(thin).toBe(0);
});

test('a cached field opens its time-lapse', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=133.7578&dec=-7.242&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('#player-caption')).toContainText('Detector D6', { timeout: 60_000 });
  await expect(page.locator('.epoch')).toHaveCount(4);
  // 2D images are always SPHEREx's own resolution: every frame on the 6.15"/px grid (0.1° -> 59 px),
  // one canvas pixel per SPHEREx pixel, scaled up as hard squares (no smoothing, unlike the 3D sky)
  const res = await page.evaluate(() => {
    const c = document.querySelector('#frame-canvas');
    return {
      frames: meridian.player.getSequence().map((f) => [f.w, f.h, f.meta?.pixel_scale_arcsec]),
      canvas: [c.width, c.height],
      rendering: getComputedStyle(c).imageRendering,
    };
  });
  for (const f of res.frames) expect(f).toEqual([59, 59, 6.15]);
  expect(res.canvas).toEqual([59, 59]);
  expect(res.rendering).toBe('pixelated');
  // keyboard: Escape back to the sky
  await page.locator('#field-title').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#field')).toBeHidden();
  expect(errors()).toEqual([]);
});

test('zooming in keeps the same all-sky images everywhere (full-resolution layer is off)', async ({ page }) => {
  await page.goto('/?ra=269.44627&dec=4.7682&fov=0.3&band=37&color=grey');
  await ready(page);
  await page.waitForTimeout(2000);
  await expect(page.locator('#status')).not.toContainText('Full-resolution');
  expect(await page.evaluate(() => meridian.commands.list().some((c) => c.name === 'toggle_native'))).toBe(false);
});

test('view types: globe and planetarium buttons (whole sky only by URL / command)', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Planetarium' }).click();
  await expect.poll(() => page.evaluate(() => aladin.getProjectionName())).toBe('STG');
  await expect(page).toHaveURL(/proj=STG/);
  expect(await page.evaluate(() => meridian.store.get().fov)).toBeLessThanOrEqual(160);
  await page.evaluate(() => meridian.run('set_projection', { proj: 'AIT' }));
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
  await page.goto('/?band=40&color=tint'); // the page opens in Grey; this test starts from Tinted band
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

test('brightness: no panel section; keys and the right-drag gesture still work and reset', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const cuts = () => page.evaluate(() => aladin.getBaseImageLayer()?.getCuts?.());
  await expect.poll(cuts, { timeout: 20_000 }).toEqual([0, 255]);
  await expect(page.getByRole('button', { name: 'Brighter' })).toHaveCount(0);
  await page.keyboard.press('>');
  await page.keyboard.press('>');
  await expect(page).toHaveURL(/level=2,0/);
  expect((await cuts())[1]).toBeLessThan(255);
  await page.keyboard.press('\\');
  await expect.poll(cuts).toEqual([0, 255]);
  // Aladin's own gesture: right-button drag sideways on the sky
  const box = await page.locator('#sky').boundingBox();
  const x = box.x + box.width * 0.6;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + 250, y, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await expect(page).toHaveURL(/level=/);
  await page.keyboard.press('\\');
  await expect.poll(cuts).toEqual([0, 255]);
});

test('only our controls on the sky: no Aladin widgets or logo; RA / Dec / field readout bottom right', async ({ page }) => {
  await page.goto('/?ra=266.4168&dec=-29.0078&fov=60');
  await ready(page);
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('#sky button, #sky select, #sky .aladin-logo, #sky .aladin-location')].filter((el) => el.offsetParent !== null).length,
  );
  expect(shown).toBe(0);
  const ro = page.locator('[data-region="readout"]');
  await expect(ro).toContainText('17h 45m 40.0s');
  await expect(ro).toContainText('−29° 00′ 28″');
  await expect(ro).toContainText('60°');
  const b = await ro.boundingBox();
  const vp = page.viewportSize();
  // bottom right, 6% clear of the screen edges (eye tracking)
  expect(vp.width - (b.x + b.width)).toBeGreaterThanOrEqual(vp.width * 0.06);
  expect(vp.width - (b.x + b.width)).toBeLessThan(vp.width * 0.06 + 20);
  expect(vp.height - (b.y + b.height)).toBeGreaterThanOrEqual(vp.height * 0.06);
  await page.evaluate(() => meridian.run('fly_to', { target: '133.79513 -7.24515', fov: 0.5 }).value);
  await expect(ro).toContainText('08h 55m 10.8s');
  await expect(ro).toContainText(/Field\s*2\.\d°/); // 0.5° asked: the sky stops at its sharp limit (~2.3° on 1280 px)
  // the side panel fits without scrolling (gaze cannot scroll easily) and leaves the gaze rest zone free
  const p = await page.evaluate(() => {
    const el = document.querySelector('#side-panel');
    return { scroll: el.scrollHeight - el.clientHeight, bottom: el.getBoundingClientRect().bottom, h: innerHeight };
  });
  expect(p.scroll).toBeLessThanOrEqual(1);
  expect(p.h - p.bottom).toBeGreaterThanOrEqual(40);
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
  await expect(caption).toContainText('In-between frames are a model'); // (the Steady background option is gone)
  await expect(page.getByRole('switch', { name: 'Steady background' })).toHaveCount(0);
  // it waits on its first image (2010) until Play is pressed, then plays; pressing again pauses
  await expect(caption).toContainText('Press Play');
  const badge = page.locator('#video-badge');
  const first = await badge.textContent();
  expect(first).toMatch(/2010/);
  await page.locator('#p-play').click();
  await expect.poll(() => badge.textContent(), { timeout: 5000 }).not.toBe(first);
  await page.locator('#p-play').click(); // pause
  expect(await page.evaluate(() => meridian.store.get().playing)).toBe(false);
  await page.keyboard.press('.'); // next real image
  await expect(caption).toContainText('Real image');
  await expect(page.locator('#video-badge')).toHaveText(/^REAL/);
  await page.locator('#p-scrub').fill('333');
  await expect(caption).toContainText('Model frame');
  await expect(page.locator('#video-badge')).toHaveText(/^MODEL/);
  await expect(page.locator('#video-marks circle')).toHaveCount(1);
  expect(errors()).toEqual([]);
});

test('overlays: world2pix / pix2world in every view, in the page and through the bridge', async ({ page }) => {
  await page.goto('/?ra=83.82208&dec=-5.39111&fov=30');
  await ready(page);
  await expect.poll(() => page.evaluate(() => meridian.world2pix(83.82208, -5.39111))).not.toBeNull();
  for (const proj of ['SIN', 'STG', 'AIT']) {
    await page.evaluate((p) => meridian.run('set_projection', { proj: p }), proj);
    await page.evaluate(() => meridian.run('fly_to', { target: '83.82208 -5.39111', fov: 30 }).value);
    const r = await page.evaluate(() => {
      const box = document.querySelector('#sky').getBoundingClientRect();
      const p = meridian.world2pix(83.82208, -5.39111); // the view centre
      const back = meridian.pix2world(p.x, p.y);
      return { p, back, w: box.width, h: box.height };
    });
    expect(Math.abs(r.p.x - r.w / 2), proj).toBeLessThan(3);
    expect(Math.abs(r.p.y - r.h / 2), proj).toBeLessThan(3);
    expect(r.p.inView).toBe(true);
    expect(Math.abs(r.back.ra - 83.82208) + Math.abs(r.back.dec + 5.39111), proj).toBeLessThan(0.05);
  }
  // the far side of the 3D globe is not on screen
  await page.evaluate(() => meridian.run('set_projection', { proj: 'SIN' }));
  expect(await page.evaluate(() => meridian.world2pix(263.82208, 5.39111))).toBeNull();
  // the same through postMessage, as an external overlay would ask
  const reply = await page.evaluate(
    () =>
      new Promise((resolve) => {
        addEventListener('message', (e) => e.data?.type === 'world2pix_result' && resolve(e.data));
        postMessage({ type: 'world2pix', id: 7, points: [{ ra: 83.82208, dec: -5.39111 }, { ra: 263.82208, dec: 5.39111 }] }, location.origin);
      }),
  );
  expect(reply.id).toBe(7);
  expect(reply.points[0].inView).toBe(true);
  expect(reply.points[1]).toBeNull();
  // whole sky (galactic frame): the Galactic centre is in the middle, and the URL keeps true ICRS
  await page.goto('/?proj=AIT&fov=360');
  await ready(page);
  await expect.poll(() => page.evaluate(() => aladin.getFrame())).toBe('GAL');
  const gc = await page.evaluate(() => {
    const box = document.querySelector('#sky').getBoundingClientRect();
    return { p: meridian.world2pix(266.4168, -29.0078), w: box.width, h: box.height };
  });
  expect(Math.abs(gc.p.x - gc.w / 2)).toBeLessThan(3);
  expect(Math.abs(gc.p.y - gc.h / 2)).toBeLessThan(3);
  await page.mouse.move(gc.w / 2, gc.h / 2);
  await page.mouse.down();
  await page.mouse.move(gc.w / 2 + 40, gc.h / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => meridian.store.get().dec)).toBeGreaterThan(-45); // was -57.9 (wrong frame)
});

test('guide registry: controls and sky objects have screen positions, null when off screen', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=269.45&dec=4.74&fov=20');
  await ready(page);
  // a detector button: its real box
  const d6 = await page.evaluate(() => {
    const b = document.querySelector('[data-guide="band-d6"]').getBoundingClientRect();
    return { r: guide.resolve('band-d6'), b: { x: b.left, y: b.top, w: b.width, h: b.height } };
  });
  expect(d6.r.rect).toEqual(d6.b);
  expect(await page.evaluate(() => guide.targetAt(guide.resolve('band-d6').x, guide.resolve('band-d6').y))).toBe('band-d6');
  expect(await page.evaluate(() => guide.resolve('face-panel'))).not.toBeNull(); // U8 face panel
  expect(await page.evaluate(() => guide.resolve('colour:D6'))).not.toBeNull();
  // Barnard's Star near the middle of the view (the name lookup runs in the background)
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard')), { timeout: 15000 }).not.toBeNull();
  const b = await page.evaluate(() => ({ p: guide.resolve('sky:barnard'), w: innerWidth, h: innerHeight }));
  expect(Math.abs(b.p.x - b.w / 2)).toBeLessThan(60);
  expect(Math.abs(b.p.y - b.h / 2)).toBeLessThan(60);
  expect(await page.evaluate(({ x, y }) => guide.targetAt(x, y, 48), b.p)).toBe('sky:barnard');
  // the other side of the sky: Barnard's Star is not on screen
  await page.evaluate(() => meridian.run('fly_to', { target: '89.45 -4.74', fov: 20 }).value);
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard'))).toBeNull();
  expect(await page.evaluate(() => guide.resolve('sky:target'))).not.toBeNull();
  expect(errors()).toEqual([]);
});

test('guide registry: in the field view the target sits in the middle of the image', async ({ page }) => {
  await page.goto('/?ra=133.7578&dec=-7.242&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('#player-caption')).toContainText('Detector D6', { timeout: 60_000 });
  const r = await page.evaluate(() => {
    const b = document.querySelector('#frame-canvas').getBoundingClientRect();
    return { t: guide.resolve('field:target'), cx: b.left + b.width / 2, cy: b.top + b.height / 2, player: guide.resolve('time-player') };
  });
  expect(Math.abs(r.t.x - r.cx)).toBeLessThan(1);
  expect(Math.abs(r.t.y - r.cy)).toBeLessThan(1);
  expect(r.player).not.toBeNull();
  expect(await page.evaluate(({ x, y }) => guide.targetAt(x, y), r.t)).toBe('field:target');
  expect(await page.evaluate(() => guide.resolve('band-d6'))).toBeNull(); // the sky controls are hidden here
});

// --- guide overlay (U3) ---

/** The pointer's tip in viewport px (from its transform), or null when hidden. */
const pointerTip = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('#guide-overlay .go-pointer');
    if (!el || el.classList.contains('is-hidden')) return null;
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform);
    return m && { x: Number(m[1]), y: Number(m[2]), flying: el.classList.contains('is-flying') };
  });

test('guide overlay: the pointer flies to a control, labels it, and clicks pass through', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=269.45&dec=4.74&fov=20');
  await ready(page);
  await page.evaluate(() => guide.pointAt('band-d6', 'Longest wavelengths'));
  // it leaves from the pill's orb (top right) and lands beside D6 in 300-600 ms
  const start = await pointerTip(page);
  expect(start.x).toBeGreaterThan(640);
  await expect.poll(async () => (await pointerTip(page))?.flying, { timeout: 2000 }).toBe(false);
  const d6 = await page.evaluate(() => guide.resolve('band-d6'));
  const tip = await pointerTip(page);
  // at D6's top-right corner, outside the box (never on its text)
  expect(Math.abs(tip.x - (d6.rect.x + d6.rect.w))).toBeLessThan(12);
  expect(Math.abs(tip.y - d6.rect.y)).toBeLessThan(12);
  expect(tip.x > d6.rect.x + d6.rect.w || tip.y < d6.rect.y).toBe(true);
  // the label is on screen and does not sit on the orb
  const label = page.locator('#guide-overlay .go-label');
  await expect(label).toHaveText('Longest wavelengths');
  await expect(label).not.toHaveClass(/is-hidden/);
  const lb = await label.boundingBox();
  expect(lb.y + lb.height).toBeLessThanOrEqual(800);
  expect(tip.x >= lb.x && tip.x <= lb.x + lb.width && tip.y >= lb.y && tip.y <= lb.y + lb.height).toBe(false);
  // the overlay never takes a click: nothing under the orb is part of it, and D6 gets the click
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#guide-overlay'), tip)).toBe(false);
  await page.mouse.click(d6.x, d6.y);
  await expect.poll(() => page.evaluate(() => meridian.store.get().band)).toBeGreaterThan(84);
  // ...and that click was the person acting: the guide's marks clear
  await expect.poll(() => page.evaluate(() => guide.overlay.active().length)).toBe(0);
  expect(errors()).toEqual([]);
});

test('guide overlay: a circle follows the sky, waits at the edge when off screen, guide commands keep it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=269.45&dec=4.74&fov=2');
  await ready(page);
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard')), { timeout: 15000 }).not.toBeNull();
  await page.evaluate(() => guide.circle('sky:barnard'));
  const ring = page.locator('#guide-overlay circle.go-circle');
  const ringAt = () => ring.evaluate((c) => ({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), hidden: c.classList.contains('is-hidden') }));
  const before = await ringAt();
  expect(before.hidden).toBe(false);
  // drag the sky by hand: the ring moves with Barnard's Star
  await page.mouse.move(640, 380);
  await page.mouse.down();
  await page.mouse.move(540, 330, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await ringAt()).x - before.x)).toBeGreaterThan(50);
  const star = await page.evaluate(() => guide.resolve('sky:barnard'));
  const after = await ringAt();
  expect(Math.abs(after.x - star.x)).toBeLessThan(3);
  expect(Math.abs(after.y - star.y)).toBeLessThan(3);
  // a command run by the guide does not clear it
  await page.evaluate(() => meridian.run('set_band', { band: 40 }, 'guide'));
  expect(await page.evaluate(() => guide.overlay.active())).toEqual(['circle:sky:barnard']);
  // move the view 10° west (no command): the star is now east of it, off the left edge
  await page.evaluate(() => aladin.gotoRaDec(259.45, 4.74));
  await expect(ring).toHaveClass(/is-hidden/);
  const edge = page.locator('#guide-overlay .go-edge');
  await expect(edge).not.toHaveClass(/is-hidden/);
  const eb = await edge.boundingBox();
  expect(eb.x).toBeLessThan(80); // east is left on the sky
  expect(errors()).toEqual([]);
});

test('guide overlay: reduced motion jumps straight to the target', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?ra=269.45&dec=4.74&fov=20');
  await ready(page);
  await page.evaluate(() => guide.pointAt('search'));
  const tip = await pointerTip(page);
  const s = await page.evaluate(() => guide.resolve('search'));
  expect(tip.flying).toBe(false);
  // beside the search box's right corner, outside the box (never on its text)
  expect(Math.abs(tip.x - (s.rect.x + s.rect.w))).toBeLessThan(12);
  expect(tip.x > s.rect.x + s.rect.w || tip.y < s.rect.y || tip.y > s.rect.y + s.rect.h).toBe(true);
});

test('guide pop-up: an offer is first in the Tab order, Esc dismisses it, the same target waits 60 s', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=269.45&dec=4.74&fov=20');
  await ready(page);
  const card = page.locator('[data-guide="guide-popup"]');
  await expect(card).toBeHidden();
  await page.evaluate(() => {
    window.__offer = guide.offer({ text: 'Want help identifying this?', target: 'sky:barnard', onNo: (r) => (window.__no = r) });
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Want help identifying this?');
  await expect(page.locator('[role="status"][aria-live="polite"]').filter({ hasText: 'Guide:' })).toHaveText('Guide: Want help identifying this?');
  expect(await page.evaluate(() => [guide.popup.isOpen(), guide.popup.kind()])).toEqual([true, 'offer']);
  // top right, above the overlay
  let b = await card.boundingBox();
  // top right, 6% clear of the screen edges (eye tracking): 1280 x 800 -> about 81 px and 52 px
  await expect.poll(async () => (await card.boundingBox()).y).toBeGreaterThanOrEqual(800 * 0.06); // after the slide-in
  b = await card.boundingBox();
  expect(b.x + b.width).toBeGreaterThan(1280 * 0.94 - 8);
  expect(b.x + b.width).toBeLessThanOrEqual(1280 * 0.94);
  expect(b.y).toBeGreaterThanOrEqual(800 * 0.06);
  expect(b.y).toBeLessThan(800 * 0.06 + 20);
  expect(await card.evaluate((el) => +getComputedStyle(el).zIndex)).toBeGreaterThanOrEqual(50);
  // Tab from the page reaches Yes, then No thanks (real buttons)
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.dataset.answer)).toBe('yes');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => [document.activeElement.tagName, document.activeElement.textContent])).toEqual(['BUTTON', 'Not now']);
  // Esc closes the card (a decline) and gives the focus back
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.__offer)).toBe('dismissed');
  expect(await page.evaluate(() => window.__no)).toBe('dismissed');
  expect(await page.evaluate(() => document.activeElement.closest('[data-guide="guide-popup"]'))).toBeNull();
  // a declined target is not offered again in this session; another one is
  expect(await page.evaluate(() => guide.offer({ text: 'Again?', target: 'sky:barnard' }))).toBe('cooling');
  await expect(card).toBeHidden();
  await page.evaluate(() => {
    window.__second = guide.offer({ text: 'Wondering about these colours?', target: 'band-ribbon' });
  });
  await expect(card).toContainText('colours');
  // while one card is open, a new offer is refused
  expect(await page.evaluate(() => guide.offer({ text: 'Third', target: 'search' }))).toBe('busy');
  await card.getByRole('button', { name: 'Not now' }).click();
  expect(await page.evaluate(() => window.__second)).toBe('no');
  expect(errors()).toEqual([]);
});

test('guide pop-up: Yes opens a step, answers resolve say(), the card stays top right, Esc beats "back to sky"', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=269.45&dec=4.74&fov=20');
  await ready(page);
  const card = page.locator('[data-guide="guide-popup"]');
  await page.evaluate(() => {
    window.__answer = null;
    guide.offer({
      text: 'Want help identifying this?',
      target: 'sky:barnard',
      onYes: () =>
        guide.say({ say: "Barnard's Star is a red dwarf about six light-years away.", answers: ['got_it', 'more', 'close'] }).then((a) => (window.__answer = a)),
    });
  });
  // keyboard only: Tab, Enter on Yes -> the step keeps the focus on its first answer
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(card).toContainText('red dwarf');
  await expect(card.locator('.gp-answers button')).toHaveText(['Got it', 'Show me more', 'Close']);
  expect(await page.evaluate(() => guide.popup.kind())).toBe('step');
  await expect.poll(() => page.evaluate(() => document.activeElement.dataset.answer)).toBe('got_it');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.__answer)).toBe('more');

  // the card always sits in the top-right corner (wireframe v4), whatever the step is about
  const long = 'SPHEREx takes one picture of each spot at a time, and over months it builds a spectrum in 102 colours.';
  page.evaluate((say) => guide.say({ say, title: 'Spectra', target: 'band-d1' }), long);
  await expect(card).toBeVisible();
  await expect(card.locator('.gp-title')).toHaveText('Spectra');
  await expect(card.locator('.gp-text')).toHaveText(long); // nothing cut
  expect(await page.evaluate(() => guide.popup.spot())).toBe('top-right');
  const box = await card.boundingBox();
  expect(box.x + box.width).toBeGreaterThan(1100);
  expect(box.x + box.width).toBeLessThanOrEqual(1280 * 0.94); // 6% clear of the edge
  expect(box.y).toBeLessThan(80);
  expect(await card.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true); // never scrolls
  await page.evaluate(() => guide.dismiss());
  await expect(card).toBeHidden();

  // in the field view, Esc closes the card first; the next Esc goes back to the sky
  await page.evaluate(() => meridian.run('go_preset', { id: 'wise_0855' }).value);
  await page.evaluate(() => meridian.run('set_field_fov', { fov: 0.1 }));
  await page.evaluate(() => meridian.store.set({ view: 'field' }, 'test'));
  await expect(page.locator('#field')).toBeVisible();
  await page.evaluate(() => {
    window.__fieldAnswer = guide.say('This is the time-lapse.');
  });
  await expect(card).toBeVisible();
  // it does not hide the field view's "Back to sky" button
  const close = await page.locator('#field-close').boundingBox();
  const cb = await card.boundingBox();
  expect(cb.y).toBeGreaterThan(close.y + close.height);
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.__fieldAnswer)).toBe('close');
  await expect(page.locator('#field')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#field')).toBeHidden();
  expect(errors()).toEqual([]);
});

test('guide pill: waits top right with the orb inside it (nothing floats beside it); the card takes its place; A opens the menu', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?fov=60');
  await ready(page);
  const pill = page.locator('[data-guide="guide-pill"]');
  const card = page.locator('[data-guide="guide-popup"]');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText('AI Guide');
  const pb = await pill.boundingBox();
  expect(pb.x + pb.width).toBeGreaterThan(1150);
  expect(pb.x + pb.width).toBeLessThanOrEqual(1280 * 0.94); // 6% clear of the edge
  expect(pb.y).toBeLessThan(80);
  // idle (W1): no free-floating pointer; the guide's orb is the one in the pill
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => [...document.querySelectorAll('#guide-overlay .go-pointer')].filter((e) => !e.classList.contains('is-hidden')).length)).toBe(0);
  await expect(pill.locator('.gp-orb')).toBeVisible();
  expect(await page.evaluate(() => guide.overlay.active())).toEqual([]);
  // key A: the menu, in the pill's place (no model here: the fixed three)
  await page.route('**/api/guide/nudge', (r) => r.fulfill({ json: { fallback: true, reason: 'test' } }));
  await page.keyboard.press('a');
  await expect(card).toContainText('What can I show you?');
  await expect(pill).toBeHidden();
  await expect(card.locator('.gp-answers button')).toHaveText(['What am I looking at?', 'Something moving', 'What the colours mean']);
  // ✕ closes it and the pill comes back
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toBeHidden();
  await expect(pill).toBeVisible();
  // the pill itself (a real button) opens the same menu
  await pill.click();
  await expect(card).toContainText('What can I show you?');
  expect(errors()).toEqual([]);
});

// --- guide script runner (U5) ---

test('guide runner: a console script skips a bad command, acts as the guide, and a button press ends it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?fov=60');
  await ready(page);
  const card = page.locator('[data-guide="guide-popup"]');
  await page.evaluate(() => {
    window.__how = null;
    guide
      .run([
        { say: 'Step one: the longest wavelengths.', actions: [{ cmd: 'not_a_command' }, { cmd: 'set_band', args: { band: 93 } }, { circle: 'band-d6' }] },
        { say: 'Step two.', actions: [{ cmd: 'set_band', args: { band: 'red' } }] },
        { say: 'Step three.' },
      ])
      .then((how) => (window.__how = how));
  });
  await expect(card).toContainText('Step one');
  await expect(card.locator('.gp-answers button')).toHaveText(['Next', 'Stop']);
  await expect(card.locator('.gp-step')).toHaveText('1 / 3');
  expect(await page.evaluate(() => meridian.store.get().band)).toBe(93);
  // the guide's own command did not clear its circle
  expect(await page.evaluate(() => guide.overlay.active())).toEqual(['circle:band-d6']);
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toContainText('Step two');
  expect(await page.evaluate(() => [guide.runner.isRunning(), meridian.store.get().band])).toEqual([true, 93]);
  // the person presses a real button: the script ends at once, the card goes
  await page.locator('[data-guide="band-d1"]').click();
  await expect(card).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__how)).toBe('interrupted');
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(false);
  expect(errors()).toEqual([]);
});

test('guide runner: the fallback scripts play with the API unreachable; Close ends them', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?fov=60');
  await ready(page);
  await page.route('**/api/**', (r) => r.abort());
  const card = page.locator('[data-guide="guide-popup"]');
  await page.evaluate(() => {
    window.__how = null;
    guide.fallback('colours').then((how) => (window.__how = how));
  });
  await expect(card).toContainText('infrared');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toContainText('D6');
  expect(await page.evaluate(() => meridian.store.get().band)).toBe(93);
  await card.getByRole('button', { name: 'Next' }).click();
  await card.getByRole('button', { name: 'Got it' }).click();
  await expect.poll(() => page.evaluate(() => window.__how)).toBe('done');
  await expect.poll(() => page.evaluate(() => guide.overlay.active().length)).toBe(0);

  await page.evaluate(() => {
    window.__how = null;
    guide.fallback('object', { id: 'sky:barnard' }).then((how) => (window.__how = how));
  });
  await expect(card).toContainText("Barnard's Star");
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => page.evaluate(() => window.__how)).toBe('closed');
  await expect(card).toBeHidden();
  expect(errors().filter((e) => !/\/api\//.test(e))).toEqual([]);
});

// --- guide attention (U6) ---

test('guide attention: resting the mouse on Barnard\'s Star for 5 s shows the offer (no ?gaze= needed); Yes starts the guide', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=269.45&dec=4.74&fov=20');
  await ready(page);
  await mockGuideApi(page);
  expect(await page.evaluate(() => guide.attention.source)).toBe('mouse');
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard')), { timeout: 15000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => guide.attention.snapshot().quiet), { timeout: 30000 }).toBeNull();
  const star = await page.evaluate(() => guide.resolve('sky:barnard'));
  const card = page.locator('[data-guide="guide-popup"]');
  const ring = page.locator('#guide-attention');
  await page.mouse.move(star.x + 20, star.y + 10); // inside the 48 px catch radius
  const t0 = Date.now();
  await expect(ring).toHaveClass(/is-on/, { timeout: 4000 });
  await expect(ring).toHaveAttribute('data-target', 'sky:barnard');
  expect(Date.now() - t0).toBeGreaterThan(1000); // not before 1.2 s
  await expect(card).toContainText(/fastest-moving star|Notice this object/, { timeout: 10000 });
  await expect(card).toContainText('You have been looking at it for 5 seconds.');
  expect(Date.now() - t0).toBeGreaterThan(4500); // about 5 s (a mouse that rests that long means interest; gaze: 7 s)
  await expect(ring).not.toHaveClass(/is-on/);
  // the pointer went first: it is on the star, circled, before any answer
  expect(await page.evaluate(() => guide.overlay.active().sort())).toEqual(['circle:sky:barnard', 'pointer']);
  await card.getByRole('button', { name: 'Yes, tell me' }).click();
  await expect(card.locator('.gp-title')).toHaveText("Barnard's Star");
  await expect(card).toContainText('Red dwarf star');
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(true);
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(card).toBeHidden();
  // still on the star, but inside the 60 s cool-down: no ring, no offer
  await page.mouse.move(star.x + 15, star.y);
  await page.waitForTimeout(1600);
  await expect(ring).not.toHaveClass(/is-on/);
  expect(errors()).toEqual([]);
});

test('guide attention: with ?gaze=off the mouse is ignored; gaze samples (U9 feed) ask about the colours', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?fov=60&gaze=off');
  await ready(page);
  await expect.poll(() => page.evaluate(() => guide.attention.snapshot().quiet), { timeout: 30000 }).toBeNull();
  await page.evaluate(() => guide.attention.configure({ ringDelayMs: 200, dwellMs: 1200 }));
  const card = page.locator('[data-guide="guide-popup"]');
  const d6 = await page.evaluate(() => guide.resolve('band-d6'));
  await page.mouse.move(d6.x, d6.y);
  await page.waitForTimeout(2000);
  await expect(card).toBeHidden();
  // a plain control (the places list) gets no guide offer, even from gaze
  await page.evaluate(() => {
    const p = guide.resolve('presets');
    window.__gaze = setInterval(() => guide.attention.feed({ x: p.rect.x + 4, y: p.rect.y + p.rect.h - 4, t: performance.now(), confidence: 0.9 }), 33);
  });
  await page.waitForTimeout(2000);
  await expect(card).toBeHidden();
  await page.evaluate(({ x, y }) => {
    clearInterval(window.__gaze);
    window.__gaze = setInterval(() => guide.attention.feed({ x, y, t: performance.now(), confidence: 0.9 }), 33);
  }, d6);
  await expect(card).toContainText(/You're on D\d/, { timeout: 5000 });
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => guide.popup.cooldown.isCooling('colours'))).toBe(true);
  await page.evaluate(() => clearInterval(window.__gaze));
  expect(errors()).toEqual([]);
});

test('guide attention: stepping back and forth in a time-lapse offers "what changed"', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=133.7578&dec=-7.242&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await mockGuideApi(page);
  await expect(page.locator('.epoch')).toHaveCount(4, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => guide.attention.snapshot().quiet), { timeout: 30000 }).toBeNull();
  const card = page.locator('[data-guide="guide-popup"]');
  for (const k of ['.', '.', ',', '.']) await page.keyboard.press(k); // 0 → 1 → 2 → 1 → 2: two turns
  await expect(card).toBeHidden();
  await page.keyboard.press(','); // a third turn
  await expect(card).toContainText('Something here may move between frames');
  await card.getByRole('button', { name: 'Yes, tell me' }).click();
  await expect(card).toContainText('This is the first picture');
  await expect.poll(() => page.evaluate(() => meridian.store.get().frameIndex)).toBe(0);
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(true);
  expect(errors()).toEqual([]);
});

// --- guide endpoint (U7) ---

test('guide endpoint: Yes shows "Thinking…", then plays the API\'s script; facts and whitelist are sent, no gaze', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?fov=60');
  await ready(page);
  let sent = null;
  const script = {
    steps: [
      { say: 'These bands are infrared light. Here is a short-wavelength band.', actions: [{ cmd: 'set_band', args: { band: 20 } }, { circle: 'band-d2' }] },
      { say: 'The colours are a display choice.', actions: [{ cmd: 'not_a_command' }, { point: 'colour-views' }] },
    ],
    source: 'claude',
  };
  await mockGuideApi(page, script, { delayMs: 600, onRequest: (b) => (sent = b) });
  const card = page.locator('[data-guide="guide-popup"]');
  await page.evaluate(() => {
    window.__how = null;
    guide.startGuide('colours').then((how) => (window.__how = how));
  });
  await expect(card).toContainText('Thinking');
  await expect(card).toContainText('short-wavelength band');
  await expect.poll(() => page.evaluate(() => meridian.store.get().band)).toBe(20);
  expect(sent.trigger).toBe('colours');
  expect(sent.commands).toContain('set_band');
  expect(sent.ids).toContain('band-d6');
  expect(sent.facts.band).toMatchObject({ band: 40, detector: 'D3' });
  expect(JSON.stringify(sent)).not.toMatch(/gaze|confidence/);
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toContainText('display choice'); // the bad command was dropped, the step kept
  await card.getByRole('button', { name: 'Got it' }).click();
  await expect.poll(() => page.evaluate(() => window.__how)).toBe('done');
  expect(errors()).toEqual([]);
});

test('guide endpoint: the fallback marker or a failed call plays the local script; Close while thinking cancels', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?fov=60');
  await ready(page);
  const card = page.locator('[data-guide="guide-popup"]');
  await mockGuideApi(page); // { fallback: true }
  await page.evaluate(() => void guide.startGuide('colours'));
  await expect(card).toContainText('SPHEREx splits it into 102 bands'); // fallback.js
  await page.evaluate(() => guide.stop());
  await expect(card).toBeHidden();

  await page.unroute('**/api/guide');
  await page.route('**/api/guide', (r) => r.fulfill({ status: 500, body: 'boom' }));
  await page.evaluate(() => void guide.startGuide('object', { id: 'sky:barnard' }));
  await expect(card).toContainText("This is Barnard's Star");
  await page.evaluate(() => guide.stop());

  await page.unroute('**/api/guide');
  await mockGuideApi(page, { steps: [{ say: 'Too late.', actions: [] }] }, { delayMs: 1500 });
  await page.evaluate(() => {
    window.__how = null;
    guide.startGuide('colours').then((how) => (window.__how = how));
  });
  await expect(card).toContainText('Thinking');
  await card.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__how)).toBe('closed');
  await page.waitForTimeout(1800);
  await expect(card).toBeHidden(); // the late reply is ignored
  expect(errors().filter((e) => !/HTTP 500 .*\/api\/guide/.test(e))).toEqual([]);
});

test('side by side with Gaia: a picture drawn from the catalogue, clearly labelled', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=269.44627&dec=4.7682&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('.epoch')).toHaveCount(5, { timeout: 60_000 });
  await page.getByRole('radio', { name: /Side by side with Gaia/ }).click();
  await expect(page).toHaveURL(/compare=gaia/);
  const label = page.locator('#wise-label');
  await expect(label).toContainText('drawn from the catalogue, not a photograph', { timeout: 60_000 });
  await expect(label).toContainText(/\d+ stars at .*2025/);
  await expect(page.locator('#gaia-canvas')).toBeVisible();
  await expect(page.locator('#wise-img')).toBeHidden();
  expect(Number(await page.locator('#gaia-canvas').getAttribute('data-drawn'))).toBeGreaterThan(100);
  await page.getByRole('radio', { name: /Side by side with WISE/ }).click();
  await expect(page.locator('#wise-img')).toBeVisible();
  await expect(page.locator('#gaia-canvas')).toBeHidden();
  expect(errors()).toEqual([]);
});

// Eye tracking is least accurate near the screen edges: nothing clickable within 6% of them.
// (Aladin's logo link is exempt: its licence asks for it in the corner.)
async function controlsNearEdges(page) {
  return page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    return [...document.querySelectorAll('button, input, select, textarea, a[href], [role="button"], [role="radio"], [role="slider"]')]
      .filter((e) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !e.closest('.aladin-logo, .aladin-logo-container'))
      .map((e) => {
        // only the part you can see: clip by scrolling panels
        let r = e.getBoundingClientRect();
        let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let a = e.parentElement; a; a = a.parentElement) {
          if (getComputedStyle(a).overflow === 'visible') continue;
          const c = a.getBoundingClientRect();
          box = { left: Math.max(box.left, c.left), top: Math.max(box.top, c.top), right: Math.min(box.right, c.right), bottom: Math.min(box.bottom, c.bottom) };
        }
        return { e, r: { ...box, width: box.right - box.left, height: box.bottom - box.top } };
      })
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .filter(({ r }) => r.left < W * 0.06 - 0.5 || r.top < H * 0.06 - 0.5 || r.right > W * 0.94 + 0.5 || r.bottom > H * 0.94 + 0.5)
      .map(({ e, r }) => `${(e.getAttribute('aria-label') || e.textContent || e.id || e.className || e.tagName).trim().slice(0, 30)} @ ${Math.round(r.left)},${Math.round(r.top)}`);
  });
}

for (const [w, h] of [[1280, 800], [1920, 1080]]) {
  test(`eye tracking: no control within 6% of the screen edges (${w}x${h})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await ready(page);
    expect(await controlsNearEdges(page), 'sky view').toEqual([]);
    await page.goto('/?ra=269.44627&dec=4.7682&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
    await ready(page);
    await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60_000 });
    for (const show of ['timelapse', 'video', 'blink', 'wise', 'gaia', 'nogaia']) {
      await page.evaluate((show) => meridian.run('set_show', { show }), show);
      await page.waitForTimeout(300);
      expect(await controlsNearEdges(page), `field view, ${show}`).toEqual([]);
    }
  });
}

test('2D view: one list of what to show; choices exclude each other; old links still open', async ({ page }) => {
  await page.goto('/?ra=269.44627&dec=4.7682&fov=0.5&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60_000 });
  const list = page.getByRole('radiogroup', { name: 'What to show' });
  await expect(list.getByRole('radio')).toHaveText([/Time-lapse/, /Change video/, /Blink two dates/, /(Side by side with|Beside) WISE/, /(Side by side with|Beside) Gaia/, /Not in Gaia/]);
  const state = () => page.evaluate(() => [meridian.store.get().op, meridian.store.get().compare]);
  await list.getByRole('radio', { name: /Change video/ }).click();
  expect(await state()).toEqual(['video', 'off']);
  await list.getByRole('radio', { name: /Side by side with WISE/ }).click(); // replaces the video
  expect(await state()).toEqual(['none', 'side']);
  await expect(list.getByRole('radio', { name: /Side by side with WISE/ })).toHaveAttribute('aria-checked', 'true');
  await expect(list.getByRole('radio', { name: /Change video/ })).toHaveAttribute('aria-checked', 'false');
  await page.locator('#field-title').focus();
  await page.keyboard.press('b'); // blink replaces WISE
  expect(await state()).toEqual(['blink', 'off']);
  await page.keyboard.press('t');
  expect(await state()).toEqual(['none', 'off']);
  // a link to the old timeline mode still opens it (no button, nothing checked)
  await page.goto('/?ra=269.44627&dec=4.7682&fov=0.5&band=92&view=field&ffov=0.1&mode=detector&compare=timeline');
  await ready(page);
  await expect(page.locator('.ctx-timeline')).toBeVisible({ timeout: 60_000 });
});

// Eye tracking: every clickable at least 64 x 64 px, and not covered by anything else.
async function smallOrCovered(page, min = 64) {
  return page.evaluate((min) =>
    [...document.querySelectorAll('button, input, select, textarea, a[href], summary, [role="button"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"]')]
      .filter((e) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .flatMap(({ e, r }) => {
        const name = (e.getAttribute('aria-label') || e.textContent || e.id || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 30);
        const out = [];
        if (r.width < min - 0.5 || r.height < min - 0.5) out.push(`${name}: ${Math.round(r.width)}x${Math.round(r.height)}`);
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (t && !e.contains(t) && !t.contains(e)) out.push(`${name}: covered`);
        return out;
      }),
    min,
  );
}

// Sizes: 64 px everywhere, except the 2D view in mouse mode, sized by the screen's height so its six titled
// sections fit (36-64 px; mouse users first, 16 Nov 2026). Eye control keeps 64 px or more.
for (const [w, h, min2d] of [[1280, 800, 40], [1920, 1080, 60]]) {
  test(`every control is big enough and reachable: sky 64 px, 2D ${min2d} px (${w}x${h})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await ready(page);
    expect(await smallOrCovered(page), 'sky view').toEqual([]);
    await page.goto('/?ra=269.44627&dec=4.7682&fov=2.6&band=92&view=field&ffov=0.1&mode=detector');
    await ready(page);
    await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60_000 });
    for (const show of ['timelapse', 'video', 'blink', 'wise', 'gaia', 'nogaia']) {
      await page.evaluate((s) => meridian.run('set_show', { show: s }), show);
      await page.waitForTimeout(400);
      expect(await smallOrCovered(page, min2d), `2D view, ${show}`).toEqual([]);
      // the controls column fits without scrolling (gaze cannot scroll easily)
      expect(await page.evaluate(() => { const r = document.querySelector('.player-right'); return r.scrollHeight - r.clientHeight; }), `2D ${show} scroll`).toBeLessThanOrEqual(1);
    }
    if (min2d === 64) {
      // eye control on: 64 px targets in the 2D view too
      await page.evaluate(() => meridian.run('set_input_mode', { mode: 'gaze' }));
      await page.evaluate(() => meridian.run('set_show', { show: 'timelapse' }));
      await page.waitForTimeout(400);
      expect(await smallOrCovered(page, 64), '2D view, eye control').toEqual([]);
    }
  });
}

test('opens in the Grey colour view; no button text spills out of its frame (Planetarium)', async ({ page }) => {
  await page.goto('/?fov=60');
  await ready(page);
  expect(await page.evaluate(() => meridian.store.get().color)).toBe('grey');
  await page.evaluate(() => meridian.run('toggle_panel', { open: true }));
  await expect(page.locator('[data-proj="STG"]')).toBeVisible();
  const spill = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent && (b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1))
      .map((b) => b.textContent.trim()),
  );
  expect(spill).toEqual([]);
});

test('loading: a bar over the image while images load; Play pressed meanwhile starts once they are in', async ({ page }) => {
  await page.route('**/api/frames?*', async (route) => {
    await new Promise((r) => setTimeout(r, 2500)); // a slow archive
    await route.continue();
  });
  await page.goto('/?ra=269.44627&dec=4.7682&fov=2.3&band=92&view=field&ffov=0.1&mode=detector');
  const bar = page.locator('#player-loading');
  await expect(bar).toBeVisible();
  await expect(page.locator('#pl-text')).toContainText('Finding SPHEREx images');
  await page.evaluate(() => meridian.run('set_show', { show: 'video' }));
  await expect(page.locator('#p-play')).toBeEnabled(); // pressable while loading
  await page.locator('#p-play').click();
  await expect(bar).toBeHidden({ timeout: 60_000 });
  expect(await page.evaluate(() => meridian.store.get().playing)).toBe(true);
  const first = await page.evaluate(() => meridian.player.getShownFrame()?.meta?.date_iso);
  await expect.poll(() => page.evaluate(() => meridian.player.getShownFrame()?.meta?.date_iso), { timeout: 15_000 }).not.toBe(first);
});

test('not in Gaia: WISE 0855 in D6 is a candidate at the target; the same patch in D1 has none', async ({ page }) => {
  await page.goto('/?ra=133.75976&dec=-7.24219&fov=2.3&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('n');
  await expect(page).toHaveURL(/op=nogaia/);
  const caption = page.locator('#player-caption');
  await expect(caption).toContainText('(your target)', { timeout: 30_000 });
  await expect(caption).toContainText('candidates, not discoveries');
  await expect(page.locator('#nogaia-marks .cand').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: /Not in Gaia/ })).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => meridian.run('set_detector', { detector: 1 }));
  await expect(caption).toContainText('Every source here has a Gaia star', { timeout: 60_000 });
});

test('mouse mode: a white star on each section title explains the section on hover; none on buttons or in eye control', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?ra=269.44627&dec=4.7682&fov=2.3&band=40&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60_000 });
  // one star per titled section of the 2D view: Zoom, Detector, View, Measure, Dates, Playback
  await expect.poll(() => page.locator('.hint-badge').count()).toBe(6);
  const title = await page.locator('#fsec-zoom .fsec-text').boundingBox();
  const star = await page.evaluate(() => [...document.querySelectorAll('.hint-badge')].map((b) => b.getBoundingClientRect()).find(Boolean));
  const badges = await page.evaluate(() => [...document.querySelectorAll('.hint-badge')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
  const zoomStar = badges.find((b) => Math.abs(b.y - (title.y + title.height / 2)) < 12 && b.x > title.x + title.width);
  expect(zoomStar, 'a star right after "Zoom"').toBeTruthy();
  expect(star).toBeTruthy();
  // no star sits on a button
  const onButton = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.hint-badge')].filter((b) => {
        const r = b.getBoundingClientRect();
        return document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).some((e) => e.tagName === 'BUTTON');
      }).length,
    );
  await expect.poll(onButton).toBe(0);
  // hovering it explains the section; it is not a control
  await page.mouse.move(zoomStar.x, zoomStar.y);
  await expect(page.locator('.hint-bubble')).toHaveText(/How much sky the 2D images cover/);
  await page.mouse.move(400, 400);
  await expect(page.locator('.hint-bubble')).toBeHidden();
  // eye control: no stars
  await page.evaluate(() => meridian.run('set_input_mode', { mode: 'gaze' }));
  await expect(page.locator('.hint-badge')).toHaveCount(0);
  await page.evaluate(() => meridian.run('set_input_mode', { mode: 'mouse' }));
  await expect.poll(() => page.locator('.hint-badge').count()).toBe(6);
  // the sky panel's sections have theirs too (Places, View, Colours)
  await page.evaluate(() => meridian.run('close_field'));
  await page.evaluate(() => meridian.run('toggle_panel', { open: true }));
  await expect.poll(() => page.locator('.hint-badge').count()).toBe(3);
});

test('SED: key e draws Gaia and SPHEREx on one graph with a blackbody temperature (eps Ind B)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?ra=331.09664&dec=-56.80066&fov=2.3&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('e');
  await expect(page.locator('#spec-title')).toHaveText('Energy distribution (SED)');
  await expect(page.getByRole('radio', { name: /SED with Gaia/ })).toHaveAttribute('aria-checked', 'true');
  const summary = page.locator('#spec-summary');
  await expect(summary).toContainText('Gaia DR3 6412596012146801152', { timeout: 120_000 });
  await expect(summary).toContainText(/Blackbody fit: about [\d,]+ K/, { timeout: 180_000 });
  await expect(page.locator('#spec-svg .sed-fit')).toHaveCount(1);
  await expect(page.locator('#spec-svg circle').first()).toBeVisible(); // SPHEREx points
  await page.getByRole('radio', { name: /SPHEREx spectrum/ }).click();
  await expect(page.locator('#spec-title')).toHaveText('Spectrum');
});

test('Calibrate button: next to Controls while the panel is open; says what is missing without a tracker', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?fov=60');
  await ready(page);
  const btn = page.locator('#calibrate-btn');
  await expect(btn).toBeVisible();
  const [t, c, s] = await Promise.all(['#panel-toggle', '#calibrate-btn', '.shell-top'].map((q) => page.locator(q).boundingBox()));
  expect(c.x).toBeGreaterThan(t.x + t.width); // right of "Controls"
  expect(Math.abs(c.y - t.y)).toBeLessThan(2); // same row
  expect(c.x + c.width).toBeLessThanOrEqual(s.x); // not under the search bar
  await btn.click();
  await expect(page.locator('#status')).toContainText('No eye tracker connected');
  await page.evaluate(() => meridian.run('toggle_panel', { open: false }));
  await expect(btn).toBeHidden();
});

test('full eye control: bigger buttons (sky ~80 px, 2D ~74 px at 1920x1080), the 2D controls still fit', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?fov=60&input=gaze');
  await ready(page);
  const minSize = () =>
    page.evaluate(() => Math.min(...[...document.querySelectorAll('button')].filter((b) => b.checkVisibility()).map((b) => b.getBoundingClientRect()).filter((r) => r.width).map((r) => Math.min(r.width, r.height))));
  expect(await minSize()).toBeGreaterThanOrEqual(78);
  await page.goto('/?ra=269.44627&dec=4.7682&fov=2.3&band=40&view=field&ffov=0.1&mode=detector&input=gaze');
  await ready(page);
  await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60_000 });
  for (const show of ['timelapse', 'video', 'blink', 'nogaia']) {
    await page.evaluate((s) => meridian.run('set_show', { show: s }), show);
    await page.waitForTimeout(300);
    expect(await minSize(), `2D ${show}`).toBeGreaterThanOrEqual(72);
    expect(await page.evaluate(() => { const r = document.querySelector('.player-right'); return r.scrollHeight - r.clientHeight; }), `2D ${show} scroll`).toBeLessThanOrEqual(1);
  }
});
