/**
 * Production Health Check Tests
 *
 * Critical tests that run after deployment to verify the live site is working.
 * Captures JavaScript errors and tests key mobile interactions.
 *
 * Run with: PLAYWRIGHT_LIVE=1 PLAYWRIGHT_BASE_URL=https://phage-explorer.org bunx playwright test production-health.e2e.ts
 */

import { test, expect, type Page, type ConsoleMessage, type TestInfo } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness, type TestHarnessState } from './e2e-harness';
import { readFile } from 'node:fs/promises';

const SITE_PATH = '/?phage=lambda&model=0';
const LIVE_ENABLED = process.env.PLAYWRIGHT_LIVE === '1';

interface JsError {
  type: string;
  text: string;
  url: string;
  location?: string;
}

class ErrorCollector {
  errors: JsError[] = [];
  warnings: JsError[] = [];

  handleConsole(msg: ConsoleMessage) {
    const type = msg.type();
    const text = msg.text();
    const location = msg.location();

    const entry: JsError = {
      type,
      text,
      url: location.url || '',
      location: location.url ? `${location.url}:${location.lineNumber}:${location.columnNumber}` : undefined,
    };

    if (type === 'error') {
      this.errors.push(entry);
    } else if (type === 'warning' && text.includes('error')) {
      this.warnings.push(entry);
    }
  }

  handlePageError(error: Error) {
    this.errors.push({
      type: 'pageerror',
      text: error.message,
      url: error.stack?.split('\n')[1]?.trim() || '',
    });
  }

  clear() {
    this.errors = [];
    this.warnings = [];
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  report(): string {
    if (!this.hasErrors() && this.warnings.length === 0) {
      return 'No JavaScript errors detected.';
    }

    const lines: string[] = [];

    if (this.errors.length > 0) {
      lines.push(`### Errors (${this.errors.length}):`);
      this.errors.forEach((e, i) => {
        lines.push(`${i + 1}. \`${e.text}\``);
        if (e.location) {
          lines.push(`   Location: ${e.location}`);
        }
      });
    }

    if (this.warnings.length > 0) {
      lines.push('');
      lines.push(`### Warnings (${this.warnings.length}):`);
      this.warnings.forEach((w, i) => {
        lines.push(`${i + 1}. \`${w.text}\``);
      });
    }

    return lines.join('\n');
  }
}

interface SetupResult {
  collector: ErrorCollector;
  finalize: () => Promise<void>;
  state: TestHarnessState;
}

const pendingFinalizers = new Map<string, () => Promise<void>>();
test.afterEach(async ({ page: _page }, testInfo) => {
  await pendingFinalizers.get(testInfo.testId)?.();
});

async function setupErrorCollector(page: Page, testInfo: TestInfo): Promise<SetupResult> {
  const collector = new ErrorCollector();
  page.on('console', (msg) => collector.handleConsole(msg));
  page.on('pageerror', (error) => collector.handlePageError(error));

  // Also set up test harness for structured artifact capture
  const harness = setupTestHarness(page, testInfo);
  const finalize = async () => {
    pendingFinalizers.delete(testInfo.testId);
    await harness.finalize();
  };
  pendingFinalizers.set(testInfo.testId, finalize);

  return {
    collector,
    finalize,
    state: harness.state,
  };
}

async function gotoAndWait(page: Page): Promise<void> {
  await page.goto(SITE_PATH, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await expectExplorerIdentity(page, test.info());
}

test('identity guard rejects a convincing page from the wrong origin', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto('data:text/html,<main><h1>Phage Explorer</h1><p>Database ready</p></main>');
    await expect(expectExplorerIdentity(page, testInfo)).rejects.toThrow('Selected explorer origin');
  } finally { await finalize(); }
});

test('identity guard rejects a blank shell despite a valid descriptor', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);
  try {
    const manifest = JSON.parse(await readFile(new URL('../public/phage.db.manifest.json', import.meta.url), 'utf8'));
    await page.route('**/phage.db.manifest.json', route => route.fulfill({ json: manifest }));
    await page.route(url => url.searchParams.has('blank-shell'), route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Phage Explorer</h1></main>' }));
    await page.goto('/?blank-shell=1');
    await expect(expectExplorerIdentity(page, testInfo)).rejects.toThrow('Loaded lambda catalog entry');
  } finally { await finalize(); }
});

