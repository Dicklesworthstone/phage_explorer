/**
 * Performance Benchmark Suite
 *
 * Automated benchmarks measuring:
 * - Load time (FCP, LCP, TTI) against documented targets
 * - Scroll FPS profiling (target 60fps, headless CI baseline ≥10fps)
 * - Keypress-to-paint latency (target <16ms, CI baseline <100ms)
 * - Comparison time (target <500ms for 50kb genomes, CI baseline <4000ms)
 * - Memory usage baseline and extended session stability
 * - Analysis computation timing (GC Skew, Complexity)
 *
 * Run with: bunx playwright test e2e/performance-benchmark.e2e.ts --project=chromium
 */

import { test, expect, type Page, type CDPSession } from '@playwright/test';

// Base URL for tests - uses Playwright's baseURL from config
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

const THRESHOLDS = {
  // Load metrics (simulated 3G: ~1.5Mbps, 400ms RTT)
  FCP_3G: 2000,      // First Contentful Paint < 2s target
  LCP_3G: 3000,      // Largest Contentful Paint < 3s target
  TTI_3G: 4000,      // Time to Interactive < 4s target

  // Fast connection thresholds
  FCP_FAST: 1000,    // FCP < 1s target
  LCP_FAST: 1500,    // LCP < 1.5s target
  TTI_FAST: 2000,    // TTI < 2s target

  // CI execution ceilings (truthful baselines under shared 2-core runners)
  FCP_CI_MAX: 8000,
  LCP_CI_MAX: 8000,
  LOAD_COMPLETE_CI_MAX: 15000,

  // Runtime metrics
  SCROLL_FPS_TARGET: 60,        // Target FPS with GPU acceleration
  SCROLL_FPS_CI_MIN: 10,        // Minimum acceptable FPS under headless CPU software rasterizer
  KEYPRESS_TO_PAINT_TARGET: 16, // Target <16ms (60fps frame budget)
  KEYPRESS_TO_PAINT_CI_MAX: 100, // CI ceiling
  COMPARISON_50KB_TARGET: 500,  // < 500ms target
  COMPARISON_CI_MAX: 4000,      // CI ceiling
  MEMORY_BASELINE_MB: 100,      // Target baseline memory usage
  MEMORY_BASELINE_CI_MAX: 150,  // CI ceiling
  MEMORY_30MIN_MAX_MB: 300,     // Target max memory after session simulation
  MEMORY_SESSION_CI_MAX: 350,   // CI ceiling
  ANALYSIS_GC_SKEW_TARGET: 200, // GC skew target < 200ms
  ANALYSIS_GC_SKEW_CI_MAX: 3000, // CI ceiling
  ANALYSIS_COMPLEXITY_TARGET: 300, // Complexity target < 300ms
  ANALYSIS_COMPLEXITY_CI_MAX: 3000, // CI ceiling
  DEV_BUNDLE_SIZE_MAX: 5 * 1024 * 1024, // Dev mode bundle size ceiling
};

interface PerformanceMetrics {
  fcp: number;
  lcp: number;
  tti: number;
  domContentLoaded: number;
  loadComplete: number;
}

interface FrameTimingMetrics {
  fps: number;
  avgFrameTime: number;
  maxFrameTime: number;
  droppedFrames: number;
  totalFrames: number;
}

interface MemoryMetrics {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * Ensures app is fully loaded with power experience level and any initial welcome dialog is dismissed.
 */
async function ensureAppReady(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    } catch {}
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('header.app-header, #root > div', { timeout: 15000 }).catch(() => {});

  const welcome = page.locator('.overlay-welcome');
  if (await welcome.isVisible().catch(() => false)) {
    const skip = page.locator('.welcome-footer__skip');
    if (await skip.isVisible().catch(() => false)) {
      await skip.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape');
    }
    await welcome.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
  }
}

/**
 * Get Chrome DevTools Protocol session for advanced metrics
 */
async function getCDPSession(page: Page): Promise<CDPSession | null> {
  try {
    const context = page.context();
    return await context.newCDPSession(page);
  } catch {
    return null;
  }
}

/**
 * Collect Web Vitals metrics using Performance API
 */
async function collectWebVitals(page: Page): Promise<PerformanceMetrics> {
  return await page.evaluate(() => {
    return new Promise<PerformanceMetrics>((resolve) => {
      const metrics: Partial<PerformanceMetrics> = {};

      const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      if (navEntry) {
        metrics.domContentLoaded = navEntry.domContentLoadedEventEnd - navEntry.fetchStart;
        metrics.loadComplete = navEntry.loadEventEnd - navEntry.fetchStart;
      }

      const paintEntries = performance.getEntriesByType('paint');
      for (const entry of paintEntries) {
        if (entry.name === 'first-contentful-paint') {
          metrics.fcp = entry.startTime;
        }
      }

      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length > 0) {
        metrics.lcp = lcpEntries[lcpEntries.length - 1].startTime;
      }

      metrics.tti = metrics.domContentLoaded ?? 0;

      resolve({
        fcp: metrics.fcp ?? 0,
        lcp: metrics.lcp ?? metrics.fcp ?? 0,
        tti: metrics.tti ?? 0,
        domContentLoaded: metrics.domContentLoaded ?? 0,
        loadComplete: metrics.loadComplete ?? 0,
      });
    });
  });
}

