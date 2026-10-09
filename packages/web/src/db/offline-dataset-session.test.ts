import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { OfflineDatasetSession, type OfflineDatasetAccess, type OfflineDatasetReport, type OfflineDatasetSelection,
  type SavedOfflineDataset } from './offline-dataset';

const chosen = (ids: number[] = [1]): OfflineDatasetSelection => ({ genomeIds: ids, atlasModels: [] });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const calls: string[] = [], signals: AbortSignal[] = [];
  const version = 'a'.repeat(64);
  let saved: SavedOfflineDataset | null = null;
  const plan = (selection: OfflineDatasetSelection) => ({ contentVersion: version, selection: structuredClone(selection),
    totalBytes: 512 * (selection.genomeIds.length + 1), artifactCount: selection.genomeIds.length + 1, withinBudget: selection.genomeIds.length <= 2 });
  const report = (selection: OfflineDatasetSelection, ready = true): OfflineDatasetReport => ({ ...plan(selection),
    checkedAt: '2026-01-01T00:00:00Z', catalog: 'available', genomes: selection.genomeIds.map(id => ({ id, status: ready ? 'available' : 'missing' })),
    atlases: [], verifiedBytes: ready ? plan(selection).totalBytes : 512, filesAvailable: ready, startupManifestAvailable: true, ready });
  const api: OfflineDatasetAccess = {
    describe: () => ({ contentVersion: version, catalogBytes: 512, cacheBudget: 1536, genomes: [], atlases: [] }),
    plan,
    saved: async signal => { calls.push('saved'); if (signal) signals.push(signal); return saved; },
    inspect: async (selection, signal) => { calls.push('inspect'); if (signal) signals.push(signal); return report(selection); },
    prepare: async (selection, options) => { calls.push('prepare'); if (options?.signal) signals.push(options.signal);
      saved = { contentVersion: version, selection: structuredClone(selection), totalBytes: plan(selection).totalBytes };
      return report(selection); },
    release: async signal => { calls.push('release'); if (signal) signals.push(signal); saved = null; },
  };
  const session = new OfflineDatasetSession(api); session.activate();
  return { session, api, report, calls, signals, setSaved: (value: SavedOfflineDataset | null) => { saved = value; } };
}

