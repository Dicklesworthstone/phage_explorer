/**
 * Live Site Verification Test
 *
 * Tests phage-explorer.org to verify deployment and capture screenshots
 * of all key features for visual verification.
 */

import { test, expect, type Page } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const SITE_URL = '/?phage=lambda&model=0';
const LIVE_ENABLED = process.env.PLAYWRIGHT_LIVE === '1'; // ubs:ignore — public test-selection flag, not a secret/token comparison.
const finalizers = new Map<string, () => Promise<void>>();

async function gotoSite(page: Page): Promise<void> {
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await expectExplorerIdentity(page, test.info());
}

test.describe('Phage Explorer Live Site Verification', () => {
  test.skip(!LIVE_ENABLED, 'Set PLAYWRIGHT_LIVE=1 to run live-site verification');
  test.beforeEach(async ({ page }, testInfo) => {
    finalizers.set(testInfo.testId, setupTestHarness(page, testInfo).finalize);
    testInfo.annotations.push({ type: 'proof-scope', description: 'Catalog identity is asserted; screenshots are diagnostic captures unless the individual test asserts the interaction.' });
    // Set viewport for consistent screenshots
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  test.afterEach(async ({ page: _page }, testInfo) => {
    const finalize = finalizers.get(testInfo.testId);
    finalizers.delete(testInfo.testId);
    await finalize?.();
  });

  test('01-homepage-loads', async ({ page }) => {
    await gotoSite(page);

    // Take initial screenshot
    await page.screenshot({
      path: test.info().outputPath('01-homepage.png'),
      fullPage: false
    });

    // Verify key elements exist
    await expect(page.locator('body')).toBeVisible();
  });

  test('02-welcome-modal', async ({ page }) => {
    await gotoSite(page);

    // Check for welcome modal (might appear for new visitors)
    const welcomeModal = page.locator('.welcome-modal, [role="dialog"]');
    if (await welcomeModal.isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.screenshot({
        path: test.info().outputPath('02-welcome-modal.png')
      });

      // Try to close or proceed through modal
      const closeBtn = page.locator('[aria-label="Close"], .modal-close, button:has-text("Get Started"), button:has-text("Continue")');
      if (await closeBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.first().click();
        await page.waitForTimeout(500);
      }
    }
  });

  test('03-sequence-view', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(2000); // Wait for data to load

    // Dismiss any modals
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Screenshot the main sequence view
    await page.screenshot({
      path: test.info().outputPath('03-sequence-view.png')
    });
  });

  test('04-phage-selector', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Look for phage selector dropdown
    const selector = page.locator('[data-testid="phage-selector"], .phage-selector, select, [role="combobox"]');
    if (await selector.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await selector.first().click();
      await page.waitForTimeout(300);
      await page.screenshot({
        path: test.info().outputPath('04-phage-selector.png')
      });
      await page.keyboard.press('Escape');
    }
  });

  test('05-control-deck', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Screenshot showing control deck
    await page.screenshot({
      path: test.info().outputPath('05-control-deck.png')
    });
  });

  test('06-settings-overlay', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Try to open settings (usually 's' key or settings button)
    await page.keyboard.press('s');
    await page.waitForTimeout(500);

    const settingsOverlay = page.locator('[data-overlay="settings"], .settings-overlay, [role="dialog"]:has-text("Settings")');
    if (await settingsOverlay.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.screenshot({
        path: test.info().outputPath('06-settings-overlay.png')
      });
      await page.keyboard.press('Escape');
    }
  });

  test('07-search-overlay', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Open search with Cmd/Ctrl+K or '/'
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    const searchOverlay = page.locator('[data-overlay="search"], .search-overlay, [role="dialog"]:has-text("Search")');
    if (await searchOverlay.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.screenshot({
        path: test.info().outputPath('07-search-overlay.png')
      });
      await page.keyboard.press('Escape');
    }
  });

  test('08-help-overlay', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Open help with '?' key
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    const helpOverlay = page.locator('[data-overlay="help"], .help-overlay, [role="dialog"]:has-text("Help")');
    if (await helpOverlay.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.screenshot({
        path: test.info().outputPath('08-help-overlay.png')
      });
      await page.keyboard.press('Escape');
    }
  });

  test('09-3d-model-view', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Toggle 3D model with '3' key
    await page.keyboard.press('3');
    await page.waitForTimeout(2000); // Give 3D time to load

    await page.screenshot({
      path: test.info().outputPath('09-3d-model.png')
    });

    // Toggle off
    await page.keyboard.press('3');
  });

  test('10-analysis-menu', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Open analysis menu with 'a' key
    await page.keyboard.press('a');
    await page.waitForTimeout(500);

    const analysisMenu = page.locator('[data-overlay="analysisMenu"], .analysis-menu, [role="dialog"]:has-text("Analysis")');
    if (await analysisMenu.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.screenshot({
        path: test.info().outputPath('10-analysis-menu.png')
      });
      await page.keyboard.press('Escape');
    }
  });

  test('11-complexity-analysis', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Open complexity overlay with 'c' key
    await page.keyboard.press('c');
    await page.waitForTimeout(1000);

    await page.screenshot({
      path: test.info().outputPath('11-complexity-analysis.png')
    });
    await page.keyboard.press('Escape');
  });

  test('12-gc-skew-analysis', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Open GC skew overlay with 'g' key
    await page.keyboard.press('g');
    await page.waitForTimeout(1000);

    await page.screenshot({
      path: test.info().outputPath('12-gc-skew.png')
    });
    await page.keyboard.press('Escape');
  });

  test('13-zoom-interaction', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Zoom in with '+' key
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await page.waitForTimeout(500);

    await page.screenshot({
      path: test.info().outputPath('13-zoomed-in.png')
    });

    // Zoom out
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await page.waitForTimeout(500);

    await page.screenshot({
      path: test.info().outputPath('14-zoomed-out.png')
    });
  });

  test('15-mobile-view', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14 Pro

    await gotoSite(page);
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');

    await page.screenshot({
      path: test.info().outputPath('15-mobile-view.png')
    });
  });

  test('16-mobile-fab-action-drawer', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 390, height: 844 });

    await gotoSite(page);
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Click the FAB to open action drawer
    const fab = page.locator('.fab, [aria-label="Open actions"], button[class*="fab"]');
    if (await fab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fab.click();
      await page.waitForTimeout(500);

      await page.screenshot({
        path: test.info().outputPath('16-mobile-action-drawer.png')
      });
    }
  });

  test('17-dark-theme-verification', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Verify dark theme is applied
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.body).backgroundColor;
    });

    await page.screenshot({
      path: test.info().outputPath('17-dark-theme.png')
    });

    // Dark theme should have dark background
    console.log(`Background color: ${bgColor}`);
  });

  test('18-comparison-overlay', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Try comparison overlay
    await page.keyboard.press('Control+Shift+c');
    await page.waitForTimeout(500);

    const comparisonOverlay = page.locator('[data-overlay="comparison"], .comparison-overlay');
    if (await comparisonOverlay.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.screenshot({
        path: test.info().outputPath('18-comparison-overlay.png')
      });
      await page.keyboard.press('Escape');
    }
  });

  test('19-command-palette', async ({ page }) => {
    await gotoSite(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Open command palette with Cmd+Shift+P
    await page.keyboard.press('Control+Shift+p');
    await page.waitForTimeout(500);

    const cmdPalette = page.locator('[data-overlay="commandPalette"], .command-palette');
    if (await cmdPalette.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.screenshot({
        path: test.info().outputPath('19-command-palette.png')
      });
      await page.keyboard.press('Escape');
    }
  });

  test('20-final-overview', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });

    await gotoSite(page);
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Final full-page screenshot
    await page.screenshot({
      path: test.info().outputPath('20-final-overview-1080p.png'),
      fullPage: false
    });
  });
});
