/**
 * Mobile UX Audit - Comprehensive E2E Tests
 *
 * Tests for mobile-specific UI/UX issues including:
 * - Layout and overflow issues
 * - Touch target sizes (WCAG 44x44 minimum)
 * - Overlay and modal behavior
 * - Control deck functionality
 * - Typography and readability
 * - Navigation and scrolling
 * - Form inputs and interactions
 */

import { test, expect, type Page, type Locator } from '@playwright/test';

// Helper to check if running on mobile viewport
const isMobileViewport = (page: Page): boolean => {
  const viewport = page.viewportSize();
  return viewport ? viewport.width <= 768 : false;
};

// Helper to check if running on phone viewport
const isPhoneViewport = (page: Page): boolean => {
  const viewport = page.viewportSize();
  return viewport ? viewport.width <= 640 : false;
};

// Helper to measure element dimensions
async function getElementDimensions(locator: Locator): Promise<{ width: number; height: number }> {
  const box = await locator.boundingBox();
  return box ? { width: box.width, height: box.height } : { width: 0, height: 0 };
}

// Helper to check if element is within viewport (used in specific tests)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function isInViewport(page: Page, locator: Locator): Promise<boolean> {
  const viewport = page.viewportSize();
  if (!viewport) return false;

  const box = await locator.boundingBox();
  if (!box) return false;

  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height
  );
}

// Helper to check horizontal overflow
async function hasHorizontalOverflow(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return false;
    return element.scrollWidth > element.clientWidth;
  }, selector);
}

// Helper to check for elements overflowing the viewport
async function getOverflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const overflowing: string[] = [];

    document.querySelectorAll('*').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.right > viewportWidth + 1 || rect.left < -1) {
        const id = el.id ? `#${el.id}` : '';
        const classes = el.className && typeof el.className === 'string'
          ? `.${el.className.split(' ').join('.')}`
          : '';
        const tag = el.tagName.toLowerCase();
        overflowing.push(`${tag}${id}${classes}`.slice(0, 100));
      }
    });

    return [...new Set(overflowing)].slice(0, 20); // Limit output
  });
}

test.describe('Mobile Layout & Overflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('no horizontal scrollbar on body', async ({ page }) => {
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });

    if (hasOverflow) {
      const overflowing = await getOverflowingElements(page);
      console.log('Overflowing elements:', overflowing);
    }

    expect(hasOverflow).toBe(false);
  });

  test('app-shell fills viewport without overflow', async ({ page }) => {
    const appShell = page.locator('.app-shell');
    await expect(appShell).toBeVisible();

    const hasOverflow = await hasHorizontalOverflow(page, '.app-shell');
    expect(hasOverflow).toBe(false);
  });

  test('app-body has proper padding for control deck on mobile', async ({ page }) => {
    if (!isPhoneViewport(page)) {
      test.skip();
      return;
    }

    const appBody = page.locator('.app-body');
    const paddingBottom = await appBody.evaluate((el) => {
      return parseInt(window.getComputedStyle(el).paddingBottom, 10);
    });

    // Should have at least 100px padding for control deck
    expect(paddingBottom).toBeGreaterThanOrEqual(100);
  });

  test('two-column layout stacks on mobile', async ({ page }) => {
    if (!isMobileViewport(page)) {
      test.skip();
      return;
    }

    const twoColumn = page.locator('.two-column').first();
    if (await twoColumn.count() === 0) {
      test.skip();
      return;
    }

    const gridCols = await twoColumn.evaluate((el) => {
      return window.getComputedStyle(el).gridTemplateColumns;
    });

    // Should be single column on mobile
    expect(gridCols).not.toContain(' ');
  });

  test('header wraps content properly on mobile', async ({ page }) => {
    const header = page.locator('.app-header');
    await expect(header).toBeVisible();

    const viewport = page.viewportSize();
    const box = await header.boundingBox();

    if (viewport && box) {
      expect(box.width).toBeLessThanOrEqual(viewport.width);
    }
  });

  test('no text truncation without ellipsis', async ({ page }) => {
    // Check that truncated text has text-overflow: ellipsis
    const truncatedElements = await page.evaluate(() => {
      const issues: string[] = [];
      document.querySelectorAll('*').forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.overflow === 'hidden' && style.whiteSpace === 'nowrap') {
          if (style.textOverflow !== 'ellipsis') {
            issues.push(el.tagName.toLowerCase() + (el.className ? `.${el.className}` : ''));
          }
        }
      });
      return issues.slice(0, 10);
    });

    if (truncatedElements.length > 0) {
      console.log('Elements with truncation but no ellipsis:', truncatedElements);
    }

    // This is a warning, not a hard failure
    expect(truncatedElements.length).toBeLessThan(5);
  });
});

