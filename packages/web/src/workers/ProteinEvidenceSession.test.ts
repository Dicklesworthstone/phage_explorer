import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import snapshot from '../../../../data/protein-references/lambda-lamb-v1.json';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { parseProteinReferenceBundle } from '../../../core/src/protein-reference';
import { type ProteinStructureOptions } from '../../../core/src/analysis/tail-fiber-structure';
import {
  ProteinEvidenceSession, executeProteinEvidenceRequest, readProteinEvidenceFile,
  type ProteinEvidenceWorker, type ProteinEvidenceRequest, type ProteinEvidenceMessage, type ProteinEvidenceOrigin,
} from './ProteinEvidenceSession';

const origin: ProteinEvidenceOrigin = { kind: 'reference-file', name: 'exact-reference.json' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function request(options: ProteinStructureOptions = {}): Promise<ProteinEvidenceRequest> {
  return { kind: 'analyze', reference: await parseProteinReferenceBundle(snapshot), options };
}
class WorkerProbe implements ProteinEvidenceWorker {
  onmessage: ProteinEvidenceWorker['onmessage'] = null;
  onerror: ProteinEvidenceWorker['onerror'] = null;
  onmessageerror: ProteinEvidenceWorker['onmessageerror'] = null;
  requests: ProteinEvidenceRequest[] = [];
  terminated = 0;
  postMessage(value: ProteinEvidenceRequest) { this.requests.push(value); }
  terminate() { this.terminated++; }
  emit(message: ProteinEvidenceMessage) { this.onmessage?.({ data: message } as MessageEvent<ProteinEvidenceMessage>); }
}
function workspace() {
  const workers: WorkerProbe[] = [], scope = { repository: {}, phage: { id: 1 }, selectedGeneId: 42 };
  const session = new ProteinEvidenceSession(() => { const worker = new WorkerProbe(); workers.push(worker); return worker; });
  session.activate(); session.setScope(scope); return { workers, session, scope };
}

describe('protein evidence worker operations', () => {
  it('loads the exact portable reference without running geometry', async () => {
    const result = await executeProteinEvidenceRequest({ kind: 'inspect', content: JSON.stringify(snapshot) });
    assert.equal(result.kind, 'reference');
    if (result.kind !== 'reference') throw new Error('Expected reference');
    assert.deepEqual(result.reference, snapshot);
    assert.equal('experiment' in result, false);
  });
  it('computes all real residues and verifies numerical replay with preserved source identity', async () => {
    const first = await executeProteinEvidenceRequest(await request({ contactCutoffAngstrom: 15 }));
    assert.equal(first.kind, 'experiment');
    if (first.kind !== 'experiment') throw new Error('Expected experiment');
    assert.equal(first.experiment.result.protein.length, 1132);
    assert.equal(first.experiment.result.coverage.coordinateResidues, 420);
    assert.equal(first.experiment.result.coverage.interchainContacts, 1);
    assert.equal(first.experiment.result.residues[33].alignment!.entropyBits, null);
    const replay = await executeProteinEvidenceRequest({ kind: 'replay', content: serializeAnalysisRecord(first.experiment.record) });
    if (replay.kind !== 'experiment') throw new Error('Expected replay');
    assert.equal(replay.verified, true);
    assert.equal(replay.experiment.record.resultId, first.experiment.record.resultId);
    assert.deepEqual(replay.experiment.reference, snapshot);
  });
  it('rejects rehashed invented geometry on the actual replay path', async () => {
    const first = await executeProteinEvidenceRequest(await request());
    if (first.kind !== 'experiment') throw new Error('Expected experiment');
    const forged = structuredClone(first.experiment.record);
    forged.fields.structure.value = { invented: true };
    const signed = await createAnalysisRecord(forged);
    await assert.rejects(executeProteinEvidenceRequest({ kind: 'replay', content: serializeAnalysisRecord(signed) }), /differ|recomput|identity/i);
  });
  it('rejects oversized and malformed UTF-8 files, including dishonest size metadata', async () => {
    await assert.rejects(readProteinEvidenceFile({ size: 600000, arrayBuffer: async () => { throw new Error('Must not read oversized input'); } }, 'reference'), /limit/);
    await assert.rejects(readProteinEvidenceFile({ size: 2, arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }, 'reference'));
    await assert.rejects(readProteinEvidenceFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(600000) }, 'reference'), /limit/);
    const source = JSON.stringify(snapshot);
    const file = { size: source.length, arrayBuffer: async () => new TextEncoder().encode('\uFEFF' + source).buffer };
    assert.equal(await readProteinEvidenceFile(file, 'reference'), source);
  });
});

