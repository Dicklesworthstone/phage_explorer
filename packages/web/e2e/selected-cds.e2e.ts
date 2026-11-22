import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';

declare global {
  interface Window {
    selectedCdsFixture: { select: (name: string) => void; holdHash: () => void; releaseHash: () => void; hashPending: boolean; hashReleased: boolean };
  }
}

const fixtureSource = String.raw`
  import React, { useEffect, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { importLocalGenomes } from '@phage-explorer/core';
  import { usePhageStore } from './store';
  import { SelectedGeneDock } from './components/mobile/SelectedGeneDock';
  import { OverlayProvider } from './components/overlays/OverlayProvider';
  import { ScrollProvider } from './providers';
  import './styles.css';
  import './styles/selected-gene-dock.css';
  import './styles/selected-gene-desktop.css';

  async function entry(sequence, location, extra = '') {
    const imported = await importLocalGenomes({ name: 'private.gb', text:
      'LOCUS       SAME ' + sequence.length + ' bp DNA circular\nACCESSION   SAME\nFEATURES             Location/Qualifiers\n' +
      '     CDS             ' + location + '\n                     /locus_tag="same-gene"\n' + extra +
      'ORIGIN\n        1 ' + sequence.toLowerCase() + '\n//\n' });
    const genome = imported.genomes[0];
    genome.phage.id = -42;
    genome.phage.genes[0].id = 7;
    return { owner: {}, sequence: genome.sequence, phage: genome.phage };
  }
  const entries = {
    joined: await entry('ATGAAACCCCCCGGGTTT', 'complement(join(1..6,13..18))'),
    alternate: await entry('ATGTGATAA', '1..9', '                     /transl_table=4\n'),
    unsupported: await entry('ATGAAATAA', '1..9', '                     /transl_table=2\n'),
    partial: await entry('ATGAAAT', '1..7'),
  };
  let select = () => {}, held = false, release = () => {};
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = async (...args) => {
    const result = nativeDigest(...args);
    if (held) {
      held = false; window.selectedCdsFixture.hashPending = true;
      await new Promise(resolve => { release = resolve; });
      window.selectedCdsFixture.hashReleased = true;
    }
    return result;
  };
  window.selectedCdsFixture = {
    select: name => select(name), hashPending: false, hashReleased: false,
    holdHash: () => { held = true; window.selectedCdsFixture.hashPending = false; window.selectedCdsFixture.hashReleased = false; },
    releaseHash: () => release(),
  };
  function Fixture() {
    const [name, setName] = useState('joined');
    useEffect(() => {
      const apply = next => flushSync(() => {
        usePhageStore.setState({ currentPhage: entries[next].phage, selectedGeneId: 7 });
        setName(next);
      });
      select = apply;
      usePhageStore.setState({ currentPhage: entries.joined.phage, selectedGeneId: 7 });
    }, []);
    return <SelectedGeneDock source={entries[name]} />;
  }
  createRoot(document.getElementById('root')).render(
    <ScrollProvider><OverlayProvider><Fixture /></OverlayProvider></ScrollProvider>
  );
`;

async function download(page: Page, name: string): Promise<{ text: string; filename: string }> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const file = await pending, path = await file.path();
  if (!path) throw new Error('Selected CDS download has no local path.');
  return { text: await readFile(path, 'utf8'), filename: file.suggestedFilename() };
}

test('selected CDS inspector exports exact private inputs and retires same-ID replacement work', async ({ page }, info) => {
  test.setTimeout(120000);
  const root = process.cwd(), fixtureId = resolve(root, 'src/selected-cds-fixture.tsx');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load selected-CDS fixture configuration.');
  const server = await createServer(mergeConfig(loaded.config, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'selected-cds-fixture',
      resolveId(id) { if (id === '/src/selected-cds-fixture.tsx' || id === fixtureId) return fixtureId; },
      load(id) { if (id === fixtureId) return fixtureSource; },
      configureServer(vite) {
        vite.middlewares.use('/selected-cds-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/selected-cds-fixture', '<div id="root"></div><script type="module" src="/src/selected-cds-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(server.resolvedUrls!.local[0] + 'selected-cds-fixture');
    await page.getByRole('button', { name: 'Open details for same-gene', exact: true }).click();
    const result = page.getByTestId('selected-cds-result');
    await expect(result.getByLabel('Annotated CDS DNA (5′ to 3′)', { exact: true })).toHaveText('AAACCCTTTCAT');
    await expect(result.getByLabel('Translated protein', { exact: true })).toHaveText('KPFH');
    await expect(page.getByRole('button', { name: 'Export local genome bundle', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share exact view', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy citation', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'NCBI record', exact: true })).toHaveCount(0);
    const cds = await download(page, 'Export CDS FASTA');
    expect(cds.text.split('\n').slice(1).join('')).toBe('AAACCCTTTCAT');
    expect(cds.text).toContain('source=local');
    const exported = JSON.parse((await download(page, 'Export CDS record (JSON)')).text);
    expect(exported.gene.qualifiers._location).toBe('complement(join(1..6,13..18))');
    expect(exported.cds).toBe('AAACCCTTTCAT'); expect(exported.protein).toBe('KPFH');
    expect(await result.getAttribute('data-result-id')).toBe(exported.resultId);

    await page.evaluate(() => { window.selectedCdsFixture.holdHash(); window.selectedCdsFixture.select('partial'); });
    await expect.poll(() => page.evaluate(() => window.selectedCdsFixture.hashPending)).toBe(true);
    await expect(result).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export CDS FASTA', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.selectedCdsFixture.select('alternate'));
    await expect(result.getByLabel('Translated protein', { exact: true })).toHaveText('MW*');
    const alternateId = await result.getAttribute('data-result-id');
    await page.evaluate(() => window.selectedCdsFixture.releaseHash());
    await expect.poll(() => page.evaluate(() => window.selectedCdsFixture.hashReleased)).toBe(true);
    await expect(result).toHaveAttribute('data-result-id', alternateId!);
    const protein = await download(page, 'Export protein FASTA');
    expect(protein.text.split('\n').slice(1).join('')).toBe('MW*');
    expect(protein.text).toContain('transl_table=4'); expect(protein.filename).not.toBe(cds.filename);

    await page.evaluate(() => window.selectedCdsFixture.select('unsupported'));
    await expect(result).toContainText('Unsupported translation table.');
    await expect(page.getByRole('button', { name: 'Export protein FASTA', exact: true })).toBeDisabled();
    expect((await download(page, 'Export CDS FASTA')).text.split('\n').slice(1).join('')).toBe('ATGAAATAA');
    await page.evaluate(() => window.selectedCdsFixture.select('partial'));
    await expect(result).toContainText('Incomplete: 1 trailing base(s)');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
