import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAbundanceJob, runAbundanceJob, readAbundanceFile, AbundanceWorkspace, abundanceTerminalLabel, type AbundanceJob } from './abundance';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisJson } from '../../../core/src/analysis-result';

const text = 'taxon,S1,S2,S3\nA,1,4,16\nB,16,4,1\n';
const options = { pseudocount: 0, numNiches: 1, permutations: 19, seed: 0, qvalueThreshold: 1 };
const job: AbundanceJob = { operation: 'analyze', input: { name: 'private.csv', text }, parameters: JSON.stringify(options) };
const directory = () => mkdtemp(join(tmpdir(), 'phage-abundance-workspace-'));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const localExecutor: typeof runAbundanceJob = (request, _signal, report) => executeAbundanceJob(request, report);
const virtualRead: typeof readAbundanceFile = async () => text;

describe('interactive terminal abundance workspace', () => {
  it('loads and explicitly analyzes with the submitted parameter snapshot', async () => {
    const workspace = new AbundanceWorkspace(localExecutor, virtualRead);
    await workspace.load('private.csv');
    assert.ok(workspace.getSnapshot().accepted?.dataset);
    assert.equal(workspace.getSnapshot().accepted?.record, null);
    workspace.setParameters(JSON.stringify(options));
    await workspace.analyze();
    const accepted = workspace.getSnapshot().accepted!;
    assert.equal(accepted.record?.seed, 0);
    assert.ok(Math.abs((accepted.record!.fields.associations.value as Array<Record<string, number>>)[0].correlation + 1) < 1e-12);
    workspace.deactivate();
  });
  it('unsent and invalid parameter edits cannot relabel an accepted result or its export', async () => {
    const workspace = new AbundanceWorkspace(localExecutor, virtualRead);
    await workspace.load('private.csv'); await workspace.analyze();
    const prior = workspace.getSnapshot().accepted!;
    workspace.setParameters('{"seed":7}');
    assert.equal(workspace.getSnapshot().options?.seed, 7);
    assert.strictEqual(workspace.getSnapshot().accepted, prior);
    const dir = await directory(), output = join(dir, 'old-result.json');
    await workspace.save(output, 'analysis');
    assert.equal((await parseAnalysisRecord(await readFile(output, 'utf8'))).seed, prior.record!.seed);
    for (const params of ['{', 'null', '[]', '{"seed":-1}', '{"unknown":1}']) {
      workspace.setParameters(params);
      assert.ok(workspace.getSnapshot().error);
      assert.equal(workspace.getSnapshot().options?.seed, 7);
      assert.strictEqual(workspace.getSnapshot().accepted, prior);
    }
    await workspace.analyze();
    assert.equal(workspace.getSnapshot().accepted?.record?.seed, 7);
    workspace.deactivate();
  });
  it('metadata changes join by ID, retain draft choices and invalidate only the obsolete result', async () => {
    const workspace = new AbundanceWorkspace(localExecutor, async path => path === 'meta.csv' ? 'sampleId,habitat\nS3,soil\nS1,gut\n' : text);
    await workspace.load('private.csv'); workspace.setParameters('{"seed":7}'); await workspace.analyze();
    await workspace.attachMetadata('meta.csv');
    assert.equal(workspace.getSnapshot().accepted?.record, null);
    assert.equal(workspace.getSnapshot().options?.seed, 7);
    assert.deepEqual(workspace.getSnapshot().accepted?.dataset.metadata.map(m => m.sampleId), ['S3', 'S1']);
    await workspace.analyze();
    assert.equal(workspace.getSnapshot().accepted?.record?.seed, 7);
    workspace.deactivate();
  });
  it('invalid replacement input preserves the complete accepted dataset and analysis', async () => {
    const workspace = new AbundanceWorkspace(localExecutor, async path => path === 'bad.csv' ? 'taxon,S1\nA,NA' : text);
    await workspace.load('private.csv'); await workspace.analyze();
    const prior = workspace.getSnapshot().accepted;
    await workspace.load('bad.csv');
    assert.strictEqual(workspace.getSnapshot().accepted, prior);
    assert.ok(workspace.getSnapshot().error); assert.equal(workspace.getSnapshot().busy, false);
    workspace.deactivate();
  });
  it('automatically recognizes saved browser records, recomputes and preserves exact identity', async () => {
    const original = await executeAbundanceJob(job);
    const workspace = new AbundanceWorkspace(runAbundanceJob, async () => original.content);
    await workspace.load('browser-record.json');
    assert.equal(workspace.getSnapshot().error, null);
    assert.equal(workspace.getSnapshot().accepted?.record?.resultId, original.identity);
    assert.match(workspace.getSnapshot().notice!, /Verified replay/);
    workspace.deactivate();
  });
  it('rejects a valid-checksum forged replay without replacing the accepted view', async () => {
    const original = await executeAbundanceJob(job);
    const record = await parseAnalysisRecord(original.content);
    (record.fields.associations.value as Array<Record<string, AnalysisJson>>)[0].pvalue = 0;
    const forged = serializeAnalysisRecord(await createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...input }) => input) }));
    const workspace = new AbundanceWorkspace(localExecutor, async path => path === 'forged.json' ? forged : text);
    await workspace.load('private.csv'); await workspace.analyze();
    const prior = workspace.getSnapshot().accepted;
    await workspace.load('forged.json');
    assert.strictEqual(workspace.getSnapshot().accepted, prior);
    assert.match(workspace.getSnapshot().error!, /Recomputed abundance result differs/);
    workspace.deactivate();
  });
  it('cancels a delayed read before it can start a worker', async () => {
    const file = deferred<string>(); let calls = 0;
    const workspace = new AbundanceWorkspace(async request => { calls++; return executeAbundanceJob(request); }, () => file.promise);
    const pending = workspace.load('delayed.csv');
    workspace.cancel(); file.resolve(text); await pending;
    assert.equal(calls, 0); assert.equal(workspace.getSnapshot().accepted, null);
    assert.equal(workspace.getSnapshot().busy, false); assert.match(workspace.getSnapshot().notice!, /Cancelled/);
    workspace.deactivate();
  });
  it('old read errors and finalizers cannot unlock or alter a newer load', async () => {
    const first = deferred<string>(), second = deferred<string>();
    const workspace = new AbundanceWorkspace(localExecutor, path => path === 'first.csv' ? first.promise : second.promise);
    const old = workspace.load('first.csv'), fresh = workspace.load('second.csv');
    first.reject(new Error('old failure')); await old;
    assert.equal(workspace.getSnapshot().busy, true); assert.equal(workspace.getSnapshot().error, null);
    second.resolve(text); await fresh;
    assert.equal(workspace.getSnapshot().accepted?.dataset.name, 'second.csv');
    workspace.deactivate();
  });
  it('cancelled computation cannot install its late response after a different dataset loads', async () => {
    const release = deferred<void>(), started = deferred<void>(); let signal: AbortSignal | undefined;
    const executor: typeof runAbundanceJob = async (request, currentSignal, report) => {
      const result = await executeAbundanceJob(request, report);
      if (request.operation === 'analyze') { signal = currentSignal; started.resolve(); await release.promise; }
      return result;
    };
    const workspace = new AbundanceWorkspace(executor, virtualRead);
    await workspace.load('first.csv');
    const pending = workspace.analyze(); await started.promise;
    await workspace.load('replacement.csv');
    const replacement = workspace.getSnapshot().accepted;
    assert.equal(signal?.aborted, true);
    release.resolve(); await pending;
    assert.strictEqual(workspace.getSnapshot().accepted, replacement);
    assert.equal(workspace.getSnapshot().accepted?.dataset.name, 'replacement.csv');
    assert.equal(workspace.getSnapshot().accepted?.record, null);
    workspace.deactivate();
  });
  it('deactivation prevents obsolete data installation and reactivation supports a fresh load', async () => {
    const file = deferred<string>();
    const workspace = new AbundanceWorkspace(localExecutor, path => path === 'old.csv' ? file.promise : Promise.resolve(text));
    const old = workspace.load('old.csv'); workspace.deactivate(); workspace.activate();
    await workspace.load('new.csv'); file.resolve(text); await old;
    assert.equal(workspace.getSnapshot().accepted?.dataset.name, 'new.csv');
    assert.equal(workspace.getSnapshot().busy, false);
    workspace.deactivate();
  });
  it('exports complete data to new paths, never overwrites existing files and leaves the view usable', async () => {
    const workspace = new AbundanceWorkspace(localExecutor, virtualRead);
    await workspace.load('private.csv');
    const dir = await directory(), path = join(dir, 'dataset.json');
    await workspace.save(path, 'dataset');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).table.counts, [[1, 4, 16], [16, 4, 1]]);
    const before = await readFile(path, 'utf8');
    await workspace.save(path, 'dataset');
    assert.match(workspace.getSnapshot().error!, /already exists/);
    assert.equal(await readFile(path, 'utf8'), before);
    await workspace.analyze(); assert.ok(workspace.getSnapshot().accepted?.record);
    workspace.deactivate();
  });
  it('sanitizes terminal display without changing the exact original exported labels', async () => {
    const label = '\u009b31mλ';
    const workspace = new AbundanceWorkspace(localExecutor, async () => text.replace('A,1', `${label},1`));
    await workspace.load('private.csv');
    const stored = workspace.getSnapshot().accepted!.dataset.table.taxa[0];
    assert.equal(stored, label);
    assert.equal(abundanceTerminalLabel(stored), 'λ');
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/.test(abundanceTerminalLabel('\x1b[31mA\x1b[0m\u202eB')));
    workspace.deactivate();
  });
});

it('an authorized export finishes on unmount and does not leave a reactivated workspace busy', async () => {
  const workspace = new AbundanceWorkspace(localExecutor, virtualRead);
  await workspace.load('private.csv');
  const dir = await directory(), output = join(dir, 'saved-after-unmount.json');
  const unsubscribe = workspace.subscribe(() => { if (workspace.getSnapshot().publishing) workspace.deactivate(); });
  await workspace.save(output, 'dataset'); unsubscribe();
  assert.equal(workspace.getSnapshot().busy, false);
  assert.equal(workspace.getSnapshot().publishing, false);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')).table.counts, [[1, 4, 16], [16, 4, 1]]);
  workspace.activate(); await workspace.analyze();
  assert.ok(workspace.getSnapshot().accepted?.record);
  workspace.deactivate();
});