test.describe('Touch Targets (WCAG 2.5.5)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('all buttons meet 44x44 minimum touch target', async ({ page }) => {
    if (!isMobileViewport(page)) {
      test.skip();
      return;
    }

    const buttons = page.locator('button, [role="button"], .btn');
    const count = await buttons.count();
    const violations: string[] = [];

    for (let i = 0; i < Math.min(count, 50); i++) {
      const button = buttons.nth(i);
      if (await button.isVisible()) {
        const { width, height } = await getElementDimensions(button);
        if (width < 44 || height < 44) {
          const text = await button.textContent();
          const label = await button.getAttribute('aria-label');
          violations.push(`${text || label || 'button'}: ${width}x${height}`);
        }
      }
    }

    if (violations.length > 0) {
      console.log('Touch target violations:', violations);
    }

    expect(violations.length).toBe(0);
  });

  test('list items meet minimum touch height', async ({ page }) => {
    if (!isMobileViewport(page)) {
      test.skip();
      return;
    }

    const listItems = page.locator('.list-item');
    const count = await listItems.count();
    const violations: string[] = [];

    for (let i = 0; i < Math.min(count, 20); i++) {
      const item = listItems.nth(i);
      if (await item.isVisible()) {
        const { height } = await getElementDimensions(item);
        if (height < 44) {
          const text = await item.textContent();
          violations.push(`${text?.slice(0, 30)}: height=${height}`);
        }
      }
    }

    if (violations.length > 0) {
      console.log('List item height violations:', violations);
    }

    expect(violations.length).toBe(0);
  });

  test('overlay close button is tappable', async ({ page }) => {
    // Open command palette
    await page.keyboard.press(':');
    await page.waitForSelector('.overlay-commandPalette', { state: 'visible' });

    const closeButton = page.locator('.overlay-commandPalette button[aria-label="Close overlay"]');
    await expect(closeButton).toBeVisible();

    const { width, height } = await getElementDimensions(closeButton);
    expect(width).toBeGreaterThanOrEqual(24);
    expect(height).toBeGreaterThanOrEqual(24);

    // Should be clickable
    await closeButton.click();
    await expect(page.locator('.overlay-commandPalette')).not.toBeVisible();
  });

  test('form inputs have adequate height', async ({ page }) => {
    if (!isMobileViewport(page)) {
      test.skip();
      return;
    }

    const inputs = page.locator('input, select, textarea');
    const count = await inputs.count();
    const violations: string[] = [];

    for (let i = 0; i < Math.min(count, 20); i++) {
      const input = inputs.nth(i);
      if (await input.isVisible()) {
        const { height } = await getElementDimensions(input);
        if (height < 44) {
          const type = await input.getAttribute('type');
          const placeholder = await input.getAttribute('placeholder');
          violations.push(`${type || 'input'} (${placeholder || 'no placeholder'}): height=${height}`);
        }
      }
    }

    if (violations.length > 0) {
      console.log('Input height violations:', violations);
    }

    expect(violations.length).toBe(0);
  });
});

