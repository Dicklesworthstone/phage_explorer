import { test, expect, type Page } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

type AxeViolationNode = {
  target: string[];
  failureSummary?: string;
};

type AxeViolation = {
  id: string;
  impact?: string;
  help: string;
  helpUrl: string;
  nodes: AxeViolationNode[];
};

type AxeResults = {
  violations: AxeViolation[];
};

const RESEARCH_THEMES = ['holographic', 'cyberpunk', 'classic', 'ocean', 'matrix', 'sunset', 'forest', 'monochrome'];

for (const theme of RESEARCH_THEMES) {
  test(`catalog audit: ${theme} mobile and desktop`, async ({ page }, info) => {
    const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, info);
    try {
      await setExperienceLevel(page, 'power');
      await page.addInitScript(themeId => localStorage.setItem('phage-explorer-theme', themeId), theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/?phage=lambda&model=0');
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Enterobacteria phage lambda');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
      if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
      await ensureAxeLoaded(page);
      for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 1000 }]) {
        await page.setViewportSize(viewport);
        await expect(page.locator('.quick-stat__label').first()).toBeVisible();
        const results = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<AxeResults> } }).axe;
          // These rules include best-practice and experimental checks that the
          // WCAG 2.1 tag-only audit below does not select (including contrast).
          return axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast', 'heading-order', 'label-content-name-mismatch'] } });
        });
        const label = `${theme}-${viewport.width}`;
        await info.attach(`catalog-audit-${label}`, { body: JSON.stringify(results), contentType: 'application/json' });
        expect(results.violations, formatViolations(label, results.violations)).toEqual([]);
      }
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally { await finalize(); }
  });

  test(`local genome accessibility: ${theme} portrait and landscape`, async ({ page }, info) => {
    const { pageErrors, finalize } = setupTestHarness(page, info);
    try {
      await setExperienceLevel(page, 'power');
      await page.addInitScript(themeId => localStorage.setItem('phage-explorer-theme', themeId), theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/?phage=lambda&model=0');
      await expectExplorerIdentity(page, info);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.keyboard.press('Control+k');
      const palette = page.getByTestId('overlay-commandPalette');
      await palette.getByRole('combobox').fill('Local genomes: import or export');
      await palette.getByRole('option').filter({ hasText: 'Local genomes: import or export' }).click();
      const overlay = page.getByTestId('overlay-genomeImport');
      await overlay.getByRole('textbox', { name: 'Paste genome data' }).fill('>THEME_LOCAL\nACGT');
      await overlay.getByRole('button', { name: 'Parse records', exact: true }).click();
      await overlay.getByRole('button', { name: 'Add records to explorer' }).click();
      const trigger = page.getByRole('button', { name: 'Export local data: genome bundle' });
      await trigger.click();
      const field = overlay.getByRole('textbox', { name: 'Paste genome data' });
      await expect(field).toHaveValue('');
      await field.fill('>invalid\nACGU');
      await overlay.getByRole('button', { name: 'Parse records', exact: true }).click();
      await expect(overlay.getByRole('alert')).toContainText('IUPAC DNA');
      await ensureAxeLoaded(page);
      const contrast = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<AxeResults & { passes: { id: string; nodes: unknown[] }[]; incomplete: unknown[] }> } }).axe;
        const root = document.querySelector('[data-testid="overlay-genomeImport"]');
        if (!root) throw new Error('Import dialog missing from contrast audit');
        return axe.run(root, { runOnly: { type: 'rule', values: ['color-contrast'] } });
      });
      await info.attach(`contrast-${theme}`, { body: JSON.stringify(contrast), contentType: 'application/json' });
      expect(contrast.violations, formatViolations(theme, contrast.violations)).toEqual([]);
      // Axe cannot resolve the sheet's fully transparent decorative pseudo-element.
      // Retain its incomplete results, and measure five named text surfaces from
      // their actual computed colors. This is not a full-panel contrast certificate.
      const textContrast = await overlay.evaluate(root => {
        const rgb = (value: string) => {
          if (!/^rgba?\(/.test(value)) throw new Error(`Unresolved CSS color: ${value}`);
          const parts = value.match(/[\d.]+/g)!.map(Number);
          return [parts[0], parts[1], parts[2], parts[3] ?? 1];
        };
        const over = (front: number[], back: number[]) => {
          const alpha = front[3] + back[3] * (1 - front[3]);
          if (!alpha) return [0, 0, 0, 0];
          return [...front.slice(0, 3).map((c, i) => (c * front[3] + back[i] * back[3] * (1 - front[3])) / alpha), alpha];
        };
        // https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
        const luminance = (color: number[]) => color.slice(0, 3).map(c => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
        return ['p:nth-of-type(1)', 'p:nth-of-type(2)', 'label[for="local-genome-input"]', 'textarea', 'p[role="alert"]'].map(selector => {
          const node = root.querySelector<HTMLElement>(selector);
          if (!node || node.getClientRects().length === 0) throw new Error(`Missing contrast sample ${selector}`);
          let background = [0, 0, 0, 0];
          for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (Number(style.opacity) !== 1 || style.backgroundImage !== 'none') throw new Error(`Unresolved painted layer for ${selector}`);
            for (const pseudo of ['::before', '::after']) {
              const decoration = getComputedStyle(parent, pseudo);
              if (!['none', 'normal'].includes(decoration.content) && decoration.display !== 'none' && Number(decoration.opacity) !== 0) {
                throw new Error(`Unresolved visible decoration for ${selector}`);
              }
            }
            background = over(background, rgb(style.backgroundColor));
            if (background[3] === 1) break;
          }
          if (background[3] !== 1) throw new Error(`No opaque background for ${selector}`);
          const foreground = over(rgb(getComputedStyle(node).color), background);
          const a = luminance(foreground), b = luminance(background);
          return { selector, foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
      });
      await info.attach(`text-contrast-${theme}`, { body: JSON.stringify(textContrast), contentType: 'application/json' });
      expect(textContrast).toHaveLength(5);
      for (const sample of textContrast) expect(sample.ratio, `${theme} ${sample.selector}`).toBeGreaterThanOrEqual(4.5);

      const input = `>long_${'αβ'.repeat(80)}\nACGT`;
      await field.fill(input);
      await field.press('g');
      await expect(field).toHaveValue(`${input}g`);
      await overlay.getByRole('button', { name: 'Parse records', exact: true }).click();
      await expect(overlay.getByRole('button', { name: 'Add records to explorer' })).toBeVisible();
      const dialog = page.getByRole('dialog', { name: 'Local genomes', exact: true });
      for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 375, height: 812 }]) {
        await page.setViewportSize(viewport);
        const layout = await overlay.evaluate(element => ({
          scroll: element.scrollWidth, client: element.clientWidth,
          body: document.documentElement.scrollWidth, viewport: window.innerWidth,
        }));
        expect(layout.scroll, `${theme} dialog width at ${viewport.width}`).toBeLessThanOrEqual(layout.client + 1);
        expect(layout.body, `${theme} document width at ${viewport.width}`).toBeLessThanOrEqual(layout.viewport + 1);
        await field.focus();
        for (const key of ['Tab', 'Shift+Tab']) {
          for (let i = 0; i < 12; i++) {
            await page.keyboard.press(key);
            expect(await dialog.evaluate(element => element.contains(document.activeElement)), `${theme} ${key} focus remains inside dialog at ${viewport.width}`).toBe(true);
          }
        }
      }
      await page.keyboard.press('Escape');
      await expect(overlay).not.toBeVisible();
      await expect(trigger).toBeFocused();
      expect(pageErrors).toEqual([]);
    } finally { await finalize(); }
  });
}

