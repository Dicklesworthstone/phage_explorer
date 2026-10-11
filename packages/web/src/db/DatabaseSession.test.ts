import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { DatabaseSession, getDatabaseSession, type DatabaseSessionObserver, type DatabaseSessionLoaderFactory } from './DatabaseSession';
import type { DatabaseLoadProgress, PhageRepository } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 5));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function repository(sequence = 'ACGT') {
  const state = { closes: 0, calls: 0, sequence, block: null as ReturnType<typeof deferred<string>> | null,
    offlineBlock: null as ReturnType<typeof deferred<unknown>> | null };
  const access = { describe: () => ({ contentVersion: sequence }), plan: () => ({ contentVersion: sequence }),
    inspect: async () => state.offlineBlock ? state.offlineBlock.promise : { contentVersion: sequence } };
  const raw = {
    async listPhages() { assert.equal(state.closes, 0, 'query must not reach a closed SQL handle'); state.calls++; return [{ id: 1, name: sequence }]; },
    async getSequenceWindow() {
      assert.equal(state.closes, 0); state.calls++;
      const result = state.block ? await state.block.promise : state.sequence;
      assert.equal(state.closes, 0, 'an in-flight query must keep its snapshot open'); return result;
    },
    getOfflineDataset() { assert.equal(state.closes, 0); return access; },
    async close() { state.closes++; },
  } as unknown as PhageRepository;
  return { state, raw };
}
function harness() {
  const attempts: Array<{ gate: ReturnType<typeof deferred<PhageRepository>>; progress: (value: DatabaseLoadProgress) => void;
    closes: number; mode: boolean | null; url: string }> = [];
  const factory: DatabaseSessionLoaderFactory = (url, progress) => {
    const item = { gate: deferred<PhageRepository>(), progress, closes: 0, mode: null as boolean | null, url };
    attempts.push(item);
    let accepted: PhageRepository | null = null, closed = false;
    return {
      async load({ forceDownload }) {
        item.mode = forceDownload;
        const value = await item.gate.promise;
        // Same ownership contract as ProgressiveDatabaseLoader: late-created
        // repositories belong to the loader even after a caller cancels.
        if (closed) await value.close(); else accepted = value;
        return value;
      },
      async close() { assert.equal(item.closes++, 0, 'loader cleanup is idempotent'); closed = true; await accepted?.close(); },
    };
  };
  const session = new DatabaseSession('/phage.db', factory, 0);
  function attach() {
    const observer = session.createObserver(); let notifications = 0;
    const unsubscribe = observer.subscribe(() => { notifications++; });
    return { observer, unsubscribe, notifications: () => notifications };
  }
  async function accept(index: number, sequence = 'ACGT', cached = false) {
    const value = repository(sequence);
    attempts[index].progress({ stage: 'ready', percent: 100, message: sequence, cached, cacheStatus: 'saved' });
    attempts[index].gate.resolve(value.raw); await tick();
    return value;
  }
  return { attempts, session, attach, accept, factory };
}
function commit(session: DatabaseSession, ...observers: DatabaseSessionObserver[]) {
  for (const observer of observers) observer.commit(session.getSnapshot().repository);
}

