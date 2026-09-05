/**
 * Live Site Verification Test
 *
 * Tests phage-explorer.org in both desktop and mobile viewports,
 * captures screenshots, and checks for JavaScript errors.
 */

import { test, expect } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const LIVE_URL = '/?phage=lambda&model=0';
const LIVE_ENABLED = process.env.PLAYWRIGHT_LIVE === '1'; // ubs:ignore — public test-selection flag, not a secret/token comparison.

test.describe('Live Site Verification', () => {
  test.skip(!LIVE_ENABLED, 'Set PLAYWRIGHT_LIVE=1 to run live-site verification');
  for (const viewport of [
    { name: 'Desktop viewport - full page test', width: 1920, height: 1080, image: 'desktop-loaded.png' },
    { name: 'Mobile viewport - iPhone 14 Pro', width: 393, height: 852, image: 'mobile-loaded.png' },
    { name: 'Tablet viewport - iPad', width: 1024, height: 768, image: 'tablet-home.png' },
  ]) {
    test(viewport.name, async ({ page }, testInfo) => {
      const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, testInfo);
      testInfo.annotations.push({ type: 'proof-scope', description: 'Catalog identity and JavaScript errors are asserted. Viewport screenshots are diagnostics, not touch-device or layout-conformance proof.' });
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await expectExplorerIdentity(page, testInfo);
        await expect(page.locator('#root')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(viewport.image), fullPage: false });
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
      } finally { await finalize(); }
    });
  }
});