test('catalog actions retain visible names when saved or copied', async ({ page }, info) => {
  const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, info);
  try {
    await setExperienceLevel(page, 'power');
    await page.goto('/?phage=lambda&model=0');
    await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save Enterobacteria phage lambda', exact: true });
    await save.click();
    const saved = page.getByRole('button', { name: 'Saved. Remove Enterobacteria phage lambda', exact: true });
    await expect(saved).toHaveAttribute('aria-pressed', 'true');
    await expect(saved).toContainText('Saved');
    for (const label of ['Copy ID', 'Cite']) {
      const action = page.locator('.quick-stat__action').filter({ hasText: label });
      await action.click();
      const copied = page.locator('.quick-stat__action').filter({ hasText: 'Copied' });
      await expect(copied).toBeVisible();
      await expect(copied).toHaveAccessibleName(new RegExp(`^Copied\\. ${label}`));
    }
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally { await finalize(); }
});

test('illustration loading name follows the delayed real image', async ({ page }, info) => {
  const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, info);
  let releaseImage: (() => void) | undefined;
  const imageReady = new Promise<void>(resolve => { releaseImage = resolve; });
  await page.route('**/illustrations/lambda.webp', async route => {
    await imageReady;
    await route.continue();
  });
  try {
    await setExperienceLevel(page, 'power');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/?phage=lambda&model=0', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Enterobacteria phage lambda');
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    const illustration = page.locator('.phage-illustration');
    await expect(illustration).toBeVisible();
    await expect(illustration).toContainText('Loading...');
    await expect(illustration).toHaveAccessibleName(/^Loading\.\.\. Anatomical diagram of Enterobacteria phage lambda/);
    await expect(illustration).toHaveAttribute('aria-busy', 'true');
    releaseImage?.();
    await expect(illustration).toHaveAccessibleName(/^Anatomical diagram of Enterobacteria phage lambda/);
    await expect(illustration).toHaveAttribute('aria-busy', 'false');
    await expect(illustration).not.toContainText('Loading...');
    await illustration.click();
    await expect(page.getByTestId('overlay-illustration')).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    releaseImage?.();
    await page.unrouteAll({ behavior: 'wait' });
    await finalize();
  }
});

