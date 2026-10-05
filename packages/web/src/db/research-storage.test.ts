import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ResearchStorage, RESEARCH_STORAGE_LIMITS, researchSnapshotName, validateResearchSnapshotContent } from './research-storage';

const content = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, inputs: [{ name: 'private.fa', text: '>private\nACGTNN' }] });
/** Event/rollback fixture for the production client's ownership rules, NOT an IndexedDB engine.
 * Native transactions, reloads and cross-tab behavior are covered separately in browser tests.
 */
function transactionFixture() {
  type Data = Record<string, Map<string, unknown>>;
  const data: Data = { metadata: new Map(), contents: new Map() };
  let queue = Promise.resolve();
  let failStore: string | null = null;
  let beforeCommit: (() => void) | null = null;
  let afterCommit: (() => void) | null = null;
  let opens = 0;
  let closed = 0;
  function transaction() {
    let state = 'queued', finishQueue!: () => void;
    let local: Data;
    const pending: Array<() => void> = [];
    const tx = {
      error: null as unknown, onabort: null as (() => void) | null, oncomplete: null as (() => void) | null, onerror: null as (() => void) | null,
      abort() {
        if (state === 'finished') throw new DOMException('Already finished', 'InvalidStateError');
        state = 'finished'; tx.error ??= new DOMException('Aborted', 'AbortError');
        queueMicrotask(() => { tx.onabort?.(); finishQueue?.(); });
      },
      objectStore(name: string) {
        const request = (work: () => unknown) => {
          const req = { result: undefined as unknown, onsuccess: null as (() => void) | null };
          pending.push(() => {
            try { req.result = work(); req.onsuccess?.(); }
            catch (cause) { tx.error = cause; tx.onerror?.(); tx.abort(); }
          });
          return req;
        };
        return {
          getAll: () => request(() => structuredClone([...local[name].values()])),
          get: (id: string) => request(() => structuredClone(local[name].get(id))),
          add: (value: { id: string }) => request(() => {
            if (failStore === name) { failStore = null; throw new DOMException('Disk quota failure', 'QuotaExceededError'); }
            if (local[name].has(value.id)) throw new Error('Duplicate key');
            local[name].set(value.id, structuredClone(value)); return value.id;
          }),
          delete: (id: string) => request(() => local[name].delete(id)),
        };
      },
    };
    queue = queue.then(() => new Promise<void>(resolve => {
      finishQueue = resolve;
      if (state === 'finished') { resolve(); return; }
      state = 'active'; local = structuredClone(data);
      const process = () => {
        if (state === 'finished') return;
        const next = pending.shift();
        if (next) { next(); queueMicrotask(process); return; }
        const before = beforeCommit; beforeCommit = null; before?.();
        if (state === 'finished') return;
        data.metadata = local.metadata; data.contents = local.contents; state = 'finished';
        const after = afterCommit; afterCommit = null; after?.();
        queueMicrotask(() => { tx.oncomplete?.(); resolve(); });
      };
      queueMicrotask(process);
    }));
    return tx;
  }
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() {
      opens++;
      const request = { onsuccess: null as (() => void) | null, result: { onversionchange: null, close: () => { closed++; }, transaction } };
      queueMicrotask(() => request.onsuccess?.()); return request;
    },
  } });
  return { data, store: new ResearchStorage('isolated-test'),
    failNext: (name: string) => { failStore = name; },
    before: (callback: () => void) => { beforeCommit = callback; },
    after: (callback: () => void) => { afterCommit = callback; },
    counts: () => ({ opens, closed }),
    restore: () => { if (prior) Object.defineProperty(globalThis, 'indexedDB', prior); else Reflect.deleteProperty(globalThis, 'indexedDB'); },
  };
}
async function fixture(test: (value: ReturnType<typeof transactionFixture>) => Promise<void>) {
  const value = transactionFixture(); try { await test(value); } finally { value.restore(); }
}

describe('saved research format routing', () => {
  it('accepts existing portable formats without relabeling analysis methods', () => {
    assert.equal(validateResearchSnapshotContent('genomes', content), new TextEncoder().encode(content).length);
    assert(validateResearchSnapshotContent('workflow', JSON.stringify({ format: 'phage-explorer-commands', version: 1 })) > 0);
    for (const [kind, method] of [['codon-reference', 'reference-codon-adaptation'], ['pangenome', 'alignment-pangenome']] as const) {
      assert(validateResearchSnapshotContent(kind, JSON.stringify({ format: 'phage-explorer-analysis', version: 1, method: { id: method } })) > 0);
    }
    for (const bad of ['null', '[]', '{}', '{', JSON.stringify({ format: 'phage-explorer-local-genomes', version: 2 })]) {
      assert.throws(() => validateResearchSnapshotContent('genomes', bad));
    }
    assert.throws(() => validateResearchSnapshotContent('pangenome', content), /match/);
    assert.throws(() => validateResearchSnapshotContent('codon-reference', JSON.stringify({ format: 'phage-explorer-analysis', version: 1, method: { id: 'codon-adaptation-lens' } })), /match/);
  });
  it('bounds names and UTF-8 bytes, not only JavaScript character counts', () => {
    assert.equal(researchSnapshotName('  Genome α  '), 'Genome α');
    for (const name of ['', ' ', '\u001b[31m', 'x'.repeat(121)]) assert.throws(() => researchSnapshotName(name));
    const multibyte = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, padding: '🧬'.repeat(3_000_000) });
    assert(multibyte.length < RESEARCH_STORAGE_LIMITS.snapshotBytes);
    assert.throws(() => validateResearchSnapshotContent('genomes', multibyte), /10 MiB/);
  });
});

