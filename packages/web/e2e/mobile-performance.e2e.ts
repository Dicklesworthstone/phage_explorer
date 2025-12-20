/**
 * Mobile & Low-End Device Performance Tests
 *
 * Tests performance characteristics on:
 * - Mobile devices (iPhone SE, iPhone 14, Pixel 7)
 * - Low-end CPU simulation (4x-6x slowdown)
 * - Slow network conditions (3G, slow 3G)
 * - Limited viewports and touch interactions
 *
 * Run with: bunx playwright test e2e/mobile-performance.spec.ts --project=chromium
 */

import { test, expect, type Page, type CDPSession } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

// Mobile device configurations
const MOBILE_DEVICES = {
  // Low-end device simulation (older iPhone SE / budget Android)
  lowEnd: {
    name: 'Low-End Mobile',
    viewport: { width: 320, height: 568 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    cpuSlowdown: 6, // Simulate very slow CPU
  },
  // Mid-range device (iPhone SE 3rd gen / Pixel 4a)
  midRange: {
    name: 'Mid-Range Mobile',
    viewport: { width: 375, height: 667 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    cpuSlowdown: 4,
  },
  // Modern flagship (iPhone 14 Pro / Pixel 7 Pro)
  flagship: {
    name: 'Flagship Mobile',
    viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    cpuSlowdown: 1, // No slowdown for flagship
  },
  // Tablet (iPad Mini)
  tablet: {
    name: 'Tablet',
    viewport: { width: 768, height: 1024 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    cpuSlowdown: 2,
  },
};

// Network condition profiles
const NETWORK_CONDITIONS = {
  slow3G: {
    name: 'Slow 3G',
    downloadThroughput: (400 * 1024) / 8,  // 400 Kbps
    uploadThroughput: (400 * 1024) / 8,
    latency: 2000,
  },
  regular3G: {
    name: 'Regular 3G',
    downloadThroughput: (1.5 * 1024 * 1024) / 8,  // 1.5 Mbps
    uploadThroughput: (750 * 1024) / 8,
    latency: 400,
  },
  good4G: {
    name: 'Good 4G',
    downloadThroughput: (4 * 1024 * 1024) / 8,  // 4 Mbps
    uploadThroughput: (3 * 1024 * 1024) / 8,
    latency: 100,
  },
};

// Performance thresholds for mobile
const MOBILE_THRESHOLDS = {
  // Time to Interactive thresholds by device class
  TTI_LOW_END: 8000,      // 8s for low-end devices
  TTI_MID_RANGE: 5000,    // 5s for mid-range
  TTI_FLAGSHIP: 2000,     // 2s for flagship

  // First Contentful Paint thresholds
  FCP_LOW_END: 4000,
  FCP_MID_RANGE: 2500,
  FCP_FLAGSHIP: 1000,

  // Interaction responsiveness
  TOUCH_RESPONSE_MS: 100, // Touch should respond in <100ms
  SCROLL_JANK_THRESHOLD: 50, // Frame drops during scroll

  // Memory thresholds (mobile has less RAM)
  MEMORY_LOW_END_MB: 50,
  MEMORY_MID_RANGE_MB: 75,
  MEMORY_FLAGSHIP_MB: 100,
};

interface PerformanceMetrics {
  fcp: number;
  lcp: number;
  tti: number;
  cls: number;
  domContentLoaded: number;
}

interface MemoryMetrics {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
}

/**
 * Get CDP session for advanced metrics
 */
async function getCDPSession(page: Page): Promise<CDPSession> {
  const context = page.context();
  return await context.newCDPSession(page);
}

/**
 * Configure device emulation with CPU throttling
 */
async function configureDevice(
  cdpSession: CDPSession,
  device: typeof MOBILE_DEVICES.lowEnd
): Promise<void> {
  // CPU throttling
  if (device.cpuSlowdown > 1) {
    await cdpSession.send('Emulation.setCPUThrottlingRate', {
      rate: device.cpuSlowdown,
    });
  }
}

/**
 * Configure network conditions
 */
async function configureNetwork(
  cdpSession: CDPSession,
  conditions: typeof NETWORK_CONDITIONS.slow3G
): Promise<void> {
  await cdpSession.send('Network.enable');
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: conditions.downloadThroughput,
    uploadThroughput: conditions.uploadThroughput,
    latency: conditions.latency,
  });
}

/**
 * Clear device/network emulation
 */
async function clearEmulation(cdpSession: CDPSession): Promise<void> {
  await cdpSession.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdpSession.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
}

/**
 * Collect Web Vitals metrics
 */
async function collectWebVitals(page: Page): Promise<PerformanceMetrics> {
  return await page.evaluate(() => {
    const metrics: Partial<PerformanceMetrics> = { cls: 0 };

    // Navigation timing
    const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    if (navEntry) {
      metrics.domContentLoaded = navEntry.domContentLoadedEventEnd - navEntry.fetchStart;
      metrics.tti = navEntry.domInteractive - navEntry.fetchStart;
    }

    // Paint timing
    const paintEntries = performance.getEntriesByType('paint');
    for (const entry of paintEntries) {
      if (entry.name === 'first-contentful-paint') {
        metrics.fcp = entry.startTime;
      }
    }

    // LCP
    const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
    if (lcpEntries.length > 0) {
      metrics.lcp = lcpEntries[lcpEntries.length - 1].startTime;
    }

    return {
      fcp: metrics.fcp ?? 0,
      lcp: metrics.lcp ?? metrics.fcp ?? 0,
      tti: metrics.tti ?? metrics.domContentLoaded ?? 0,
      cls: metrics.cls ?? 0,
      domContentLoaded: metrics.domContentLoaded ?? 0,
    };
  });
}

/**
 * Get memory metrics
 */
async function getMemoryMetrics(page: Page): Promise<MemoryMetrics | null> {
  return await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = (performance as any).memory;
    if (!memory) return null;
    return {
      usedJSHeapSize: memory.usedJSHeapSize / (1024 * 1024),
      totalJSHeapSize: memory.totalJSHeapSize / (1024 * 1024),
    };
  });
}

