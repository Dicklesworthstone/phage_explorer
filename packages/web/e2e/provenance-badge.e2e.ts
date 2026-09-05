import { test, expect } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

/**
 * The provenance badge must actually render.
 *
 * This spec exists because the structural tests were not enough. They asserted
 * that `OverlayProvenance` was imported and used in CommandPalette.tsx, that the
 * shared `Overlay` reads the level from the registry, and that measured is
 * exempt. All of that passed while the badge rendered nowhere in the palette,
 * because the palette has TWO result lists -- recent commands and filtered
 * results -- and only one had been edited.
 *
 * A grep for a component name proves the component is mentioned. It does not
 * prove a user sees it. This opens the app and reads the pixels' text.
 *
 * Fast (about 4 s) because it reuses one page load for both assertions.
 */

test.use({ serviceWorkers: 'block' });

test('the provenance level is visible before and after opening an overlay', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const { finalize } = setupTestHarness(page, testInfo);

  await page.addInitScript(() =>
    localStorage.setItem(
      'phage-explorer-main-prefs',
      JSON.stringify({ experienceLevel: 'power' })
    )
  );
  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, testInfo);

  const skip = page.locator('button:has-text("Skip")').first();
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await page.getByRole('button', { name: /command palette/i }).first().click();
  const palette = page.locator('[data-testid="overlay-commandPalette"]');
  await palette.waitFor({ timeout: 30000 });

  // 1. Before opening. This is the case the badge exists for: the niche network
  // carried an honest disclaimer inside its body and sat in the plain Analysis
  // category, so the user learned what it was only after choosing it.
  await page.locator('[data-testid="command-palette-input"]').fill('virion stability');
  const option = palette
    .locator('[role="option"]', { hasText: /Virion stability/i })
    .first();
  await expect(option).toBeVisible({ timeout: 30000 });
  await expect(option).toContainText(/heuristic/i);

  // 2. After opening, from the shared Overlay chrome rather than from anything
  // the VirionStability component does itself.
  await option.click();
  const overlay = page.locator('[data-testid="overlay-stability"]');
  await overlay.waitFor({ timeout: 30000 });
  await expect(overlay).toContainText(/heuristic/i);
  await finalize();
});

test('a measured overlay carries no badge', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const { finalize } = setupTestHarness(page, testInfo);

  // The discrimination check. If the badge rendered on everything, the test
  // above would pass and the label would carry no information: measured is the
  // overwhelming majority, and a badge on every panel is a badge nobody reads.
  await page.addInitScript(() =>
    localStorage.setItem(
      'phage-explorer-main-prefs',
      JSON.stringify({ experienceLevel: 'power' })
    )
  );
  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, testInfo);

  const skip = page.locator('button:has-text("Skip")').first();
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await page.getByRole('button', { name: /command palette/i }).first().click();
  const palette = page.locator('[data-testid="overlay-commandPalette"]');
  await palette.waitFor({ timeout: 30000 });
  await page.locator('[data-testid="command-palette-input"]').fill('gc skew');

  const option = palette.locator('[role="option"]', { hasText: /GC skew/i }).first();
  await expect(option).toBeVisible({ timeout: 30000 });
  await expect(option).not.toContainText(/heuristic|demo data|simulation/i);
  await finalize();
});
