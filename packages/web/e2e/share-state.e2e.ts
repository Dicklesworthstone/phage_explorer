import { test, expect, type Page } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';

async function dismissWelcomeIfPresent(page: Page): Promise<void> {
  const welcome = page.locator('.overlay-welcome');
  const isVisible = await welcome
    .waitFor({ state: 'visible', timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (!isVisible) return;

  const skip = page.locator('.welcome-footer__skip');
  if (await skip.isVisible().catch(() => false)) {
    await skip.click().catch(() => {});
    await welcome.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => null);
    return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await welcome.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => null);
}

function queryParam(page: Page, name: string): string | null {
  return new URL(page.url()).searchParams.get(name);
}

async function expectPhageName(page: Page, name: string): Promise<void> {
  await expect(page.locator('.detail-card').getByRole('heading', { level: 3 })).toHaveText(name, { timeout: 20_000 });
}

async function expectT4AminoAcidState(page: Page): Promise<void> {
  await expectPhageName(page, 'Enterobacteria phage T4');

  const aminoAcidView = page.getByRole('radio', { name: 'Amino Acids view' });
  await expect(aminoAcidView).toBeVisible({ timeout: 20_000 });
  await expect(aminoAcidView).toHaveAttribute('aria-checked', 'true');

  await expect.poll(() => queryParam(page, 'phage')).toBe('t4');
  await expect.poll(() => queryParam(page, 'view')).toBe('aa');
  await expect.poll(() => queryParam(page, 'frame')).toBe('1');
  await expect.poll(() => queryParam(page, 'model')).toBe('0');
  await expect.poll(() => Number(queryParam(page, 'pos') ?? '0')).toBeGreaterThan(0);
}

test.describe('Shareable explorer state', () => {
  test('reads bounded sequence passages and changes view by keyboard without switching genomes', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);
    try {
      await page.goto('/?phage=lambda&view=dna&pos=0&model=0');
      await dismissWelcomeIfPresent(page);
      const viewer = page.getByRole('region', { name: 'Sequence viewer' });
      const toggle = viewer.getByRole('button', { name: 'Read sequence as text' });
      await toggle.focus();
      await toggle.press('Enter');
      const bases = viewer.getByRole('textbox', { name: 'DNA sequence', exact: true });
      await expect(bases).toHaveValue(/^GGGCGGCG.{52}$/);
      const next = viewer.getByRole('button', { name: 'Next passage' });
      await next.focus();
      await next.press('Enter');
      await expect(bases).toHaveValue(/^TTCTTCTT.{52}$/);
      await expect(viewer.getByRole('status')).toContainText('60 through 119');
      const index = viewer.getByRole('spinbutton', { name: 'Start index' });
      await index.fill('48501');
      await index.press('Enter');
      await expect(bases).toHaveValue(/^.$/);
      await expect(next).toBeDisabled();

      const dna = viewer.getByRole('radio', { name: 'DNA view' });
      const dual = viewer.getByRole('radio', { name: 'Dual view' });
      const amino = viewer.getByRole('radio', { name: 'Amino Acids view' });
      await dna.focus();
      await dna.press('ArrowDown');
      await expect(dual).toBeFocused();
      await expect(dual).toBeChecked();
      await dual.press('ArrowRight');
      await expect(amino).toBeFocused();
      await expect(amino).toBeChecked();
      await expect(viewer.getByRole('textbox', { name: 'Amino acid sequence' })).toHaveValue(/^.{60}$/);
      await expect.poll(() => queryParam(page, 'phage')).toBe('lambda');
    } finally {
      await finalize();
    }
  });

  test('restores deep links and phage-level browser history', async ({ page }, testInfo) => {
    const { finalize, consoleErrors, pageErrors } = setupTestHarness(page, testInfo);

    await test.step('Open a complete phage deep link', async () => {
      await page.goto('/?phage=t4&view=aa&pos=300&frame=1&model=0', {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('header.app-header')).toBeVisible();
      await dismissWelcomeIfPresent(page);
      await expectT4AminoAcidState(page);
    });

    await test.step('Reload the canonicalized URL and restore the same state', async () => {
      const canonicalUrl = page.url();
      expect(canonicalUrl).toContain('phage=t4');
      expect(canonicalUrl).toContain('view=aa');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissWelcomeIfPresent(page);
      await expectT4AminoAcidState(page);
    });

    await test.step('Update the current history entry for view-only changes', async () => {
      const dnaView = page.getByRole('radio', { name: 'DNA view' });
      await dnaView.click();
      await expect(dnaView).toHaveAttribute('aria-checked', 'true');
      await expect.poll(() => queryParam(page, 'view')).toBe('dna');
      await expect.poll(() => queryParam(page, 'pos')).toBe('0');
    });

    await test.step('Push a history entry for a new phage and restore T4 with Back', async () => {
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      await page.keyboard.press('j');
      await expect.poll(() => queryParam(page, 'phage')).not.toBe('t4');
      const nextEntry = page.url();
      await expect(page.locator('.detail-card').getByRole('heading', { level: 3 })).not.toHaveText('Enterobacteria phage T4');

      await page.goBack({ waitUntil: 'domcontentloaded' });
      await dismissWelcomeIfPresent(page);
      await expectPhageName(page, 'Enterobacteria phage T4');
      await expect.poll(() => queryParam(page, 'phage')).toBe('t4');
      await expect.poll(() => queryParam(page, 'view')).toBe('dna');
      await expect(page.getByRole('radio', { name: 'DNA view' })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      await page.goForward();
      await expect(page).toHaveURL(nextEntry);
      await expect(page.locator('.detail-card').getByRole('heading', { level: 3 })).not.toHaveText('Enterobacteria phage T4');
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    });

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    await finalize();
  });
});
