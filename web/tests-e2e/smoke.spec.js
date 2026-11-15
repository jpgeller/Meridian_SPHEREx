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
  await page.getByRole('button', { name: 'Sky tools' }).click();
  await expect(page.getByRole('button', { name: 'Planetarium' })).toBeHidden();
  await page.evaluate(() => meridian.run('toggle_tools'));
  await expect(page.getByRole('button', { name: 'Planetarium' })).toBeVisible();
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

test('zooming in keeps the same all-sky images everywhere (full-resolution layer is off)', async ({ page }) => {
  await page.goto('/?ra=269.44627&dec=4.7682&fov=0.3&band=37&color=grey');
  await ready(page);
  await page.waitForTimeout(2000);
  await expect(page.locator('#status')).not.toContainText('Full-resolution');
  expect(await page.evaluate(() => meridian.commands.list().some((c) => c.name === 'toggle_native'))).toBe(false);
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
  await expect(caption).toContainText('Steady background'); // the default: still stars stay still
  await page.getByRole('checkbox', { name: 'Steady background' }).uncheck(); // each real image as it is
  await page.locator('#p-play').click(); // pause (Space on the focused checkbox would tick it again)
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
  // it starts near the top right (the pop-up's corner) and lands on D6 in about 600 ms
  const start = await pointerTip(page);
  expect(start.x).toBeGreaterThan(640);
  await expect.poll(async () => (await pointerTip(page))?.flying, { timeout: 2000 }).toBe(false);
  const d6 = await page.evaluate(() => guide.resolve('band-d6'));
  const tip = await pointerTip(page);
  expect(Math.abs(tip.x - d6.x)).toBeLessThan(1); // centred, on the top edge (the arrow sits above it)
  expect(tip.y).toBeGreaterThan(d6.rect.y);
  expect(tip.y).toBeLessThan(d6.rect.y + 12);
  // the label is on screen and does not sit on the tip
  const label = page.locator('#guide-overlay .go-label');
  await expect(label).toHaveText('Longest wavelengths');
  await expect(label).not.toHaveClass(/is-hidden/);
  const lb = await label.boundingBox();
  expect(lb.y + lb.height).toBeLessThanOrEqual(800);
  expect(tip.x >= lb.x && tip.x <= lb.x + lb.width && tip.y >= lb.y && tip.y <= lb.y + lb.height).toBe(false);
  // the overlay never takes a click: the button under the tip gets it
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).closest('[data-guide]')?.dataset.guide, tip)).toBe('band-d6');
  await page.mouse.click(tip.x, tip.y);
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
  expect(Math.abs(tip.x - s.x)).toBeLessThan(1); // on the bottom edge: the search box is at the top
  expect(tip.y).toBeGreaterThan(s.rect.y + s.rect.h - 12);
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
  const b = await card.boundingBox();
  expect(b.x + b.width).toBeGreaterThan(1200);
  expect(b.y).toBeLessThan(40);
  expect(await card.evaluate((el) => +getComputedStyle(el).zIndex)).toBeGreaterThanOrEqual(50);
  // Tab from the page reaches Yes, then No thanks (real buttons)
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.dataset.answer)).toBe('yes');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => [document.activeElement.tagName, document.activeElement.textContent])).toEqual(['BUTTON', 'No thanks']);
  // Esc closes the card (a decline) and gives the focus back
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.__offer)).toBe('dismissed');
  expect(await page.evaluate(() => window.__no)).toBe('dismissed');
  expect(await page.evaluate(() => document.activeElement.closest('[data-guide="guide-popup"]'))).toBeNull();
  // the same target is not offered again inside the cool-down; another one is
  expect(await page.evaluate(() => guide.offer({ text: 'Again?', target: 'sky:barnard' }))).toBe('cooling');
  await expect(card).toBeHidden();
  await page.evaluate(() => {
    window.__second = guide.offer({ text: 'Wondering about these colours?', target: 'band-ribbon' });
  });
  await expect(card).toContainText('colours');
  // while one card is open, a new offer is refused
  expect(await page.evaluate(() => guide.offer({ text: 'Third', target: 'search' }))).toBe('busy');
  await card.getByRole('button', { name: 'No thanks' }).click();
  expect(await page.evaluate(() => window.__second)).toBe('no');
  expect(errors()).toEqual([]);
});