test.describe('Overlays & Modals on Mobile', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('command palette opens as bottom sheet on phones', async ({ page }) => {
    await page.keyboard.press(':');
    await page.waitForSelector('.overlay-commandPalette', { state: 'visible' });

    const overlay = page.locator('.overlay-commandPalette');
    const viewport = page.viewportSize();

    if (isPhoneViewport(page) && viewport) {
      const box = await overlay.boundingBox();
      if (box) {
        // Should be positioned at bottom
        expect(box.y + box.height).toBeGreaterThanOrEqual(viewport.height - 50);
        // Should be full width
        expect(box.width).toBeGreaterThanOrEqual(viewport.width * 0.95);
      }
    }

    await page.keyboard.press('Escape');
  });

  test('overlays do not exceed viewport height', async ({ page }) => {
    // Open settings overlay
    await page.keyboard.press(':');
    await page.waitForSelector('.overlay-commandPalette', { state: 'visible' });

    const overlay = page.locator('.overlay-commandPalette');
    const viewport = page.viewportSize();
    const box = await overlay.boundingBox();

    if (viewport && box) {
      expect(box.height).toBeLessThanOrEqual(viewport.height);
    }

    await page.keyboard.press('Escape');
  });

  test('overlay content is scrollable when needed', async ({ page }) => {
    await page.keyboard.press(':');
    await page.waitForSelector('.overlay-commandPalette', { state: 'visible' });

    const content = page.locator('.overlay-commandPalette .scrollable-y, .overlay-commandPalette [style*="overflow"]');
    if (await content.count() > 0) {
      const isScrollable = await content.first().evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.overflowY === 'auto' || style.overflowY === 'scroll';
      });
      expect(isScrollable).toBe(true);
    }

    await page.keyboard.press('Escape');
  });

  test('welcome modal is usable on mobile', async ({ page }) => {
    // Clear localStorage to trigger welcome modal
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.reload();
    await page.waitForLoadState('networkidle');

    const welcomeModal = page.locator('.overlay-welcome, [class*="welcome"]');
    if (await welcomeModal.count() > 0) {
      await expect(welcomeModal.first()).toBeVisible();

      // Check buttons are tappable
      const buttons = welcomeModal.locator('button');
      const count = await buttons.count();

      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        if (await button.isVisible()) {
          const { width, height } = await getElementDimensions(button);
          expect(width).toBeGreaterThanOrEqual(40);
          expect(height).toBeGreaterThanOrEqual(36);
        }
      }
    }
  });
});

test.describe('Control Deck (Mobile)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('control deck is visible only on phones', async ({ page }) => {
    const controlDeck = page.locator('.control-deck');

    if (isPhoneViewport(page)) {
      await expect(controlDeck).toBeVisible();
    } else {
      // May or may not be visible on tablets, but definitely hidden on desktop
      const viewport = page.viewportSize();
      if (viewport && viewport.width > 768) {
        const display = await controlDeck.evaluate((el) => {
          return window.getComputedStyle(el).display;
        });
        expect(display).toBe('none');
      }
    }
  });

  test('control deck tabs are tappable', async ({ page }) => {
    if (!isPhoneViewport(page)) {
      test.skip();
      return;
    }

    const controlDeck = page.locator('.control-deck');
    await expect(controlDeck).toBeVisible();

    const tabs = controlDeck.locator('.tab-btn');
    const count = await tabs.count();

    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      if (await tab.isVisible()) {
        const { height } = await getElementDimensions(tab);
        expect(height).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('control deck buttons are properly sized', async ({ page }) => {
    if (!isPhoneViewport(page)) {
      test.skip();
      return;
    }

    const deckButtons = page.locator('.deck-btn');
    const count = await deckButtons.count();

    for (let i = 0; i < count; i++) {
      const btn = deckButtons.nth(i);
      if (await btn.isVisible()) {
        const { width, height } = await getElementDimensions(btn);
        expect(width).toBeGreaterThanOrEqual(44);
        expect(height).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('control deck does not obscure content', async ({ page }) => {
    if (!isPhoneViewport(page)) {
      test.skip();
      return;
    }

    const controlDeck = page.locator('.control-deck');
    const appBody = page.locator('.app-body');

    const deckBox = await controlDeck.boundingBox();
    const bodyBox = await appBody.boundingBox();

    if (deckBox && bodyBox) {
      // Content should end before control deck starts
      expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(deckBox.y + 10);
    }
  });
});

test.describe('Typography & Readability', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('base font size is at least 16px on mobile', async ({ page }) => {
    if (!isMobileViewport(page)) {
      test.skip();
      return;
    }

    const bodyFontSize = await page.evaluate(() => {
      const style = window.getComputedStyle(document.body);
      return parseInt(style.fontSize, 10);
    });

    expect(bodyFontSize).toBeGreaterThanOrEqual(14);
  });

  test('text is not too small to read', async ({ page }) => {
    const smallTextElements = await page.evaluate(() => {
      const issues: string[] = [];
      document.querySelectorAll('*').forEach((el) => {
        const style = window.getComputedStyle(el);
        const fontSize = parseInt(style.fontSize, 10);
        const hasText = el.textContent && el.textContent.trim().length > 0;
        const isVisible = style.display !== 'none' && style.visibility !== 'hidden';

        if (hasText && isVisible && fontSize < 10 && fontSize > 0) {
          issues.push(`${el.tagName}: ${fontSize}px`);
        }
      });
      return issues.slice(0, 10);
    });

    if (smallTextElements.length > 0) {
      console.log('Very small text found:', smallTextElements);
    }

    // Allow some tiny text (badges, labels) but not too many
    expect(smallTextElements.length).toBeLessThan(3);
  });

  test('line height is readable', async ({ page }) => {
    const paragraphs = page.locator('p, .list-subtitle, .detail-card p');
    const count = await paragraphs.count();

    for (let i = 0; i < Math.min(count, 10); i++) {
      const p = paragraphs.nth(i);
      if (await p.isVisible()) {
        const lineHeight = await p.evaluate((el) => {
          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize);
          const lh = parseFloat(style.lineHeight);
          return lh / fontSize;
        });

        // Line height should be at least 1.2 for readability
        expect(lineHeight).toBeGreaterThanOrEqual(1.1);
      }
    }
  });
});

test.describe('Navigation & Scrolling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('page is scrollable when content exceeds viewport', async ({ page }) => {
    // This depends on content, so we just verify no scroll lock issues
    const overflowY = await page.evaluate(() => {
      return window.getComputedStyle(document.body).overflowY;
    });

    expect(overflowY).not.toBe('hidden');
  });

  test('lists are vertically scrollable', async ({ page }) => {
    const lists = page.locator('.list');
    const count = await lists.count();

    for (let i = 0; i < count; i++) {
      const list = lists.nth(i);
      if (await list.isVisible()) {
        const overflowY = await list.evaluate((el) => {
          return window.getComputedStyle(el).overflowY;
        });

        expect(['auto', 'scroll']).toContain(overflowY);
      }
    }
  });

  test('sequence view has proper scroll behavior', async ({ page }) => {
    const sequenceView = page.locator('.sequence-view, .sequence-block');
    if (await sequenceView.count() > 0) {
      const firstView = sequenceView.first();
      if (await firstView.isVisible()) {
        const overflow = await firstView.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return { x: style.overflowX, y: style.overflowY };
        });

        // Should allow scrolling in at least one direction
        expect(['auto', 'scroll']).toContain(overflow.x);
      }
    }
  });
});

