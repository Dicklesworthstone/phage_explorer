import { test as base, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProgressiveManifest } from '../src/db/progressive-manifest';
import { setupTestHarness } from './e2e-harness';

const USER_AGENT = 'dicklesworthstone-release-wave/1.0 (+https://github.com/Dicklesworthstone)';
interface Assets { origin: string; manifest: ProgressiveManifest; requests: string[]; corruptCatalog: boolean; delays: Map<string, Promise<void>> }

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
    const assets: Assets = { origin: '', manifest: publication.manifest, requests: [], corruptCatalog: false, delays: new Map() };
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        assets.requests.push(url.pathname);
        await assets.delays.get(url.pathname);
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

async function openOfflineManager(page: Page) {
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.keyboard.press('Control+,');
  const settings = page.getByTestId('overlay-settings');
  await expect(settings).toBeVisible();
  const launch = settings.getByRole('button', { name: 'Manage offline genomes', exact: true });
  if (await launch.isVisible()) await launch.click();
  const panel = settings.getByRole('region', { name: 'Offline genome selection', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Load saved selection', exact: true })).toBeEnabled();
  return { settings, panel };
}
async function uncachedChoice(page: Page, assets: Assets) {
  const ids = await page.locator('[data-genome-id]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-genome-id'))));
  const choice = assets.manifest.genomes.find(genome => ids.includes(genome.id) && !assets.requests.includes('/' + genome.artifact.path));
  expect(choice, 'test must select a real genome that the app has not prefetched').toBeDefined();
  return choice!;
}
async function cachedFile(page: Page, path: string) {
  return page.evaluate(async artifactPath => {
    const cache = await caches.open('phage-explorer-data-v3');
    const response = await cache.match(new URL(artifactPath, location.href));
    if (!response) return null;
    const bytes = await response.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return { bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') };
  }, path);
}

test('Settings prepares an unvisited genome, restores offline, and releases only its reservation', async ({ page, context, assets }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto(`${assets.origin}/?phage=lambda&model=0`); await expectCatalog(page, assets.manifest.genomes.length);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
    await page.waitForLoadState('networkidle');
    let { settings, panel } = await openOfflineManager(page);
    const choice = await uncachedChoice(page, assets), path = '/' + choice.artifact.path;
    const row = () => panel.locator(`[data-genome-id="${choice.id}"]`);
    await row().getByRole('checkbox').check();
    const before = assets.requests.filter(value => value.startsWith('/phage-data/')).length;
    await panel.getByRole('button', { name: 'Check saved files', exact: true }).click();
    await expect(row()).toContainText('Not cached');
    await expect(panel.getByTestId('offline-verification')).toHaveAttribute('data-ready', 'false');
    expect(assets.requests.filter(value => value.startsWith('/phage-data/'))).toHaveLength(before);
    await panel.getByRole('button', { name: 'Prepare / resume selection', exact: true }).click();
    await expect(panel.getByTestId('offline-verification')).toHaveAttribute('data-ready', 'true');
    expect(await cachedFile(page, choice.artifact.path)).toEqual({ bytes: choice.artifact.bytes, sha256: choice.artifact.sha256 });
    expect(assets.requests.filter(value => value === path)).toHaveLength(1);
    await expect(panel.getByTestId('offline-saved-selection')).toContainText(assets.manifest.contentVersion);
    await context.setOffline(true); await page.reload(); await expectCatalog(page, assets.manifest.genomes.length);
    ({ settings, panel } = await openOfflineManager(page));
    await expect(row().getByRole('checkbox')).toBeChecked();
    await expect(panel.getByTestId('offline-verification')).toHaveCount(0); // Restoring a reservation is not byte verification.
    await panel.getByRole('button', { name: 'Check saved files', exact: true }).click();
    await expect(panel.getByTestId('offline-verification')).toHaveAttribute('data-ready', 'true');
    const identity = await cachedFile(page, choice.artifact.path);
    expect(identity).toEqual({ bytes: choice.artifact.bytes, sha256: choice.artifact.sha256 });
    await panel.getByRole('button', { name: 'Release offline reservation', exact: true }).click();
    await expect(panel.getByTestId('offline-saved-selection')).toHaveText('No saved offline reservation.');
    expect(await cachedFile(page, choice.artifact.path)).toEqual(identity);
    expect(assets.requests.filter(value => value === path)).toHaveLength(1);
    await settings.getByRole('button', { name: 'Close offline manager', exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally { await context.setOffline(false); await finalize(); }
});

test('closing Settings cancels a delayed download and resume never accepts stale readiness', async ({ page, assets }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo); let release: (() => void) | undefined;
  try {
    await page.goto(`${assets.origin}/?phage=lambda&model=0`); await expectCatalog(page, assets.manifest.genomes.length);
    await page.waitForLoadState('networkidle');
    let { settings, panel } = await openOfflineManager(page);
    const choice = await uncachedChoice(page, assets), path = '/' + choice.artifact.path;
    assets.delays.set(path, new Promise<void>(resolve => { release = resolve; }));
    await panel.locator(`[data-genome-id="${choice.id}"]`).getByRole('checkbox').check();
    await panel.getByRole('button', { name: 'Prepare / resume selection', exact: true }).click();
    await expect.poll(() => assets.requests.includes(path)).toBe(true);
    await expect(settings.getByRole('button', { name: 'Reload database from server', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(settings).not.toBeVisible();
    release?.(); assets.delays.delete(path);
    ({ settings, panel } = await openOfflineManager(page));
    await expect(panel.getByTestId('offline-verification')).toHaveCount(0);
    await expect(panel.locator(`[data-genome-id="${choice.id}"]`).getByRole('checkbox')).toBeChecked();
    await panel.getByRole('button', { name: 'Prepare / resume selection', exact: true }).click();
    await expect(panel.getByTestId('offline-verification')).toHaveAttribute('data-ready', 'true');
    expect(await cachedFile(page, choice.artifact.path)).toEqual({ bytes: choice.artifact.bytes, sha256: choice.artifact.sha256 });
    await panel.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(panel.getByTestId('offline-verification')).toHaveCount(0);
    await expect(panel.getByTestId('offline-byte-plan')).toContainText('0 genomes');
    await expect(settings.getByRole('button', { name: 'Reload database from server', exact: true })).toBeEnabled();
    expect(pageErrors).toEqual([]);
  } finally { release?.(); assets.delays.clear(); await finalize(); }
});