test('identity guard rejects a stale data descriptor on the selected origin', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);
  try {
    const manifest = JSON.parse(await readFile(new URL('../public/phage.db.manifest.json', import.meta.url), 'utf8'));
    await page.route('**/phage.db.manifest.json', route => route.fulfill({ json: { ...manifest, contentVersion: '0'.repeat(64) } }));
    await page.route(url => url.searchParams.has('stale-descriptor'), route => route.fulfill({ contentType: 'text/html', body: '<main>Phage Explorer</main>' }));
    await page.goto('/?stale-descriptor=1');
    await expect(expectExplorerIdentity(page, testInfo)).rejects.toThrow('Expected database content version');
  } finally { await finalize(); }
});

test.describe('Production Health Checks', () => {
  test.skip(!LIVE_ENABLED, 'Set PLAYWRIGHT_LIVE=1 to run production health checks');

  test('critical-path: homepage loads without JavaScript errors', async ({ page }, testInfo) => {
    const { collector: errorCollector, finalize } = await setupErrorCollector(page, testInfo);

    await gotoAndWait(page);

    // Dismiss any modals
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Log collected errors
    console.log('JavaScript Errors Report:');
    console.log(errorCollector.report());

    // Take screenshot for evidence
    await page.screenshot({ path: testInfo.outputPath('health-check-homepage.png') });

    // Filter out non-critical worker errors (simulation workers can fail gracefully)
    const criticalErrors = errorCollector.errors.filter(e =>
      !e.text.includes('Worker simulation') &&
      !e.text.includes('error: undefined') &&
      !e.text.includes('ResizeObserver')
    );

    // Assert no critical errors
    expect(criticalErrors, 'Found critical JavaScript errors on page load').toHaveLength(0);
    await finalize();
  });

  test('critical-path: canvas renders with non-zero dimensions', async ({ page }, testInfo) => {
    const { collector: errorCollector, finalize } = await setupErrorCollector(page, testInfo);

    await gotoAndWait(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Check that the sequence canvas has non-zero dimensions
    const canvas = page.locator('canvas[role="img"]').first();
    await expect(canvas).toBeVisible({ timeout: 10000 });
    // Sequence drawing is suspended outside the viewport.
    await canvas.scrollIntoViewIfNeeded();
    await expect(canvas).toBeInViewport();

    const dimensions = await canvas.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      // The sequence renderer can bind WebGL. Copy pixels into a separate 2D
      // probe instead of asking the application's canvas to change contexts.
      const probe = document.createElement('canvas');
      probe.width = 128;
      probe.height = 128;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas pixel probe is unavailable');
      const countColors = (source: HTMLCanvasElement) => {
        ctx.clearRect(0, 0, 128, 128);
        ctx.drawImage(source, 0, 0, 128, 128);
        const pixels = ctx.getImageData(0, 0, 128, 128).data;
        const colors = new Set<number>();
        for (let i = 0; i < pixels.length; i += 4) {
          colors.add(pixels[i] * 16777216 + pixels[i + 1] * 65536 + pixels[i + 2] * 256 + pixels[i + 3]);
        }
        return colors.size;
      };
      const blank = document.createElement('canvas');
      blank.width = 128;
      blank.height = 128;
      return {
        clientWidth: rect.width,
        clientHeight: rect.height,
        canvasWidth: (el as HTMLCanvasElement).width,
        canvasHeight: (el as HTMLCanvasElement).height,
        paintedColors: countColors(el as HTMLCanvasElement),
        blankColors: countColors(blank),
      };
    });

    console.log('Canvas dimensions:', JSON.stringify(dimensions, null, 2));

    expect(dimensions.clientWidth, 'Canvas should have non-zero client width').toBeGreaterThan(0);
    expect(dimensions.clientHeight, 'Canvas should have non-zero client height').toBeGreaterThan(0);
    expect(dimensions.canvasWidth, 'Canvas buffer width should be non-zero').toBeGreaterThan(0);
    expect(dimensions.canvasHeight, 'Canvas buffer height should be non-zero').toBeGreaterThan(0);
    expect(dimensions.blankColors, 'Blank canvas negative control').toBe(1);
    expect(dimensions.paintedColors, 'Sequence canvas must contain drawn pixels').toBeGreaterThan(dimensions.blankColors);
    await testInfo.attach('canvas-pixel-evidence', { body: JSON.stringify(dimensions), contentType: 'application/json' });

    // Assert no critical JS errors during render (ignore known non-critical worker noise)
    const criticalErrors = errorCollector.errors.filter(e =>
      !e.text.includes('Worker simulation') &&
      !e.text.includes('error: undefined') &&
      !e.text.includes('ResizeObserver')
    );
    expect(criticalErrors, 'Found critical JavaScript errors while rendering canvas').toHaveLength(0);
    await finalize();
  });

  test('critical-path: database loads successfully', async ({ page }, testInfo) => {
    const { collector: errorCollector, finalize } = await setupErrorCollector(page, testInfo);

    await gotoAndWait(page);

    // gotoAndWait already asserted the real catalog and expected data identity.
    const sequenceCanvas = page.locator('canvas[role="img"]');
    await expect(sequenceCanvas.first()).toBeVisible({ timeout: 15000 });

    // Verify no database-related errors
    const dbErrors = errorCollector.errors.filter(e =>
      e.text.toLowerCase().includes('database') ||
      e.text.toLowerCase().includes('sqlite') ||
      e.text.toLowerCase().includes('hash mismatch')
    );

    console.log('Database-related errors:', dbErrors.length > 0 ? JSON.stringify(dbErrors, null, 2) : 'None');
    expect(dbErrors, 'Found database-related errors').toHaveLength(0);
    await finalize();
  });

  test('mobile: touch scroll changes sequence position in a phone viewport', async ({ page, browserName }, testInfo) => {
    // Set iPhone 14 Pro viewport
    await page.setViewportSize({ width: 393, height: 852 });

    const { collector: errorCollector, finalize } = await setupErrorCollector(page, testInfo);
    await gotoAndWait(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Verify canvas renders on mobile
    const canvas = page.locator('canvas[role="img"]').first();
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // Check canvas dimensions
    const beforeDimensions = await canvas.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });

    console.log('Mobile canvas dimensions:', beforeDimensions);
    expect(beforeDimensions.width, 'Canvas width on mobile').toBeGreaterThan(0);
    expect(beforeDimensions.height, 'Canvas height on mobile').toBeGreaterThan(0);

    // Verify touch scrolling is enabled (touchAction should be 'none')
    const touchAction = await canvas.evaluate((el) => {
      return getComputedStyle(el).touchAction;
    });
    console.log('Touch action:', touchAction);
    expect(touchAction, 'Canvas touchAction should be none for custom scroll').toBe('none');

    if (browserName === 'chromium') {
      await canvas.scrollIntoViewIfNeeded();
      const position = page.locator('.sequence-view__jump-status').first();
      await expect(position).toContainText('Pos:');
      const beforePosition = await position.innerText();
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Sequence canvas has no touch target');
      const viewport = page.viewportSize();
      if (!viewport) throw new Error('Phone viewport is unavailable');
      const x = box.x + box.width / 2;
      const startY = Math.min(box.y + box.height - 30, viewport.height - 80);
      const endY = Math.max(box.y + 30, startY - 180);
      expect(startY - endY, 'Gesture must move inside the visible canvas').toBeGreaterThan(50);
      const session = await page.context().newCDPSession(page);
      try {
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
        for (let step = 1; step <= 6; step++) {
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x, y: startY + (endY - startY) * step / 6 }],
          });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(position).not.toHaveText(beforePosition);
        await testInfo.attach('touch-scroll-evidence', {
          body: JSON.stringify({ before: beforePosition, after: await position.innerText(), browserName, viewport }),
          contentType: 'application/json',
        });
      } finally { await session.detach(); }
    } else {
      throw new Error('Touch gesture proof requires a supported browser input adapter');
    }

    // Take mobile screenshot
    await page.screenshot({ path: testInfo.outputPath('health-check-mobile.png') });

    // Verify no critical errors during mobile interaction
    // Filter out non-critical worker errors and ResizeObserver warnings
    const criticalErrors = errorCollector.errors.filter(e =>
      !e.text.includes('ResizeObserver') &&
      !e.text.includes('Worker simulation') &&
      !e.text.includes('error: undefined')
    );
    expect(criticalErrors, 'Found critical JavaScript errors on mobile').toHaveLength(0);
    await finalize();
  });

  test('mobile: canvas renders in landscape orientation', async ({ page }, testInfo) => {
    // Set landscape viewport
    await page.setViewportSize({ width: 852, height: 393 });

    const { collector: errorCollector, finalize } = await setupErrorCollector(page, testInfo);
    await gotoAndWait(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const canvas = page.locator('canvas[role="img"]').first();
    await expect(canvas).toBeVisible({ timeout: 10000 });

    const dimensions = await canvas.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });

    console.log('Landscape canvas dimensions:', dimensions);
    expect(dimensions.width, 'Canvas width in landscape').toBeGreaterThan(0);
    expect(dimensions.height, 'Canvas height in landscape').toBeGreaterThan(0);

    await page.screenshot({ path: testInfo.outputPath('health-check-landscape.png') });

    // Filter out non-critical worker errors
    const criticalErrors = errorCollector.errors.filter(e =>
      !e.text.includes('Worker simulation') &&
      !e.text.includes('error: undefined')
    );
    expect(criticalErrors, 'Found critical JavaScript errors in landscape').toHaveLength(0);
    await finalize();
  });

  test('performance: page loads within acceptable time', async ({ page }, testInfo) => {
    const { finalize } = await setupErrorCollector(page, testInfo);
    const startTime = Date.now();

    await gotoAndWait(page);

    const loadTime = Date.now() - startTime;
    console.log(`Page load time: ${loadTime}ms`);

    // Page should load within 10 seconds
    expect(loadTime, 'Page load time should be under 10 seconds').toBeLessThan(10000);

    // LCP should be reasonable
    const lcp = await page.evaluate(() => {
      return new Promise<number | null>((resolve) => {
        new PerformanceObserver((entryList) => {
          const entries = entryList.getEntries();
          if (entries.length > 0) {
            resolve(entries[entries.length - 1].startTime);
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });

        // Timeout fallback
        setTimeout(() => resolve(null), 5000);
      });
    });

    console.log(`LCP: ${lcp}ms`);
    // LCP should be under 4 seconds for good user experience
    expect(lcp, 'LCP must actually be observed').not.toBeNull();
    expect(lcp, 'LCP must be positive').toBeGreaterThan(0);
    expect(lcp, 'LCP should be under 4 seconds').toBeLessThan(4000);
    await finalize();
  });

  test('accessibility: key elements are accessible', async ({ page }, testInfo) => {
    const { finalize } = await setupErrorCollector(page, testInfo);
    await gotoAndWait(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Check canvas has accessible role
    const canvas = page.locator('canvas[role="img"]');
    await expect(canvas.first()).toHaveAttribute('aria-label', /sequence/i);

    // Check for main landmarks
    const mainContent = page.locator('main, [role="main"], #root');
    await expect(mainContent.first()).toBeVisible();
    await finalize();
  });

  test('wasm: SQLite WASM loads and initializes the real catalog', async ({ page }, testInfo) => {
    const { collector: errorCollector, finalize, state } = await setupErrorCollector(page, testInfo);

    await gotoAndWait(page);

    // Check for WASM-related errors
    const wasmErrors = errorCollector.errors.filter(e =>
      e.text.toLowerCase().includes('wasm') ||
      e.text.toLowerCase().includes('webassembly')
    );

    console.log('WASM errors:', wasmErrors.length > 0 ? JSON.stringify(wasmErrors, null, 2) : 'None');

    expect(wasmErrors, 'SQLite WASM must initialize without errors').toHaveLength(0);
    expect(state.network.some(entry => entry.type === 'response' && /sql-wasm.*\.wasm/.test(entry.url) && entry.status === 200), 'Bundled SQLite WASM response was observed').toBe(true);
    await finalize();
  });

  test('headers: security headers are present', async ({ page }, testInfo) => {
    const { finalize } = await setupErrorCollector(page, testInfo);
    const response = await page.goto(SITE_PATH);
    await expectExplorerIdentity(page, testInfo);

    expect(response).not.toBeNull();
    if (response) {
      const headers = response.headers();

      // Check for cross-origin isolation headers (required for SharedArrayBuffer)
      expect(headers['cross-origin-opener-policy'], 'COOP header should be present').toBe('same-origin');
      expect(headers['cross-origin-embedder-policy'], 'COEP header should be present').toBe('require-corp');

      console.log('Security headers verified:');
      console.log('- COOP:', headers['cross-origin-opener-policy']);
      console.log('- COEP:', headers['cross-origin-embedder-policy']);
    }
    await finalize();
  });
});