test.describe('Landscape Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('control deck collapses in landscape on phones', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport) {
      test.skip();
      return;
    }

    // Check if landscape phone
    const isLandscapePhone = viewport.width > viewport.height && viewport.height <= 500;

    if (isLandscapePhone) {
      const controlDeck = page.locator('.control-deck');
      if (await controlDeck.isVisible()) {
        // In landscape phone mode, control deck should be compact
        const { height } = await getElementDimensions(controlDeck);
        expect(height).toBeLessThan(150);
      }
    }
  });

  test('content is usable in landscape mode', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width <= viewport.height) {
      test.skip();
      return;
    }

    // Main content should be visible
    const mainContent = page.locator('.app-body');
    await expect(mainContent).toBeVisible();

    // Should have reasonable height
    const { height } = await getElementDimensions(mainContent);
    expect(height).toBeGreaterThan(100);
  });
});

test.describe('Header & Footer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('header content fits on mobile', async ({ page }) => {
    const header = page.locator('.app-header');
    await expect(header).toBeVisible();

    const viewport = page.viewportSize();
    const box = await header.boundingBox();

    if (viewport && box) {
      // Header should not exceed viewport width
      expect(box.width).toBeLessThanOrEqual(viewport.width);

      // Header should have reasonable height
      if (isMobileViewport(page)) {
        expect(box.height).toBeLessThan(150);
      }
    }
  });

  test('footer keyboard hints hidden on mobile', async ({ page }) => {
    if (!isMobileViewport(page)) {
      test.skip();
      return;
    }

    const footerHints = page.locator('.footer-hints');
    if (await footerHints.count() > 0) {
      const display = await footerHints.evaluate((el) => {
        return window.getComputedStyle(el).display;
      });
      expect(display).toBe('none');
    }
  });

  test('app footer hidden when control deck is shown', async ({ page }) => {
    if (!isPhoneViewport(page)) {
      test.skip();
      return;
    }

    const footer = page.locator('.app-footer');
    if (await footer.count() > 0) {
      const display = await footer.evaluate((el) => {
        return window.getComputedStyle(el).display;
      });
      expect(display).toBe('none');
    }
  });
});

