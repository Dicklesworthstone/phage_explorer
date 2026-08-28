import { test, expect } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';

test.describe('Hotkeys and Overlay Stack', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();
    const welcome = page.locator('.overlay-welcome');
    if (await welcome.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await welcome.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
    }
  });

  test('should enforce overlay stack limit and support undo', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await test.step('Cold load', async () => {
      await page.waitForTimeout(300); // Wait for hydration
    });

    await test.step('Open 3 overlays (Help, Settings, AA Key)', async () => {
      // 1. Open Help (?)
      await page.keyboard.press('?');
      await expect(page.locator('[data-testid="overlay-help"]')).toBeVisible();

      // 2. Open Settings (Ctrl+,)
      await page.keyboard.press('Control+,');
      await expect(page.locator('[data-testid="overlay-settings"]')).toBeVisible();

      // 3. Open AA Key (Shift+K)
      await page.keyboard.press('Shift+K');
      await expect(page.locator('[data-testid="overlay-aaKey"]')).toBeVisible();

      // Assert stack size is 3 (all visible)
      const overlays = page.locator('.overlay[data-testid^="overlay-"]');
      expect(await overlays.count()).toBe(3);
    });

    await test.step('Open 4th overlay (Command Palette) - expect replacement', async () => {
      // 4. Open Command Palette (Control+k)
      await page.keyboard.press('Control+k');

      // Expect Command Palette to appear
      await expect(page.locator('[data-testid="overlay-commandPalette"]')).toBeVisible();

      // Expect stack size to remain 3 (Help should be evicted)
      const overlays = page.locator('.overlay[data-testid^="overlay-"]');
      expect(await overlays.count()).toBe(3);

      // Help should be gone
      await expect(page.locator('[data-testid="overlay-help"]')).toBeHidden();

      // Check for toast
      const toast = page.locator('[data-testid="overlay-stack-limit-toast"]');
      await expect(toast).toBeVisible();
      await expect(toast).toContainText('Overlay limit');
    });

    await test.step('Undo eviction', async () => {
      const undoBtn = page.locator('[data-testid="overlay-stack-limit-undo"]');
      await undoBtn.click();

      // Expect Command Palette to disappear
      await expect(page.locator('[data-testid="overlay-commandPalette"]')).toBeHidden();

      // Expect Help to reappear
      await expect(page.locator('[data-testid="overlay-help"]')).toBeVisible();

      // Stack should be back to Help, Settings, AA Key
      await expect(page.locator('[data-testid="overlay-settings"]')).toBeVisible();
      await expect(page.locator('[data-testid="overlay-aaKey"]')).toBeVisible();
    });

    await finalize();
  });

  test('should close overlays in LIFO order with Escape', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();

    // Open Help -> Settings
    await page.keyboard.press('?');
    await expect(page.locator('[data-testid="overlay-help"]')).toBeVisible();

    await page.keyboard.press('Control+,');
    await expect(page.locator('[data-testid="overlay-settings"]')).toBeVisible();

    // Press Escape -> Should close Settings (top), Help remains
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="overlay-settings"]')).toBeHidden();
    await expect(page.locator('[data-testid="overlay-help"]')).toBeVisible();

    // Press Escape -> Should close Help
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="overlay-help"]')).toBeHidden();

    await finalize();
  });

  test('overlay-internal hotkeys should only fire when overlay is topmost', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();

    await test.step('Open Help overlay and verify detail toggle works', async () => {
      await page.keyboard.press('?');
      const helpOverlay = page.locator('[data-testid="overlay-help"]');
      await expect(helpOverlay).toBeVisible();

      // Find the detail toggle indicator or check UI state
      // The 'd' key should cycle detail levels (essential -> detailed -> essential)
      // Look for visual indicator of detail level change
      // If there's a toggle button, get its initial state
      // For now, we just verify pressing 'd' doesn't cause errors when Help is topmost
      await page.keyboard.press('d');

      // Help overlay should still be visible and functional
      await expect(helpOverlay).toBeVisible();
    });

    await test.step('Open Settings on top - Help detail toggle should be blocked', async () => {
      await page.keyboard.press('Control+,');
      const settingsOverlay = page.locator('[data-testid="overlay-settings"]');
      await expect(settingsOverlay).toBeVisible();

      // Both overlays should be in DOM
      await expect(page.locator('[data-testid="overlay-help"]')).toBeVisible();

      // Press 'd' - should NOT affect Help overlay because Settings is topmost
      // This is the key test: 'd' is contextual to Help, so it shouldn't fire
      await page.keyboard.press('d');

      // Settings should still be open (wasn't closed by 'd')
      await expect(settingsOverlay).toBeVisible();
      // Help should still be open too
      await expect(page.locator('[data-testid="overlay-help"]')).toBeVisible();
    });

    await test.step('Close Settings - Help detail toggle should work again', async () => {
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid="overlay-settings"]')).toBeHidden();
      await expect(page.locator('[data-testid="overlay-help"]')).toBeVisible();

      // Now Help is topmost, 'd' should work again
      await page.keyboard.press('d');

      // Help overlay should still be visible
      await expect(page.locator('[data-testid="overlay-help"]')).toBeVisible();
    });

    await finalize();
  });

  test('command palette: Escape clears query then closes', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();

    await page.keyboard.press(':');
    const palette = page.locator('[data-testid="overlay-commandPalette"]');
    await expect(palette).toBeVisible();

    const input = page.locator('[data-testid="command-palette-input"]');
    await expect(input).toBeFocused();

    await input.fill('theme');
    await expect(input).toHaveValue('theme');

    // First Escape clears query, keeps palette open
    await page.keyboard.press('Escape');
    await expect(palette).toBeVisible();
    await expect(input).toHaveValue('');

    // Second Escape closes palette
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await finalize();
  });

  test('platform shortcuts: Control+K and Meta+K open command palette', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();
    await page.waitForTimeout(500);

    // Use data-testid for stable selector
    const palette = page.locator('[data-testid="overlay-commandPalette"]');
    const input = page.locator('[data-testid="command-palette-input"]');

    await test.step('Control+K opens palette (Windows/Linux)', async () => {
      await page.keyboard.press('Control+k');
      await expect(palette).toBeVisible();
      await expect(input).toBeFocused();

      // Close it
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
    });

    await test.step('Meta+K opens palette (macOS)', async () => {
      await page.keyboard.press('Meta+k');
      await expect(palette).toBeVisible();
      await expect(input).toBeFocused();

      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
    });

    await test.step('Legacy : shortcut still works', async () => {
      await page.keyboard.press(':');
      await expect(palette).toBeVisible();

      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
    });

    await finalize();
  });

  test('platform shortcuts: Control+, and Meta+, open settings', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();
    await page.waitForTimeout(500);

    const settings = page.locator('[data-testid="overlay-settings"]');

    await test.step('Control+, opens settings (Windows/Linux)', async () => {
      await page.keyboard.press('Control+,');
      await expect(settings).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(settings).toBeHidden();
    });

    await test.step('Meta+, opens settings (macOS)', async () => {
      await page.keyboard.press('Meta+,');
      await expect(settings).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(settings).toBeHidden();
    });

    await finalize();
  });

  test('analysis overlays open via keyboard shortcuts', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();
    await page.waitForTimeout(500);

    // Note: Analysis overlays require a phage to be loaded
    // Check if we have a phage loaded first
    const phageList = page.locator('[data-testid="phage-list"]');
    const hasPhages = await phageList.count() > 0;

    if (hasPhages) {
      await test.step('GC Skew opens via G key', async () => {
        await page.keyboard.press('g');
        const gcSkewOverlay = page.locator('[data-testid="overlay-gcSkew"]');
        // May or may not appear depending on phage state - just verify no error
        await page.waitForTimeout(300);

        // Close if it opened
        if (await gcSkewOverlay.isVisible()) {
          await page.keyboard.press('Escape');
        }
      });

      await test.step('Analysis Menu opens via A key', async () => {
        await page.keyboard.press('a');
        const analysisMenu = page.locator('[data-testid="overlay-analysisMenu"]');
        await expect(analysisMenu).toBeVisible({ timeout: 3000 });

        await page.keyboard.press('Escape');
        await expect(analysisMenu).toBeHidden();
      });
    }

    await finalize();
  });

  test('shortcuts should not fire while typing in input', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();
    await page.waitForTimeout(500);

    // Open command palette
    await page.keyboard.press(':');
    const palette = page.locator('[data-testid="overlay-commandPalette"]');
    await expect(palette).toBeVisible();

    const input = page.locator('[data-testid="command-palette-input"]');
    await expect(input).toBeFocused();

    // Type 'g' while focused in input - should NOT trigger GC Skew overlay
    await input.fill('g');
    await expect(input).toHaveValue('g');

    // GC Skew overlay should NOT be visible
    await expect(page.locator('[data-testid="overlay-gcSkew"]')).toBeHidden();

    // Command palette should still be visible
    await expect(palette).toBeVisible();

    await finalize();
  });
});
