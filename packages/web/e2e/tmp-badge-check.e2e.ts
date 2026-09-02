import { test, expect } from '@playwright/test';
test.use({ serviceWorkers: 'block' });
test('provenance badge renders in an overlay header', async ({ page }) => {
  test.setTimeout(300000);
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  await page.goto('http://localhost:5173');
  await page.waitForSelector('#root > div', { timeout: 60000 });
  const skip = page.locator('button:has-text("Skip")').first();
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/phage/i, { timeout: 60000 });

  const btn = page.getByRole('button', { name: /command palette/i }).first();
  await btn.click();
  await page.locator('[data-testid="overlay-commandPalette"]').waitFor({ timeout: 30000 });
  // 1. Badge visible in the palette list, before the overlay opens.
  const opt = page.locator('[data-testid="overlay-commandPalette"] [role="option"]', { hasText: /Virion stability/i }).first();
  await page.locator('[data-testid="command-palette-input"]').fill('virion stability');
  await expect(opt).toBeVisible({ timeout: 30000 });
  const optText = await opt.innerText();
  console.log('[palette row]', optText.replace(/\s+/g, ' '));
  expect(optText).toMatch(/heuristic/i);

  // 2. Badge visible in the overlay header, after opening.
  await opt.click();
  const overlay = page.locator('[data-testid="overlay-stability"]');
  await overlay.waitFor({ timeout: 30000 });
  const header = await overlay.innerText();
  console.log('[overlay head]', header.replace(/\s+/g, ' ').slice(0, 200));
  expect(header).toMatch(/heuristic/i);
});