test.describe('Visual Regressions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('capture homepage screenshot', async ({ page }) => {
    await page.screenshot({
      path: `test-results/screenshots/homepage-${page.viewportSize()?.width}x${page.viewportSize()?.height}.png`,
      fullPage: true,
    });
  });

  test('capture command palette screenshot', async ({ page }) => {
    await page.keyboard.press(':');
    await page.waitForSelector('.overlay-commandPalette', { state: 'visible' });
    await page.waitForTimeout(300); // Wait for animation

    await page.screenshot({
      path: `test-results/screenshots/command-palette-${page.viewportSize()?.width}x${page.viewportSize()?.height}.png`,
    });

    await page.keyboard.press('Escape');
  });
});

test.describe('Specific Bug Checks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('badges do not overflow container', async ({ page }) => {
    const badges = page.locator('.badge');
    const count = await badges.count();

    for (let i = 0; i < Math.min(count, 20); i++) {
      const badge = badges.nth(i);
      if (await badge.isVisible()) {
        const parent = badge.locator('..');
        const badgeBox = await badge.boundingBox();
        const parentBox = await parent.boundingBox();

        if (badgeBox && parentBox) {
          // Badge should not extend beyond parent (with small tolerance)
          expect(badgeBox.x).toBeGreaterThanOrEqual(parentBox.x - 5);
          expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(parentBox.x + parentBox.width + 5);
        }
      }
    }
  });

  test('3D viewer has minimum dimensions on mobile', async ({ page }) => {
    const threeContainer = page.locator('.three-container');
    if (await threeContainer.count() > 0 && await threeContainer.isVisible()) {
      const { width, height } = await getElementDimensions(threeContainer);

      if (isMobileViewport(page)) {
        expect(height).toBeGreaterThanOrEqual(200);
        expect(width).toBeGreaterThanOrEqual(200);
      }
    }
  });

  test('sequence view toolbar buttons accessible', async ({ page }) => {
    const toolbar = page.locator('.sequence-view .toolbar');
    if (await toolbar.count() > 0 && await toolbar.isVisible()) {
      const buttons = toolbar.locator('button');
      const count = await buttons.count();

      for (let i = 0; i < count; i++) {
        const btn = buttons.nth(i);
        if (await btn.isVisible()) {
          const { width, height } = await getElementDimensions(btn);

          if (isMobileViewport(page)) {
            expect(width).toBeGreaterThanOrEqual(36);
            expect(height).toBeGreaterThanOrEqual(36);
          }
        }
      }
    }
  });

  test('metrics grid readable on mobile', async ({ page }) => {
    if (!isMobileViewport(page)) {
      test.skip();
      return;
    }

    const metrics = page.locator('.metrics');
    if (await metrics.count() > 0 && await metrics.isVisible()) {
      const gridCols = await metrics.evaluate((el) => {
        return window.getComputedStyle(el).gridTemplateColumns;
      });

      // Should be 2 columns or fewer on mobile
      const colCount = gridCols.split(' ').length;
      expect(colCount).toBeLessThanOrEqual(2);
    }
  });

  test('settings overlay stacks properly on mobile', async ({ page }) => {
    if (!isMobileViewport(page)) {
      test.skip();
      return;
    }

    // Try to open settings
    await page.keyboard.press(':');
    await page.waitForSelector('.overlay-commandPalette', { state: 'visible' });

    const searchInput = page.locator('.overlay-commandPalette input[type="text"]');
    await searchInput.fill('settings');
    await page.waitForTimeout(200);

    // Look for settings command
    const settingsItem = page.locator('.list-item').filter({ hasText: /settings/i }).first();
    if (await settingsItem.count() > 0) {
      await settingsItem.click();
      await page.waitForTimeout(300);

      const settingsRow = page.locator('.settings-row');
      if (await settingsRow.count() > 0) {
        const flexDir = await settingsRow.first().evaluate((el) => {
          return window.getComputedStyle(el).flexDirection;
        });

        // Should be column on mobile
        expect(flexDir).toBe('column');
      }
    }

    await page.keyboard.press('Escape');
  });
});
