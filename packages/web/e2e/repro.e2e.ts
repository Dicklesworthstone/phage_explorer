import { test, expect } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';

test('mobile: welcome sheet visible and Lenis disabled', async ({ page }, testInfo) => {
  test.skip(
    !/(^mobile-|^android-|^tablet-)/.test(testInfo.project.name),
    'Mobile-only assertions (touch + coarse pointer)'
  );

  const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, testInfo);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#root > div', { timeout: 30000 });
  await page.waitForTimeout(1500);

  // On touch devices we should not initialize Lenis at all.
  const htmlClassName = await page.evaluate(() => document.documentElement.className);
  expect(htmlClassName).not.toMatch(/\blenis\b/);

  // Welcome overlay should show on first run and be reachable on mobile.
  const welcomeOverlay = page.locator('.overlay-welcome');
  await expect(welcomeOverlay).toBeVisible();

  const skip = page.locator('.welcome-footer__skip');
  await expect(skip).toBeVisible();
  await expect(skip).toBeEnabled();

  const [isBottomSheet, skipRect, viewport] = await Promise.all([
    page.locator('.bottom-sheet__container').isVisible().catch(() => false),
    skip.evaluate((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }),
    page.viewportSize(),
  ]);

  expect(viewport).not.toBeNull();
  if (viewport) {
    expect(skipRect.bottom).toBeLessThanOrEqual(viewport.height + 1);
  }

  // On narrow mobile, Welcome should render its footer into the BottomSheet footer slot.
  if (isBottomSheet) {
    const isInBottomSheetFooter = await skip.evaluate((el) => Boolean(el.closest('.bottom-sheet__footer')));
    expect(isInBottomSheetFooter).toBe(true);
  }

  // Mobile scroll flicker mitigation: backdrop-filter should be disabled on touch devices.
  const headerBackdrop = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.app-header');
    if (!header) return null;
    const style = window.getComputedStyle(header);
    return {
      backdropFilter: (style as unknown as { backdropFilter?: string }).backdropFilter ?? '',
      webkitBackdropFilter: (style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ?? '',
    };
  });

  expect(headerBackdrop).not.toBeNull();
  if (headerBackdrop) {
    expect(headerBackdrop.backdropFilter.includes('blur')).toBe(false);
    expect(headerBackdrop.webkitBackdropFilter.includes('blur')).toBe(false);
  }

  // Dismiss welcome and ensure other overlays can open on mobile.
  await skip.click();
  await expect(welcomeOverlay).toBeHidden({ timeout: 5000 });

  const settingsButton = page.getByRole('button', { name: 'Open settings' });
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();

  const settingsOverlay = page.locator('.overlay-settings');
  await expect(settingsOverlay).toBeVisible();

  const settingsBottomSheetClose = page.locator('.bottom-sheet__close').first();
  if (await settingsBottomSheetClose.isVisible().catch(() => false)) {
    await settingsBottomSheetClose.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await expect(settingsOverlay).toBeHidden({ timeout: 5000 });

  // Ensure a phage is selected so ActionDrawer analysis actions are enabled.
  const quickStats = page.locator('.quick-stats');
  await expect(quickStats).toBeVisible({ timeout: 30000 });

  // 3D should be disabled by default on coarse-pointer devices (battery/perf).
  const mobile3DToggle = page.getByRole('button', { name: /^3D model:/ });
  await expect(mobile3DToggle).toBeVisible();
  await expect(mobile3DToggle).toHaveAttribute('aria-label', '3D model: off');

  // Fullscreen 3D should not turn into a full-screen overlay (regression: HUD panels used a full-surface class).
  await mobile3DToggle.click();
  await expect(mobile3DToggle).toHaveAttribute('aria-label', '3D model: on');

  const threePanel = page.locator('.panel', { hasText: '3D Structure' }).first();
  await threePanel.scrollIntoViewIfNeeded();

  const fullscreen3D = threePanel.locator('button[title="Fullscreen"]').first();
  await expect(fullscreen3D).toBeVisible();
  await fullscreen3D.click();

  const fullscreenHud = page.locator('.three-hud', { hasText: 'FPS' }).first();
  await expect(fullscreenHud).toBeVisible();
  await expect(page.locator('.three-overlay', { hasText: 'FPS' })).toHaveCount(0);

  // Exit fullscreen so it doesn't intercept subsequent mobile interactions (FAB, bottom sheets).
  await page.evaluate(() => {
    const btn = document.querySelector('button[title="Fullscreen"]');
    if (btn instanceof HTMLButtonElement) btn.click();
  });
  await expect(page.locator('.three-container--fullscreen')).toHaveCount(0);

  // ActionDrawer opens and launches a representative analysis overlay.
  const fab = page.getByRole('button', { name: 'Open control menu' });
  await expect(fab).toBeVisible();
  await fab.click();

  const drawer = page.locator('#action-drawer');
  await expect(drawer).toBeVisible();

  // BottomSheet uses transform-based animations; ensure the sheet is actually in the viewport
  // before interacting (Playwright's toBeVisible doesn't guarantee in-viewport).
  const sheetHandle = page.locator('.bottom-sheet__handle');
  await expect(sheetHandle).toBeVisible();
  await expect(sheetHandle).toBeInViewport();

  const packagingPressure = drawer.locator('[data-action-id="overlay.packagingPressure"]');
  await expect(packagingPressure).toBeVisible();
  await expect(packagingPressure).toBeEnabled();
  await packagingPressure.scrollIntoViewIfNeeded();
  await expect(packagingPressure).toBeInViewport();
  await packagingPressure.click();

  const pressureOverlay = page.locator('.overlay-pressure');
  await expect(pressureOverlay).toBeVisible();

  const pressureClose = page.locator('.bottom-sheet__close').first();
  if (await pressureClose.isVisible().catch(() => false)) {
    await pressureClose.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await expect(pressureOverlay).toBeHidden({ timeout: 5000 });

  // No uncaught JS errors.
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath('repro-mobile-welcome.png') });
  await finalize();
});