describe('saved research client transaction ownership (event fixture)', () => {
  it('preserves exact export bytes and lists metadata without private payloads', () => fixture(async ({ store, counts }) => {
    const text = `  ${content}\n`;
    const entry = await store.save('genomes', 'Test', text);
    assert.equal((await new ResearchStorage('isolated-test').read(entry.id, 'genomes')).content, text);
    const [listed] = await store.list('genomes');
    assert.deepEqual(listed, entry); assert(!Object.hasOwn(listed, 'content'));
    assert.equal(counts().opens, counts().closed);
  }));
  it('keeps two independent same-name saves rather than last-writer-wins', () => fixture(async ({ store }) => {
    const entries = await Promise.all([store.save('genomes', 'Same', content), store.save('genomes', 'Same', content)]);
    assert.notEqual(entries[0].id, entries[1].id);
    assert.equal((await store.list()).length, 2);
  }));
  it('does not acknowledge a successful metadata write when the payload transaction aborts', () => fixture(async ({ store, data, failNext }) => {
    const original = await store.save('genomes', 'Original', content);
    failNext('contents');
    await assert.rejects(store.save('genomes', 'Failed', content), { name: 'QuotaExceededError' });
    assert.deepEqual([...data.metadata.keys()], [original.id]);
    assert.deepEqual([...data.contents.keys()], [original.id]);
    assert.equal((await store.read(original.id, 'genomes')).content, content);
  }));
  it('aborts before opening and rolls back cancellation after successful requests', () => fixture(async ({ store, before, counts, data }) => {
    const prior = new AbortController(); prior.abort();
    await assert.rejects(store.save('genomes', 'Cancelled', content, prior.signal), { name: 'AbortError' });
    assert.equal(counts().opens, 0);
    const pending = new AbortController(); before(() => pending.abort());
    await assert.rejects(store.save('genomes', 'Cancelled', content, pending.signal), { name: 'AbortError' });
    assert.equal(data.metadata.size, 0); assert.equal(data.contents.size, 0);
  }));
  it('reports an actual commit even if cancellation arrives before its completion notification', () => fixture(async ({ store, after }) => {
    const controller = new AbortController(); after(() => controller.abort());
    const committed = await store.save('genomes', 'Committed', content, controller.signal);
    assert.equal((await store.read(committed.id, 'genomes')).content, content);
  }));
  it('enforces the global snapshot cap atomically across concurrent writers without eviction', () => fixture(async ({ store }) => {
    for (let i = 0; i < 63; i++) await store.save('genomes', `Item ${i}`, content);
    const results = await Promise.allSettled([store.save('genomes', 'Last A', content), store.save('genomes', 'Last B', content)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await store.list()).length, 64);
  }));
  it('enforces the total byte cap before writing and retains earlier records', () => fixture(async ({ store, data }) => {
    const original = await store.save('genomes', 'Original', content);
    // Metadata fixture represents existing full snapshots; avoid allocating 64 MiB in this client test.
    data.metadata.set(original.id, { ...original, bytes: RESEARCH_STORAGE_LIMITS.snapshotBytes });
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID(); data.metadata.set(id, { ...original, id, bytes: RESEARCH_STORAGE_LIMITS.snapshotBytes });
    }
    const fiveMiB = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1, padding: 'A'.repeat(5 * 1024 * 1024) });
    await assert.rejects(store.save('genomes', 'Over budget', fiveMiB), /library is full/);
    assert.equal(data.metadata.size, 6); assert.equal(data.contents.size, 1);
  }));
  it('refuses wrong-panel, missing and same-length damaged contents without removing them', () => fixture(async ({ store, data }) => {
    const entry = await store.save('genomes', 'Original', content);
    await assert.rejects(store.read(entry.id, 'pangenome'), /another panel/);
    await assert.rejects(store.read(crypto.randomUUID(), 'genomes'), /missing/);
    data.contents.set(entry.id, { id: entry.id, content: content.replace('ACGTNN', 'TCGTNN') });
    await assert.rejects(store.read(entry.id, 'genomes'), /checksum/);
    assert.equal(data.metadata.size, 1); assert.equal(data.contents.size, 1);
  }));
  it('removes only an explicitly selected immutable ID and refuses wrong-panel deletion', () => fixture(async ({ store }) => {
    const a = await store.save('genomes', 'Same', content), b = await store.save('genomes', 'Same', content);
    await assert.rejects(store.remove(a.id, 'pangenome'), /another panel/);
    await store.remove(a.id, 'genomes');
    assert.deepEqual((await store.list()).map(entry => entry.id), [b.id]);
    assert.equal((await store.read(b.id, 'genomes')).content, content);
  }));
  it('isolates throwing change observers from committed saves', () => fixture(async ({ store }) => {
    let calls = 0;
    const off = store.subscribe(() => { calls++; throw new Error('Observer failed'); });
    const entry = await store.save('genomes', 'Saved', content); off();
    assert.equal(calls, 1); assert.equal((await store.read(entry.id, 'genomes')).content, content);
  }));
});
