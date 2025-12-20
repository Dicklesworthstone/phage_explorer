import { test } from '@playwright/test';

test('capture desktop screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('https://phage-explorer.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/desktop-1920x1080.png', fullPage: false });
  await page.screenshot({ path: 'test-results/desktop-1920x1080-full.png', fullPage: true });
  console.log('Desktop screenshots saved');
});

test('capture laptop screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('https://phage-explorer.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/laptop-1440x900.png', fullPage: false });
  console.log('Laptop screenshot saved');
});

test('capture tablet screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('https://phage-explorer.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/tablet-768x1024.png', fullPage: false });
  await page.screenshot({ path: 'test-results/tablet-768x1024-full.png', fullPage: true });
  console.log('Tablet screenshot saved');
});

test('capture mobile screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://phage-explorer.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/mobile-390x844.png', fullPage: false });
  await page.screenshot({ path: 'test-results/mobile-390x844-full.png', fullPage: true });
  console.log('Mobile screenshot saved');
});

test('capture small mobile screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('https://phage-explorer.vercel.app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/mobile-small-320x568.png', fullPage: false });
  await page.screenshot({ path: 'test-results/mobile-small-320x568-full.png', fullPage: true });
  console.log('Small mobile screenshot saved');
});
