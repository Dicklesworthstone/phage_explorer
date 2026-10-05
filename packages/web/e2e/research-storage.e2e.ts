/** Native IndexedDB contract tests. Serve only the transpiled production storage module;
 * these establish browser storage behavior, not React rendering or scientific validity.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { ResearchStorage } from '../src/db/research-storage';

declare global { interface Window { ResearchStorage: typeof ResearchStorage } }
const source = ts.transpileModule(readFileSync(new URL('../src/db/research-storage.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const payload = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1,
  inputs: [{ name: 'private.fa', text: '>private\nACGTNNACGT' }] });
async function loadStorage(page: Page) {
  await page.route('**/__research_storage_contract__/index.html', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><script type="module">import {ResearchStorage} from "./storage.js"; window.ResearchStorage=ResearchStorage;</script>' }));
  await page.route('**/__research_storage_contract__/storage.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
  await page.goto('/__research_storage_contract__/index.html');
  await page.waitForFunction(() => !!window.ResearchStorage);
}

test.describe('Private research snapshots: native transactions', () => {
  test('survives reload with exact bytes and metadata-only listing', async ({ page }) => {
    await loadStorage(page);
    const id = await page.evaluate(async content => (await new window.ResearchStorage().save('genomes', 'Reload test', content)).id, payload);
    await page.reload(); await page.waitForFunction(() => !!window.ResearchStorage);
    const result = await page.evaluate(async id => ({ saved: await new window.ResearchStorage().read(id, 'genomes'),
      list: await new window.ResearchStorage().list() }), id);
    expect(result.saved.content).toBe(payload);
    expect(result.list).toHaveLength(1);
    expect(result.list[0]).not.toHaveProperty('content');
  });
  test('independent tabs retain same-name revisions and notify without transmitting private data', async ({ page, context }) => {
    await loadStorage(page); const other = await context.newPage(); await loadStorage(other);
    await other.evaluate(() => {
      const events: unknown[] = []; (window as unknown as { changeEvents: unknown[] }).changeEvents = events;
      const channel = new BroadcastChannel('phage-explorer-private-research');
      channel.onmessage = event => events.push(event.data);
    });
    const [a, b] = await Promise.all([
      page.evaluate(async content => new window.ResearchStorage().save('genomes', 'Same', content), payload),
      other.evaluate(async content => new window.ResearchStorage().save('genomes', 'Same', content), payload),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(await page.evaluate(async () => (await new window.ResearchStorage().list()).length)).toBe(2);
    await expect.poll(() => other.evaluate(() => (window as unknown as { changeEvents: unknown[] }).changeEvents.length)).toBeGreaterThan(0);
    expect(await other.evaluate(() => (window as unknown as { changeEvents: unknown[] }).changeEvents.every(event => event === 'changed'))).toBe(true);
  });
  test('cancellation after a native write request succeeds rolls back both stores', async ({ page }) => {
    await loadStorage(page);
    const result = await page.evaluate(async content => {
      const store = new window.ResearchStorage(); const original = await store.save('genomes', 'Original', content);
      const controller = new AbortController(), add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(value: unknown, key?: IDBValidKey) {
        const request = add.call(this, value, key);
        if (this.name === 'contents') request.addEventListener('success', () => controller.abort(), { once: true });
        return request;
      };
      let error = '';
      try { await store.save('genomes', 'Cancelled', content, controller.signal); }
      catch (cause) { error = (cause as Error).name; }
      finally { IDBObjectStore.prototype.add = add; }
      return { error, ids: (await store.list()).map(item => item.id), original: original.id };
    }, payload);
    expect(result.error).toBe('AbortError'); expect(result.ids).toEqual([result.original]);
  });
  test('an injected payload failure aborts the actual transaction without losing the previous save', async ({ page }) => {
    await loadStorage(page);
    const result = await page.evaluate(async content => {
      const store = new window.ResearchStorage(); const original = await store.save('genomes', 'Original', content);
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(value: unknown, key?: IDBValidKey) {
        if (this.name === 'contents') throw new DOMException('Injected quota failure', 'QuotaExceededError');
        return add.call(this, value, key);
      };
      let error = '';
      try { await store.save('genomes', 'Failed', content); } catch (cause) { error = (cause as Error).name; }
      finally { IDBObjectStore.prototype.add = add; }
      return { error, count: (await store.list()).length, text: (await store.read(original.id, 'genomes')).content };
    }, payload);
    expect(result).toEqual({ error: 'QuotaExceededError', count: 1, text: payload });
  });
  test('simultaneous writers cannot bypass the entry cap', async ({ page }) => {
    await loadStorage(page);
    const result = await page.evaluate(async content => {
      const store = new window.ResearchStorage();
      for (let i = 0; i < 63; i++) await store.save('genomes', `Item ${i}`, content);
      const saves = await Promise.allSettled([store.save('genomes', 'Last A', content), new window.ResearchStorage().save('genomes', 'Last B', content)]);
      return { count: (await store.list()).length, success: saves.filter(item => item.status === 'fulfilled').length };
    }, payload);
    expect(result).toEqual({ count: 64, success: 1 });
  });
  test('damaged stored bytes and wrong panel cannot be opened; explicit deletion affects only one ID', async ({ page }) => {
    await loadStorage(page);
    const result = await page.evaluate(async content => {
      const store = new window.ResearchStorage();
      const a = await store.save('genomes', 'A', content), b = await store.save('genomes', 'B', content);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('phage-explorer-private-research', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('contents', 'readwrite');
          tx.objectStore('contents').put({ id: a.id, content: content.replace('ACGTNN', 'TCGTNN') });
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
      const failures: string[] = [];
      for (const [id, kind] of [[a.id, 'genomes'], [b.id, 'pangenome']] as const) {
        try { await store.read(id, kind); } catch (cause) { failures.push((cause as Error).message); }
      }
      await store.remove(a.id, 'genomes');
      return { failures, ids: (await store.list()).map(item => item.id), b: b.id, text: (await store.read(b.id, 'genomes')).content };
    }, payload);
    expect(result.failures[0]).toContain('checksum'); expect(result.failures[1]).toContain('another panel');
    expect(result.ids).toEqual([result.b]); expect(result.text).toBe(payload);
  });
});