test('guide pop-up: Yes opens a step, answers resolve say(), a step over its target moves away, Esc beats "back to sky"', async ({ page }) => {
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
  await expect(card.locator('button')).toHaveText(['Got it', 'Show me more', 'Close']);
  expect(await page.evaluate(() => guide.popup.kind())).toBe('step');
  await expect.poll(() => page.evaluate(() => document.activeElement.dataset.answer)).toBe('got_it');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.__answer)).toBe('more');

  // a step whose target sits under the card moves (full text) to the top left; one elsewhere stays
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.dataset.guide = 'test-under-card';
    el.style.cssText = 'position:fixed; top:60px; right:40px; width:60px; height:40px;';
    document.body.append(el);
  });
  const long = 'SPHEREx takes one picture of each spot at a time, and over months it builds a spectrum in 102 colours.';
  page.evaluate((say) => guide.say({ say, target: 'band-d1' }), long);
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => guide.popup.spot())).toBe('top-right');
  const full = (await card.boundingBox()).height;
  page.evaluate((say) => guide.say({ say, target: 'test-under-card' }), long);
  await expect.poll(() => page.evaluate(() => guide.popup.spot())).toBe('top-left');
  await expect(card.locator('.gp-text')).toHaveText(long);
  // after the slide: clear of the target and the search bar, same height (nothing cut)
  await expect.poll(async () => (await card.boundingBox()).x).toBeLessThan(20);
  const moved = await card.boundingBox();
  const under = await page.locator('[data-guide="test-under-card"]').boundingBox();
  expect(moved.x + moved.width).toBeLessThan(under.x);
  expect(moved.height).toBe(full);
  const search = await page.locator('#search').boundingBox();
  expect(moved.y).toBeGreaterThan(search.y + search.height);
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

test('guide pop-up: a step about a star under the top-right corner moves the card off the star', async ({ page }) => {
  // Barnard's Star lands under the top-right card at this view
  await page.goto('/?ra=276.7&dec=0.3&fov=20');
  await ready(page);
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard')), { timeout: 15000 }).not.toBeNull();
  const star = await page.evaluate(() => guide.resolve('sky:barnard'));
  expect(star.x).toBeGreaterThan(928); // where the default card would be
  expect(star.y).toBeLessThan(226);
  const say = 'Barnard’s Star moves across the sky faster than any other star: about the width of the full Moon every 180 years.';
  await page.evaluate((s) => {
    guide.say({ say: s, target: 'sky:barnard' });
  }, say);
  const card = page.locator('[data-guide="guide-popup"]');
  await expect(card.locator('.gp-text')).toHaveText(say); // the whole text, nothing cut
  await expect.poll(() => page.evaluate(() => guide.popup.spot())).not.toBe('top-right');
  // once it has slid away the star is visible to everyone again (gaze, overlay), and not under the card
  await expect.poll(() => page.evaluate(() => guide.resolve('sky:barnard'))).not.toBeNull();
  const b = await card.boundingBox();
  const p = await page.evaluate(() => guide.resolve('sky:barnard'));
  const pad = 24 + (p.r ?? 0);
  const inside = p.x > b.x - pad && p.x < b.x + b.width + pad && p.y > b.y - pad && p.y < b.y + b.height + pad;
  expect(inside).toBe(false);
  // the guide's pointer flies from the card's new place
  await page.evaluate(() => guide.pointAt('sky:barnard'));
  const from = await page.evaluate(() => {
    const m = document.querySelector('#guide-overlay .go-pointer').style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px/);
    return { x: +m[1], y: +m[2] };
  });
  expect(Math.abs(from.x - (b.x + b.width / 2))).toBeLessThan(60);
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
  await expect(card.locator('button')).toHaveText(['Show me more', 'Close']);
  expect(await page.evaluate(() => meridian.store.get().band)).toBe(93);
  // the guide's own command did not clear its circle
  expect(await page.evaluate(() => guide.overlay.active())).toEqual(['circle:band-d6']);
  await card.getByRole('button', { name: 'Show me more' }).click();
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
  await card.getByRole('button', { name: 'Show me more' }).click();
  await expect(card).toContainText('D6');
  expect(await page.evaluate(() => meridian.store.get().band)).toBe(93);
  await card.getByRole('button', { name: 'Show me more' }).click();
  await card.getByRole('button', { name: 'Got it' }).click();
  await expect.poll(() => page.evaluate(() => window.__how)).toBe('done');
  await expect.poll(() => page.evaluate(() => guide.overlay.active().length)).toBe(0);

  await page.evaluate(() => {
    window.__how = null;
    guide.fallback('object', { id: 'sky:barnard' }).then((how) => (window.__how = how));
  });
  await expect(card).toContainText("Barnard's Star");
  await card.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => page.evaluate(() => window.__how)).toBe('closed');
  await expect(card).toBeHidden();
  expect(errors().filter((e) => !/\/api\//.test(e))).toEqual([]);
});