describe('shared database ownership', () => {
  test('two readers share one load, progress and repository; one leaving cannot close the other', async () => {
    const h = harness(), a = h.attach(), b = h.attach();
    const first = h.session.load(), second = h.session.load(); assert.equal(first, second);
    await tick(); assert.equal(h.attempts.length, 1);
    h.attempts[0].progress({ stage: 'downloading', percent: 40, message: 'bytes' });
    assert.equal(a.observer.getSnapshot(), b.observer.getSnapshot());
    const db = await h.accept(0, 'AAAA', true); await first;
    commit(h.session, a.observer, b.observer);
    assert.equal(h.session.getSnapshot().isCached, true);
    a.unsubscribe(); await turn(); assert.equal(db.state.closes, 0);
    assert.equal((await b.observer.getSnapshot().repository!.listPhages())[0].name, 'AAAA');
    b.unsubscribe(); await turn(); assert.equal(db.state.closes, 1);
    assert.equal(h.session.getSnapshot().repository, null);
  });
  test('StrictMode cleanup and immediate setup preserve the pending load', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
    a.unsubscribe(); const stop = a.observer.subscribe(() => {});
    const same = h.session.load(); assert.equal(loading, same);
    const db = await h.accept(0); await loading; commit(h.session, a.observer); await turn();
    assert.equal(h.attempts.length, 1); assert.equal(db.state.closes, 0);
    stop(); await turn(); assert.equal(db.state.closes, 1);
  });
  test('StrictMode reattachment preserves a ready database without a download', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
    const db = await h.accept(0); await loading; commit(h.session, a.observer);
    const before = h.session.getSnapshot().repository;
    a.unsubscribe(); const stop = a.observer.subscribe(() => {}); await h.session.load(); await turn();
    assert.equal(h.session.getSnapshot().repository, before); assert.equal(db.state.closes, 0);
    stop(); await turn();
  });
  test('a genuine remount gets a new open database, never a cached closed instance', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
    const old = await h.accept(0, 'AAAA'); await loading; commit(h.session, a.observer);
    const oldSnapshot = h.session.getSnapshot().repository!;
    a.unsubscribe(); await turn(); assert.equal(old.state.closes, 1);
    const b = h.attach(); assert.equal(b.observer.getSnapshot().repository, null);
    const reloading = h.session.load(); await tick(); const current = await h.accept(1, 'CCCC', true); await reloading;
    assert.notEqual(h.session.getSnapshot().repository, oldSnapshot);
    assert.equal(await h.session.getSnapshot().repository!.getSequenceWindow(1, 0, 4), 'CCCC');
    b.unsubscribe(); await turn(); assert.equal(current.state.closes, 1);
  });
  test('borrowed close cannot shut down another reader or a composed local repository', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
    const db = await h.accept(0); await loading; await h.session.getSnapshot().repository!.close();
    assert.equal(db.state.closes, 0); await h.session.getSnapshot().repository!.listPhages();
    a.unsubscribe(); await turn(); assert.equal(db.state.closes, 1);
  });
  test('sessions are shared only within the same explicit owner and dataset URL', () => {
    const h = harness(), owner = {}, other = {};
    assert.equal(getDatabaseSession(owner, '/a', h.factory), getDatabaseSession(owner, '/a', h.factory));
    assert.notEqual(getDatabaseSession(owner, '/a', h.factory), getDatabaseSession(owner, '/b', h.factory));
    assert.notEqual(getDatabaseSession(owner, '/a', h.factory), getDatabaseSession(other, '/a', h.factory));
    assert.equal(h.attempts.length, 0, 'render-only lookups open no database');
  });
  test('disabled observers do not load data until explicitly asked', async () => {
    const h = harness(), a = h.attach(); await turn(); assert.equal(h.attempts.length, 0);
    assert.equal(h.session.getSnapshot().isFetching, false);
    const loading = h.session.load(); await tick(); await h.accept(0); await loading;
    a.unsubscribe(); await turn();
  });
});