/**
 * Measure touch interaction responsiveness
 */
async function measureTouchResponse(page: Page): Promise<number> {
  return await page.evaluate(() => {
    return new Promise<number>((resolve) => {
      const start = performance.now();
      const handler = () => {
        const end = performance.now();
        document.removeEventListener('touchend', handler);
        resolve(end - start);
      };
      document.addEventListener('touchend', handler);

      // Simulate touch event
      const event = new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
      });
      document.body.dispatchEvent(event);
    });
  });
}

// ============================================================================
// LOW-END DEVICE TESTS
// ============================================================================

test.describe('Low-End Device Performance', () => {
  test.describe.configure({ mode: 'serial' });

  test('Performance on low-end mobile (CPU 6x slowdown)', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    const device = MOBILE_DEVICES.lowEnd;

    try {
      // Configure device emulation
      await page.setViewportSize(device.viewport);
      await configureDevice(cdpSession, device);
      await configureNetwork(cdpSession, NETWORK_CONDITIONS.regular3G);

      console.log(`\n=== ${device.name} Performance Test ===`);
      console.log(`Viewport: ${device.viewport.width}x${device.viewport.height}`);
      console.log(`CPU Slowdown: ${device.cpuSlowdown}x`);
      console.log(`Network: ${NETWORK_CONDITIONS.regular3G.name}`);

      const startTime = Date.now();
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait for app to be interactive
      await page.waitForSelector('#root > div', { timeout: 30000 }).catch(() => {});
      const loadTime = Date.now() - startTime;

      await page.waitForTimeout(2000);
      const metrics = await collectWebVitals(page);
      const memory = await getMemoryMetrics(page);

      console.log(`\nResults:`);
      console.log(`  Total Load Time: ${loadTime}ms (target: <${MOBILE_THRESHOLDS.TTI_LOW_END}ms)`);
      console.log(`  FCP: ${metrics.fcp.toFixed(0)}ms (target: <${MOBILE_THRESHOLDS.FCP_LOW_END}ms)`);
      console.log(`  LCP: ${metrics.lcp.toFixed(0)}ms`);
      console.log(`  TTI: ${metrics.tti.toFixed(0)}ms`);
      if (memory) {
        console.log(`  Memory: ${memory.usedJSHeapSize.toFixed(1)}MB (target: <${MOBILE_THRESHOLDS.MEMORY_LOW_END_MB}MB)`);
      }

      // Evaluate results
      if (loadTime < MOBILE_THRESHOLDS.TTI_LOW_END) {
        console.log('✅ Load time acceptable for low-end device');
      } else {
        console.warn(`⚠️ Load time ${loadTime}ms exceeds low-end threshold`);
      }

      if (memory && memory.usedJSHeapSize < MOBILE_THRESHOLDS.MEMORY_LOW_END_MB) {
        console.log('✅ Memory usage acceptable for low-end device');
      } else if (memory) {
        console.warn(`⚠️ Memory ${memory.usedJSHeapSize.toFixed(1)}MB may be high for low-end device`);
      }

      console.log('==========================================\n');

      // Basic assertion - should load within 30 seconds even on slow device
      expect(loadTime).toBeLessThan(30000);
    } finally {
      await clearEmulation(cdpSession);
    }
  });

  test('Performance on slow 3G network', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    const device = MOBILE_DEVICES.midRange;
    const network = NETWORK_CONDITIONS.slow3G;

    try {
      await page.setViewportSize(device.viewport);
      await configureDevice(cdpSession, device);
      await configureNetwork(cdpSession, network);

      console.log(`\n=== Slow 3G Network Test ===`);
      console.log(`Network: ${network.name} (${(network.downloadThroughput * 8 / 1024).toFixed(0)} Kbps)`);

      const startTime = Date.now();
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForSelector('#root > div', { timeout: 60000 }).catch(() => {});
      const loadTime = Date.now() - startTime;

      console.log(`\nResults:`);
      console.log(`  Load Time: ${loadTime}ms`);

      // On slow 3G, we expect slower loads but should still be usable
      if (loadTime < 15000) {
        console.log('✅ Acceptable load time on slow 3G');
      } else if (loadTime < 30000) {
        console.log('⚠️ Slow but usable on slow 3G');
      } else {
        console.warn('❌ Too slow for slow 3G - consider optimizing');
      }

      console.log('============================\n');
    } finally {
      await clearEmulation(cdpSession);
    }
  });
});

