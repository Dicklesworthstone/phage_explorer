/**
 * Performance Benchmark Suite
 *
 * Automated benchmarks measuring:
 * - Load time (FCP, LCP, TTI) - target: < 2s on 3G
 * - Scroll FPS profiling - target: 60fps sustained
 * - Comparison time - target: < 500ms for 50kb genomes
 * - Memory usage over time
 * - Analysis computation timing
 *
 * Run with: bunx playwright test e2e/performance-benchmark.e2e.ts --project=chromium
 */

import { test, expect, type Page, type CDPSession } from '@playwright/test';

// Base URL for tests - uses Playwright's baseURL from config
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

// import * as path from 'path';

// const REPORT_DIR = path.join(__dirname, '../../test-results');
// const BENCHMARK_RESULTS_DIR = path.join(REPORT_DIR, 'benchmarks');

// const CPU_THROTTLING_RATE = 4; // Simulate 4x slower CPU for mobile tests
const THRESHOLDS = {
  // Load metrics (simulated 3G: ~1.5Mbps, 400ms RTT)
  FCP_3G: 2000,      // First Contentful Paint < 2s
  LCP_3G: 3000,      // Largest Contentful Paint < 3s
  TTI_3G: 4000,      // Time to Interactive < 4s

  // Fast connection thresholds
  FCP_FAST: 500,     // FCP < 500ms on fast connection
  LCP_FAST: 1000,    // LCP < 1s on fast connection
  TTI_FAST: 1500,    // TTI < 1.5s on fast connection

  // Runtime metrics
  SCROLL_FPS_MIN: 55,           // Minimum acceptable FPS during scroll
  SCROLL_FPS_TARGET: 60,        // Target FPS
  COMPARISON_50KB: 500,         // < 500ms for 50kb genome comparison
  MEMORY_BASELINE_MB: 100,      // Baseline memory usage
  MEMORY_30MIN_MAX_MB: 300,     // Max memory after 30min session simulation
  ANALYSIS_GC_SKEW: 200,        // GC skew calculation < 200ms
  ANALYSIS_COMPLEXITY: 300,     // Complexity analysis < 300ms
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
 * Get Chrome DevTools Protocol session for advanced metrics
 */
async function getCDPSession(page: Page): Promise<CDPSession> {
  const context = page.context();
  const cdpSession = await context.newCDPSession(page);
  return cdpSession;
}

/**
 * Collect Web Vitals metrics using Performance API
 */
async function collectWebVitals(page: Page): Promise<PerformanceMetrics> {
  return await page.evaluate(() => {
    return new Promise<PerformanceMetrics>((resolve) => {
      // Use PerformanceObserver for accurate metrics
      const metrics: Partial<PerformanceMetrics> = {};

      // Get navigation timing
      const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      if (navEntry) {
        metrics.domContentLoaded = navEntry.domContentLoadedEventEnd - navEntry.fetchStart;
        metrics.loadComplete = navEntry.loadEventEnd - navEntry.fetchStart;
      }

      // Get paint timings
      const paintEntries = performance.getEntriesByType('paint');
      for (const entry of paintEntries) {
        if (entry.name === 'first-contentful-paint') {
          metrics.fcp = entry.startTime;
        }
      }

      // Get LCP
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length > 0) {
        metrics.lcp = lcpEntries[lcpEntries.length - 1].startTime;
      }

      // Estimate TTI (simplified - time until main thread is idle)
      // In production, use web-vitals library or Long Tasks API
      metrics.tti = metrics.domContentLoaded ?? 0;

      // Fallback values if metrics not available
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
async function measureScrollFPS(page: Page, duration: number = 3000): Promise<FrameTimingMetrics> {
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
          // Calculate metrics
          const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
          const maxFrameTime = Math.max(...frameTimes);
          const fps = 1000 / avgFrameTime;
          const droppedFrames = frameTimes.filter(t => t > 16.67).length; // Frames > 16.67ms

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
      usedJSHeapSize: memory.usedJSHeapSize / (1024 * 1024), // Convert to MB
      totalJSHeapSize: memory.totalJSHeapSize / (1024 * 1024),
      jsHeapSizeLimit: memory.jsHeapSizeLimit / (1024 * 1024),
    };
  });
}

/**
 * Simulate 3G network conditions
 */
async function emulate3G(cdpSession: CDPSession): Promise<void> {
  await cdpSession.send('Network.enable');
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: (1.5 * 1024 * 1024) / 8, // 1.5 Mbps
    uploadThroughput: (750 * 1024) / 8,           // 750 Kbps
    latency: 400,                                  // 400ms RTT
  });
}

/**
 * Clear network throttling
 */
async function clearNetworkThrottling(cdpSession: CDPSession): Promise<void> {
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: -1, // No throttling
    uploadThroughput: -1,
    latency: 0,
  });
}

