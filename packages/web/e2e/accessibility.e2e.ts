import { test, expect, type Page } from '@playwright/test';

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

const AXE_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/axe-core@4.11.0/axe.min.js';

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
      runOnly: { type: 'tag', values: ['wcag21a', 'wcag21aa'] },
    });
  });
}

async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  const results = await runA11yAudit(page);
  expect(results.violations, formatViolations(label, results.violations)).toEqual([]);
}

test('WCAG 2.1 A/AA: base + key overlays', async ({ page }) => {
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
});
