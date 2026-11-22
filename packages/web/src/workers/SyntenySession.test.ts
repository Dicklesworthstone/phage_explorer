import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { importLocalGenomes, serializeAnalysisRecord, type PhageFull } from '@phage-explorer/core';
import { BunSqliteRepository } from '../../../db-runtime/src/bun-repository';
import { analyzeSyntenyExperiment, type SyntenyExperiment, type SyntenyExperimentInput } from '../../../comparison/src/synteny-experiment';
import { replaySavedResearch, validateResearchSnapshotContent } from '../db/research-storage';
import { readSyntenyPair, runSyntenyTask, SyntenySession, type SyntenyWorker } from './SyntenySession';
import type { SyntenyRequest, SyntenyWorkerJob, SyntenyWorkerMessage } from './synteny-worker';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const source = (name = 'alpha'): SyntenyExperimentInput => ({
  query: { id: 1, name: 'Query', accession: 'Q', length: 20, source: 'local', contentId: 'Q', annotationMetadata: null },
  reference: { id: 2, name: 'Reference', accession: 'R', length: 20, source: 'local', contentId: 'R', annotationMetadata: null },
  genesQuery: [{ id: 1, name, locusTag: null, product: null, startPos: 0, endPos: 10, strand: '+', type: 'CDS' }],
  genesReference: [{ id: 1, name: 'alpha', locusTag: null, product: null, startPos: 0, endPos: 10, strand: '+', type: 'CDS' }],
});
class ControlledWorker implements SyntenyWorker {
  onmessage: ((event: MessageEvent<SyntenyWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: SyntenyWorkerJob | null = null;
  terminated = 0;
  postMessage(job: SyntenyWorkerJob) { this.posted = job; }
  terminate() { this.terminated++; }
  result(value: SyntenyExperiment) { this.onmessage?.({ data: { jobId: this.posted!.jobId, kind: 'result', value } } as MessageEvent<SyntenyWorkerMessage>); }
  error(message: string) { this.onmessage?.({ data: { jobId: this.posted!.jobId, kind: 'error', message } } as MessageEvent<SyntenyWorkerMessage>); }
}
async function posted(workers: ControlledWorker[], count: number) {
  for (let i = 0; i < 20 && workers.length < count; i++) await Promise.resolve();
  expect(workers).toHaveLength(count); expect(workers[count - 1].posted).not.toBeNull();
  return workers[count - 1];
}

describe('owned synteny experiments', () => {
  it('replaces a source only after its own complete result and refuses queued obsolete replies', async () => {
    const workers: ControlledWorker[] = [];
    const session = new SyntenySession(() => { const worker = new ControlledWorker(); workers.push(worker); return worker; });
    const a = {}, b = {}; session.activate();
    const first = session.run(a, { kind: 'analyze', input: source() });
    const workerA = await posted(workers, 1), late = workerA.onmessage!;
    const second = session.run(b, { kind: 'analyze', input: source('beta') });
    const workerB = await posted(workers, 2);
    expect(await first).toBe(false); expect(workerA.terminated).toBe(1);
    session.cancel(a); // The old component effect must not cancel the new source's owner.
    expect(workerB.terminated).toBe(0);
    late({ data: { jobId: workerA.posted!.jobId, kind: 'result', value: await analyzeSyntenyExperiment(source()) } } as MessageEvent<SyntenyWorkerMessage>);
    expect(session.getSnapshot().accepted).toBeNull();
    workerB.result(await analyzeSyntenyExperiment(source('beta')));
    expect(await second).toBe(true);
    expect(session.getSnapshot().acceptedScope).toBe(b);
    expect(session.getSnapshot().accepted!.result.heatmap.values).toEqual([0]);
    session.deactivate();
  });

  it('keeps accepted evidence on failed or cancelled reopen and cannot start work from a late file read', async () => {
    const workers: ControlledWorker[] = [];
    const session = new SyntenySession(() => { const worker = new ControlledWorker(); workers.push(worker); return worker; });
    const live = {}, saved = {}; session.activate();
    const initial = session.run(live, { kind: 'analyze', input: source() });
    const first = await posted(workers, 1), original = await analyzeSyntenyExperiment(source());
    first.result(original); expect(await initial).toBe(true);
    const controller = new AbortController();
    const rejected = replaySavedResearch(controller.signal, {
      run: () => session.run(saved, { kind: 'replay', content: '{}' }), cancel: () => session.cancel(saved),
      error: () => session.getSnapshot().error,
    });
    const failed = await posted(workers, 2); failed.error('unsupported saved method');
    await expect(rejected).rejects.toThrow('unsupported saved method');
    expect(session.getSnapshot().accepted).toBe(original);
    const file = deferred<SyntenyRequest>();
    const pending = session.run(saved, () => file.promise);
    session.cancel(saved);
    expect(await pending).toBe(false);
    file.resolve({ kind: 'replay', content: serializeAnalysisRecord(original.record) });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(workers).toHaveLength(2); expect(session.getSnapshot().accepted).toBe(original);
    session.deactivate();
    expect(await session.run(saved, { kind: 'replay', content: '{}' })).toBe(false);
    expect(workers).toHaveLength(2);
  });

  it('does not report local-library success before a verified saved experiment is accepted', async () => {
    const workers: ControlledWorker[] = [];
    const session = new SyntenySession(() => { const worker = new ControlledWorker(); workers.push(worker); return worker; });
    session.activate(); const scope = {}, experiment = await analyzeSyntenyExperiment(source());
    const content = serializeAnalysisRecord(experiment.record);
    expect(validateResearchSnapshotContent('synteny', content)).toBe(new TextEncoder().encode(content).length);
    expect(() => validateResearchSnapshotContent('phylogeny', content)).toThrow('does not match');
    const controller = new AbortController();
    const pending = replaySavedResearch(controller.signal, {
      run: () => session.run(scope, { kind: 'replay', content }), cancel: () => session.cancel(scope), error: () => session.getSnapshot().error,
    });
    const worker = await posted(workers, 1);
    expect(session.getSnapshot().accepted).toBeNull();
    worker.result(experiment); await pending;
    expect(session.getSnapshot()).toMatchObject({ accepted: experiment, acceptedScope: scope, verified: true, busy: false });
    session.deactivate();
  });

  it('settles input timeouts without creating a worker', async () => {
    const workers: ControlledWorker[] = [];
    const session = new SyntenySession(() => { const worker = new ControlledWorker(); workers.push(worker); return worker; }, 1000, 5);
    session.activate(); const input = deferred<SyntenyRequest>();
    expect(await session.run({}, () => input.promise)).toBe(false);
    expect(session.getSnapshot().error).toContain('source read timed out');
    expect(workers).toHaveLength(0);
    input.resolve({ kind: 'analyze', input: source() });
    await Promise.resolve();
    expect(workers).toHaveLength(0);
    session.deactivate();
  });
});

async function phages(): Promise<[PhageFull, PhageFull]> {
  const imported = await importLocalGenomes({ name: 'annotations.fa', text: '>Query\n' + 'ACGT'.repeat(25) + '\n>Reference\n' + 'ACGT'.repeat(25) });
  return imported.genomes.map((genome, index) => ({ ...genome.phage, id: index + 1,
    genes: source().genesQuery.map(gene => ({ ...gene, id: 1 })) })) as [PhageFull, PhageFull];
}
describe('exact repository annotation capture', () => {
  it('clones both annotation sets before asynchronous reference metadata resolves', async () => {
    const [querySource, referenceSource] = await phages();
    const { localGenome: _queryLocal, ...query } = querySource, { localGenome: _referenceLocal, ...reference } = referenceSource;
    const metadata = deferred<Record<string, unknown>>(), asked = deferred<void>();
    const repository = {
      getPhageById: async (id: number) => id === query.id ? query : reference,
      getAnnotationMeta: () => { asked.resolve(undefined); return metadata.promise; },
    };
    const pending = readSyntenyPair(repository, query, reference.id, new AbortController().signal);
    await asked.promise;
    query.genes[0].name = 'mutated during metadata read';
    metadata.resolve({ version: 'known-release' });
    const result = await pending;
    expect(result.genesQuery[0].name).toBe('alpha');
    expect(result.query.annotationMetadata).toEqual({ version: 'known-release' });
    expect(result.query.source).toBe('catalog');
  });

  it('refuses changed identities, incomplete annotations and late cancelled reads', async () => {
    const [query, reference] = await phages();
    const controller = new AbortController();
    await expect(readSyntenyPair({ getPhageById: async () => reference }, query, reference.id, controller.signal)).rejects.toThrow('selected sources');
    await expect(readSyntenyPair({ getPhageById: async id => id === query.id ? query : { ...reference, genes: [] } },
      query, reference.id, controller.signal)).rejects.toThrow('Both phages need gene annotations');
    const read = deferred<PhageFull | null>();
    const pending = readSyntenyPair({ getPhageById: () => read.promise }, query, reference.id, controller.signal);
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    read.resolve(query);
    await Promise.resolve();
  });

  it('exports a real catalog comparison and replays without the repository or any genome bases', async () => {
    const repository = new BunSqliteRepository(fileURLToPath(new URL('../../public/phage.db', import.meta.url)), { readonly: true });
    let experiment: SyntenyExperiment;
    try {
      const catalog = await repository.listPhages();
      const queryInfo = catalog.find(phage => /lambda/i.test(phage.name)), referenceInfo = catalog.find(phage => /P22/i.test(phage.name));
      expect(queryInfo).toBeDefined(); expect(referenceInfo).toBeDefined();
      const query = await repository.getPhageById(queryInfo!.id);
      const input = await readSyntenyPair(repository, query!, referenceInfo!.id, new AbortController().signal);
      experiment = await runSyntenyTask({ kind: 'analyze', input });
      expect(experiment.input.genesQuery.length).toBeGreaterThan(0);
      expect(experiment.input.genesReference.length).toBeGreaterThan(0);
      expect(experiment.result.heatmap.values).toHaveLength(input.genesQuery.length * input.genesReference.length);
    } finally { await repository.close(); }
    const restored = await runSyntenyTask({ kind: 'replay', content: serializeAnalysisRecord(experiment!.record) });
    expect(restored.record.resultId).toBe(experiment!.record.resultId);
    expect(restored.input).toEqual(experiment!.input);
    expect(restored.result).toEqual(experiment!.result);
  }, 30000);
});