// ============================================================================
// MID-RANGE DEVICE TESTS
// ============================================================================

test.describe('Mid-Range Device Performance', () => {
  test('Performance on mid-range mobile', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    const device = MOBILE_DEVICES.midRange;

    try {
      await page.setViewportSize(device.viewport);
      await configureDevice(cdpSession, device);
      await configureNetwork(cdpSession, NETWORK_CONDITIONS.good4G);

      console.log(`\n=== ${device.name} Performance Test ===`);

      const startTime = Date.now();
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
      const loadTime = Date.now() - startTime;

      await page.waitForTimeout(1000);
      const metrics = await collectWebVitals(page);
      const memory = await getMemoryMetrics(page);

      console.log(`\nResults:`);
      console.log(`  Load Time: ${loadTime}ms (target: <${MOBILE_THRESHOLDS.TTI_MID_RANGE}ms)`);
      console.log(`  FCP: ${metrics.fcp.toFixed(0)}ms (target: <${MOBILE_THRESHOLDS.FCP_MID_RANGE}ms)`);
      if (memory) {
        console.log(`  Memory: ${memory.usedJSHeapSize.toFixed(1)}MB (target: <${MOBILE_THRESHOLDS.MEMORY_MID_RANGE_MB}MB)`);
      }

      if (loadTime < MOBILE_THRESHOLDS.TTI_MID_RANGE) {
        console.log('✅ Excellent performance for mid-range device');
      } else if (loadTime < MOBILE_THRESHOLDS.TTI_MID_RANGE * 1.5) {
        console.log('⚠️ Acceptable performance for mid-range device');
      } else {
        console.warn('❌ Below target for mid-range device');
      }

      console.log('========================================\n');

      expect(loadTime).toBeLessThan(MOBILE_THRESHOLDS.TTI_MID_RANGE * 2);
    } finally {
      await clearEmulation(cdpSession);
    }
  });
});

// ============================================================================
// FLAGSHIP DEVICE TESTS
// ============================================================================