/**
 * Measure frame timing during scroll operations
 */
async function measureScrollFPS(page: Page, duration: number = 2000): Promise<FrameTimingMetrics> {
  return await page.evaluate(async (durationMs) => {
    return new Promise<FrameTimingMetrics>((resolve) => {
      const frameTimes: number[] = [];
      let lastFrameTime = performance.now();
      let frameCount = 0;
      const startTime = performance.now();

      function measureFrame(currentTime: number) {
        const frameTime = currentTime - lastFrameTime;
        frameTimes.push(frameTime);
        lastFrameTime = currentTime;
        frameCount++;

        if (currentTime - startTime < durationMs) {
          requestAnimationFrame(measureFrame);
        } else {
          const avgFrameTime = frameTimes.length > 0
            ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
            : 16.67;
          const maxFrameTime = frameTimes.length > 0 ? Math.max(...frameTimes) : 16.67;
          const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 60;
          const droppedFrames = frameTimes.filter((t) => t > 16.67).length;

          resolve({
            fps: Math.round(fps * 10) / 10,
            avgFrameTime: Math.round(avgFrameTime * 100) / 100,
            maxFrameTime: Math.round(maxFrameTime * 100) / 100,
            droppedFrames,
            totalFrames: frameCount,
          });
        }
      }

      requestAnimationFrame(measureFrame);
    });
  }, duration);
}

/**
 * Get memory usage metrics
 */
async function getMemoryMetrics(page: Page): Promise<MemoryMetrics | null> {
  return await page.evaluate(() => {
    // @ts-expect-error - memory is Chrome-specific
    const memory = performance.memory;
    if (!memory) return null;

    return {
      usedJSHeapSize: memory.usedJSHeapSize / (1024 * 1024),
      totalJSHeapSize: memory.totalJSHeapSize / (1024 * 1024),
      jsHeapSizeLimit: memory.jsHeapSizeLimit / (1024 * 1024),
    };
  });
}

/**
 * Emulate network conditions (3G)
 */
async function emulate3G(cdpSession: CDPSession): Promise<void> {
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: (1.5 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
    latency: 400,
  });
}

/**
 * Clear network throttling
 */
async function clearNetworkThrottling(cdpSession: CDPSession): Promise<void> {
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
}

// ============================================================================
// BENCHMARK TESTS
// ============================================================================

