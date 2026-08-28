import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';
import { ActionRegistry, ActionIds } from '../src/keyboard/actionRegistry';
import { formatPrimaryActionShortcut, type ShortcutPlatform } from '../src/keyboard/actionSurfaces';

async function captureErrorBoundaryDetails(page: Page, testInfo: TestInfo) {
  const boundary = page.locator('.error-boundary');
  const visible = await boundary.isVisible().catch(() => false);
  if (!visible) return;

  const details = boundary.locator('details');
  if (await details.count()) {
    const summary = details.locator('summary');
    await summary.click().catch(() => null);
  }

  const pre = boundary.locator('pre');
  const detailsText = await pre.innerText().catch(() => null);
  if (detailsText) {
    await testInfo.attach('error-boundary.txt', {
      body: detailsText,
      contentType: 'text/plain',
    });
  }
}

test.describe('Command Palette Drift', () => {
  test('should display shortcuts matching ActionRegistry', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    try {
      await page.goto('/');
      await expect(page.locator('header.app-header')).toBeVisible();

      // Welcome modal intercepts shortcuts; dismiss it if the first-run sheet is up.
      const skip = page.locator('.welcome-footer__skip');
      if (await skip.isVisible().catch(() => false)) {
        await skip.click().catch(() => {});
        await page.locator('.overlay-welcome').waitFor({ state: 'hidden' }).catch(() => {});
      }

      await page.waitForSelector('#root > div', { timeout: 30000 });

      // Ctrl+K is the platform shortcut; ':' is the vim-style alias.
      await page.keyboard.press('Control+k');
      const palette = page.locator('[data-testid="overlay-commandPalette"]');
      if (!(await palette.isVisible().catch(() => false))) {
        await page.keyboard.press(':');
      }

      // If the app crashed, attach details for debugging.
      await captureErrorBoundaryDetails(page, testInfo);
      await expect(page.locator('.error-boundary')).toBeHidden();

      await expect(palette).toBeVisible();

      // Check a few key actions
      const shortcutPlatform = await page.evaluate((): ShortcutPlatform => {
        const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
        const platform = (nav.userAgentData?.platform ?? navigator.platform ?? '').toLowerCase();
        return platform.includes('mac') ? 'mac' : 'default';
      });

      const checkAction = async (actionId: string) => {
        const action = ActionRegistry[actionId as keyof typeof ActionRegistry];
        if (!action) return;

        // Find the item in the palette
        const item = palette.locator('[role="option"]', { hasText: action.title }).first();
        await expect(item).toBeVisible();

        const expected = formatPrimaryActionShortcut(action, shortcutPlatform);
        expect(expected).toBeTruthy();

        const shortcutHint = item.locator('.key-hint').first();
        await expect(shortcutHint).toHaveText(expected!);
      };

      await checkAction(ActionIds.OverlaySettings);
      await checkAction(ActionIds.OverlayHelp);
      await checkAction(ActionIds.ViewToggle3DModel);
    } finally {
      await finalize();
    }
  });
});