describe('verified refresh and reader leases', () => {
  test('replacement stays open alongside the old snapshot until each reader commits the replacement', async () => {
    const h = harness(), a = h.attach(), b = h.attach();
    const loading = h.session.load(); await tick(); const old = await h.accept(0, 'AAAA', true); await loading;
    commit(h.session, a.observer, b.observer); const previous = h.session.getSnapshot().repository!;
    const refresh = h.session.reload(); await tick();
    assert.equal(h.session.getSnapshot().repository, previous); assert.equal(h.session.getSnapshot().isCached, true);
    const next = await h.accept(1, 'TTTT'); await refresh;
    assert.equal(await previous.getSequenceWindow(1, 0, 4), 'AAAA'); assert.equal(old.state.closes, 0);
    commit(h.session, a.observer); await tick(); assert.equal(old.state.closes, 0);
    commit(h.session, b.observer); await tick(); assert.equal(old.state.closes, 1);
    await assert.rejects(previous.listPhages(), { name: 'AbortError' });
    assert.equal(await h.session.getSnapshot().repository!.getSequenceWindow(1, 0, 4), 'TTTT');
    a.unsubscribe(); b.unsubscribe(); await turn(); assert.equal(next.state.closes, 1);
  });
  test('in-flight sequence reads finish against the original immutable snapshot', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
    const old = await h.accept(0, 'AAAA'); await loading; commit(h.session, a.observer);
    old.state.block = deferred<string>(); const read = h.session.getSnapshot().repository!.getSequenceWindow(1, 0, 4);
    const refresh = h.session.reload(); await tick(); await h.accept(1, 'GGGG'); await refresh; commit(h.session, a.observer);
    assert.equal(old.state.closes, 0);
    old.state.block.resolve('AAAA'); assert.equal(await read, 'AAAA'); await tick(); assert.equal(old.state.closes, 1);
    a.unsubscribe(); await turn();
  });
  test('nested offline verification also retains its original snapshot while running', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
    const old = await h.accept(0); await loading; commit(h.session, a.observer);
    old.state.offlineBlock = deferred<unknown>();
    const access = h.session.getSnapshot().repository!.getOfflineDataset!()!;
    assert.equal(access, h.session.getSnapshot().repository!.getOfflineDataset!());
    const check = access.inspect({ genomeIds: [], atlasModels: [] });
    const refresh = h.session.reload(); await tick(); await h.accept(1); await refresh; commit(h.session, a.observer);
    assert.equal(old.state.closes, 0); old.state.offlineBlock.resolve({ ready: true }); await check; await tick();
    assert.equal(old.state.closes, 1);
    await assert.rejects(access.inspect({ genomeIds: [], atlasModels: [] }), { name: 'AbortError' });
    a.unsubscribe(); await turn();
  });
  test('failed forced refresh retries in forced mode and preserves the previous usable dataset', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
    const old = await h.accept(0, 'AAAA', true); await loading; commit(h.session, a.observer);
    const before = h.session.getSnapshot().repository;
    const refresh = h.session.reload(), rejected = assert.rejects(refresh, /checksum/); await tick();
    h.attempts[1].gate.reject(new Error('checksum')); await turn();
    assert.equal(h.attempts[2].mode, true); h.attempts[2].gate.reject(new Error('checksum')); await rejected;
    assert.deepEqual(h.attempts.map(item => item.mode), [false, true, true]);
    assert.equal(h.session.getSnapshot().repository, before); assert.equal(old.state.closes, 0);
    assert.equal(h.session.getSnapshot().progress?.updateStatus, 'failed'); assert.equal(h.session.getSnapshot().isCached, true);
    assert.equal(h.session.getSnapshot().isFetching, false); await before!.listPhages();
    const recovery = h.session.reload(); await tick(); await h.accept(3, 'CCCC'); await recovery; commit(h.session, a.observer);
    assert.equal(h.session.getSnapshot().error, null); assert.equal(h.session.getSnapshot().progress?.updateStatus, undefined);
    a.unsubscribe(); await turn();
  });
  test('all concurrent refresh callers await the same replacement without cancelling each other', async () => {
    const h = harness(), a = h.attach(); const first = h.session.reload(), second = h.session.reload(), initial = h.session.load();
    assert.equal(first, second); assert.equal(first, initial); await tick(); await h.accept(0); await first;
    assert.equal(h.attempts.length, 1); assert.equal(h.attempts[0].mode, true); a.unsubscribe(); await turn();
  });
  test('forced refresh supersedes an initial load and a late old completion cannot win', async () => {
    const h = harness(), a = h.attach(); const initial = h.session.load(); const rejected = assert.rejects(initial, { name: 'AbortError' }); await tick();
    const refresh = h.session.reload(); await tick(); const current = await h.accept(1, 'CCCC'); await refresh; await rejected;
    const accepted = h.session.getSnapshot();
    const old = await h.accept(0, 'AAAA'); await tick();
    assert.equal(h.session.getSnapshot(), accepted); assert.equal(old.state.closes, 1); assert.equal(current.state.closes, 0);
    a.unsubscribe(); await turn();
  });
  test('late progress from a failed retry or retired loader cannot relabel accepted data', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
    h.attempts[0].gate.reject(new Error('retry')); await turn();
    h.attempts[1].progress({ stage: 'initializing', percent: 60, message: 'new attempt' });
    h.attempts[0].progress({ stage: 'error', percent: 0, message: 'obsolete' });
    assert.equal(h.session.getSnapshot().progress?.message, 'new attempt');
    await h.accept(1); await loading; const accepted = h.session.getSnapshot();
    h.attempts[0].progress({ stage: 'error', percent: 0, message: 'obsolete' }); assert.equal(h.session.getSnapshot(), accepted);
    const refresh = h.session.reload(); await tick(); await h.accept(2); await refresh;
    const after = h.session.getSnapshot(); h.attempts[1].progress({ stage: 'error', percent: 0, message: 'retired' });
    assert.equal(h.session.getSnapshot(), after); a.unsubscribe(); await turn();
  });
  test('the accepted loader can still report delayed persistence or background-update status', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick(); await h.accept(0); await loading;
    h.attempts[0].progress({ stage: 'ready', percent: 100, message: 'disk full', cacheStatus: 'unavailable' });
    assert.equal(h.session.getSnapshot().progress?.cacheStatus, 'unavailable'); a.unsubscribe(); await turn();
  });
});