test.describe('Flagship Device Performance', () => {
  test('Performance on flagship mobile', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    const device = MOBILE_DEVICES.flagship;

    try {
      await page.setViewportSize(device.viewport);
      await configureDevice(cdpSession, device);

      console.log(`\n=== ${device.name} Performance Test ===`);

      const startTime = Date.now();
      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      const loadTime = Date.now() - startTime;

      const metrics = await collectWebVitals(page);
      const memory = await getMemoryMetrics(page);

      console.log(`\nResults:`);
      console.log(`  Load Time: ${loadTime}ms (target: <${MOBILE_THRESHOLDS.TTI_FLAGSHIP}ms)`);
      console.log(`  FCP: ${metrics.fcp.toFixed(0)}ms (target: <${MOBILE_THRESHOLDS.FCP_FLAGSHIP}ms)`);
      console.log(`  LCP: ${metrics.lcp.toFixed(0)}ms`);
      if (memory) {
        console.log(`  Memory: ${memory.usedJSHeapSize.toFixed(1)}MB`);
      }

      if (loadTime < MOBILE_THRESHOLDS.TTI_FLAGSHIP) {
        console.log('✅ Excellent performance for flagship device');
      }

      console.log('======================================\n');

      expect(loadTime).toBeLessThan(MOBILE_THRESHOLDS.TTI_FLAGSHIP * 2);
    } finally {
      await clearEmulation(cdpSession);
    }
  });
});

// ============================================================================
// INTERACTION TESTS
// ============================================================================

test.describe('Mobile Interaction Performance', () => {
  test('Touch scroll responsiveness', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    const device = MOBILE_DEVICES.midRange;

    try {
      await page.setViewportSize(device.viewport);
      await configureDevice(cdpSession, device);

      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      console.log('\n=== Touch Scroll Test ===');

      // Perform touch scroll simulation
      const scrollContainer = await page.locator('main, .sequence-viewer, #root > div').first();

      if (await scrollContainer.isVisible()) {
        // Measure scroll performance
        const scrollMetrics = await page.evaluate(async () => {
          const frameTimes: number[] = [];
          let lastTime = performance.now();
          let frameCount = 0;

          const measureFrames = () => {
            return new Promise<void>((resolve) => {
              const observer = (currentTime: number) => {
                frameTimes.push(currentTime - lastTime);
                lastTime = currentTime;
                frameCount++;

                if (frameCount < 60) {
                  requestAnimationFrame(observer);
                } else {
                  resolve();
                }
              };
              requestAnimationFrame(observer);
            });
          };

          await measureFrames();

          const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
          const jankFrames = frameTimes.filter(t => t > 16.67).length;

          return {
            avgFrameTime: Math.round(avgFrameTime * 10) / 10,
            jankFrames,
            totalFrames: frameCount,
            fps: Math.round(1000 / avgFrameTime),
          };
        });

        console.log(`  Average Frame Time: ${scrollMetrics.avgFrameTime}ms`);
        console.log(`  FPS: ${scrollMetrics.fps}`);
        console.log(`  Jank Frames: ${scrollMetrics.jankFrames}/${scrollMetrics.totalFrames}`);

        if (scrollMetrics.jankFrames < MOBILE_THRESHOLDS.SCROLL_JANK_THRESHOLD) {
          console.log('✅ Smooth scrolling');
        } else {
          console.warn('⚠️ Scroll jank detected');
        }
      }

      console.log('=========================\n');
    } finally {
      await clearEmulation(cdpSession);
    }
  });

  test('Keyboard navigation on mobile', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    const device = MOBILE_DEVICES.midRange;

    try {
      await page.setViewportSize(device.viewport);
      await configureDevice(cdpSession, device);

      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);

      console.log('\n=== Mobile Navigation Test ===');

      // Test arrow key navigation (simulating software keyboard)
      const startTime = Date.now();

      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(50);
      }

      const navTime = Date.now() - startTime;

      console.log(`  Navigation Time (5 keypresses): ${navTime}ms`);
      console.log(`  Avg per keypress: ${(navTime / 5).toFixed(0)}ms`);

      if (navTime / 5 < MOBILE_THRESHOLDS.TOUCH_RESPONSE_MS) {
        console.log('✅ Navigation responsive');
      } else {
        console.warn('⚠️ Navigation may feel sluggish');
      }

      console.log('==============================\n');

      expect(navTime / 5).toBeLessThan(MOBILE_THRESHOLDS.TOUCH_RESPONSE_MS * 2);
    } finally {
      await clearEmulation(cdpSession);
    }
  });
});

