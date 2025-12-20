import { test } from '@playwright/test';

// Capture at many viewport sizes for thorough analysis
const viewports = [
  { name: 'desktop-4k', width: 2560, height: 1440 },
  { name: 'desktop-1080p', width: 1920, height: 1080 },
  { name: 'laptop-15', width: 1440, height: 900 },
  { name: 'laptop-13', width: 1280, height: 800 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'mobile-large', width: 428, height: 926 },
  { name: 'mobile-medium', width: 390, height: 844 },
  { name: 'mobile-small', width: 375, height: 667 },
  { name: 'mobile-mini', width: 320, height: 568 },
];

for (const vp of viewports) {
  test(`capture ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('https://phage-explorer.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Viewport screenshot
    await page.screenshot({
      path: `test-results/${vp.name}.png`,
      fullPage: false
    });

    // Full page screenshot
    await page.screenshot({
      path: `test-results/${vp.name}-full.png`,
      fullPage: true
    });

    console.log(`${vp.name}: captured`);
  });
}
