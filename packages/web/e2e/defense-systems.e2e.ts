import { test, expect } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

/**
 * Smoke test that verifies the heuristic defense-system annotations are
 * actually surfaced in the web UI.
 *
 * The DefenseArmsRaceOverlay is gated behind the 'power' experience level, so
 * we pre-seed localStorage with that level and skip the welcome modal.
 */
test('defense systems overlay renders heuristic annotations', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);

  // Seed before hydration in this test's fresh browser context.
  await page.addInitScript(() => {
    localStorage.setItem(
      'phage-explorer-main-prefs',
      JSON.stringify({ experienceLevel: 'power' })
    );
  });

  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, testInfo);

  // Dismiss the welcome modal if it appears.
  const skipWelcome = page.locator('button:has-text("Skip")').first();
  if (await skipWelcome.isVisible().catch(() => false)) {
    await skipWelcome.click();
  }

  // Select T7, which has heuristic defense-system annotations in the DB.
  const t7Item = page.locator('[data-testid="phage-list-item"]', { hasText: /T7/i }).first();
  await t7Item.click();
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('Enterobacteria phage T7');

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

  // Wait for the async defense-system data to load (an actual annotation, not
  // just the empty-state message).
  await expect(
    overlay.locator('text=/anti-RM|Anti-CRISPR|anti-Abi/i').first()
  ).toBeVisible({ timeout: 10000 });

  // For T7 we expect at least one of the heuristic hits to appear.
  const hasAntiCrispr = await overlay.locator('text=/Anti-CRISPR/i').first().isVisible().catch(() => false);
  const hasAntiRM = await overlay.locator('text=/anti-RM/i').first().isVisible().catch(() => false);
  expect(hasAntiCrispr || hasAntiRM).toBe(true);

  await finalize();
});