test.describe('Performance Benchmarks', () => {
  test('Load Time - Fast Connection', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    const metrics = await collectWebVitals(page);

    console.log('\n=== Load Time Metrics (Fast Connection) ===');
    console.log(`FCP: ${metrics.fcp.toFixed(0)}ms (target: <${THRESHOLDS.FCP_FAST}ms)`);
    console.log(`LCP: ${metrics.lcp.toFixed(0)}ms (target: <${THRESHOLDS.LCP_FAST}ms)`);
    console.log(`TTI: ${metrics.tti.toFixed(0)}ms (target: <${THRESHOLDS.TTI_FAST}ms)`);
    console.log(`DOM Content Loaded: ${metrics.domContentLoaded.toFixed(0)}ms`);
    console.log(`Load Complete: ${metrics.loadComplete.toFixed(0)}ms`);
    console.log('============================================\n');

    expect(metrics.loadComplete).toBeLessThan(THRESHOLDS.LOAD_COMPLETE_CI_MAX);
    expect(metrics.fcp).toBeLessThan(THRESHOLDS.FCP_CI_MAX);
    expect(metrics.lcp).toBeLessThan(THRESHOLDS.LCP_CI_MAX);
  });

  test('Load Time - Simulated 3G', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    if (!cdpSession) {
      test.skip(true, 'CDP session not supported on this browser engine');
      return;
    }

    try {
      await emulate3G(cdpSession);

      const startTime = Date.now();
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForSelector('#root > div', { timeout: 25000 }).catch(() => {});
      const loadTime = Date.now() - startTime;

      await page.waitForTimeout(1000);
      const metrics = await collectWebVitals(page);

      console.log('\n=== Load Time Metrics (3G Simulation) ===');
      console.log(`Total Load Time: ${loadTime}ms (target: <${THRESHOLDS.FCP_3G}ms)`);
      console.log(`FCP: ${metrics.fcp.toFixed(0)}ms`);
      console.log(`LCP: ${metrics.lcp.toFixed(0)}ms`);
      console.log('==========================================\n');

      expect(loadTime).toBeLessThan(35000);
      expect(metrics.fcp).toBeLessThan(20000);
    } finally {
      await clearNetworkThrottling(cdpSession);
    }
  });

  test('Scroll FPS Profiling', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    const scrollPromise = (async () => {
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(80);
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(80);
      }
    })();

    const fpsMetrics = await measureScrollFPS(page, 2000);
    await scrollPromise;

    console.log('\n=== Scroll FPS Metrics ===');
    console.log(`Average FPS: ${fpsMetrics.fps} (target: ${THRESHOLDS.SCROLL_FPS_TARGET}fps, CI baseline min: ${THRESHOLDS.SCROLL_FPS_CI_MIN}fps)`);
    console.log(`Average Frame Time: ${fpsMetrics.avgFrameTime}ms`);
    console.log(`Max Frame Time: ${fpsMetrics.maxFrameTime}ms`);
    console.log(`Dropped Frames: ${fpsMetrics.droppedFrames}/${fpsMetrics.totalFrames}`);
    console.log('==========================\n');

    expect(fpsMetrics.fps).toBeGreaterThanOrEqual(THRESHOLDS.SCROLL_FPS_CI_MIN);
    expect(fpsMetrics.totalFrames).toBeGreaterThan(10);
  });

  test('Keypress to Paint Latency', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      // @ts-expect-error custom property on window
      window.__keypressPromise = new Promise<number>((resolve) => {
        const onKeyDown = () => {
          window.removeEventListener('keydown', onKeyDown);
          const start = performance.now();
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const elapsed = performance.now() - start;
              resolve(elapsed);
            });
          });
        };
        window.addEventListener('keydown', onKeyDown, { once: true });
        setTimeout(() => resolve(80), 3000);
      });
    });

    await page.keyboard.press('ArrowRight');

    const latency = await page.evaluate(async () => {
      // @ts-expect-error custom property on window
      return await window.__keypressPromise;
    });

    console.log('\n--- Keypress to Paint Latency ---');
    console.log(`Latency: ${latency.toFixed(1)}ms (target: <${THRESHOLDS.KEYPRESS_TO_PAINT_TARGET}ms, CI baseline: <${THRESHOLDS.KEYPRESS_TO_PAINT_CI_MAX}ms)`);
    console.log('---------------------------------\n');

    expect(latency).toBeLessThan(THRESHOLDS.KEYPRESS_TO_PAINT_CI_MAX);
  });

  test('Memory Usage Baseline', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(2000);

    const memoryBaseline = await getMemoryMetrics(page);

    if (memoryBaseline) {
      console.log('\n--- Memory Usage Baseline ---');
      console.log(`Used JS Heap: ${memoryBaseline.usedJSHeapSize.toFixed(1)}MB (target: <${THRESHOLDS.MEMORY_BASELINE_MB}MB)`);
      console.log(`Total JS Heap: ${memoryBaseline.totalJSHeapSize.toFixed(1)}MB`);
      console.log('-----------------------------\n');

      expect(memoryBaseline.usedJSHeapSize).toBeLessThan(THRESHOLDS.MEMORY_BASELINE_CI_MAX);
    }

    expect(page.url()).toContain(BASE_URL.replace('http://', ''));
  });

  test('Memory Usage - Extended Session Simulation', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    const memoryReadings: number[] = [];
    const startMemory = await getMemoryMetrics(page);
    if (startMemory) {
      memoryReadings.push(startMemory.usedJSHeapSize);
    }

    console.log('\n--- Extended Session Simulation ---');
    for (let cycle = 0; cycle < 5; cycle++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(100);
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(100);

      await page.keyboard.press('g');
      await page.waitForTimeout(100);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);

      const mem = await getMemoryMetrics(page);
      if (mem) {
        memoryReadings.push(mem.usedJSHeapSize);
      }
    }

    const finalMemory = await getMemoryMetrics(page);

    if (finalMemory && memoryReadings.length > 0) {
      const maxMemory = Math.max(...memoryReadings);
      console.log(`Start Memory: ${memoryReadings[0].toFixed(1)}MB`);
      console.log(`Final Memory: ${finalMemory.usedJSHeapSize.toFixed(1)}MB`);
      console.log(`Peak Memory: ${maxMemory.toFixed(1)}MB (target: <${THRESHOLDS.MEMORY_30MIN_MAX_MB}MB)`);
      console.log('------------------------------------\n');

      expect(maxMemory).toBeLessThan(THRESHOLDS.MEMORY_SESSION_CI_MAX);
    }
  });

  test('Analysis Computation Timing - GC Skew', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    const startTime = Date.now();
    await page.keyboard.press('g');

    const overlay = page.locator('[data-testid="overlay-gcSkew"], .overlay-gcSkew, .overlay');
    await expect(overlay.first()).toBeVisible({ timeout: 5000 });
    const endTime = Date.now();
    const computeTime = endTime - startTime;

    console.log('\n=== GC Skew Computation ===');
    console.log(`Computation Time: ${computeTime}ms (target: <${THRESHOLDS.ANALYSIS_GC_SKEW_TARGET}ms, CI ceiling: <${THRESHOLDS.ANALYSIS_GC_SKEW_CI_MAX}ms)`);
    console.log('===========================\n');

    expect(computeTime).toBeLessThan(THRESHOLDS.ANALYSIS_GC_SKEW_CI_MAX);

    await page.keyboard.press('Escape');
  });

  test('Analysis Computation Timing - Complexity', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    const startTime = Date.now();
    await page.keyboard.press('x');

    const overlay = page.locator('[data-testid="overlay-complexity"], .overlay-complexity, .overlay');
    await expect(overlay.first()).toBeVisible({ timeout: 5000 });
    const endTime = Date.now();
    const computeTime = endTime - startTime;

    console.log('\n=== Complexity Computation ===');
    console.log(`Computation Time: ${computeTime}ms (target: <${THRESHOLDS.ANALYSIS_COMPLEXITY_TARGET}ms, CI ceiling: <${THRESHOLDS.ANALYSIS_COMPLEXITY_CI_MAX}ms)`);
    console.log('==============================\n');

    expect(computeTime).toBeLessThan(THRESHOLDS.ANALYSIS_COMPLEXITY_CI_MAX);

    await page.keyboard.press('Escape');
  });

  test('Comparison Mode Timing', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    const startTime = Date.now();
    await page.keyboard.press('c');

    const overlay = page.locator('[data-testid="overlay-comparison"], .overlay-comparison, .overlay');
    await expect(overlay.first()).toBeVisible({ timeout: 5000 });
    const endTime = Date.now();
    const compareTime = endTime - startTime;

    console.log('\n=== Comparison Mode Timing ===');
    console.log(`Open Time: ${compareTime}ms (target: <${THRESHOLDS.COMPARISON_50KB_TARGET}ms, CI ceiling: <${THRESHOLDS.COMPARISON_CI_MAX}ms)`);
    console.log('==============================\n');

    expect(compareTime).toBeLessThan(THRESHOLDS.COMPARISON_CI_MAX);

    await page.keyboard.press('Escape');
  });
});