test('desktop: welcome stepper navigation and keyboard', async ({ page }, testInfo) => {
  test.skip(
    /(^mobile-|^android-|^tablet-)/.test(testInfo.project.name),
    'Desktop-only assertions'
  );

  const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, testInfo);

  await page.setViewportSize({ width: 1600, height: 900 });
  // Clear localStorage to ensure first-run state
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#root > div', { timeout: 30000 });
  await page.waitForTimeout(500);

  const welcomeOverlay = page.locator('.overlay-welcome');
  await expect(welcomeOverlay).toBeVisible({ timeout: 15000 });

  // Step 1: Intro - verify step indicator format
  const stepLabel = page.locator('.welcome-step-label');
  await expect(stepLabel).toContainText('Step 1 of 3', { timeout: 10000 });

  // Verify Next button is visible
  const nextButton = welcomeOverlay.locator('.btn-primary', { hasText: 'Next' });
  await expect(nextButton).toBeVisible();

  // Verify Back button is NOT visible on step 1
  const backButton = welcomeOverlay.locator('.btn-secondary', { hasText: 'Back' });
  await expect(backButton).toHaveCount(0);

  // Click Next to go to step 2
  await nextButton.click();
  await expect(stepLabel).toContainText('Step 2 of 3');

  // Step 2: Level selection - Back button should now be visible
  await expect(backButton).toBeVisible();

  // Click Back to return to step 1
  await backButton.click();
  await expect(stepLabel).toContainText('Step 1 of 3');

  // Use Enter key to advance (primary action)
  await page.keyboard.press('Enter');
  await expect(stepLabel).toContainText('Step 2 of 3');

  // Continue to step 3
  await page.keyboard.press('Enter');
  await expect(stepLabel).toContainText('Step 3 of 3');

  // Final step should show "Get Started" instead of "Next"
  const getStartedButton = welcomeOverlay.locator('.btn-primary', { hasText: 'Get Started' });
  await expect(getStartedButton).toBeVisible();

  // Test Escape closes the overlay
  await page.keyboard.press('Escape');
  await expect(welcomeOverlay).toBeHidden({ timeout: 5000 });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await finalize();
});