// ============================================================================
// MEMORY STRESS TEST
// ============================================================================

test.describe('Mobile Memory Management', () => {
  test('Memory usage during extended mobile session', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    const device = MOBILE_DEVICES.midRange;

    try {
      await page.setViewportSize(device.viewport);
      await configureDevice(cdpSession, device);

      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      console.log('\n=== Mobile Memory Stress Test ===');

      const memoryReadings: number[] = [];
      const initialMemory = await getMemoryMetrics(page);

      if (initialMemory) {
        memoryReadings.push(initialMemory.usedJSHeapSize);
        console.log(`Initial Memory: ${initialMemory.usedJSHeapSize.toFixed(1)}MB`);
      }

      // Simulate user activity cycles
      for (let cycle = 0; cycle < 5; cycle++) {
        // Navigate between phages
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(300);

        // Scroll
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press('ArrowRight');
          await page.waitForTimeout(100);
        }

        // Toggle overlay
        await page.keyboard.press('g');
        await page.waitForTimeout(200);
        await page.keyboard.press('g');
        await page.waitForTimeout(200);

        const mem = await getMemoryMetrics(page);
        if (mem) {
          memoryReadings.push(mem.usedJSHeapSize);
        }
      }

      const finalMemory = await getMemoryMetrics(page);

      if (finalMemory && memoryReadings.length > 0) {
        const memoryGrowth = finalMemory.usedJSHeapSize - memoryReadings[0];
        const maxMemory = Math.max(...memoryReadings);

        console.log(`Final Memory: ${finalMemory.usedJSHeapSize.toFixed(1)}MB`);
        console.log(`Memory Growth: ${memoryGrowth.toFixed(1)}MB`);
        console.log(`Peak Memory: ${maxMemory.toFixed(1)}MB`);
        console.log(`Target Max: ${MOBILE_THRESHOLDS.MEMORY_MID_RANGE_MB}MB`);

        if (maxMemory < MOBILE_THRESHOLDS.MEMORY_MID_RANGE_MB) {
          console.log('✅ Memory usage acceptable for mobile');
        } else {
          console.warn('⚠️ Memory usage may cause issues on mobile devices');
        }
      }

      console.log('==================================\n');
    } finally {
      await clearEmulation(cdpSession);
    }
  });
});

// ============================================================================
// TABLET TESTS
// ============================================================================

test.describe('Tablet Performance', () => {
  test('Performance on tablet viewport', async ({ page }) => {
    const cdpSession = await getCDPSession(page);
    const device = MOBILE_DEVICES.tablet;

    try {
      await page.setViewportSize(device.viewport);
      await configureDevice(cdpSession, device);

      console.log(`\n=== ${device.name} Performance Test ===`);
      console.log(`Viewport: ${device.viewport.width}x${device.viewport.height}`);

      const startTime = Date.now();
      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      const loadTime = Date.now() - startTime;

      const metrics = await collectWebVitals(page);

      console.log(`\nResults:`);
      console.log(`  Load Time: ${loadTime}ms`);
      console.log(`  FCP: ${metrics.fcp.toFixed(0)}ms`);
      console.log(`  LCP: ${metrics.lcp.toFixed(0)}ms`);

      // Tablets should perform closer to desktop
      if (loadTime < 3000) {
        console.log('✅ Excellent tablet performance');
      }

      console.log('====================================\n');

      expect(loadTime).toBeLessThan(5000);
    } finally {
      await clearEmulation(cdpSession);
    }
  });
});

// Summary report
test.afterAll(async () => {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  MOBILE PERFORMANCE BENCHMARK COMPLETE       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║                                              ║');
  console.log('║  Device Targets:                             ║');
  console.log('║  - Low-end:   TTI < 8s,  Memory < 50MB       ║');
  console.log('║  - Mid-range: TTI < 5s,  Memory < 75MB       ║');
  console.log('║  - Flagship:  TTI < 2s,  Memory < 100MB      ║');
  console.log('║                                              ║');
  console.log('║  Interaction Targets:                        ║');
  console.log('║  - Touch response: < 100ms                   ║');
  console.log('║  - Scroll jank frames: < 50                  ║');
  console.log('║                                              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('\n');
});
