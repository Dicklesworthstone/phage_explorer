import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { setupTestHarness } from './e2e-harness';

const USER_AGENT = 'OpenAI File Downloader, XaiImageApiFetch/1.0';
const buildDirectory = resolve(process.env.PLAYWRIGHT_BUILD_DIR ?? 'dist');
interface AssetServer {
  origin: string;
  revision: number;
  manifestOverride: Record<string, unknown> | null;
  requests: Array<{ path: string; userAgent: string | undefined }>;
}

// Serve the actual production build. Only the worker's trailing comment and
// fault-injected manifest vary; the worker and application are never replaced
// with a fixture implementation. Each test gets an isolated real HTTP origin.
const test = base.extend<{ assets: AssetServer }>({
  assets: async ({}, use, testInfo) => {
    const assets: AssetServer = { origin: '', revision: 1, manifestOverride: null, requests: [] };
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        assets.requests.push({ path: url.pathname + url.search, userAgent: request.headers['user-agent'] });
        const path = resolve(buildDirectory, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
        if (!path.startsWith(buildDirectory + sep)) {
          response.writeHead(403).end();
          return;
        }
        let body = await readFile(path);
        if (url.pathname === '/sw.js') body = Buffer.concat([body, Buffer.from(`\n// Test deployment revision ${assets.revision}\n`)]);
        if (url.pathname === '/phage.db.manifest.json' && assets.manifestOverride) body = Buffer.from(JSON.stringify(assets.manifestOverride));
        const types: Record<string, string> = {
          '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
          '.json': 'application/json', '.webmanifest': 'application/manifest+json',
          '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
          '.woff2': 'font/woff2', '.gz': 'application/gzip',
        };
        response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        response.end(body);
      })().catch(() => response.writeHead(404).end());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind');
    assets.origin = `http://127.0.0.1:${address.port}`;
    try { await use(assets); }
    finally {
      await testInfo.attach('origin-requests', { body: JSON.stringify(assets.requests), contentType: 'application/json' });
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
});

test.use({ userAgent: USER_AGENT, serviceWorkers: 'allow' });
// Two full real SW installations and precaching are included in the update
// journey. This is a lifecycle budget, not a performance threshold.
test.setTimeout(120_000);
test.beforeEach(async ({ page }) => {
  // Exercise the existing normal-user registration branch, normally skipped
  // under webdriver. No production-only testing hook is added.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    // A first offline visit lands on the browser's opaque network-error page.
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    }
  });
});

async function catalog(page: Page) {
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('Enterobacteria phage lambda');
  await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(24);
}

async function controlled(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
}

async function identity(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('phage-explorer-db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const snapshot = await new Promise<{ data: Uint8Array; contentVersion: string; sha256: string } | undefined>((resolve, reject) => {
        const request = db.transaction('database').objectStore('database').get('phage-db:snapshot');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!snapshot) return null;
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(snapshot.data));
      const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      return { contentVersion: snapshot.contentVersion, sha256: snapshot.sha256, valid: actual === snapshot.sha256 };
    } finally { db.close(); }
  });
}