describe('cancellation and failure cleanup', () => {
  test('last reader leaving settles a stalled initial load and releases a late-created handle', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(), rejected = assert.rejects(loading, { name: 'AbortError' }); await tick();
    a.unsubscribe(); await turn(); await rejected; assert.equal(h.attempts[0].closes, 1);
    const late = await h.accept(0); assert.equal(late.state.closes, 1); assert.equal(h.session.getSnapshot().repository, null);
  });
  test('unmount while retry waits cancels retry instead of opening an unobserved database', async () => {
    const h = harness(); const session = new DatabaseSession('/db', h.factory, 1000), observer = session.createObserver();
    const unsubscribe = observer.subscribe(() => {}), loading = session.load(), rejected = assert.rejects(loading, { name: 'AbortError' }); await tick();
    h.attempts[0].gate.reject(new Error('transport')); await tick(); unsubscribe(); await turn(); await rejected;
    assert.equal(h.attempts.length, 1); assert.equal(session.getSnapshot().isFetching, false);
  });
  test('initial errors propagate from load and leave no accepted repository', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(), rejected = assert.rejects(loading, /missing/); await tick();
    h.attempts[0].gate.reject(new Error('missing')); await turn(); h.attempts[1].gate.reject(new Error('missing')); await rejected;
    assert.equal(h.session.getSnapshot().repository, null); assert.equal(h.session.getSnapshot().error, 'missing');
    assert.equal(h.session.getSnapshot().isLoading, false); assert.deepEqual(h.attempts.map(item => item.closes), [1, 1]);
    a.unsubscribe(); await turn();
  });
  test('in-flight query can finish after the last observer leaves, then its handle closes', async () => {
    const h = harness(), a = h.attach(); const loading = h.session.load(); await tick(); const db = await h.accept(0); await loading;
    db.state.block = deferred<string>(); const read = h.session.getSnapshot().repository!.getSequenceWindow(1, 0, 4);
    a.unsubscribe(); await turn(); assert.equal(db.state.closes, 0);
    db.state.block.resolve('ACGT'); await read; await tick(); assert.equal(db.state.closes, 1);
  });
  test('unsubscribe is idempotent and inactive commands cannot start a loader', async () => {
    const h = harness(), a = h.attach(); a.unsubscribe(); a.unsubscribe(); await turn();
    await assert.rejects(h.session.load(), { name: 'AbortError' }); await assert.rejects(h.session.reload(), { name: 'AbortError' });
    assert.equal(h.attempts.length, 0);
  });
  test('synchronous factory errors are retried and surfaced without a stuck spinner', async () => {
    let calls = 0; const session = new DatabaseSession('/db', () => { calls++; throw new Error('factory'); }, 0);
    const stop = session.createObserver().subscribe(() => {}); await assert.rejects(session.load(), /factory/);
    assert.equal(calls, 2); assert.equal(session.getSnapshot().isFetching, false); stop(); await turn();
  });
  test('a loader close failure cannot prevent another refresh from succeeding', async () => {
    const db = repository(); let count = 0;
    const session = new DatabaseSession('/db', () => ({ load: async () => { if (!count++) throw new Error('retry'); return db.raw; },
      close: async () => { throw new Error('cleanup'); } }), 0);
    const stop = session.createObserver().subscribe(() => {}); await session.load();
    assert.ok(session.getSnapshot().repository); assert.equal(count, 2); stop(); await turn();
  });
});


