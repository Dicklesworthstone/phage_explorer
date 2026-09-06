import { test, expect, type Page } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

test.use({ userAgent: 'OpenAI File Downloader, XaiImageApiFetch/1.0' });

async function cachedIdentity(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('phage-explorer-db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const entry = await new Promise<{ data: Uint8Array; contentVersion: string; sha256: string } | undefined>((resolve, reject) => {
        const request = db.transaction('database').objectStore('database').get('phage-db:snapshot');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!entry) return null;
      const bytes = new Uint8Array(entry.data);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      const actual = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
      return { contentVersion: entry.contentVersion, sha256: entry.sha256, size: bytes.length, valid: actual === entry.sha256 };
    } finally {
      db.close();
    }
  });
}

async function expectCatalog(page: Page) {
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('Enterobacteria phage lambda');
  await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(24);
  await expect(page.getByTestId('phage-list')).toContainText('48,502');
}

async function expectOfflineCache(page: Page) {
  await expect(page.getByRole('status', { name: 'Offline database status', exact: true })).toHaveText('Database available offline');
}

// WebKit cannot fulfill a synthetic 304 through Playwright routing. Serve a
// real conditional HTTP response so every engine exercises the same protocol.
async function serveConditionalManifest(manifest: unknown, etag: string, onResponse: (notModified: boolean) => void) {
  const server = createServer((request, response) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'If-None-Match',
      'Access-Control-Expose-Headers': 'ETag',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      ETag: etag,
    };
    if (request.method === 'OPTIONS') { // ubs:ignore — public HTTP method comparison, not authentication or a secret.
      response.writeHead(204, headers).end();
      return;
    } // ubs:ignore — closes the OPTIONS branch; request headers are never merged into response headers.
    const notModified = request.headers['if-none-match'] === etag; // ubs:ignore — public ETag comparison; no secret and no request object is merged into state.
    onResponse(notModified);
    response.writeHead(notModified ? 304 : 200, headers);
    response.end(notModified ? undefined : JSON.stringify(manifest));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Manifest server did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/phage.db.manifest.json`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test('SQLite initializes during the real database download and optional search waits for the catalog', async ({ page }, testInfo) => {
  const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, testInfo);
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve; });
  let downloading = false;
  let sqlReady = false;
  let searchRequests = 0;
  await page.route('**/phage.db.gz?*', async route => {
    downloading = true;
    await downloadGate;
    await route.continue(); // Delay the actual asset; never substitute database bytes.
  });
  page.on('requestfinished', request => {
    if (/\/sql-wasm-[^/]+\.wasm$/.test(request.url())) sqlReady = true;
  });
  page.on('request', request => {
    if (/\/search\.worker-[^/]+\.js$/.test(request.url())) searchRequests++;
  });
  try {
    await page.goto('/?phage=lambda&model=0', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => downloading).toBe(true);
    await expect.poll(() => sqlReady, { message: 'SQLite WASM completes while the DB response is still held' }).toBe(true);
    expect(searchRequests, 'optional worker must not compete with initial database loading').toBe(0);
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(0);
    releaseDownload();
    await expectCatalog(page);
    await expectOfflineCache(page);
    await expect.poll(() => searchRequests, { message: 'search still preloads after the catalog becomes usable' }).toBe(1);
    expect((await cachedIdentity(page))?.valid).toBe(true);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.keyboard.press('/');
    const search = page.locator('.overlay-search');
    await search.getByLabel('Query', { exact: true }).fill('ATG');
    await expect(search.locator('[data-result-index="0"]')).toContainText('ATG');
    await search.locator('[data-result-index="0"]').click();
    await expect(search).not.toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search commands' }).fill('lambda');
    await expect(page.getByTestId('command-palette-results')).toContainText('Enterobacteria phage lambda');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Search commands' })).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Search commands' })).not.toBeVisible();
    await page.keyboard.press('/');
    await search.getByLabel('Query', { exact: true }).fill('ATGC');
    await expect(search.locator('[data-result-index="0"]')).toContainText('ATGC');
    expect(searchRequests, 'Search and Command Palette reuse the one preloaded worker across reopen').toBe(1);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    releaseDownload();
    await finalize();
  }
});

test('an early SQLite download failure is observed and Retry recovers without a page reload', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve; });
  let failedWasm = false;
  let rejectWasm = true;
  await page.route('**/phage.db.gz?*', async route => {
    await downloadGate;
    await route.continue();
  });
  await page.route('**/sql-wasm-*.wasm', async route => {
    if (rejectWasm) {
      failedWasm = true;
      await route.abort('failed'); // Explicit transport fault; successful retry uses the real WASM asset.
    } else {
      await route.continue();
    }
  });
  try {
    await page.goto('/?phage=lambda&model=0', { waitUntil: 'domcontentloaded' });
    const identity = await page.evaluate(() => {
      document.documentElement.dataset.startupIdentity = crypto.randomUUID();
      return document.documentElement.dataset.startupIdentity;
    });
    await expect.poll(() => failedWasm).toBe(true);
    releaseDownload();
    await expect(page.getByRole('status', { name: 'Database loading progress' })).toContainText('error');
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(0);
    expect(await cachedIdentity(page)).toBeNull();
    expect(pageErrors, 'an early rejected initialization must not become an unhandled rejection').toEqual([]);
    rejectWasm = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expectCatalog(page);
    await expectOfflineCache(page);
    expect((await cachedIdentity(page))?.valid).toBe(true);
    expect(await page.evaluate(() => document.documentElement.dataset.startupIdentity)).toBe(identity);
    expect(pageErrors).toEqual([]);
  } finally {
    releaseDownload();
    await finalize();
  }
});

test('database loads real catalog data and reuses verified cache without another download', async ({ page }, testInfo) => {
  const { consoleErrors, pageErrors, finalize } = setupTestHarness(page, testInfo);
  const downloads: string[] = [];
  page.on('request', request => {
    if (/\/phage\.db(?:\.gz)?(?:\?|$)/.test(request.url())) downloads.push(request.url());
  });
  try {
    const response = await page.request.get('/phage.db.manifest.json');
    expect(response.ok()).toBe(true);
    const manifest = await response.json();
    expect(manifest.version).toBe(2);
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    expect(new URL(page.url()).origin).toBe(new URL(testInfo.project.use.baseURL!).origin);
    await expectOfflineCache(page);
    const cold = await cachedIdentity(page);
    expect(cold).toEqual({ contentVersion: manifest.contentVersion, sha256: manifest.sha256, size: manifest.size, valid: true });
    expect(downloads.length).toBeGreaterThan(0);

    downloads.length = 0;
    await page.reload();
    await expectCatalog(page);
    expect(await cachedIdentity(page)).toEqual(cold);
    expect(downloads).toHaveLength(0);
    expect(pageErrors).toHaveLength(0);
    expect(consoleErrors.filter(e => /database|sqlite|hash mismatch/i.test(e))).toHaveLength(0);
    await testInfo.attach('database-identity', { body: JSON.stringify({ cold, warmDatabaseTransfers: downloads.length }), contentType: 'application/json' });
  } finally {
    await finalize();
  }
});

test('corrupt update cannot replace a verified cached catalog, including after a 304 manifest', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  let manifestServer: Awaited<ReturnType<typeof serveConditionalManifest>> | undefined;
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    await expectOfflineCache(page);
    const original = await cachedIdentity(page);
    expect(original?.valid).toBe(true);
    const response = await page.request.get('/phage.db.manifest.json');
    const manifest = await response.json();
    // Controlled update fault: a new manifest arrives but the server still
    // serves the old DB bytes. This is protocol fault injection, not live data.
    const update = { ...manifest, contentVersion: 'a'.repeat(64), sha256: 'b'.repeat(64) };
    let manifestRequests = 0;
    let notModified = 0;
    let updateDownloads = 0;
    manifestServer = await serveConditionalManifest(update, '"test-update"', cached => {
      manifestRequests++;
      if (cached) notModified++;
    });
    const manifestUrl = manifestServer.url;
    await page.route('**/phage.db.manifest.json', route => route.continue({ url: manifestUrl }));
    page.on('request', request => {
      if (/\/phage\.db(?:\.gz)?\?/.test(request.url())) updateDownloads++;
    });
    await page.reload();
    await expectCatalog(page);
    await expect.poll(() => manifestRequests).toBeGreaterThanOrEqual(2);
    await expect.poll(() => notModified).toBeGreaterThan(0);
    await expect.poll(() => updateDownloads).toBeGreaterThan(0);
    // A rejected background refresh must keep the actual previous bytes and identity.
    expect(await cachedIdentity(page)).toEqual(original);
    expect(pageErrors).toHaveLength(0);
  } finally {
    try { await finalize(); } finally { await manifestServer?.close(); }
  }
});

test('cold load rejects a mismatched descriptor instead of displaying unverified data', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);
  try {
    const response = await page.request.get('/phage.db.manifest.json');
    const manifest = await response.json();
    await page.route('**/phage.db.manifest.json', route => route.fulfill({ json: { ...manifest, sha256: '0'.repeat(64) } }));
    await page.goto('/?model=0');
    await expect(page.getByRole('heading', { name: 'Database load failed' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Repository status' })).toContainText('Database integrity check failed');
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(0);
    expect(await cachedIdentity(page)).toBeNull();
  } finally {
    await finalize();
  }
});

for (const mode of ['normal', 'interrupted write', 'two tabs'] as const) {
test(`real data and schema update converges to a verified cache: ${mode}`, async ({ page, context }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  let manifestServer: Awaited<ReturnType<typeof serveConditionalManifest>> | undefined;
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    await expectOfflineCache(page);
    const original = await cachedIdentity(page);
    const artifacts = testInfo.outputPath('changed-database');
    await mkdir(artifacts, { recursive: true });
    const source = resolve(artifacts, 'source.db');
    const raw = await page.request.get('/phage.db');
    expect(raw.ok()).toBe(true);
    await writeFile(source, await raw.body());
    // Mutate a private SQLite snapshot. The actual build command generates the
    // served bytes and descriptor; neither checksum nor result is hard-coded.
    execFileSync('bun', ['-e', `import { Database } from 'bun:sqlite';
      const path = process.argv[1]; const db = Database.deserialize(Buffer.from(await Bun.file(path).arrayBuffer()));
      try { db.run("UPDATE phages SET gc_content=50 WHERE slug='lambda'"); db.run('PRAGMA user_version=1'); await Bun.write(path, db.serialize()); }
      finally { db.close(); }`, source], { stdio: ['ignore', 'pipe', 'inherit'] });
    const sourceBytes = await readFile(source);
    const buildLog = execFileSync('bun', [resolve(process.cwd(), '../../scripts/build-web-db.ts'), '--source', source, '--output', artifacts], { stdio: ['ignore', 'pipe', 'inherit'] });
    expect((await readFile(source)).equals(sourceBytes)).toBe(true);
    await testInfo.attach('update-builder', { body: buildLog, contentType: 'text/plain' });
    const manifest = JSON.parse(await readFile(resolve(artifacts, 'phage.db.manifest.json'), 'utf8'));
    const gz = await readFile(resolve(artifacts, 'phage.db.gz'));
    expect(manifest.contentVersion).not.toBe(original!.contentVersion);
    let downloads = 0;
    let notModified = 0;
    manifestServer = await serveConditionalManifest(manifest, '"real-update"', cached => {
      if (cached) notModified++;
    });
    const manifestUrl = manifestServer.url;
    await context.route('**/phage.db.manifest.json', route => route.continue({ url: manifestUrl }));
    let releaseConcurrentDownloads: (() => void) | undefined;
    const bothDownloading = new Promise<void>(resolve => { releaseConcurrentDownloads = resolve; });
    await context.route('**/phage.db.gz?*', async route => {
      downloads++;
      if (mode === 'two tabs') {
        if (downloads === 2) releaseConcurrentDownloads?.();
        await bothDownloading;
      }
      return route.fulfill({ body: gz, contentType: 'application/gzip' });
    });
    if (mode === 'interrupted write') {
      await page.addInitScript(() => {
        // Abort the real loader's first update transaction after put succeeds.
        // The atomic record must retain both the previous identity and bytes.
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value, key) {
          const request = put.call(this, value, key);
          if (key === 'phage-db:snapshot' && !sessionStorage.getItem('aborted-update-write')) {
            sessionStorage.setItem('aborted-update-write', 'yes');
            request.addEventListener('success', () => this.transaction.abort(), { once: true });
          }
          return request;
        };
      });
    }
    const second = mode === 'two tabs' ? await context.newPage() : null;
    await Promise.all([page.reload(), second?.goto('/?phage=lambda&model=0')]);
    await expectCatalog(page);
    if (second) await expectCatalog(second);
    if (mode === 'interrupted write') {
      await expect(page.getByRole('region', { name: 'Database update status' })).toContainText('could not be saved');
      expect(await cachedIdentity(page)).toEqual(original);
      await page.reload();
      await expectCatalog(page);
    }
    await expect.poll(() => cachedIdentity(page)).toEqual({ contentVersion: manifest.contentVersion, sha256: manifest.sha256, size: manifest.size, valid: true });
    const expectedDownloads = mode === 'normal' ? 1 : 2;
    expect(downloads).toBe(expectedDownloads);
    if (second) expect(await cachedIdentity(second)).toEqual(await cachedIdentity(page));
    expect(notModified).toBeGreaterThan(0);
    await page.reload();
    await expectCatalog(page);
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('50.0%');
    expect(downloads).toBe(expectedDownloads);
    expect(pageErrors).toEqual([]);
    if (second) await second.close();
  } finally {
    try { await finalize(); } finally { await manifestServer?.close(); }
  }
});
}

test('equivalent builder layouts keep the already verified cache without another database transfer', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    await expectOfflineCache(page);
    const original = await cachedIdentity(page);
    const artifacts = testInfo.outputPath('equivalent-layout');
    await mkdir(artifacts, { recursive: true });
    const source = resolve(artifacts, 'source.db');
    await writeFile(source, await (await page.request.get('/phage.db')).body());
    execFileSync('bun', ['-e', `import { Database } from 'bun:sqlite';
      const path=process.argv[1]; const db=Database.deserialize(Buffer.from(await Bun.file(path).arrayBuffer()));
      try { db.exec('PRAGMA page_size=8192; VACUUM'); await Bun.write(path,db.serialize()); } finally { db.close(); }`, source], { stdio: ['ignore', 'pipe', 'inherit'] });
    const buildLog = execFileSync('bun', [resolve(process.cwd(), '../../scripts/build-web-db.ts'), '--source', source, '--output', artifacts], { stdio: ['ignore', 'pipe', 'inherit'] });
    const manifest = JSON.parse(await readFile(resolve(artifacts, 'phage.db.manifest.json'), 'utf8'));
    expect(manifest.contentVersion).toBe(original!.contentVersion);
    expect(manifest.sha256).not.toBe(original!.sha256);
    await page.route('**/phage.db.manifest.json', route => route.fulfill({ json: manifest }));
    let downloads = 0;
    page.on('request', request => { if (/\/phage\.db(?:\.gz)?\?/.test(request.url())) downloads++; });
    await page.reload();
    await expectCatalog(page);
    expect(downloads).toBe(0);
    expect(await cachedIdentity(page)).toEqual(original);
    expect(pageErrors).toEqual([]);
    await testInfo.attach('equivalent-builder', { body: buildLog, contentType: 'text/plain' });
    await testInfo.attach('equivalent-layout-identities', { body: JSON.stringify({ original, nextDeployment: manifest, downloads }), contentType: 'application/json' });
  } finally { await finalize(); }
});

test('verified cached catalog remains usable when the database origin is unavailable', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    await expectOfflineCache(page);
    const original = await cachedIdentity(page);
    let transfers = 0;
    await page.route('**/phage.db*', route => {
      if (/\/phage\.db(?:\.gz)?(?:\?|$)/.test(route.request().url())) transfers++;
      return route.abort('internetdisconnected');
    });
    await page.reload();
    await expectCatalog(page);
    expect(await cachedIdentity(page)).toEqual(original);
    expect(transfers).toBe(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await finalize();
  }
});

test('Settings refresh reports corruption and preserves the verified cache for recovery', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    await expectOfflineCache(page);
    const original = await cachedIdentity(page);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    const descriptor = await (await page.request.get('/phage.db.manifest.json')).json();
    await page.route('**/phage.db.manifest.json', route => route.fulfill({ json: { ...descriptor, sha256: '0'.repeat(64) } }));
    await page.getByTestId('header-settings-btn').click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Reload database from server', exact: true }).click();
    await expect(settings).toContainText('Failed to reload database. Check your connection.');
    expect(await cachedIdentity(page)).toEqual(original);
    await expectCatalog(page);
    await page.unroute('**/phage.db.manifest.json');
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      settings.getByRole('button', { name: 'Reload database from server', exact: true }).click(),
    ]);
    await expectCatalog(page);
    expect(await cachedIdentity(page)).toEqual(original);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('missing gzip falls back to matching raw SQLite and exposes the shipped atlas', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  let rawDownloads = 0;
  page.on('request', request => {
    if (/\/phage\.db\?/.test(request.url())) rawDownloads++;
  });
  try {
    await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
    await page.route('**/phage.db.gz?*', route => route.fulfill({ status: 404 }));
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    expect(rawDownloads).toBe(1);
    await expectOfflineCache(page);
    expect((await cachedIdentity(page))?.valid).toBe(true);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.keyboard.press('Alt+Shift+l');
    const atlas = page.getByTestId('overlay-latentSpaceAtlas');
    await expect(atlas).toBeVisible();
    await expect(atlas).toContainText('Showing 2039 of 2039 proteins');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+e');
    const defense = page.getByTestId('overlay-defenseArmsRace');
    await expect(defense).toBeVisible();
    await expect(defense.getByRole('button', { name: /anti-RM.*1/i })).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await finalize();
  }
});

test('a failed first cache write keeps verified catalog data usable and reports offline unavailability', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        const request = put.call(this, value, key);
        if (key === 'phage-db:snapshot') {
          request.addEventListener('success', () => this.transaction.abort(), { once: true });
        }
        return request;
      };
    });
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    await expect(page.getByRole('status', { name: 'Offline database status', exact: true })).toHaveText('Database loaded. Offline storage is unavailable.');
    expect(await cachedIdentity(page)).toBeNull();
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
