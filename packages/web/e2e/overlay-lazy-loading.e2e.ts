import { test, expect } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Overlay lazy-load chunking E2E regression test (s4qx.8.4)
 *
 * Verifies:
 * 1. No overlay chunks fetched on cold load
 * 2. Opening an overlay fetches only that overlay's chunk
 * 3. Unrelated overlays remain unfetched
 *
 * Outputs:
 * - network-chunks.json: Filtered list of JS chunk requests with timing
 */

// Known overlay chunk patterns (Vite may hash these, but source paths often leak)
const OVERLAY_CHUNK_PATTERNS = [
  /HelpOverlay/i,
  /SettingsOverlay/i,
  /SearchOverlay/i,
  /CommandPalette/i,
  /AnalysisMenu/i,
  /SimulationHub/i,
  /GCSkewOverlay/i,
  /ComplexityOverlay/i,
  /BendabilityOverlay/i,
  /RepeatsOverlay/i,
  /GelOverlay/i,
  /HilbertOverlay/i,
  /PhasePortraitOverlay/i,
  /GenomicSignaturePCAOverlay/i,
  /DefenseArmsRaceOverlay/i,
  /\/overlays\//i,  // Any path containing /overlays/
];

// Patterns for JS chunks (not the main bundle)
const JS_CHUNK_PATTERNS = [
  /\/assets\/[^/]+\.js$/,  // Vite production chunks
  /\.chunk\.js$/,
  /\.[a-f0-9]{8}\.js$/,    // Hash-based chunk names
];

interface ChunkRequest {
  url: string;
  ts: number;
  phase: 'cold-load' | 'after-open';
  matchedPattern?: string;
}

function isOverlayChunk(url: string): { isOverlay: boolean; pattern?: string } {
  for (const pattern of OVERLAY_CHUNK_PATTERNS) {
    if (pattern.test(url)) {
      return { isOverlay: true, pattern: pattern.toString() };
    }
  }
  return { isOverlay: false };
}

function isJsChunk(url: string): boolean {
  // Exclude main entry points and vendor chunks that load on cold start
  if (url.includes('index') && url.includes('.js')) return false;
  if (url.includes('vendor')) return false;
  if (url.includes('polyfill')) return false;

  return JS_CHUNK_PATTERNS.some(p => p.test(url)) || url.endsWith('.js');
}