test('a cache-origin flag survives later progress without a cached field', async () => {
  const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
  h.attempts[0].progress({ stage: 'checking', percent: 20, message: 'verified cache', cached: true });
  h.attempts[0].progress({ stage: 'ready', percent: 100, message: 'ready' });
  h.attempts[0].gate.resolve(repository().raw); await loading;
  assert.equal(h.session.getSnapshot().isCached, true); a.unsubscribe(); await turn();
});
test('superseding work before its first microtask never starts the cancelled loader', async () => {
  const h = harness(), a = h.attach(); const initial = h.session.load(), rejected = assert.rejects(initial, { name: 'AbortError' });
  const refresh = h.session.reload(); await tick(); await rejected;
  assert.equal(h.attempts.length, 1); assert.equal(h.attempts[0].mode, true);
  await h.accept(0); await refresh; a.unsubscribe(); await turn();
});
test('rejected query calls release their lease and cannot strand retired handles', async () => {
  const h = harness(), a = h.attach(); const loading = h.session.load(); await tick();
  const db = await h.accept(0); await loading; commit(h.session, a.observer);
  db.state.block = deferred<string>(); const query = h.session.getSnapshot().repository!.getSequenceWindow(1, 0, 4);
  const rejected = assert.rejects(query, /query failed/);
  const refresh = h.session.reload(); await tick(); await h.accept(1); await refresh; commit(h.session, a.observer);
  db.state.block.reject(new Error('query failed')); await rejected; await tick(); assert.equal(db.state.closes, 1);
  a.unsubscribe(); await turn();
});


test('optional neighbor warming fails quietly while direct missing-genome reads still reject', async () => {
  const raw = repository().raw;
  raw.prefetchAround = async () => { throw new Error('uncached neighbor is offline'); };
  raw.getPhageById = async () => { throw new Error('requested genome is offline'); };
  const session = new DatabaseSession('/db', () => ({ load: async () => raw, close: () => raw.close() }), 0);
  const stop = session.createObserver().subscribe(() => {}); await session.load();
  const borrowed = session.getSnapshot().repository!;
  await borrowed.prefetchAround(0, 2); await borrowed.listPhages();
  await assert.rejects(borrowed.getPhageById(99), /requested genome is offline/);
  stop(); await turn(); await borrowed.prefetchAround(0, 2);
  await assert.rejects(borrowed.listPhages(), { name: 'AbortError' });
});
test('a subscriber joining a refresh synchronously gets the real completion promise', async () => {
  const h = harness(); let joined: Promise<void> | undefined;
  const stop = h.session.createObserver().subscribe(() => {
    if (h.session.getSnapshot().isFetching && !joined) joined = h.session.reload();
  });
  const refresh = h.session.reload(); assert.equal(joined, refresh);
  await tick(); let settled = false; void joined!.then(() => { settled = true; });
  await tick(); assert.equal(settled, false); await h.accept(0); await refresh;
  assert.equal(settled, true); stop(); await turn();
});


test('a stalled cleanup cannot strand an initial error or its bounded retry', async () => {
  let attempts = 0, closes = 0;
  const session = new DatabaseSession('/db', () => ({
    load: async () => { attempts++; throw new Error('load failed'); },
    close: () => { closes++; return new Promise<void>(() => {}); },
  }), 0);
  const stop = session.createObserver().subscribe(() => {});
  await assert.rejects(session.load(), /load failed/);
  assert.equal(attempts, 2); assert.equal(closes, 2); assert.equal(session.getSnapshot().isFetching, false);
  stop(); await turn();
});
test('a reader resubscribing during notification is not notified twice for the same publication', async () => {
  const h = harness(), observer = h.session.createObserver(); let calls = 0;
  let stop = () => {};
  const notify = () => { calls++; if (calls === 1) { stop(); stop = observer.subscribe(notify); } };
  stop = observer.subscribe(notify);
  const loading = h.session.load(); assert.equal(calls, 1);
  await tick(); await h.accept(0); await loading;
  stop(); await turn();
});
