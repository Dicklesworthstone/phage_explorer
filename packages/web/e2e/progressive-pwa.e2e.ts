import { test as base, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProgressiveManifest } from '../src/db/progressive-manifest';
import { setupTestHarness } from './e2e-harness';

const USER_AGENT = 'dicklesworthstone-release-wave/1.0 (+https://github.com/Dicklesworthstone)';
interface Assets { origin: string; manifest: ProgressiveManifest; requests: string[]; corruptCatalog: boolean }

// Real built application + real production publisher. No fake repositories or
// replacement app/worker scripts. A private origin isolates offline caches.
const test = base.extend<{ assets: Assets }>({
  assets: async ({}, use, testInfo) => {
    const parent = testInfo.outputPath('progressive-public'); await mkdir(parent, { recursive: true });
    const publication = JSON.parse(execFileSync('bun', ['-e', `
      import { Database } from 'bun:sqlite';
      const { prepareWebPublicAssets } = await import(process.argv[1]);
      const result = await prepareWebPublicAssets({ publicDirectory: process.argv[2], stagingParent: process.argv[3],
        openSource: path => new Database(path, { readonly: true }), createDatabase: () => new Database(':memory:') });
      process.stdout.write(JSON.stringify(result));
    `, pathToFileURL(resolve('build.ts')).href, resolve('public'), parent], { encoding: 'utf8' })) as {directory:string;manifest:ProgressiveManifest};
    const built = resolve(process.env.PLAYWRIGHT_BUILD_DIR ?? 'dist');
    const assets: Assets = { origin: '', manifest: publication.manifest, requests: [], corruptCatalog: false };
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        assets.requests.push(url.pathname);
        // A v3 failure cannot obtain legacy bytes from a v2 build's public directory.
        if (url.pathname === '/phage.db' || url.pathname === '/phage.db.gz') { response.writeHead(404).end(); return; }
        const dataset = url.pathname === '/phage.db.manifest.json' || url.pathname.startsWith('/phage-data/');
        const root = dataset ? publication.directory : built;
        const path = resolve(root, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
        if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
        const body = await readFile(path);
        if (assets.corruptCatalog && url.pathname === '/' + assets.manifest.catalog.path) body[body.length - 1] ^= 1;
        const types: Record<string, string> = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
          '.json':'application/json', '.wasm':'application/wasm', '.webmanifest':'application/manifest+json',
          '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2' };
        response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control':'no-store' });
        response.end(body);
      })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end(); });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Progressive server did not bind.');
    assets.origin = `http://127.0.0.1:${address.port}`;
    try { await use(assets); }
    finally {
      await testInfo.attach('progressive-origin-requests', { body: JSON.stringify({ manifest: assets.manifest, requests: assets.requests }), contentType:'application/json' });
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
});

test.use({ userAgent: USER_AGENT, serviceWorkers:'allow', launchOptions:{args:[`--user-agent=${USER_AGENT}`]} });
test.setTimeout(120_000);
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({experienceLevel:'power'}));
    }
  });
});

async function catalogIdentity(page: Page) {
  return page.evaluate(async () => {
    const pointerCache = await caches.open('phage-explorer-manifests-v3');
    const response = await pointerCache.match(new URL('/phage.db.manifest.json', location.href));
    if (!response) return null;
    const manifest = await response.json();
    const dataCache = await caches.open('phage-explorer-data-v3');
    const catalog = await dataCache.match(new URL(manifest.catalog.path, location.href));
    if (!catalog) return null;
    const bytes = await catalog.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return {contentVersion:manifest.contentVersion, catalog:actual, valid:actual === manifest.catalog.sha256 && bytes.byteLength === manifest.catalog.bytes};
  });
}

async function expectCatalog(page: Page, count: number) {
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('Enterobacteria phage lambda');
  await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(count);
}

test('actual progressive app loads a subset of genomes and reopens verified data offline', async ({page, context, assets}, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto(`${assets.origin}/?phage=lambda&model=0`);
    await expectCatalog(page, assets.manifest.genomes.length);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
    await page.waitForLoadState('networkidle');
    const identity = await catalogIdentity(page);
    expect(identity).toEqual({contentVersion:assets.manifest.contentVersion,catalog:assets.manifest.catalog.sha256,valid:true});
    const shardPaths = new Set(assets.manifest.genomes.map(genome => '/' + genome.artifact.path));
    const loaded = new Set(assets.requests.filter(path => shardPaths.has(path)));
    expect(loaded.size).toBeGreaterThan(0);
    expect(loaded.size, 'opening one phage must not eagerly fetch the entire dataset').toBeLessThan(assets.manifest.genomes.length);
    expect(assets.requests.filter(path => path === '/phage.db' || path === '/phage.db.gz')).toEqual([]);
    expect(assets.requests.filter(path => path.startsWith('/phage-data/'))[0]).toBe('/' + assets.manifest.catalog.path);
    const transfers = assets.requests.filter(path => path.startsWith('/phage-data/')).length;
    await context.setOffline(true);
    await page.reload();
    await expectCatalog(page, assets.manifest.genomes.length);
    expect(await catalogIdentity(page)).toEqual(identity);
    expect(assets.requests.filter(path => path.startsWith('/phage-data/'))).toHaveLength(transfers);
    expect(pageErrors).toEqual([]);
  } finally { await context.setOffline(false); await finalize(); }
});

test('actual progressive app rejects a damaged catalog without installing a pointer or requesting a monolith', async ({page, assets}, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  assets.corruptCatalog = true;
  try {
    await page.goto(`${assets.origin}/?phage=lambda&model=0`);
    await expect(page.getByRole('heading', {name:'Database load failed'})).toBeVisible();
    await expect(page.getByRole('region', {name:'Repository status'})).toContainText('Dataset integrity check failed');
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(0);
    expect(await catalogIdentity(page)).toBeNull();
    expect(assets.requests.filter(path => path === '/phage.db' || path === '/phage.db.gz')).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
