// The five challenge targets work with no API at all: their answers ship as static files
// (web/public/data/api, written by api/export_static.py; served by src/core/staticApi.js).
import { test, expect } from '@playwright/test';

const TARGETS = ['barnard', 'eps_ind_b', 'wise_0855', 'rw_aur', 'r_dra'];
// what the target's field view asks for; none of it may reach the network
const FIELD_DATA = /\/api\/(resolve|frames|cutout|context|spectrum)/;

for (const id of TARGETS) {
  test(`no API: ${id} opens its time-lapse, WISE and Gaia from static files`, async ({ page }) => {
    const networkHits = [];
    // the API only (a '**/api/**' glob would also block the static files under /data/api/)
    await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
      if (FIELD_DATA.test(route.request().url())) networkHits.push(route.request().url());
      return route.abort(); // the API is gone
    });
    const errors = [];
    page.on('pageerror', (e) => {
      const text = `${e} ${(e.stack ?? '').split('\n').slice(0, 4).join(' / ')}`;
      if (!/tg\.log/.test(text)) errors.push(text); // Aladin's usage logger (harmless, see CLAUDE.md)
    });
    page.on('console', (m) => m.type() === 'error' && /\[(context|spectrum|player|field)/i.test(m.text()) && errors.push(m.text()));

    await page.goto('/?tour=0&gaze=off');
    await page.waitForFunction(() => window.meridian && document.querySelector('#controls'));
    await page.evaluate((pid) => meridian.run('go_preset', { id: pid }).value, id); // what the Places button runs
    await page.evaluate(() => meridian.run('open_field'));
    await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => meridian.player.getSequence().length > 0, null, { timeout: 30_000 });
    const frames = await page.evaluate(() => meridian.player.getSequence().map((f) => [f.w, f.h]));
    for (const f of frames) expect(f).toEqual([59, 59]);

    // every band mode the player offers at the default field (ingest cached exactly these)
    for (const d of [1, 2, 3, 4, 5, 6]) {
      await page.evaluate((det) => meridian.run('set_detector', { detector: det }), d);
      await page.waitForTimeout(800);
    }
    await page.evaluate(() => meridian.run('set_band', { band: 92 }));
    await page.evaluate(() => meridian.run('set_mode', { mode: 'single' }));
    await page.waitForTimeout(800);
    await page.evaluate(() => meridian.run('set_mode', { mode: 'rgb' }));
    await page.waitForTimeout(800);
    await page.evaluate(() => meridian.run('set_show', { show: 'video' })); // moving objects
    await page.waitForTimeout(800);
    // spectrum and SED at the target
    await page.evaluate(() => meridian.run('select_point'));
    await expect(page.locator('#spec-status')).toContainText(/from \d+ images/, { timeout: 30_000 });
    await page.evaluate(() => meridian.run('set_spectrum_view', { view: 'sed' }));
    await page.waitForTimeout(800);
    await page.evaluate(() => meridian.run('close_spectrum'));

    await page.evaluate(() => meridian.run('set_show', { show: 'wise' }));
    await expect(page.locator('#wise-img')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => meridian.run('set_show', { show: 'gaia' }));
    await expect(page.locator('#wise-label')).toContainText('drawn from the catalogue', { timeout: 30_000 });

    expect(networkHits).toEqual([]);
    expect(errors).toEqual([]);
  });
}