// --- guide attention (U6) ---

test('guide attention: with ?gaze=mouse, resting the mouse on Barnard\'s Star for 7 s shows the offer; Yes starts the guide', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?ra=269.45&dec=4.74&fov=20&gaze=mouse');
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
  await expect(card).toContainText('Want help identifying this?', { timeout: 10000 });
  expect(Date.now() - t0).toBeGreaterThan(6500); // about 7 s
  await expect(ring).not.toHaveClass(/is-on/);
  await card.getByRole('button', { name: 'Yes' }).click();
  await expect(card).toContainText("Barnard's Star");
  expect(await page.evaluate(() => guide.runner.isRunning())).toBe(true);
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toBeHidden();
  // still on the star, but inside the 60 s cool-down: no ring, no offer
  await page.mouse.move(star.x + 15, star.y);
  await page.waitForTimeout(1600);
  await expect(ring).not.toHaveClass(/is-on/);
  expect(errors()).toEqual([]);
});

test('guide attention: without ?gaze=mouse the mouse is ignored; gaze samples (U9 feed) ask about the colours', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?fov=60');
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
  await expect(card).toContainText('Wondering about these colours?', { timeout: 5000 });
  await card.getByRole('button', { name: 'No thanks' }).click();
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
  await expect(card).toContainText('Want to see what changed?');
  await card.getByRole('button', { name: 'Yes' }).click();
  await expect(card).toContainText('replaying the same visits');
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
  await card.getByRole('button', { name: 'Show me more' }).click();
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
  await card.getByRole('button', { name: 'Close' }).click();
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
  await page.getByRole('radio', { name: 'Side by side with Gaia' }).click();
  await expect(page).toHaveURL(/compare=gaia/);
  const label = page.locator('#wise-label');
  await expect(label).toContainText('drawn from the catalogue, not a photograph', { timeout: 60_000 });
  await expect(label).toContainText(/\d+ stars at .*2025/);
  await expect(page.locator('#gaia-canvas')).toBeVisible();
  await expect(page.locator('#wise-img')).toBeHidden();
  expect(Number(await page.locator('#gaia-canvas').getAttribute('data-drawn'))).toBeGreaterThan(100);
  await page.getByRole('radio', { name: 'Side by side with WISE' }).click();
  await expect(page.locator('#wise-img')).toBeVisible();
  await expect(page.locator('#gaia-canvas')).toBeHidden();
  expect(errors()).toEqual([]);
});
