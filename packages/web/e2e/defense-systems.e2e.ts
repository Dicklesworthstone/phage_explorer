import { test, expect } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';

/**
 * Smoke test that verifies the heuristic defense-system annotations are
 * actually surfaced in the web UI.
 *
 * The DefenseArmsRaceOverlay is gated behind the 'power' experience level, so
 * we pre-seed localStorage with that level and skip the welcome modal.
 */
test('defense systems overlay renders heuristic annotations', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);

  await page.goto('http://localhost:5173');

  // Seed persisted main-store preferences so the overlay is not gated.
  await page.evaluate(() => {
    localStorage.setItem(
      'phage-explorer-main-prefs',
      JSON.stringify({ experienceLevel: 'power' })
    );
  });

  // Clear any cached SQLite database so the build picks up the new phage.db.
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('phage-explorer-db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  });

  // Reload so the app hydrates with the seeded preferences and fresh DB.
  await page.reload();

  // Wait for the app shell to render.
  await page.waitForSelector('#root > div', { timeout: 30000 });

  // Dismiss the welcome modal if it appears.
  const skipWelcome = page.locator('button:has-text("Skip")').first();
  if (await skipWelcome.isVisible().catch(() => false)) {
    await skipWelcome.click();
  }

  // Select T7, which has heuristic defense-system annotations in the DB.
  const t7Item = page.locator('[data-testid="phage-list-item"]', { hasText: /T7/i }).first();
  await t7Item.click();

  // Open the defense arms race overlay via the command palette.
  await page.keyboard.press('Control+k');
  const palette = page.locator('[data-testid="overlay-commandPalette"]');
  await palette.waitFor({ timeout: 10000 });

  const input = page.locator('[data-testid="command-palette-input"]');
  await input.fill('defense arms race');

  const item = palette.locator('[role="option"]', { hasText: /Defense arms race/i }).first();
  await expect(item).toBeVisible();
  await item.click();

  // Wait for the overlay title and check for the anti-defense system labels.
  const overlay = page.locator('[data-testid="overlay-defenseArmsRace"]').last();
  await overlay.waitFor({ timeout: 10000 });

  const bodyText = await overlay.textContent();
  expect(bodyText).toMatch(/DEFENSE ARMS RACE/i);

  // Wait for the async defense-system data to load.
  await overlay.locator('text=/No defense system annotations|anti-RM|Anti-CRISPR/i')
    .first()
    .waitFor({ timeout: 10000 });

  // For T7 we expect at least one of the heuristic hits to appear.
  const hasAntiCrispr = await overlay.locator('text=/Anti-CRISPR/i').first().isVisible().catch(() => false);
  const hasAntiRM = await overlay.locator('text=/anti-RM/i').first().isVisible().catch(() => false);
  expect(hasAntiCrispr || hasAntiRM).toBe(true);

  await finalize();
});