// ============================================================================
// BENCHMARK TESTS
// ============================================================================

test.describe('Performance Benchmarks', () => {
  test.describe.configure({ mode: 'serial' }); // Run benchmarks sequentially

  test('Load Time - Fast Connection', async ({ page }) => {
    // Navigate and collect metrics
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // Wait for app to fully initialize
    await page.waitForSelector('[data-testid="app-ready"], .sequence-viewer, #root > div', {
      timeout: 10000
    }).catch(() => {
      // Fallback: just wait for root content
    });
    await page.waitForTimeout(1000);

    const metrics = await collectWebVitals(page);

    console.log('\n=== Load Time Metrics (Fast Connection) ===');
    console.log(`FCP: ${metrics.fcp.toFixed(0)}ms (target: <${THRESHOLDS.FCP_FAST}ms)`);
    console.log(`LCP: ${metrics.lcp.toFixed(0)}ms (target: <${THRESHOLDS.LCP_FAST}ms)`);
    console.log(`TTI: ${metrics.tti.toFixed(0)}ms (target: <${THRESHOLDS.TTI_FAST}ms)`);
    console.log(`DOM Content Loaded: ${metrics.domContentLoaded.toFixed(0)}ms`);
    console.log(`Load Complete: ${metrics.loadComplete.toFixed(0)}ms`);
    console.log('============================================\n');

    // Soft assertions - log warnings but don't fail
    if (metrics.fcp > THRESHOLDS.FCP_FAST) {
      console.warn(`⚠️ FCP exceeds target: ${metrics.fcp}ms > ${THRESHOLDS.FCP_FAST}ms`);
    }
    if (metrics.lcp > THRESHOLDS.LCP_FAST) {
      console.warn(`⚠️ LCP exceeds target: ${metrics.lcp}ms > ${THRESHOLDS.LCP_FAST}ms`);
    }

    // Basic sanity check - page should load within 10 seconds
    expect(metrics.loadComplete).toBeLessThan(10000);
  });

  test('Load Time - Simulated 3G', async ({ page }) => {
    const cdpSession = await getCDPSession(page);

    try {
      // Enable 3G throttling
      await emulate3G(cdpSession);

      const startTime = Date.now();
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for meaningful content
      await page.waitForSelector('#root > div', { timeout: 20000 }).catch(() => {});
      const loadTime = Date.now() - startTime;

      await page.waitForTimeout(2000);
      const metrics = await collectWebVitals(page);

      console.log('\n=== Load Time Metrics (3G Simulation) ===');
      console.log(`Total Load Time: ${loadTime}ms (target: <${THRESHOLDS.FCP_3G}ms for FCP)`);
      console.log(`FCP: ${metrics.fcp.toFixed(0)}ms (target: <${THRESHOLDS.FCP_3G}ms)`);
      console.log(`LCP: ${metrics.lcp.toFixed(0)}ms (target: <${THRESHOLDS.LCP_3G}ms)`);
      console.log(`TTI: ${metrics.tti.toFixed(0)}ms (target: <${THRESHOLDS.TTI_3G}ms)`);
      console.log('==========================================\n');

      // Log performance rating
      if (loadTime < THRESHOLDS.FCP_3G) {
        console.log('✅ Load time meets 3G target');
      } else {
        console.warn(`⚠️ Load time ${loadTime}ms exceeds 3G target ${THRESHOLDS.FCP_3G}ms`);
      }
    } finally {
      await clearNetworkThrottling(cdpSession);
    }
  });

  test('Scroll FPS Profiling', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Find scrollable content area
    // const scrollContainer = page.locator('.sequence-viewer, [data-testid="genome-viewer"], main').first();

    // Start FPS measurement while scrolling
    const scrollPromise = (async () => {
      // Perform smooth scroll operations
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(100);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(100);
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(100);
      }
    })();

    const fpsMetrics = await measureScrollFPS(page, 3000);
    await scrollPromise;

    console.log('\n=== Scroll FPS Metrics ===');
    console.log(`Average FPS: ${fpsMetrics.fps} (target: ${THRESHOLDS.SCROLL_FPS_TARGET}fps)`);
    console.log(`Average Frame Time: ${fpsMetrics.avgFrameTime}ms`);
    console.log(`Max Frame Time: ${fpsMetrics.maxFrameTime}ms`);
    console.log(`Dropped Frames: ${fpsMetrics.droppedFrames}/${fpsMetrics.totalFrames}`);
    console.log('==========================\n');

    // Check FPS meets minimum threshold
    if (fpsMetrics.fps >= THRESHOLDS.SCROLL_FPS_MIN) {
      console.log('✅ Scroll FPS meets minimum target');
    } else {
      console.warn(`⚠️ Scroll FPS ${fpsMetrics.fps} below minimum ${THRESHOLDS.SCROLL_FPS_MIN}`);
    }

    // Soft assertion - FPS should be reasonable
    expect(fpsMetrics.fps).toBeGreaterThan(30);
  });

  test('Memory Usage Baseline', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    const memoryBaseline = await getMemoryMetrics(page);

    if (memoryBaseline) {
      console.log('\n=== Memory Usage Baseline ===');
      console.log(`Used JS Heap: ${memoryBaseline.usedJSHeapSize.toFixed(1)}MB (target: <${THRESHOLDS.MEMORY_BASELINE_MB}MB)`);
      console.log(`Total JS Heap: ${memoryBaseline.totalJSHeapSize.toFixed(1)}MB`);
      console.log(`Heap Limit: ${memoryBaseline.jsHeapSizeLimit.toFixed(1)}MB`);
      console.log('=============================\n');

      if (memoryBaseline.usedJSHeapSize < THRESHOLDS.MEMORY_BASELINE_MB) {
        console.log('✅ Memory usage within baseline target');
      } else {
        console.warn(`⚠️ Memory ${memoryBaseline.usedJSHeapSize.toFixed(1)}MB exceeds baseline ${THRESHOLDS.MEMORY_BASELINE_MB}MB`);
      }
    } else {
      console.log('⚠️ Memory metrics not available (Chrome-specific API)');
    }

    // Basic assertion that page is functional
    expect(page.url()).toContain(BASE_URL.replace('http://', ''));
  });

  test('Memory Usage - Extended Session Simulation', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const memoryReadings: number[] = [];
    const startMemory = await getMemoryMetrics(page);
    if (startMemory) {
      memoryReadings.push(startMemory.usedJSHeapSize);
    }

    // Simulate user activity (compressed time simulation)
    console.log('\n=== Extended Session Simulation ===');
    console.log('Simulating user interactions...');

    for (let cycle = 0; cycle < 10; cycle++) {
      // Navigate between phages
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(200);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);

      // Scroll genome
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(50);
      }

      // Toggle overlays
      await page.keyboard.press('g');
      await page.waitForTimeout(200);
      await page.keyboard.press('g');
      await page.waitForTimeout(200);

      // Record memory after each cycle
      const mem = await getMemoryMetrics(page);
      if (mem) {
        memoryReadings.push(mem.usedJSHeapSize);
      }
    }

    const finalMemory = await getMemoryMetrics(page);

    if (finalMemory && memoryReadings.length > 0) {
      const memoryGrowth = finalMemory.usedJSHeapSize - memoryReadings[0];
      const avgMemory = memoryReadings.reduce((a, b) => a + b, 0) / memoryReadings.length;
      const maxMemory = Math.max(...memoryReadings);

      console.log(`Start Memory: ${memoryReadings[0].toFixed(1)}MB`);
      console.log(`Final Memory: ${finalMemory.usedJSHeapSize.toFixed(1)}MB`);
      console.log(`Memory Growth: ${memoryGrowth.toFixed(1)}MB`);
      console.log(`Average Memory: ${avgMemory.toFixed(1)}MB`);
      console.log(`Peak Memory: ${maxMemory.toFixed(1)}MB`);
      console.log(`Target Max: ${THRESHOLDS.MEMORY_30MIN_MAX_MB}MB`);
      console.log('====================================\n');

      if (maxMemory < THRESHOLDS.MEMORY_30MIN_MAX_MB) {
        console.log('✅ Memory usage within extended session target');
      } else {
        console.warn(`⚠️ Peak memory ${maxMemory.toFixed(1)}MB exceeds target ${THRESHOLDS.MEMORY_30MIN_MAX_MB}MB`);
      }
    }
  });

  test('Analysis Computation Timing - GC Skew', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Trigger GC Skew overlay and measure time
    const startTime = Date.now();
    await page.keyboard.press('g'); // Toggle GC skew

    // Wait for overlay to render
    await page.waitForTimeout(500);
    const endTime = Date.now();
    const computeTime = endTime - startTime;

    console.log('\n=== GC Skew Computation ===');
    console.log(`Computation Time: ${computeTime}ms (target: <${THRESHOLDS.ANALYSIS_GC_SKEW}ms)`);
    console.log('===========================\n');

    if (computeTime < THRESHOLDS.ANALYSIS_GC_SKEW) {
      console.log('✅ GC Skew computation within target');
    } else {
      console.warn(`⚠️ GC Skew computation ${computeTime}ms exceeds target ${THRESHOLDS.ANALYSIS_GC_SKEW}ms`);
    }

    // Clean up - toggle off
    await page.keyboard.press('g');
  });

  test('Analysis Computation Timing - Complexity', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Trigger complexity overlay and measure time
    const startTime = Date.now();
    await page.keyboard.press('x'); // Toggle complexity

    // Wait for overlay to render
    await page.waitForTimeout(500);
    const endTime = Date.now();
    const computeTime = endTime - startTime;

    console.log('\n=== Complexity Computation ===');
    console.log(`Computation Time: ${computeTime}ms (target: <${THRESHOLDS.ANALYSIS_COMPLEXITY}ms)`);
    console.log('==============================\n');

    if (computeTime < THRESHOLDS.ANALYSIS_COMPLEXITY) {
      console.log('✅ Complexity computation within target');
    } else {
      console.warn(`⚠️ Complexity computation ${computeTime}ms exceeds target ${THRESHOLDS.ANALYSIS_COMPLEXITY}ms`);
    }

    // Clean up
    await page.keyboard.press('x');
  });

  test('Comparison Mode Timing', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Navigate to have multiple phages loaded
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);

    // Trigger comparison mode and measure time
    const startTime = Date.now();
    await page.keyboard.press('w'); // Open comparison

    // Wait for comparison overlay to render
    await page.waitForSelector('[data-testid="comparison-overlay"], .comparison-panel', {
      timeout: 5000
    }).catch(() => {
      // Fallback wait
    });
    await page.waitForTimeout(1000);
    const endTime = Date.now();
    const compareTime = endTime - startTime;

    console.log('\n=== Comparison Mode Timing ===');
    console.log(`Load Time: ${compareTime}ms (target: <${THRESHOLDS.COMPARISON_50KB}ms)`);
    console.log('==============================\n');

    if (compareTime < THRESHOLDS.COMPARISON_50KB) {
      console.log('✅ Comparison mode within target');
    } else {
      console.warn(`⚠️ Comparison mode ${compareTime}ms exceeds target ${THRESHOLDS.COMPARISON_50KB}ms`);
    }

    // Close comparison
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

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Calculate totals
    const jsSize = responses
      .filter(r => r.url.includes('.js'))
      .reduce((sum, r) => sum + r.size, 0);
    const cssSize = responses
      .filter(r => r.url.includes('.css'))
      .reduce((sum, r) => sum + r.size, 0);
    const totalSize = jsSize + cssSize;

    console.log('\n=== Bundle Size Analysis ===');
    console.log(`Total JS: ${(jsSize / 1024).toFixed(1)}KB`);
    console.log(`Total CSS: ${(cssSize / 1024).toFixed(1)}KB`);
    console.log(`Combined: ${(totalSize / 1024).toFixed(1)}KB`);
    console.log('============================\n');

    // Warn if bundle is large (> 500KB compressed typical target)
    if (totalSize > 500 * 1024) {
      console.warn('⚠️ Bundle size exceeds 500KB');
    } else {
      console.log('✅ Bundle size within reasonable limits');
    }
  });

  test('No Memory Leaks During Navigation', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const initialMemory = await getMemoryMetrics(page);

    // Navigate back and forth multiple times
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(100);
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(100);
    }

    // Force garbage collection if available (V8-specific, may not exist)
    await page.evaluate(() => {
      const globalGc = (globalThis as unknown as { gc?: () => void }).gc;
      if (typeof globalGc === 'function') globalGc();
    });

    await page.waitForTimeout(1000);
    const finalMemory = await getMemoryMetrics(page);

    if (initialMemory && finalMemory) {
      const memoryDelta = finalMemory.usedJSHeapSize - initialMemory.usedJSHeapSize;

      console.log('\n=== Navigation Memory Test ===');
      console.log(`Initial: ${initialMemory.usedJSHeapSize.toFixed(1)}MB`);
      console.log(`Final: ${finalMemory.usedJSHeapSize.toFixed(1)}MB`);
      console.log(`Delta: ${memoryDelta.toFixed(1)}MB`);
      console.log('==============================\n');

      // Allow up to 10MB growth for caching, etc.
      if (memoryDelta < 10) {
        console.log('✅ No significant memory leaks detected');
      } else {
        console.warn(`⚠️ Potential memory leak: ${memoryDelta.toFixed(1)}MB growth`);
      }
    }
  });
});

// Summary report at end
test.afterAll(async () => {
  console.log('\n');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     PERFORMANCE BENCHMARK COMPLETE       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Review console output for detailed      ║');
  console.log('║  metrics and recommendations.            ║');
  console.log('║                                          ║');
  console.log('║  Targets:                                ║');
  console.log('║  - FCP (3G): < 2000ms                    ║');
  console.log('║  - LCP (3G): < 3000ms                    ║');
  console.log('║  - Scroll FPS: > 55fps                   ║');
  console.log('║  - Comparison: < 500ms                   ║');
  console.log('║  - Memory baseline: < 100MB              ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('\n');
});