describe('owned protein evidence sessions', () => {
  it('cancels a pending file read before a worker can start', async () => {
    const { workers, session, scope } = workspace();
    let release!: (value: ProteinEvidenceRequest) => void;
    const work = session.run(scope, () => new Promise(done => { release = done; }), origin);
    session.cancel(); assert.equal(await work, false);
    release(await request()); await tick();
    assert.equal(workers.length, 0); assert.equal(session.getSnapshot().accepted, null);
    session.deactivate();
  });
  it('discards late results after same-ID repository replacement or selected-gene changes', async () => {
    const { workers, session, scope } = workspace();
    const input = await request(), result = await executeProteinEvidenceRequest(input);
    const old = session.run(scope, input, { kind: 'current-cds', genomeAccession: 'NC_001416.1', geneId: 42, proteinAccession: 'P03749' });
    await tick(); const late = workers[0].onmessage!;
    const replacement = { repository: {}, phage: { id: 1 }, selectedGeneId: 42 };
    session.setScope(replacement); assert.equal(await old, false); assert.equal(workers[0].terminated, 1);
    late({ data: result } as MessageEvent<ProteinEvidenceMessage>);
    assert.equal(session.getSnapshot().accepted, null); assert.equal(session.getSnapshot().origin, null);
    const changed = session.run(replacement, input, origin); await tick();
    const lateGene = workers[1].onmessage!;
    session.setScope({ ...replacement, selectedGeneId: 41 }); assert.equal(await changed, false);
    lateGene({ data: result } as MessageEvent<ProteinEvidenceMessage>);
    assert.equal(session.getSnapshot().accepted, null); session.deactivate();
  });
  it('captures submitted data before yielding and refuses a valid result for different settings', async () => {
    const { workers, session, scope } = workspace();
    const input = await request(), other = await executeProteinEvidenceRequest(await request({ contactCutoffAngstrom: 15 }));
    const work = session.run(scope, input, origin);
    if (input.kind === 'analyze') input.reference.proteins[0].sequence = 'A';
    await tick();
    const sent = workers[0].requests[0];
    assert.equal(sent.kind === 'analyze' && sent.reference.proteins[0].sequence.length, 1132);
    workers[0].emit(other);
    assert.equal(await work, false);
    assert.match(session.getSnapshot().error!, /submitted|settings|identity/);
    assert.equal(session.getSnapshot().accepted, null);
    session.deactivate();
  });
  it('rejects correctly rehashed worker replies with foreign source metadata or a seed', async () => {
    const { workers, session, scope } = workspace();
    const input = await request(), result = await executeProteinEvidenceRequest(input);
    if (result.kind !== 'experiment') throw new Error('Expected experiment');
    try {
      for (const variant of ['source', 'accession', 'seed'] as const) {
        const changed = structuredClone(result);
        if (variant === 'source') changed.experiment.record.inputs[0].source = 'local';
        else if (variant === 'accession') changed.experiment.record.inputs[0].accession = 'FOREIGN-PROTEIN';
        else changed.experiment.record.seed = 123;
        changed.experiment.record = await createAnalysisRecord(changed.experiment.record);
        const pending = session.run(scope, input, origin); await tick();
        const worker = workers.at(-1)!; worker.emit(changed);
        assert.equal(await pending, false, 'Reject foreign ' + variant);
        assert.match(session.getSnapshot().error!, /submitted|source|identity/);
        assert.equal(session.getSnapshot().accepted, null);
        assert.equal(worker.terminated, 1);
      }
    } finally { session.deactivate(); }
  });
  it('terminates malformed replies and allows a successful retry with owned source labels', async () => {
    const { workers, session, scope } = workspace();
    const input = await request();
    const first = session.run(scope, input, origin); await tick();
    workers[0].emit({ kind: 'experiment', verified: false, experiment: {} } as ProteinEvidenceMessage);
    assert.equal(await first, false); assert.equal(workers[0].terminated, 1);
    const retry = session.run(scope, input, origin); await tick();
    workers[1].emit(await executeProteinEvidenceRequest(input));
    assert.equal(await retry, true, session.getSnapshot().error ?? 'No result');
    assert.deepEqual(session.getSnapshot().origin, origin);
    assert.equal(session.getSnapshot().accepted!.result.protein.accession, 'P03749');
    session.deactivate();
  });
  it('clears accepted exports after a settings scope change and ignores old operation replies', async () => {
    const { workers, session, scope } = workspace();
    const input = await request(), result = await executeProteinEvidenceRequest(input);
    const first = session.run(scope, input, origin); await tick(); workers[0].emit(result);
    assert.equal(await first, true);
    const edited = { ...scope, revision: 2 }; session.setScope(edited);
    assert.equal(session.getSnapshot().accepted, null);
    const pending = session.run(edited, input, origin); await tick();
    const late = workers[1].onmessage!;
    const replacement = session.run(edited, await request({ chainLabelAsymId: null }), origin); await tick();
    assert.equal(await pending, false);
    late({ data: result } as MessageEvent<ProteinEvidenceMessage>); assert.equal(session.getSnapshot().accepted, null);
    workers[2].emit(await executeProteinEvidenceRequest(workers[2].requests[0]));
    assert.equal(await replacement, true); assert.equal(session.getSnapshot().accepted!.result.chain, null);
    session.deactivate();
  });
});