test('installable manifest, real worker control and offline catalog with uncached 3D failure', async ({ page, context, assets }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await context.setOffline(true);
    await expect(page.goto(assets.origin)).rejects.toThrow();
    await context.setOffline(false);
    await page.goto(`${assets.origin}/?phage=lambda&model=0`);
    await catalog(page);
    await controlled(page);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    const manifest = await (await page.request.get(`${assets.origin}/manifest.webmanifest`)).json();
    expect(manifest).toMatchObject({ display: 'standalone', start_url: '/', scope: '/' });
    expect(manifest.icons).toEqual([
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ]);
    for (const icon of manifest.icons) {
      const bytes = await (await page.request.get(assets.origin + icon.src)).body();
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
    }
    const cdp = await context.newCDPSession(page);
    const readiness = await cdp.send('Page.getInstallabilityErrors');
    expect(readiness.installabilityErrors).toEqual([]);
    await cdp.detach();
    const before = await identity(page);
    expect(before?.valid).toBe(true);
    const transfers = assets.requests.filter(r => /\/phage\.db(?:\.gz)?\?/.test(r.path)).length;
    await context.setOffline(true);
    await page.reload();
    await catalog(page);
    await controlled(page);
    expect(await identity(page)).toEqual(before);
    expect(assets.requests.filter(r => /\/phage\.db(?:\.gz)?\?/.test(r.path))).toHaveLength(transfers);
    await page.keyboard.press('m');
    await expect(page.getByRole('heading', { name: 'Unable to Load Structure' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await catalog(page);
    expect(pageErrors).toEqual([]);
    expect(assets.requests.every(r => r.userAgent === USER_AGENT)).toBe(true);
    await testInfo.attach('offline-identity-and-installability', { body: JSON.stringify({ before, after: await identity(page), readiness }), contentType: 'application/json' });
  } finally { await context.setOffline(false); await finalize(); }
});

test('real update waits for user action, survives reopening and activates before reload', async ({ page, assets }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto(`${assets.origin}/?phage=lambda&model=0`);
    await catalog(page);
    await controlled(page);
    const before = await identity(page);
    await page.evaluate(() => {
      (window as Window & { originalController?: ServiceWorker | null }).originalController = navigator.serviceWorker.controller;
      sessionStorage.setItem('user-work-update-test', 'preserve me');
    });
    assets.revision = 2;
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect(page.getByText('Update available', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.serviceWorker.controller === (window as Window & { originalController?: ServiceWorker | null }).originalController)).toBe(true);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe('installed');
    // A reopened page must still offer the already-waiting update.
    await page.reload();
    await catalog(page);
    await expect(page.getByText('Update available', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      navigator.serviceWorker.addEventListener('controllerchange', () => sessionStorage.setItem('update-controlled', 'yes'), { once: true });
    });
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      page.getByRole('button', { name: 'Reload', exact: true }).click(),
    ]);
    await catalog(page);
    await controlled(page);
    expect(await page.evaluate(() => sessionStorage.getItem('update-controlled'))).toBe('yes');
    expect(await page.evaluate(() => sessionStorage.getItem('user-work-update-test'))).toBe('preserve me');
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting ?? null)).toBeNull();
    expect(await identity(page)).toEqual(before);
    await expect(page.getByText('Update available', { exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('actual stale service-worker response cannot replace the known-good database', async ({ page, assets }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto(`${assets.origin}/?phage=lambda&model=0`);
    await catalog(page);
    await controlled(page);
    const before = await identity(page);
    const manifest = await (await page.request.get(`${assets.origin}/phage.db.manifest.json`)).json();
    // Plant old valid gzip bytes under a new content URL in actual CacheStorage.
    // The descriptor deliberately disagrees, modelling an interrupted rollout.
    const staleVersion = 'a'.repeat(64);
    assets.manifestOverride = { ...manifest, contentVersion: staleVersion, sha256: 'b'.repeat(64) };
    await page.evaluate(async (version) => {
      const bytes = await fetch('/phage.db.gz');
      const cache = await caches.open('phage-database-v2');
      await cache.put(`/phage.db.gz?v=${version}`, bytes);
    }, staleVersion);
    const workerResponses: string[] = [];
    page.on('response', response => {
      if (response.fromServiceWorker() && response.url().includes('phage.db.gz?v=')) workerResponses.push(response.url());
    });
    await page.reload();
    await catalog(page);
    await expect.poll(() => workerResponses.length).toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: 'Database update status' })).toContainText('Database update failed. Your verified cached database is still in use.');
    expect(await identity(page)).toEqual(before);
    assets.manifestOverride = null;
    await page.reload();
    await catalog(page);
    expect(await identity(page)).toEqual(before);
    expect(pageErrors).toEqual([]);
    await testInfo.attach('stale-worker-recovery', { body: JSON.stringify({ before, workerResponses, recovered: await identity(page) }), contentType: 'application/json' });
  } finally { await finalize(); }
});