test('opening and choosing a draft do not inspect storage or download anything', () => {
  const h = harness(); h.session.select(chosen([2]));
  assert.deepEqual(h.calls, []); assert.equal(h.session.getSnapshot().saved, undefined);
  assert.equal(h.session.getSnapshot().report, null); assert.deepEqual(h.session.getSnapshot().plan.selection, chosen([2]));
});
test('restoring a saved selection is metadata-only and never declares readiness', async () => {
  const h = harness(); h.setSaved({ contentVersion: 'a'.repeat(64), totalBytes: 1024, selection: chosen([2]) });
  await h.session.restore(); assert.deepEqual(h.calls, ['saved']);
  assert.deepEqual(h.session.getSnapshot().plan.selection, chosen([2])); assert.equal(h.session.getSnapshot().report, null);
});
test('another generation or missing reservation cannot erase or relabel a current draft', async () => {
  const h = harness(); h.session.select(chosen([2]));
  h.setSaved({ contentVersion: 'b'.repeat(64), totalBytes: 1024, selection: null }); await h.session.restore();
  assert.deepEqual(h.session.getSnapshot().plan.selection, chosen([2]));
  assert.match(h.session.getSnapshot().notice, /another dataset/);
  h.setSaved(null); await h.session.restore(); assert.deepEqual(h.session.getSnapshot().plan.selection, chosen([2]));
});
test('late restoration cannot overwrite a newer selection', async () => {
  const h = harness(), work = deferred<SavedOfflineDataset | null>(); h.api.saved = () => work.promise;
  const pending = h.session.restore(); h.session.select(chosen([2]));
  await pending; work.resolve({ contentVersion: 'a'.repeat(64), totalBytes: 1024, selection: chosen([1]) }); await Promise.resolve();
  assert.deepEqual(h.session.getSnapshot().plan.selection, chosen([2])); assert.equal(h.session.getSnapshot().saved, undefined);
});
test('changing a checked selection invalidates the result and its readiness', async () => {
  const h = harness(); h.session.select(chosen()); await h.session.check(); assert.equal(h.session.getSnapshot().report?.ready, true);
  h.session.select(chosen([2])); assert.equal(h.session.getSnapshot().report, null);
});
test('cancelling a provider that ignores abort settles promptly and rejects late evidence', async () => {
  const h = harness(), work = deferred<OfflineDatasetReport>(); let signal: AbortSignal | undefined;
  h.api.inspect = (_selected, nextSignal) => { signal = nextSignal; return work.promise; };
  h.session.select(chosen()); const pending = h.session.check(); h.session.cancel(); await pending;
  assert.equal(signal?.aborted, true); assert.equal(h.session.getSnapshot().busy, null);
  work.resolve(h.report(chosen())); await Promise.resolve(); assert.equal(h.session.getSnapshot().report, null);
});
test('progress from a replaced preparation cannot alter the newer job', async () => {
  const h = harness(), work = deferred<OfflineDatasetReport>(); let options: Parameters<OfflineDatasetAccess['prepare']>[1];
  h.api.prepare = (_selected, nextOptions) => { options = nextOptions; return work.promise; };
  h.session.select(chosen()); const pending = h.session.prepare();
  options!.onProgress!({ phase: 'downloading', completed: 1, total: 2, completedBytes: 512, totalBytes: 1024 });
  assert.equal(h.session.getSnapshot().progress?.completedBytes, 512);
  h.session.select(chosen([2])); await h.session.check(); await pending;
  options!.onProgress!({ phase: 'verifying', completed: 2, total: 2, completedBytes: 1024, totalBytes: 1024 });
  work.resolve(h.report(chosen())); await Promise.resolve();
  assert.deepEqual(h.session.getSnapshot().report?.selection, chosen([2])); assert.equal(h.session.getSnapshot().progress, null);
});
test('successful preparation refreshes saved metadata only after verified completion', async () => {
  const h = harness(); h.session.select(chosen()); await h.session.prepare();
  assert.deepEqual(h.calls, ['prepare', 'saved']); assert.equal(h.session.getSnapshot().report?.ready, true);
  assert.deepEqual(h.session.getSnapshot().saved?.selection, chosen()); assert.equal(h.session.getSnapshot().busy, null);
});
test('a failed or incomplete preparation clears stale readiness rather than claiming success', async () => {
  const h = harness(); h.session.select(chosen()); await h.session.check();
  h.api.prepare = async selected => h.report(selected, false); await h.session.prepare();
  assert.equal(h.session.getSnapshot().report, null); assert.match(h.session.getSnapshot().error!, /did not verify/);
  h.api.prepare = async () => { throw new Error('quota denied'); }; await h.session.prepare();
  assert.match(h.session.getSnapshot().error!, /quota denied/); assert.equal(h.session.getSnapshot().busy, null);
});
test('release clears protection evidence without calling a file deletion API', async () => {
  const h = harness(); h.session.select(chosen()); await h.session.prepare(); await h.session.release();
  assert.deepEqual(h.calls, ['prepare', 'saved', 'release']); assert.equal(h.session.getSnapshot().saved, null);
  assert.equal(h.session.getSnapshot().report, null); assert.match(h.session.getSnapshot().notice, /not deleted/);
});
test('deactivation cancels release and reactivation does not accept its late completion', async () => {
  const h = harness(), work = deferred<void>(); let signal: AbortSignal | undefined;
  h.api.release = nextSignal => { signal = nextSignal; return work.promise; };
  const pending = h.session.release(); h.session.deactivate(); await pending;
  assert.equal(signal?.aborted, true); h.session.activate(); h.session.select(chosen([2])); await h.session.check();
  work.resolve(); await Promise.resolve(); assert.equal(h.session.getSnapshot().report?.ready, true);
});
test('inactive sessions cannot start I/O and preserve React external-store snapshot identity between changes', async () => {
  const h = harness(), first = h.session.getSnapshot(); assert.equal(h.session.getSnapshot(), first);
  let changes = 0; const unsubscribe = h.session.subscribe(() => { changes++; });
  h.session.select(chosen()); assert.equal(changes, 1); assert.notEqual(h.session.getSnapshot(), first);
  unsubscribe(); h.session.deactivate(); await h.session.restore(); await h.session.prepare(); await h.session.check(); await h.session.release();
  assert.deepEqual(h.calls, []); assert.equal(changes, 1);
});
test('late failures after cancellation are observed without replacing a newer success', async () => {
  const h = harness(), work = deferred<OfflineDatasetReport>();
  h.api.prepare = () => work.promise; const pending = h.session.prepare(); h.session.cancel(); await h.session.check();
  work.reject(new Error('late transport failure')); await pending; await Promise.resolve();
  assert.equal(h.session.getSnapshot().error, null); assert.equal(h.session.getSnapshot().report?.ready, true);
});
