import { test, expect, type Page } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
    const original = await cachedIdentity(page);
    expect(original?.valid).toBe(true);
    const response = await page.request.get('/phage.db.manifest.json');
    const manifest = await response.json();
    // Controlled update fault: a new manifest arrives but the server still
    // serves the old DB bytes. This is protocol fault injection, not live data.
    const update = { ...manifest, contentVersion: 'a'.repeat(64), sha256: 'b'.repeat(64) };
    let manifestRequests = 0;
    let updateDownloads = 0;
    await page.route('**/phage.db.manifest.json', route => { // ubs:ignore — test-only fixed response; no request object is merged into runtime state.
      manifestRequests++;
      if (route.request().headers()['if-none-match'] === '"test-update"') {
        return route.fulfill({ status: 304, headers: { ETag: '"test-update"' } });
      }
      return route.fulfill({ status: 200, json: update, headers: { ETag: '"test-update"' } });
    });
    page.on('request', request => {
      if (/\/phage\.db(?:\.gz)?\?/.test(request.url())) updateDownloads++;
    });
    await page.reload();
    await expectCatalog(page);
    await expect.poll(() => manifestRequests).toBeGreaterThanOrEqual(2);
    await expect.poll(() => updateDownloads).toBeGreaterThan(0);
    // A rejected background refresh must keep the actual previous bytes and identity.
    expect(await cachedIdentity(page)).toEqual(original);
    expect(pageErrors).toHaveLength(0);
  } finally {
    await finalize();
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
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
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
    await context.route('**/phage.db.manifest.json', route => { // ubs:ignore — test-only fixed response; no request object is merged into runtime state.
      if (route.request().headers()['if-none-match'] === '"real-update"') {
        notModified++;
        return route.fulfill({ status: 304, headers: { ETag: '"real-update"' } });
      }
      return route.fulfill({ json: manifest, headers: { ETag: '"real-update"' } });
    });
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
    await finalize();
  }
});
}

test('equivalent builder layouts keep the already verified cache without another database transfer', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectCatalog(page);
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
