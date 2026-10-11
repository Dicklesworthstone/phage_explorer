import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';
import type { ProgressiveManifest } from '../src/db/progressive-manifest';

interface Publication { directory: string; manifest: ProgressiveManifest; name: string; sequence: string }
interface Fixture {
  url: string;
  original: Publication;
  updated: Publication;
  revision: 'original' | 'updated';
  corrupt: boolean;
  requests: string[];
  gate: Promise<void> | null;
}

// Real React StrictMode, QueryClient, useDatabaseQuery, layout-aware loader and
// sql.js. Only the surrounding two-consumer view and HTTP failure controls are
// test fixtures; no loader/repository/worker implementation is replaced.
const VIEW = `
  import React, { useEffect, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { useDatabaseQuery } from './hooks/useDatabaseQuery';
  const client = new QueryClient();
  const identities = new WeakMap(); let nextId = 0;
  function identity(repository) {
    if (!repository) return 'none';
    if (!identities.has(repository)) identities.set(repository, ++nextId);
    return String(identities.get(repository));
  }
  window.databaseSessionProbe = { latest: {} };
  function Reader({ id }) {
    const database = useDatabaseQuery({ databaseUrl: '/cohort/phage.db' });
    const [row, setRow] = useState(null), [error, setError] = useState(''), [outcome, setOutcome] = useState('');
    const [reads, setReads] = useState(0);
    const read = async () => {
      try {
        const repository = database.repository;
        if (!repository) return;
        const list = await repository.listPhages();
        const sequence = await repository.getSequenceWindow(list[0].id, 0, 12);
        setRow({ name: list[0].name, sequence }); setError('');
      } catch (cause) { setError(String(cause)); }
      finally { setReads(value => value + 1); }
    };
    useEffect(() => {
      window.databaseSessionProbe.latest[id] = database.repository;
      void read();
    }, [database.repository]);
    const refresh = async () => {
      setOutcome('pending');
      try { await Promise.all([database.reload(), database.reload()]); setOutcome('complete'); }
      catch (cause) { setOutcome('failed: ' + String(cause)); }
    };
    return <section aria-label={'Reader ' + id}>
      <output data-testid={'identity-' + id}>{identity(database.repository)}</output>
      <output data-testid={'name-' + id}>{row?.name ?? ''}</output>
      <output data-testid={'sequence-' + id}>{row?.sequence ?? ''}</output>
      <output data-testid={'error-' + id}>{error}</output>
      <output data-testid={'reads-' + id}>{reads}</output>
      <output data-testid={'fetching-' + id}>{String(database.isFetching)}</output>
      <output data-testid={'outcome-' + id}>{outcome}</output>
      <output data-testid={'load-error-' + id}>{database.error ?? ''}</output>
      <button onClick={() => { void read(); }}>Read {id}</button>
      <button onClick={() => { void refresh(); }}>Refresh {id} twice</button>
    </section>;
  }
  function Fixture() {
    const [a, setA] = useState(true), [b, setB] = useState(true), [draft, setDraft] = useState('');
    return <main>
      <label>Unsaved research draft<input value={draft} onChange={e => setDraft(e.target.value)} /></label>
      <button onClick={() => setA(false)}>Unmount A</button><button onClick={() => setB(false)}>Unmount B</button>
      <button onClick={() => { setA(true); setB(true); }}>Mount both</button>
      {a && <Reader id="A" />}{b && <Reader id="B" />}
    </main>;
  }
  createRoot(document.getElementById('root')).render(
    <React.StrictMode><QueryClientProvider client={client}><Fixture /></QueryClientProvider></React.StrictMode>
  );
`;

