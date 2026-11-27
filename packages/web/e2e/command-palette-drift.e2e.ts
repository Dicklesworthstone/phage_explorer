import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';
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
  test('Enter and Tab use the highlighted row across categories and recent commands', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);
    await page.addInitScript(() => localStorage.setItem('phage-explorer-recent-commands', '["overlay.help"]'));
    try {
      await page.goto('/?phage=lambda&model=0');
      await expectExplorerIdentity(page, testInfo);
      const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
      if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
      const palette = page.getByTestId('overlay-commandPalette');
      const input = page.getByTestId('command-palette-input');
      // Registered late, but displayed near the top alongside the other navigation commands.
      const title = ActionRegistry[ActionIds.NavSavedViews].title;
      for (const key of ['Enter', 'Tab']) {
        await page.getByRole('button', { name: /command palette/i }).first().click();
        await expect(palette.getByRole('group', { name: 'Recent commands' })).toBeVisible();
        const row = palette.getByRole('group', { name: 'Navigation commands' }).getByRole('option', { name: new RegExp(title) });
        const index = Number(await row.getAttribute('data-cmd-index'));
        expect(index).toBeGreaterThan(0);
        for (let i = 0; i < index; i++) await input.press('ArrowDown');
        await expect(row).toHaveAttribute('aria-selected', 'true');
        await expect(input).toHaveAttribute('aria-activedescendant', `cmd-item-${index}`);
        await input.press(key);
        if (key === 'Enter') {
          await expect(page.getByTestId('overlay-savedViews')).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('overlay-savedViews')).toBeHidden();
        } else {
          await expect(input).toHaveValue(title);
        }
      }
    } finally {
      await finalize();
    }
  });

  test('changing the query cannot execute a previous result while catalog search is pending', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);
    // Leave the second catalog query in flight. Keystrokes and command execution
    // should work independently of when the search worker returns.
    await page.addInitScript(() => {
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args: unknown[]) {
        if (message?.path?.[0] === 'fuzzySearch' && message.argumentList?.[0]?.value?.query === 'no-such-palette-result') {
          document.documentElement.dataset.paletteQueryPending = 'true';
          return;
        }
        return Reflect.apply(send, this, [message, ...args]);
      };
    });
    try {
      await page.goto('/?phage=lambda&model=0');
      await expectExplorerIdentity(page, testInfo);
      const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
      if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
      await page.getByRole('button', { name: /command palette/i }).first().click();
      const palette = page.getByTestId('overlay-commandPalette');
      const input = palette.getByRole('combobox');
      await input.fill('lambda');
      await expect(palette.getByRole('group', { name: 'Phages commands' }).getByRole('option').first()).toBeVisible();

      await input.fill('no-such-palette-result');
      await expect(page.locator('html')).toHaveAttribute('data-palette-query-pending', 'true');
      await expect(palette.getByRole('option')).toHaveCount(0);
      await input.press('Enter');
      await expect(palette).toBeVisible();

      // This phrase occurs only in the saved-views action description.
      await input.fill('name, restore, import and export exact explorer views');
      const row = palette.getByRole('option', { name: /Saved views and navigation history/i });
      await expect(row).toHaveAttribute('aria-selected', 'true');
      await input.press('Enter');
      await expect(page.getByTestId('overlay-savedViews')).toBeVisible();
    } finally {
      await finalize();
    }
  });

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
