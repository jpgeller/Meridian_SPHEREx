// The 2D view's Measure section: Spectrum and SED with Gaia as buttons (not only keys s / e).
import { test, expect } from '@playwright/test';

const ready = (page) => page.waitForFunction(() => window.meridian && document.querySelector('#controls'));

test('Measure: Spectrum and SED with Gaia open the panel on the target, show as pressed, close on a second press', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.goto('/?ra=331.09664&dec=-56.80066&fov=2.3&band=92&view=field&ffov=0.1&mode=detector');
  await ready(page);
  await expect(page.locator('.epoch').first()).toBeVisible({ timeout: 60_000 });
  const spectrumBtn = page.getByRole('button', { name: /^Spectrum/ });
  const sedBtn = page.getByRole('button', { name: /^SED with Gaia/ });
  await expect(spectrumBtn).toBeVisible();
  await expect(sedBtn).toBeVisible();
  // SED
  await sedBtn.click();
  await expect(page.locator('.spectrum')).toBeVisible();
  await expect(page.locator('#spec-title')).toHaveText('Energy distribution (SED)');
  await expect(sedBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(spectrumBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#spec-summary')).toContainText('Gaia DR3', { timeout: 120_000 });
  // switch to the spectrum, then close it with a second press
  await spectrumBtn.click();
  await expect(page.locator('#spec-title')).toHaveText('Spectrum');
  await expect(spectrumBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(sedBtn).toHaveAttribute('aria-pressed', 'false');
  await spectrumBtn.click();
  await expect(page.locator('.spectrum')).toBeHidden();
  await expect(spectrumBtn).toHaveAttribute('aria-pressed', 'false');
  // the panel's own Close resets the buttons too
  await sedBtn.click();
  await expect(sedBtn).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#spec-close').click();
  await expect(sedBtn).toHaveAttribute('aria-pressed', 'false');
});