const test = base.extend<{ database: Fixture }>({
  database: async ({}, use, info) => {
    const root = process.cwd(), output = info.outputPath('dataset-publications');
    const publications = JSON.parse(execFileSync('bun', ['-e', `
      import { Database } from 'bun:sqlite';
      import { join } from 'node:path';
      const { publishProgressiveDatasetToDirectory } = await import(process.argv[1]);
      const source = new Database(process.argv[2], { readonly: true });
      const snapshot = Database.deserialize(source.serialize()); source.close();
      const first = snapshot.query('SELECT id, name FROM phages ORDER BY id LIMIT 1').get();
      async function publish(label) {
        const directory = join(process.argv[3], label);
        const manifest = await publishProgressiveDatasetToDirectory({ source: snapshot,
          createDatabase: () => new Database(':memory:'), outputDirectory: directory });
        const row = snapshot.query('SELECT name FROM phages WHERE id=?').get(first.id);
        const chunk = snapshot.query('SELECT sequence FROM sequences WHERE phage_id=? AND chunk_index=0').get(first.id);
        return { directory, manifest, name: row.name, sequence: chunk.sequence.slice(0,12) };
      }
      try {
        const original = await publish('original');
        // Explicit private fault/update fixture, not a revision of deposited evidence.
        snapshot.query('UPDATE phages SET name=? WHERE id=?').run('Synthetic session update fixture', first.id);
        snapshot.query("UPDATE sequences SET sequence = CASE substr(sequence,1,1) WHEN 'A' THEN 'C' ELSE 'A' END || substr(sequence,2) WHERE phage_id=? AND chunk_index=0").run(first.id);
        const updated = await publish('updated');
        process.stdout.write(JSON.stringify({original,updated}));
      } finally { snapshot.close(); }
    `, pathToFileURL(resolve('../../scripts/build-progressive-web-db.ts')).href, resolve('public/phage.db'), output],
    { encoding: 'utf8' })) as Pick<Fixture, 'original' | 'updated'>;
    const fixture: Fixture = { ...publications, url: '', revision: 'original', corrupt: false, requests: [], gate: null };
    const source = resolve(root, 'src/database-session-fixture.tsx');
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
    if (!loaded) throw new Error('Vite configuration is unavailable.');
    const server = await createServer(mergeConfig(loaded.config, {
      root, configFile: false, cacheDir: info.outputPath('vite-cache'),
      server: { host: '127.0.0.1', port: 0, open: false },
      plugins: [{
        name: 'real-database-session-fixture',
        resolveId(id) { if (id === '/src/database-session-fixture.tsx') return source; },
        load(id) { if (id === source) return VIEW; },
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            if (url.pathname === '/database-session-fixture') {
              void vite.transformIndexHtml(url.pathname, '<div id="root"></div><script type="module" src="/src/database-session-fixture.tsx"></script>')
                .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
              return;
            }
            if (!url.pathname.startsWith('/cohort/')) { next(); return; }
            fixture.requests.push(url.pathname);
            const publication = fixture[fixture.revision];
            void (async () => {
              const relative = decodeURIComponent(url.pathname.slice('/cohort/'.length));
              if (relative === 'phage.db.manifest.json') {
                response.setHeader('Content-Type', 'application/json');
                response.setHeader('Cache-Control', 'no-cache');
                response.setHeader('ETag', '"' + publication.manifest.contentVersion + '"');
                if (request.headers['if-none-match'] === '"' + publication.manifest.contentVersion + '"') {
                  response.writeHead(304).end(); return;
                }
                response.end(JSON.stringify(publication.manifest)); return;
              }
              if (!relative.startsWith('phage-data/')) { response.writeHead(404).end(); return; }
              if (relative === publication.manifest.catalog.path && fixture.gate) await fixture.gate;
              const path = resolve(publication.directory, relative);
              if (!path.startsWith(publication.directory + sep)) { response.writeHead(403).end(); return; }
              const bytes = await readFile(path);
              if (fixture.corrupt && relative === publication.manifest.catalog.path) bytes[bytes.length - 1] ^= 1;
              response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Cache-Control', 'no-store');
              response.end(bytes);
            })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end(); });
          });
        },
      }],
    } satisfies InlineConfig));
    try {
      await server.listen(); fixture.url = server.resolvedUrls!.local[0] + 'database-session-fixture';
      await use(fixture);
    } finally {
      await info.attach('dataset-requests', { body: JSON.stringify(fixture.requests), contentType: 'application/json' });
      await server.close();
    }
  },
});
test.setTimeout(120_000);

