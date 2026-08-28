import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';

async function waitForSequenceReady(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('header.app-header')).toBeVisible({ timeout: 30000 });

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

  const canvas = page.locator('.sequence-grid-canvas');
  await expect(canvas).toBeVisible({ timeout: 30000 });
  await canvas.scrollIntoViewIfNeeded();

  const description = page.locator('#sequence-view-description');
  await expect(description).not.toContainText('not loaded yet', { timeout: 30000 });

  const jumpStatus = page.locator('.sequence-view__jump-status').first();
  await expect(jumpStatus).toContainText('Pos:', { timeout: 30000 });
}

async function getCanvasBlackPixelRatio(page: Page, selector = '.sequence-grid-canvas') {
  return page.evaluate(async (sel) => {
    const canvas = document.querySelector(sel);
    if (!(canvas instanceof HTMLCanvasElement)) {
      return { ok: false as const, reason: 'canvas_not_found' as const };
    }

    const width = canvas.width;
    const height = canvas.height;
    if (width <= 0 || height <= 0) {
      return { ok: false as const, reason: 'canvas_zero_size' as const, width, height };
    }

    const dataUrl = canvas.toDataURL('image/png');
    const img = new Image();
    img.decoding = 'async';
    img.src = dataUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('failed_to_load_canvas_image'));
    });

    const analysisSize = 256;
    const probe = document.createElement('canvas');
    probe.width = analysisSize;
    probe.height = analysisSize;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return { ok: false as const, reason: 'probe_context_failed' as const };
    }
    // Keep nearest-neighbor characteristics so pure-black tiles stay detectable after downscale.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, analysisSize, analysisSize);

    const image = ctx.getImageData(0, 0, analysisSize, analysisSize);
    const data = image.data;
    let nearBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Treat very-dark pixels as "black tiles" (helps detect unpainted canvas regions).
      if (r <= 1 && g <= 1 && b <= 1) {
        nearBlack++;
      }
    }

    const total = analysisSize * analysisSize;
    return {
      ok: true as const,
      ratio: nearBlack / total,
      nearBlack,
      total,
      source: { width, height },
    };
  }, selector);
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}

async function readJumpStatus(page: Page): Promise<string> {
  return (await page.locator('.sequence-view__jump-status').first().textContent())?.trim() ?? '';
}

test.describe('Sequence scroll repaint regression', () => {
  test('does not show large black regions during rapid scrolling', async ({ page }, testInfo) => {
    const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, testInfo);

    try {
      await waitForSequenceReady(page);

      const beforeStatus = await readJumpStatus(page);
      const beforeBlack = await getCanvasBlackPixelRatio(page);

      await attachJson(testInfo, 'canvas-black-before.json', {
        jumpStatus: beforeStatus,
        black: beforeBlack,
      });

      const canvas = page.locator('.sequence-grid-canvas');
      await canvas.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const box = await canvas.boundingBox();
      if (!box) {
        throw new Error('Expected canvas bounding box, got null');
      }
      await canvas.hover();

      // Aggressive wheel scrolling to provoke repaint issues.
      // Keep delays short to approximate a fast trackpad/mousewheel stream.
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => {
          const target =
            document.querySelector('.sequence-view__canvas-wrapper') ??
            document.querySelector('.sequence-grid-canvas');
          target?.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true })
          );
        });
        await page.waitForTimeout(20);
      }

      // Capture quickly after scroll input while the renderer may still be catching up.
      const jumpStatusLocator = page.locator('.sequence-view__jump-status').first();
      await expect(jumpStatusLocator).not.toHaveText(beforeStatus, { timeout: 10000 });
      const afterStatus = await readJumpStatus(page);
      const afterBlack = await getCanvasBlackPixelRatio(page);

      await attachJson(testInfo, 'canvas-black-after.json', {
        jumpStatus: afterStatus,
        black: afterBlack,
      });

      // Sanity: verify we actually scrolled.
      expect(afterStatus).not.toBe(beforeStatus);

      // Fail fast on crashes/errors that often accompany rendering glitches.
      expect(pageErrors).toHaveLength(0);
      expect(consoleErrors).toHaveLength(0);

      // Regression guard: large portions of the canvas should not be near-black.
      // Threshold is intentionally permissive because themes are dark; we're catching massive black tiles.
      if (!afterBlack.ok) {
        throw new Error(`Canvas analysis failed: ${afterBlack.reason}`);
      }
      expect(afterBlack.ratio).toBeLessThan(0.12);
    } finally {
      await finalize();
    }
  });
});
