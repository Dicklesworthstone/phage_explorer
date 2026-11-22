import { describe, expect, test } from 'bun:test';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { createCompatibilityExperiment, type CompatibilityInput } from '../../../core/src/analysis/alignment-compatibility';
import {
  AlignmentCompatibilitySession, executeCompatibilityRequest, readCompatibilityFile,
  type AlignmentCompatibilityWorker, type AlignmentCompatibilityRequest, type AlignmentCompatibilityWork,
} from './AlignmentCompatibilitySession';

const fixture = (): CompatibilityInput => ({ format: 'phage-explorer-alignment-compatibility', version: 1, name: 'Private four-taxon fixture',
  source: { kind: 'demo', reference: 'Hand-counted, not biological data', version: '1', license: 'CC0' },
  alignment: { fasta: '>a\nAA\n>b\nAG\n>c\nGA\n>d\nGG\n', homologous: true, method: 'Constructed columns', reference: 'Fixture declaration' } });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
class ManualWorker implements AlignmentCompatibilityWorker {
  onmessage: AlignmentCompatibilityWorker['onmessage'] = null;
  onerror: AlignmentCompatibilityWorker['onerror'] = null;
  onmessageerror: AlignmentCompatibilityWorker['onmessageerror'] = null;
  terminated = false;
  request: AlignmentCompatibilityRequest | null = null;
  terminate = () => { this.terminated = true; };
  postMessage = (request: AlignmentCompatibilityRequest) => { this.request = request; };
  result(value: AlignmentCompatibilityWork) { this.onmessage?.({ data: { kind: 'result', value } } as MessageEvent); }
}
const work = async (): Promise<AlignmentCompatibilityWork> => ({ ...await createCompatibilityExperiment(fixture()), verified: false });
function manual() {
  const workers: ManualWorker[] = [];
  const session = new AlignmentCompatibilitySession(() => { const worker = new ManualWorker(); workers.push(worker); return worker; });
  session.activate(); return { session, workers };
}
describe('owned aligned-site work', () => {
  test('actual isolated workers calculate and freshly replay the complete experiment', async () => {
    const session = new AlignmentCompatibilitySession(() => new Worker(new URL('./alignment-compatibility.worker.ts', import.meta.url), { type: 'module' }) as unknown as AlignmentCompatibilityWorker);
    session.activate();
    try {
      expect(await session.run({ kind: 'analyze', input: fixture() })).toBe(true);
      const accepted = session.getSnapshot().accepted!;
      expect(accepted.result.pairs).toEqual([[0, 1, 1, 1, 1, 1]]);
      const content = serializeAnalysisRecord(accepted.record);
      expect(await session.run({ kind: 'replay', content })).toBe(true);
      expect(session.getSnapshot().accepted?.verified).toBe(true);
      expect(session.getSnapshot().accepted?.record.resultId).toBe(accepted.record.resultId);
      expect(await session.run({ kind: 'replay', content: content.replace(accepted.record.resultId, '0'.repeat(64)) })).toBe(false);
      expect(session.getSnapshot().accepted?.record.resultId).toBe(accepted.record.resultId);
      expect(session.getSnapshot().error).toContain('checksum');
    } finally { session.deactivate(); }
  });
  test('captures direct mutable input before subscriber callbacks can change it', async () => {
    const { session, workers } = manual(), input = fixture();
    const unsubscribe = session.subscribe(() => { input.alignment.fasta = '>changed\nAAAA'; });
    const pending = session.run({ kind: 'analyze', input }); await tick();
    expect(workers[0].request?.kind).toBe('analyze');
    expect((workers[0].request as Extract<AlignmentCompatibilityRequest, { kind: 'analyze' }>).input.alignment.fasta).toContain('>d\nGG');
    unsubscribe(); session.cancel(); expect(await pending).toBe(false);
    expect(workers[0].terminated).toBe(true);
  });
  test('new work owns publication and canceled/late results cannot replace accepted evidence', async () => {
    const { session, workers } = manual(), accepted = await work();
    const first = session.run({ kind: 'analyze', input: fixture() }); await tick(); workers[0].result(accepted);
    expect(await first).toBe(true);
    const obsolete = session.run({ kind: 'analyze', input: fixture() }); await tick();
    const late = workers[1].onmessage;
    const latest = session.run({ kind: 'analyze', input: fixture() }); await tick();
    expect(await obsolete).toBe(false); expect(workers[1].terminated).toBe(true);
    late?.({ data: { kind: 'result', value: { ...accepted, verified: true } } } as MessageEvent);
    expect(session.getSnapshot().accepted?.verified).toBe(false);
    session.deactivate(); expect(await latest).toBe(false);
    expect(session.getSnapshot().busy).toBe(false);
    expect(session.getSnapshot().accepted).toEqual(accepted);
    expect(await session.run({ kind: 'analyze', input: fixture() })).toBe(false);
  });
  test('cancel settles an uncooperative file read, forwards abort, and never launches its late worker', async () => {
    const { session, workers } = manual(); let signal: AbortSignal | undefined;
    let resolve!: (value: AlignmentCompatibilityRequest) => void;
    const pending = session.run(owned => { signal = owned; return new Promise(yes => { resolve = yes; }); });
    await tick(); session.cancel();
    expect(await pending).toBe(false); expect(signal?.aborted).toBe(true);
    resolve({ kind: 'analyze', input: fixture() }); await tick();
    expect(workers.length).toBe(0); expect(session.getSnapshot().busy).toBe(false);
  });
  test('an uncooperative input read has a deadline and releases ownership before any late resolution', async () => {
    let signal: AbortSignal | undefined, resolve!: (value: AlignmentCompatibilityRequest) => void, workers = 0;
    const session = new AlignmentCompatibilitySession(() => { workers++; return new ManualWorker(); }, 5);
    session.activate();
    expect(await session.run(owned => { signal = owned; return new Promise(yes => { resolve = yes; }); })).toBe(false);
    expect(session.getSnapshot().error).toContain('read timed out');
    expect(session.getSnapshot().busy).toBe(false); expect(signal?.aborted).toBe(true);
    resolve({ kind: 'analyze', input: fixture() }); await tick(); expect(workers).toBe(0);
    session.deactivate();
  });
  test('valid worker records still must match the exact submitted source, interval and replay mode', async () => {
    const good = await work(), differentInput = fixture(); differentInput.name = 'Another valid alignment source';
    const otherSource = { ...await createCompatibilityExperiment(differentInput), verified: false };
    const otherInterval = { ...await createCompatibilityExperiment(fixture(), { start: 0, end: 1 }), verified: false };
    const replayRequest: AlignmentCompatibilityRequest = { kind: 'replay', content: serializeAnalysisRecord(good.record) };
    const cases: Array<[AlignmentCompatibilityRequest, AlignmentCompatibilityWork]> = [
      [{ kind: 'analyze', input: fixture() }, otherSource],
      [{ kind: 'analyze', input: fixture() }, otherInterval],
      [{ kind: 'analyze', input: fixture() }, { ...good, verified: true }],
      [replayRequest, { ...otherSource, verified: true }],
      [replayRequest, good],
    ];
    for (const [request, response] of cases) {
      const { session, workers } = manual();
      const pending = session.run(request); await tick(); workers[0].result(response);
      expect(await pending).toBe(false); expect(session.getSnapshot().accepted).toBeNull();
      expect(session.getSnapshot().error).toContain('unbound'); session.deactivate();
    }
  });
  test('termination failures and malformed transport shapes settle without crashing or publishing', async () => {
    const good = await work();
    const malformed = [
      { ...good, result: { ...good.result, sites: [null] } },
      { ...good, record: { ...good.record, inputs: [null] } },
      { ...good, record: { ...good.record, fields: { compatibility: 'bad' } } },
      { ...good, result: { ...good.result, pairs: [[0, 1, 0, 0, 0, 0]] } },
      { ...good, input: { ...good.input, source: { ...good.input.source, kind: ['demo'] } } },
    ];
    for (const value of malformed) {
      const { session, workers } = manual(); const pending = session.run({ kind: 'analyze', input: fixture() }); await tick();
      workers[0].terminate = () => { throw new Error('provider cleanup failure'); };
      workers[0].result(value as unknown as AlignmentCompatibilityWork);
      expect(await pending).toBe(false); expect(session.getSnapshot().busy).toBe(false);
      expect(session.getSnapshot().error).toContain('worker response'); expect(session.getSnapshot().accepted).toBeNull();
      expect(workers[0].onmessage).toBeNull(); session.deactivate();
    }
  });
  test('file import enforces actual byte size and strict UTF-8 while preserving a source BOM', async () => {
    const controller = new AbortController();
    const bytes = new TextEncoder().encode('\uFEFF>a\nAA');
    expect(await readCompatibilityFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer }, controller.signal)).toBe('\uFEFF>a\nAA');
    await expect(readCompatibilityFile({ size: 1, arrayBuffer: async () => bytes.buffer }, controller.signal)).rejects.toThrow('size');
    await expect(readCompatibilityFile({ size: 2, arrayBuffer: async () => new Uint8Array([0xc0, 0x80]).buffer }, controller.signal)).rejects.toThrow('UTF-8');
    await expect(readCompatibilityFile({ size: 11, arrayBuffer: async () => bytes.buffer }, controller.signal, 10)).rejects.toThrow('limit');
    controller.abort(); await expect(readCompatibilityFile({ size: 1, arrayBuffer: async () => bytes.buffer }, controller.signal)).rejects.toThrow('cancelled');
  });
  test('request execution rejects unsupported kinds and incompatible saved methods', async () => {
    await expect(executeCompatibilityRequest({ kind: 'wrong' } as unknown as AlignmentCompatibilityRequest)).rejects.toThrow('Unsupported');
    const original = await work(), content = serializeAnalysisRecord(original.record).replace('aligned-dna-site-compatibility', 'different-method');
    await expect(executeCompatibilityRequest({ kind: 'replay', content })).rejects.toThrow('incompatible');
  });
});