describe('actual protein evidence worker', () => {
  it('runs reference load, computation and fresh replay in disposable workers', async () => {
    const scope = {}, session = new ProteinEvidenceSession(() => new Worker(new URL('./protein-evidence.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); session.setScope(scope);
    try {
      assert.equal(await session.run(scope, { kind: 'inspect', content: JSON.stringify(snapshot) }, origin), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().accepted, null);
      const reference = session.getSnapshot().reference!;
      assert.equal(await session.run(scope, { kind: 'analyze', reference, options: {} }, origin), true, session.getSnapshot().error ?? '');
      const first = session.getSnapshot().accepted!;
      assert.equal(first.result.coverage.intrachainContacts, 958);
      assert.equal(await session.run(scope, { kind: 'replay', content: serializeAnalysisRecord(first.record) }, { kind: 'saved-experiment', name: 'saved.json' }), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().verified, true);
      assert.equal(session.getSnapshot().accepted!.record.resultId, first.record.resultId);
    } finally { session.deactivate(); }
  }, 20000);
  it('terminates a started computation and never exposes a partial record', async () => {
    const scope = {}, session = new ProteinEvidenceSession(() => new Worker(new URL('./protein-evidence.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); session.setScope(scope); let started = false;
    const stop = session.subscribe(() => {
      if (!started && session.getSnapshot().phase.startsWith('Computing observed')) { started = true; session.cancel(); }
    });
    try {
      assert.equal(await session.run(scope, await request({ contactCutoffAngstrom: 30 }), origin), false);
      assert.equal(started, true); assert.equal(session.getSnapshot().busy, false); assert.equal(session.getSnapshot().accepted, null);
    } finally { stop(); session.deactivate(); }
  }, 20000);
});