test('desktop: key overlays open and no console errors', async ({ page }, testInfo) => {
  test.skip(
    /(^mobile-|^android-|^tablet-)/.test(testInfo.project.name),
    'Desktop-only assertions'
  );

  const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, testInfo);

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#root > div', { timeout: 30000 });
  await page.waitForTimeout(500);

  // Dismiss welcome modal if present.
  const welcomeOverlay = page.locator('.overlay-welcome');
  const skip = page.locator('.welcome-footer__skip');
  if (await welcomeOverlay.isVisible()) {
    await expect(skip).toBeVisible();
    await skip.click();
    await expect(welcomeOverlay).toBeHidden({ timeout: 5000 });
  }

  // Header shortcut hints should reflect actual ActionRegistry bindings (trust surface).
  const commandPaletteButton = page.getByRole('button', { name: 'Open command palette' });
  await expect(commandPaletteButton).toBeVisible();
  await expect(commandPaletteButton).toHaveAttribute('title', /Command Palette/);
  await expect(commandPaletteButton).toHaveAttribute('title', /Ctrl\+k|Cmd\+k|:/i);

  const headerSettingsButton = page.getByRole('button', { name: 'Open settings' });
  await expect(headerSettingsButton).toBeVisible();
  await expect(headerSettingsButton).toHaveAttribute('title', /Settings/);
  await expect(headerSettingsButton).toHaveAttribute('title', /Ctrl\+,/);

  // Settings overlay opens and closes.
  await headerSettingsButton.click();

  const settingsOverlay = page.locator('.overlay-settings');
  await expect(settingsOverlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsOverlay).toBeHidden({ timeout: 5000 });

  // Settings hotkey should match the displayed hint.
  await page.keyboard.press('Control+,');
  await expect(settingsOverlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsOverlay).toBeHidden({ timeout: 5000 });

  // Command palette opens and closes.
  await page.keyboard.press(':');
  const palette = page.locator('.overlay-commandPalette');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden({ timeout: 5000 });

  // AnalysisSidebar shortcut badges should match actual hotkeys (trust surface).
  const analysisSidebar = page.locator('.analysis-sidebar');
  await expect(analysisSidebar).toBeVisible();

  // Simulation tools are in a collapsed category by default; expand it for assertions.
  const simulationsCategory = analysisSidebar.locator('.category-header', { hasText: 'Simulations' }).first();
  await expect(simulationsCategory).toBeVisible();
  await simulationsCategory.click();

  const simulationHubTool = analysisSidebar.locator('.tool-btn', { hasText: 'Simulation hub' }).first();
  await expect(simulationHubTool).toBeVisible();
  const simulationHubShortcut = simulationHubTool.locator('.tool-shortcut');
  await expect(simulationHubShortcut).toHaveText('Shift+S');

  await page.keyboard.press('Shift+S');
  const simulationHubOverlay = page.locator('.overlay-simulationHub');
  await expect(simulationHubOverlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(simulationHubOverlay).toBeHidden({ timeout: 5000 });

  // 3D default/copy/persistence: desktop defaults ON; disabling persists and the copy never lies.
  const quickStats = page.locator('.quick-stats');
  await expect(quickStats).toBeVisible({ timeout: 30000 });

  const toolbar = page.locator('.action-toolbar');
  await expect(toolbar).toBeVisible();

  const desktop3DToggle = toolbar.getByRole('button', { name: '3D' }).first();
  await expect(desktop3DToggle).toBeVisible();
  await expect(desktop3DToggle).toHaveAttribute('aria-pressed', 'true');

  await desktop3DToggle.click();
  await expect(desktop3DToggle).toHaveAttribute('aria-pressed', 'false');

  const viewerPlaceholderDescription = page.locator('.viewer-placeholder__description');
  await expect(viewerPlaceholderDescription).toBeVisible();
  await expect(viewerPlaceholderDescription).not.toContainText(/disabled by default/i);

  // Persisted main prefs write is debounced.
  await page.waitForTimeout(700);
  const persistedShow3D = await page.evaluate(() => {
    const raw = localStorage.getItem('phage-explorer-main-prefs');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { show3DModel?: unknown };
      return typeof parsed.show3DModel === 'boolean' ? parsed.show3DModel : null;
    } catch {
      return 'parse-error';
    }
  });
  expect(persistedShow3D).toBe(false);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#root > div', { timeout: 30000 });
  await page.waitForTimeout(500);

  // Dismiss welcome modal if present (should not be after initial skip, but keep test resilient).
  const welcomeOverlayReloaded = page.locator('.overlay-welcome');
  const skipReloaded = page.locator('.welcome-footer__skip');
  if (await welcomeOverlayReloaded.isVisible()) {
    await expect(skipReloaded).toBeVisible();
    await skipReloaded.click();
    await expect(welcomeOverlayReloaded).toBeHidden({ timeout: 5000 });
  }

  const toolbarReloaded = page.locator('.action-toolbar');
  await expect(toolbarReloaded).toBeVisible();
  const desktop3DToggleReloaded = toolbarReloaded.getByRole('button', { name: '3D' }).first();
  await expect(desktop3DToggleReloaded).toHaveAttribute('aria-pressed', 'false');

  // No uncaught JS errors.
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await finalize();
});