test('offline audit: readable recovery page returns to the catalog', async ({ page }, info) => {
  const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, info);
  try {
    await setExperienceLevel(page, 'power');
    await page.goto('/offline.html');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Connection restored');
    await ensureAxeLoaded(page);
    const results = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<AxeResults> } }).axe;
      return axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast', 'heading-order', 'label-content-name-mismatch'] } });
    });
    await info.attach('offline-audit', { body: JSON.stringify(results), contentType: 'application/json' });
    expect(results.violations, formatViolations('offline', results.violations)).toEqual([]);
    await page.getByRole('link', { name: 'Try Again' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Enterobacteria phage lambda');
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally { await finalize(); }
});

const AXE_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.11.0/axe.min.js';

async function setExperienceLevel(page: Page, level: 'novice' | 'intermediate' | 'power'): Promise<void> {
  await page.addInitScript((requestedLevel: string) => {
    try {
      const STORAGE_KEY = 'phage-explorer-main-prefs';
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...parsed,
          experienceLevel: requestedLevel,
        })
      );
    } catch {
      // Ignore storage failures in restricted environments
    }
  }, level);
}

function formatViolations(label: string, violations: AxeViolation[]): string {
  if (violations.length === 0) return '';

  const lines: string[] = [`axe-core violations in "${label}":`];

  for (const v of violations.slice(0, 10)) {
    lines.push(`- ${v.id} (${v.impact ?? 'unknown'}): ${v.help}`);
    lines.push(`  ${v.helpUrl}`);
    for (const node of v.nodes.slice(0, 5)) {
      const target = node.target.join(', ');
      const summary = node.failureSummary?.replace(/\s+/g, ' ').trim();
      lines.push(`  • ${target}${summary ? ` — ${summary}` : ''}`);
    }
  }

  if (violations.length > 10) {
    lines.push(`…and ${violations.length - 10} more violation(s).`);
  }

  return lines.join('\n');
}

async function waitForAppReady(page: Page): Promise<void> {
  // The keyboard manager registers hotkeys during React mount; avoid flakiness on slow CI.
  await page.waitForSelector('button.btn', { state: 'attached', timeout: 10000 });
}

async function ensureAxeLoaded(page: Page): Promise<void> {
  const alreadyLoaded = await page.evaluate(() => {
    const axe = (window as unknown as { axe?: { run?: unknown } }).axe;
    return typeof axe?.run === 'function';
  }).catch(() => false);

  if (alreadyLoaded) return;
  try {
    await page.addScriptTag({ url: AXE_SCRIPT_URL });
  } catch (err) {
    throw new Error(
      `Failed to inject axe-core from ${AXE_SCRIPT_URL}. Ensure network access is available when running this test.\n${String(err)}`
    );
  }
}

async function runA11yAudit(page: Page): Promise<AxeResults> {
  await ensureAxeLoaded(page);
  return await page.evaluate(async (): Promise<AxeResults> => {
    const axe = (window as unknown as { axe?: { run?: (context?: unknown, options?: unknown) => Promise<AxeResults> } }).axe;
    if (typeof axe?.run !== 'function') throw new Error('axe-core failed to load');
    return await axe.run(document, {
      // This legacy overlay sweep selects the additions in WCAG 2.1 only.
      // Cumulative WCAG 2.0 + 2.1 coverage remains on phage_explorer-5t4r.4;
      // the explicit catalog audits above also check contrast and headings.
      runOnly: { type: 'tag', values: ['wcag21a', 'wcag21aa'] },
    });
  });
}

async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  const results = await runA11yAudit(page);
  expect(results.violations, formatViolations(label, results.violations)).toEqual([]);
}

