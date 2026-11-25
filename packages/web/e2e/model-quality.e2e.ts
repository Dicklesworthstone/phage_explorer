import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

test.use({ serviceWorkers: 'block' });

test('a loaded 3D model survives quality changes and exports a painted frame', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);
  // Only the external structure is a fixture. Keep the real parser, renderer and controls.
  const cif = `data_viewer
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
ATOM 1 C 40 30 20
ATOM 2 O 41 31 20
ATOM 3 N 39 32 22
#`;
  await page.route('https://files.rcsb.org/download/7VI9.cif', route => route.fulfill({
    contentType: 'text/plain',
    headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
    body: cif,
  }));

  try {
    await page.goto('/?phage=lambda&model=1');
    await expectExplorerIdentity(page, testInfo);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    const panel = page.locator('[aria-label="3D structure viewer"]');
    await expect(panel.getByText('3 atoms (asymmetric unit)')).toBeVisible();
    const pause = panel.getByTitle('Pause rotation', { exact: true });
    if (await pause.isVisible()) await pause.click();

    const canvas = panel.locator('.three-container canvas');
    const original = await canvas.elementHandle();
    if (!original) throw new Error('Missing WebGL canvas');
    let lowWidth = 0;
    for (const quality of ['low', 'high'] as const) {
      await panel.getByTestId('model3d-quality-trigger').click();
      await panel.getByTestId(`model3d-quality-option-${quality}`).click();
      await expect(panel.getByTestId('model3d-quality-trigger')).toHaveText(quality);
      expect(await canvas.evaluate((node, previous) => node === previous, original)).toBe(true);
      const bufferWidth = () => canvas.evaluate(node => (node as HTMLCanvasElement).width);
      if (quality === 'low') lowWidth = await bufferWidth();
      else await expect.poll(bufferWidth).toBeGreaterThan(lowWidth);

      const downloadPromise = page.waitForEvent('download');
      await panel.getByRole('button', { name: 'Save screenshot' }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('phage-explorer-3d.png');
      const path = await download.path();
      if (!path) throw new Error('3D screenshot did not download');
      const png = await readFile(path);
      const colorCount = await page.evaluate(async (base64) => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + base64;
        await image.decode();
        const probe = document.createElement('canvas');
        probe.width = probe.height = 96;
        const context = probe.getContext('2d')!;
        context.drawImage(image, 0, 0, 96, 96);
        const rgba = context.getImageData(0, 0, 96, 96).data;
        const colors = new Set<number>();
        for (let i = 0; i < rgba.length; i += 4) {
          if (rgba[i + 3] > 0) colors.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
        }
        return colors.size;
      }, png.toString('base64'));
      expect(colorCount, `Visible geometry in the ${quality}-quality export`).toBeGreaterThan(8);
    }
  } finally {
    await finalize();
  }
});
