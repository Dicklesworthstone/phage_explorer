import { test } from '@playwright/test';
test.use({ serviceWorkers: 'block' });
test('debug phylo loading', async ({ page }) => {
  page.on('console', m => console.log(`[console:${m.type()}]`, m.text().slice(0, 300)));
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 400)));
  page.on('requestfailed', r => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));
  await page.route('https://eutils.ncbi.nlm.nih.gov/**', r => { console.log('[routed]', r.request().url().slice(0,120)); return r.abort(); });

  await page.goto('http://localhost:5173');
  await page.evaluate(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  await page.reload();
  await page.waitForSelector('#root > div', { timeout: 30000 });
  const skip = page.locator('button:has-text("Skip")').first();
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await page.keyboard.press('Control+k');
  await page.locator('[data-testid="overlay-commandPalette"]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid="command-palette-input"]').fill('phylodynamics');
  await page.locator('[data-testid="overlay-commandPalette"] [role="option"]', { hasText: /Phylodynamics/i }).first().click();
  await page.locator('[data-testid="overlay-phylodynamics"]').waitFor({ timeout: 20000 });

  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    const txt = (await page.locator('[data-testid="overlay-phylodynamics"]').innerText()).replace(/\s+/g, ' ');
    console.log(`[t=${(i + 1) * 5}s]`, txt.slice(0, 220));
    if (!/LOADING/i.test(txt)) { console.log('>>> SETTLED'); break; }
  }
});
