/**
 * Live Site Verification Test
 *
 * Tests phage-explorer.org in both desktop and mobile viewports,
 * captures screenshots, and checks for JavaScript errors.
 */

import { test, expect, type ConsoleMessage } from '@playwright/test';

const LIVE_URL = 'https://phage-explorer.org';
const SCREENSHOT_DIR = 'screenshots/live-test';

// Collect JS errors during test
const jsErrors: string[] = [];

test.describe('Live Site Verification', () => {
  test.beforeEach(async ({ page }) => {
    // Collect console errors
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        jsErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    // Collect page errors
    page.on('pageerror', (error: Error) => {
      jsErrors.push(`[PageError] ${error.message}`);
    });
  });

  test('Desktop viewport - full page test', async ({ page }) => {
    // Set desktop viewport
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Navigate to site
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });

    // Wait for app to initialize
    await page.waitForTimeout(3000);

    // Take full page screenshot
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/desktop-home.png`,
      fullPage: false,
    });

    // Check for main app container
    const appContainer = page.locator('#root');
    await expect(appContainer).toBeVisible();

    // Wait a bit more for any lazy-loaded content
    await page.waitForTimeout(2000);

    // Take another screenshot after full load
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/desktop-loaded.png`,
      fullPage: false,
    });

    // Log any JS errors found
    if (jsErrors.length > 0) {
      console.log('Desktop JS Errors:', jsErrors);
    }
  });

  test('Mobile viewport - iPhone 14 Pro', async ({ page }) => {
    // Clear errors for this test
    jsErrors.length = 0;

    // Set iPhone 14 Pro viewport
    await page.setViewportSize({ width: 393, height: 852 });

    // Navigate to site
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });

    // Wait for app to initialize
    await page.waitForTimeout(3000);

    // Take mobile screenshot
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/mobile-home.png`,
      fullPage: false,
    });

    // Check for main app container
    const appContainer = page.locator('#root');
    await expect(appContainer).toBeVisible();

    // Wait for mobile UI to settle
    await page.waitForTimeout(2000);

    // Take another screenshot
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/mobile-loaded.png`,
      fullPage: false,
    });

    // Log any JS errors found
    if (jsErrors.length > 0) {
      console.log('Mobile JS Errors:', jsErrors);
    }
  });

  test('Tablet viewport - iPad', async ({ page }) => {
    // Clear errors for this test
    jsErrors.length = 0;

    // Set iPad viewport
    await page.setViewportSize({ width: 1024, height: 768 });

    // Navigate to site
    await page.goto(LIVE_URL, { waitUntil: 'networkidle' });

    // Wait for app to initialize
    await page.waitForTimeout(3000);

    // Take tablet screenshot
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/tablet-home.png`,
      fullPage: false,
    });

    // Check for main app container
    const appContainer = page.locator('#root');
    await expect(appContainer).toBeVisible();

    // Log any JS errors found
    if (jsErrors.length > 0) {
      console.log('Tablet JS Errors:', jsErrors);
    }
  });

  test.afterAll(async () => {
    // Report all collected JS errors
    if (jsErrors.length > 0) {
      console.log('\n=== All JS Errors Collected ===');
      jsErrors.forEach((error, i) => {
        console.log(`${i + 1}. ${error}`);
      });
      console.log('================================\n');
    } else {
      console.log('\n✓ No JavaScript errors detected!\n');
    }
  });
});