test('WCAG 2.1-specific rules: base + key overlays', async ({ page }) => {
  // Keep this test stable even when experience level gating changes.
  await setExperienceLevel(page, 'power');

  // `networkidle` can hang on Vite (HMR websocket).
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForAppReady(page);

  // If the Welcome modal auto-opens (fresh storage), audit it first.
  const welcome = page.locator('.overlay-welcome');
  const welcomeVisible = await welcome
    .waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true)
    .catch(() => false);

  if (welcomeVisible) {
    await expectNoA11yViolations(page, 'Welcome modal');
    await page.keyboard.press('Escape');
    await welcome.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(200);
  }

  await expectNoA11yViolations(page, 'Base');

  // Help overlay (?)
  await page.keyboard.press('Shift+Slash');
  const help = page.locator('.overlay-help');
  await help.waitFor({ state: 'visible', timeout: 5000 });
  await expectNoA11yViolations(page, 'Help overlay');
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(200);

  // Command palette (:)
  await page.keyboard.press('Shift+Semicolon');
  const palette = page.locator('.overlay-commandPalette');
  await palette.waitFor({ state: 'visible', timeout: 5000 });
  await expectNoA11yViolations(page, 'Command palette');
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(200);

  // Search overlay (/)
  await page.keyboard.press('Slash');
  const search = page.locator('.overlay-search');
  await search.waitFor({ state: 'visible', timeout: 10000 });
  await expectNoA11yViolations(page, 'Search overlay');
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(200);

  // Analysis menu (a)
  await page.keyboard.press('a');
  const analysis = page.locator('.overlay-analysisMenu');
  await analysis.waitFor({ state: 'visible', timeout: 5000 });
  await expectNoA11yViolations(page, 'Analysis menu');
  await page.keyboard.press('Escape');
  await analysis.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(200);

  // Settings overlay (Ctrl+,)
  await page.keyboard.press('Control+,');
  const settings = page.locator('.overlay-settings');
  await settings.waitFor({ state: 'visible', timeout: 5000 });
  await expectNoA11yViolations(page, 'Settings overlay');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
});

// Helper to test an overlay with a simple hotkey
async function testOverlayA11y(
  page: Page,
  hotkey: string,
  overlayId: string,
  label: string
): Promise<void> {
  await page.keyboard.press(hotkey);
  const overlay = page.locator(`.overlay-${overlayId}`);
  await overlay.waitFor({ state: 'visible', timeout: 8000 });
  await expectNoA11yViolations(page, label);
  await page.keyboard.press('Escape');
  await overlay.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(150);
}

test('WCAG 2.1-specific rules: analysis overlays', async ({ page }) => {
  // These overlays are gated behind Intermediate/Power hotkeys.
  await setExperienceLevel(page, 'power');

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForAppReady(page);

  // Dismiss Welcome modal if present
  const welcome = page.locator('.overlay-welcome');
  const welcomeVisible = await welcome
    .waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  if (welcomeVisible) {
    await page.keyboard.press('Escape');
    await welcome.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(200);
  }

  // GC Skew (g)
  await testOverlayA11y(page, 'g', 'gcSkew', 'GC Skew overlay');

  // Complexity (x)
  await testOverlayA11y(page, 'x', 'complexity', 'Complexity overlay');

  // Bendability (b)
  await testOverlayA11y(page, 'b', 'bendability', 'Bendability overlay');

  // Promoter (p)
  await testOverlayA11y(page, 'p', 'promoter', 'Promoter overlay');

  // Repeats (r)
  await testOverlayA11y(page, 'r', 'repeats', 'Repeats overlay');

  // K-mer Anomaly (Alt+J)
  await testOverlayA11y(page, 'Alt+j', 'kmerAnomaly', 'K-mer Anomaly overlay');

  // Hilbert (Alt+Shift+H)
  await testOverlayA11y(page, 'Alt+Shift+h', 'hilbert', 'Hilbert curve overlay');

  // Gel (Alt+G)
  await testOverlayA11y(page, 'Alt+g', 'gel', 'Gel electrophoresis overlay');

  // Dot Plot (Alt+O)
  await testOverlayA11y(page, 'Alt+o', 'dotPlot', 'Dot plot overlay');

  // Bias Decomposition (Alt+B)
  await testOverlayA11y(page, 'Alt+b', 'biasDecomposition', 'Bias Decomposition overlay');
});

test('WCAG 2.1-specific rules: reference overlays', async ({ page }) => {
  // Keep reference overlays audited under the same "power user" state.
  await setExperienceLevel(page, 'power');

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForAppReady(page);

  // Dismiss Welcome modal if present
  const welcome = page.locator('.overlay-welcome');
  const welcomeVisible = await welcome
    .waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  if (welcomeVisible) {
    await page.keyboard.press('Escape');
    await welcome.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(200);
  }

  // AA Key (Shift+K)
  await testOverlayA11y(page, 'Shift+K', 'aaKey', 'Amino Acid Key overlay');

  // AA Legend (Shift+L)
  await testOverlayA11y(page, 'Shift+L', 'aaLegend', 'Amino Acid Legend overlay');

  // Goto (Ctrl+g)
  await testOverlayA11y(page, 'Control+g', 'goto', 'Goto overlay');

  // HGT (Alt+H)
  await testOverlayA11y(page, 'Alt+h', 'hgt', 'HGT detection overlay');
});