test('StrictMode readers share real SQLite and survive partial unmount and complete remount', async ({ page, database }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(database.url);
  for (const id of ['A', 'B']) {
    await expect(page.getByTestId('name-' + id)).toHaveText(database.original.name);
    await expect(page.getByTestId('sequence-' + id)).toHaveText(database.original.sequence);
  }
  const instance = await page.getByTestId('identity-A').textContent();
  await expect(page.getByTestId('identity-B')).toHaveText(instance!);
  expect(database.requests.filter(path => path.endsWith('phage.db.manifest.json'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Unmount A', exact: true }).click();
  const beforeRead = Number(await page.getByTestId('reads-B').textContent());
  await page.getByRole('button', { name: 'Read B', exact: true }).click();
  await expect(page.getByTestId('reads-B')).toHaveText(String(beforeRead + 1));
  await expect(page.getByTestId('error-B')).toBeEmpty(); await expect(page.getByTestId('sequence-B')).toHaveText(database.original.sequence);
  await page.getByRole('button', { name: 'Unmount B', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const probe = (window as unknown as { databaseSessionProbe: { latest: Record<string, { listPhages(): Promise<unknown> }> } }).databaseSessionProbe;
    try { await probe.latest.B.listPhages(); return false; } catch { return true; }
  }), { message: 'last unsubscribe retires the borrowed snapshot' }).toBe(true);
  const artifactRequests = database.requests.filter(path => path.includes('/phage-data/')).length;
  await page.getByRole('button', { name: 'Mount both', exact: true }).click();
  await expect(page.getByTestId('sequence-A')).toHaveText(database.original.sequence);
  await expect(page.getByTestId('sequence-B')).toHaveText(database.original.sequence);
  await expect(page.getByTestId('identity-A')).not.toHaveText(instance!);
  expect(database.requests.filter(path => path.includes('/phage-data/'))).toHaveLength(artifactRequests);
  expect(errors).toEqual([]);
});

test('failed replacement keeps old SQL readable; simultaneous refresh callers accept one real update', async ({ page, database }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(database.url); await expect(page.getByTestId('name-A')).toHaveText(database.original.name);
  await page.getByLabel('Unsaved research draft', { exact: true }).fill('Keep this private draft');
  const original = await page.getByTestId('identity-A').textContent();
  database.revision = 'updated'; database.corrupt = true;
  await page.getByRole('button', { name: 'Refresh A twice', exact: true }).click();
  await expect(page.getByTestId('outcome-A')).toContainText('failed:');
  await expect(page.getByTestId('load-error-B')).toContainText('integrity');
  const beforeRead = Number(await page.getByTestId('reads-B').textContent());
  await page.getByRole('button', { name: 'Read B', exact: true }).click();
  await expect(page.getByTestId('reads-B')).toHaveText(String(beforeRead + 1));
  await expect(page.getByTestId('identity-B')).toHaveText(original!);
  await expect(page.getByTestId('sequence-B')).toHaveText(database.original.sequence);
  await expect(page.getByTestId('error-B')).toBeEmpty();
  database.corrupt = false;
  let release!: () => void; database.gate = new Promise<void>(resolve => { release = resolve; });
  const before = database.requests.filter(path => path.endsWith('phage.db.manifest.json')).length;
  try {
    await page.getByRole('button', { name: 'Refresh A twice', exact: true }).click();
    await expect(page.getByTestId('fetching-A')).toHaveText('true'); await expect(page.getByTestId('fetching-B')).toHaveText('true');
    const duringRefresh = Number(await page.getByTestId('reads-B').textContent());
    await page.getByRole('button', { name: 'Read B', exact: true }).click();
    await expect(page.getByTestId('reads-B')).toHaveText(String(duringRefresh + 1));
    await expect(page.getByTestId('error-B')).toBeEmpty();
    release(); database.gate = null;
    await expect(page.getByTestId('outcome-A')).toHaveText('complete');
    for (const id of ['A', 'B']) {
      await expect(page.getByTestId('name-' + id)).toHaveText(database.updated.name);
      await expect(page.getByTestId('sequence-' + id)).toHaveText(database.updated.sequence);
      await expect(page.getByTestId('load-error-' + id)).toBeEmpty();
    }
    expect(database.requests.filter(path => path.endsWith('phage.db.manifest.json'))).toHaveLength(before + 1);
    await expect(page.getByTestId('identity-A')).not.toHaveText(original!);
    await expect(page.getByLabel('Unsaved research draft', { exact: true })).toHaveValue('Keep this private draft');
    expect(errors).toEqual([]);
  } finally { release(); database.gate = null; }
});