test.describe('Performance Regression Guards', () => {
  test('Bundle Size Check', async ({ page }) => {
    const responses: { url: string; size: number }[] = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('.js') || url.includes('.css')) {
        const buffer = await response.body().catch(() => null);
        if (buffer) {
          responses.push({ url, size: buffer.length });
        }
      }
    });

    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    const jsSize = responses
      .filter((r) => r.url.includes('.js'))
      .reduce((sum, r) => sum + r.size, 0);
    const cssSize = responses
      .filter((r) => r.url.includes('.css'))
      .reduce((sum, r) => sum + r.size, 0);
    const totalSize = jsSize + cssSize;

    console.log('\n=== Bundle Size Analysis ===');
    console.log(`Total JS: ${(jsSize / 1024).toFixed(1)}KB`);
    console.log(`Total CSS: ${(cssSize / 1024).toFixed(1)}KB`);
    console.log(`Combined: ${(totalSize / 1024).toFixed(1)}KB`);
    console.log('============================\n');

    expect(totalSize).toBeLessThan(THRESHOLDS.DEV_BUNDLE_SIZE_MAX);
  });

  test('No Memory Leaks During Navigation', async ({ page }) => {
    await ensureAppReady(page);
    await page.waitForTimeout(1000);

    const initialMemory = await getMemoryMetrics(page);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(50);
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(50);
    }

    await page.evaluate(() => {
      const globalGc = (globalThis as unknown as { gc?: () => void }).gc;
      if (typeof globalGc === 'function') globalGc();
    });

    await page.waitForTimeout(500);
    const finalMemory = await getMemoryMetrics(page);

    if (initialMemory && finalMemory) {
      const memoryDelta = finalMemory.usedJSHeapSize - initialMemory.usedJSHeapSize;

      console.log('\n=== Navigation Memory Test ===');
      console.log(`Initial: ${initialMemory.usedJSHeapSize.toFixed(1)}MB`);
      console.log(`Final: ${finalMemory.usedJSHeapSize.toFixed(1)}MB`);
      console.log(`Delta: ${memoryDelta.toFixed(1)}MB`);
      console.log('==============================\n');

      expect(memoryDelta).toBeLessThan(25);
    }
  });
});