test.describe('Overlay Lazy Loading', () => {
  test('should not load overlay chunks until opened', async ({ page }, testInfo) => {
    const { state, finalize, consoleErrors, pageErrors } = setupTestHarness(page, testInfo);
    const chunkRequests: ChunkRequest[] = [];
    let coldLoadEndMs = 0;
    let openedOverlayAtMs = 0;

    // Seed intermediate level so a lazy-loaded analysis overlay is reachable
    // from the keyboard (core overlays like Help/Settings are eagerly bundled).
    await page.addInitScript(() => {
      localStorage.setItem(
        'phage-explorer-main-prefs',
        JSON.stringify({ experienceLevel: 'intermediate' })
      );
    });

    await test.step('Cold load', async () => {
      await page.goto('/?phage=lambda&model=0');
      await expectExplorerIdentity(page, testInfo);
      const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
      if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
      coldLoadEndMs = Date.now() - state.startTs;
    });

    await test.step('Catalog cold-load requests', async () => {
      const requests = state.network.filter(n => n.type === 'request' && n.ts <= coldLoadEndMs);

      for (const req of requests) {
        if (!isJsChunk(req.url)) continue;

        const overlayCheck = isOverlayChunk(req.url);
        chunkRequests.push({
          url: req.url,
          ts: req.ts,
          phase: 'cold-load',
          matchedPattern: overlayCheck.pattern,
        });
      }
    });

    await test.step('Verify no eager overlay loads', async () => {
      const eagerOverlays = chunkRequests.filter(c => c.phase === 'cold-load' && c.matchedPattern);

      if (eagerOverlays.length > 0) {
        console.error('REGRESSION: Detected eager overlay chunk loads on cold start:');
        for (const chunk of eagerOverlays) {
          console.error(`  - ${chunk.url} (matched: ${chunk.matchedPattern})`);
        }
      }

      expect(eagerOverlays, 'No overlay chunks should load on cold start').toHaveLength(0);
    });

    await test.step('Open GC skew overlay via keyboard', async () => {
      openedOverlayAtMs = Date.now() - state.startTs;
      await page.keyboard.press('g');

      // GC skew is lazy-loaded; wait for it to render.
      const gcSkewOverlay = page.locator('[data-testid="overlay-gcSkew"]');
      await expect(gcSkewOverlay).toBeVisible({ timeout: 5000 });
    });

    await test.step('Wait for chunk to load', async () => {
      // Give time for dynamic import to complete
      await page.waitForTimeout(500);
    });

    await test.step('Catalog post-open requests', async () => {
      const requests = state.network.filter(n => n.type === 'request' && n.ts > coldLoadEndMs);

      for (const req of requests) {
        if (!isJsChunk(req.url)) continue;

        const overlayCheck = isOverlayChunk(req.url);
        chunkRequests.push({
          url: req.url,
          ts: req.ts,
          phase: 'after-open',
          matchedPattern: overlayCheck.pattern,
        });
      }
    });

    await test.step('Verify chunk loaded on demand', async () => {
      const postOpenChunks = chunkRequests.filter(c => c.phase === 'after-open');

      // We expect at least one new JS request after opening the overlay
      // In dev mode, Vite serves the module directly; in prod, it's a chunk
      const gcSkewChunk = postOpenChunks.find(c =>
        c.matchedPattern?.includes('GCSkewOverlay') ||
        c.url.includes('GCSkewOverlay') ||
        c.url.includes('/overlays/')
      );

      expect(
        gcSkewChunk,
        'Expected the GC skew module after opening its overlay'
      ).toBeTruthy();
    });

    await test.step('Verify unrelated overlays not loaded', async () => {
      // After opening Help, Settings/CommandPalette/etc should NOT be loaded
      const unrelatedPatterns = [/SettingsOverlay/i, /CommandPalette/i, /AnalysisMenu/i];

      const unrelatedLoads = chunkRequests.filter(c =>
        unrelatedPatterns.some(p => p.test(c.url))
      );

      if (unrelatedLoads.length > 0) {
        console.warn('Detected unrelated overlay loads (may be acceptable in dev mode):');
        for (const chunk of unrelatedLoads) {
          console.warn(`  - ${chunk.url}`);
        }
      }

      expect(unrelatedLoads, 'Opening GC skew must not fetch unrelated overlay chunks').toHaveLength(0);
    });

    await test.step('Write network-chunks.json artifact', async () => {
      const outputDir = testInfo.outputDir;
      await fs.mkdir(outputDir, { recursive: true });

      const artifact = {
        testName: 'overlay-lazy-loading',
        timestamp: new Date().toISOString(),
        coldLoadEndMs,
        openedOverlayAtMs,
        summary: {
          totalChunks: chunkRequests.length,
          coldLoadChunks: chunkRequests.filter(c => c.phase === 'cold-load').length,
          afterOpenChunks: chunkRequests.filter(c => c.phase === 'after-open').length,
          eagerOverlayChunks: chunkRequests.filter(c => c.phase === 'cold-load' && c.matchedPattern).length,
        },
        chunks: chunkRequests,
      };

      const artifactPath = path.join(outputDir, 'network-chunks.json');
      await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8');
      await testInfo.attach('network-chunks.json', {
        path: artifactPath,
        contentType: 'application/json'
      });
    });

    // Final assertions
    expect(consoleErrors, 'No console errors expected').toEqual([]);
    expect(pageErrors, 'No page errors expected').toEqual([]);

    await finalize();
  });

  test('opening Settings should not load Help chunk', async ({ page }, testInfo) => {
    const { state, finalize } = setupTestHarness(page, testInfo);

    await test.step('Cold load', async () => {
      await page.goto('/');
      await expect(page.locator('header.app-header')).toBeVisible();
      await page.waitForTimeout(500);
    });

    const preOpenTs = Date.now() - state.startTs;

    await test.step('Open Settings overlay', async () => {
      await page.keyboard.press('Control+,');
      const settingsOverlay = page.locator('[data-testid="overlay-settings"]');
      await expect(settingsOverlay).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(500);
    });

    await test.step('Verify Help not loaded', async () => {
      const requests = state.network.filter(n =>
        n.type === 'request' &&
        n.ts > preOpenTs &&
        /HelpOverlay/i.test(n.url)
      );

      expect(requests, 'Help overlay should not load when opening Settings').toHaveLength(0);
    });

    await finalize();
  });
});
