import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { validateEpistasisAssayDataset, type EpistasisAssayDataset } from '../../../core/src/analysis/epistasis-evidence';
import {
  EpistasisEvidenceSession, executeEpistasisEvidenceRequest, readEpistasisEvidenceFile, EPISTASIS_FILE_LIMIT,
  type EpistasisEvidenceWorker, type EpistasisEvidenceRequest, type EpistasisEvidenceMessage,
} from './EpistasisEvidenceSession';

function dataset(design: 'paired' | 'independent' = 'independent'): EpistasisAssayDataset {
  return {
    format: 'phage-explorer-epistasis-assay', version: 1, name: 'Private assay arithmetic fixture',
    source: { kind: 'local', description: 'Artificial hand-checked measurements; no biological inference.', reference: 'Notebook fixture', license: 'CC0' },
    protein: { id: 'private-assay-protein', accession: 'TEST.1', sequence: 'ACDE' },
    assay: { name: 'Fixture response', units: 'response units', conditions: 'Three independent units, or three matched blocks.',
      scale: 'identity', replicateDesign: design },
    observations: [
      ...[10, 12, 14].map((value, i) => ({ variant: 'WT', replicateId: 'r' + i, value })),
      ...[8, 9, 10].map((value, i) => ({ variant: 'A1G', replicateId: 'r' + i, value })),
      ...[11, 13, 15].map((value, i) => ({ variant: 'C2T', replicateId: 'r' + i, value })),
      ...[10, 14, 18].map((value, i) => ({ variant: 'A1G:C2T', replicateId: 'r' + i, value })),
      { variant: 'A1G:D3E', replicateId: 'r0', value: 5 },
    ],
  };
}
const request = (design: 'paired' | 'independent' = 'independent'): EpistasisEvidenceRequest =>
  ({ kind: 'analyze', dataset: dataset(design), options: { bootstrapSamples: 0, seed: 0 } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('measured epistasis worker operations', () => {
  it('loads complete supplied data without inventing a result', async () => {
    const result = await executeEpistasisEvidenceRequest({ kind: 'import', content: JSON.stringify(dataset()) });
    assert.deepEqual(result.dataset, validateEpistasisAssayDataset(dataset()));
    assert.equal(result.result, null); assert.equal(result.record, null); assert.equal(result.verified, false);
  });

  it('runs the real arithmetic method and preserves unavailable groups through fresh replay', async () => {
    const first = await executeEpistasisEvidenceRequest(request());
    assert(first.result && first.record);
    assert.equal(first.result.coverage.estimatedPairs, 1); assert.equal(first.result.coverage.unavailablePairs, 1);
    const pair = first.result.pairs.find(row => row.variant === 'A1G:C2T')!;
    // Four independently specified means: 14 - 9 - 13 + 12 = 4.
    assert.equal(pair.contrast, 4);
    // Unbiased variances: 16,1,4,4; each with three independent observations.
    assert.ok(Math.abs(pair.standardError! - Math.sqrt(25 / 3)) < 1e-12);
    const incomplete = first.result.pairs.find(row => row.variant === 'A1G:D3E')!;
    assert.equal(incomplete.contrast, null); assert.deepEqual(incomplete.missingVariants, ['D3E']);
    const replay = await executeEpistasisEvidenceRequest({ kind: 'import', content: serializeAnalysisRecord(first.record) });
    assert.equal(replay.verified, true); assert.deepEqual(replay, { ...first, verified: true });
  });

  it('enforces the raw dataset byte bound independently of the larger saved-record envelope', async () => {
    const content = JSON.stringify(dataset()) + ' '.repeat(2 * 1024 * 1024);
    await assert.rejects(executeEpistasisEvidenceRequest({ kind: 'import', content }), /2 MiB/);
  });

  it('uses whole matched blocks instead of independent genotype variances when paired', async () => {
    const result = await executeEpistasisEvidenceRequest(request('paired'));
    const pair = result.result!.pairs.find(row => row.variant === 'A1G:C2T')!;
    // Block contrasts are 1,4,7: mean 4, variance 9, SE sqrt(9/3).
    assert.equal(pair.contrast, 4); assert.ok(Math.abs(pair.standardError! - Math.sqrt(3)) < 1e-12);
    assert.deepEqual(pair.completeBlocks, ['r0', 'r1', 'r2']);
  });

  it('recomputes rather than accepting a rehashed fabricated result', async () => {
    const first = await executeEpistasisEvidenceRequest(request());
    const forged = structuredClone(first.record!);
    forged.fields.result.value = { fabricated: true };
    const rehashed = await createAnalysisRecord(forged);
    await assert.rejects(executeEpistasisEvidenceRequest({ kind: 'replay', content: serializeAnalysisRecord(rehashed) }), /differs|recomput/i);
  });

  it('rejects oversized reads, malformed UTF-8 and changed input sizes before import', async () => {
    await assert.rejects(readEpistasisEvidenceFile({ size: EPISTASIS_FILE_LIMIT + 1,
      arrayBuffer: async () => { throw new Error('Must not read'); } }), /limit/);
    await assert.rejects(readEpistasisEvidenceFile({ size: 2, arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }));
    await assert.rejects(readEpistasisEvidenceFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(EPISTASIS_FILE_LIMIT + 1) }), /limit/);
    const text = JSON.stringify(dataset()), bytes = new TextEncoder().encode('\uFEFF' + text);
    assert.equal(await readEpistasisEvidenceFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer }), text);
  });
});

class WorkerProbe implements EpistasisEvidenceWorker {
  onmessage: EpistasisEvidenceWorker['onmessage'] = null;
  onerror: EpistasisEvidenceWorker['onerror'] = null;
  onmessageerror: EpistasisEvidenceWorker['onmessageerror'] = null;
  requests: EpistasisEvidenceRequest[] = [];
  terminated = 0;
  postMessage(value: EpistasisEvidenceRequest) { this.requests.push(value); }
  terminate() { this.terminated++; }
  emit(message: EpistasisEvidenceMessage) { this.onmessage?.({ data: message } as MessageEvent<EpistasisEvidenceMessage>); }
}
function workspace() {
  const workers: WorkerProbe[] = [];
  const session = new EpistasisEvidenceSession(() => { const worker = new WorkerProbe(); workers.push(worker); return worker; });
  session.activate(); return { workers, session };
}

describe('owned epistasis evidence sessions', () => {
  it('cancels a file read before it can create a worker and ignores its late completion', async () => {
    const { session, workers } = workspace();
    let release!: (value: EpistasisEvidenceRequest) => void;
    const pending = session.run(() => new Promise(resolve => { release = resolve; }));
    session.cancel(); assert.equal(await pending, false);
    release(request()); await tick();
    assert.equal(workers.length, 0); assert.equal(session.getSnapshot().accepted, null);
    session.deactivate();
  });

  it('captures submitted data and rejects a valid result from a different assay or settings', async () => {
    const { session, workers } = workspace(), input = request();
    const other = await executeEpistasisEvidenceRequest(request('paired'));
    const pending = session.run(input);
    if (input.kind === 'analyze') input.dataset.name = 'Edited after submission';
    await tick();
    assert.equal(workers[0].requests[0].kind === 'analyze' && workers[0].requests[0].dataset.name, dataset().name);
    workers[0].emit({ kind: 'result', result: other }); assert.equal(await pending, false);
    assert.match(session.getSnapshot().error!, /submitted|settings/); assert.equal(workers[0].terminated, 1);
    assert.equal(session.getSnapshot().accepted, null); session.deactivate();
  });

  it('retains accepted results after rejection, malformed messages and cancellation', async () => {
    const { session, workers } = workspace(), input = request();
    const result = await executeEpistasisEvidenceRequest(input);
    const first = session.run(input); await tick(); workers[0].emit({ kind: 'result', result });
    assert.equal(await first, true); const accepted = session.getSnapshot().accepted;
    const bad = session.run(input); await tick(); workers[1].emit({ kind: 'result', result: {} } as EpistasisEvidenceMessage);
    assert.equal(await bad, false); assert.strictEqual(session.getSnapshot().accepted, accepted);
    const pending = session.run(request('paired')); await tick(); const late = workers[2].onmessage!;
    session.cancel(); assert.equal(await pending, false); assert.equal(workers[2].terminated, 1);
    late({ data: { kind: 'result', result: await executeEpistasisEvidenceRequest(request('paired')) } } as MessageEvent<EpistasisEvidenceMessage>);
    assert.strictEqual(session.getSnapshot().accepted, accepted); session.deactivate();
  });

  it('rejects dataset-only analysis replies even when their source and options are valid', async () => {
    const { session, workers } = workspace(), input = request();
    const result = await executeEpistasisEvidenceRequest(input);
    const first = session.run(input); await tick(); workers[0].emit({ kind: 'result', result });
    assert.equal(await first, true); const accepted = session.getSnapshot().accepted;
    const { result: _result, record: _record, ...onlyDataset } = result;
    for (const malformed of [onlyDataset, { ...result, result: undefined }, { ...result, record: undefined },
      { ...result, result: null, record: null }, { ...result, result: [], record: [] }]) {
      const pending = session.run(input); await tick();
      workers.at(-1)!.emit({ kind: 'result', result: malformed } as unknown as EpistasisEvidenceMessage);
      assert.equal(await pending, false); assert.match(session.getSnapshot().error!, /analysis state/);
      assert.strictEqual(session.getSnapshot().accepted, accepted);
    }
    session.deactivate();
  });

  it('rejects worker results whose hash-valid source, seed or displayed rows are inconsistent', async () => {
    const { session, workers } = workspace(), input = request();
    const original = await executeEpistasisEvidenceRequest(input);
    for (const change of ['source', 'seed', 'display'] as const) {
      const changed = structuredClone(original);
      if (change === 'source') changed.record!.inputs[0].accession = 'FOREIGN';
      else if (change === 'seed') changed.record!.seed = 9;
      else changed.result!.pairs[0].contrast = 1234;
      if (change !== 'display') changed.record = await createAnalysisRecord(changed.record!);
      const pending = session.run(input); await tick();
      workers.at(-1)!.emit({ kind: 'result', result: changed });
      assert.equal(await pending, false, change);
      assert.equal(session.getSnapshot().accepted, null);
    }
    session.deactivate();
  });

  it('supersedes old workers and prevents post-unmount publication', async () => {
    const { session, workers } = workspace();
    const old = session.run(request()); await tick();
    const late = workers[0].onmessage!;
    const current = session.run(request('paired')); await tick();
    assert.equal(await old, false); assert.equal(workers[0].terminated, 1);
    late({ data: { kind: 'result', result: await executeEpistasisEvidenceRequest(request()) } } as MessageEvent<EpistasisEvidenceMessage>);
    assert.equal(session.getSnapshot().accepted, null);
    session.deactivate(); assert.equal(await current, false); assert.equal(workers[1].terminated, 1);
    assert.equal(session.getSnapshot().accepted, null); assert.equal(await session.run(request()), false);
  });
});

describe('actual epistasis evidence worker', () => {
  it('imports, analyzes and replays exact observations in owned workers', async () => {
    const session = new EpistasisEvidenceSession(() => new Worker(new URL('./epistasis-evidence.worker.ts', import.meta.url), { type: 'module' }));
    session.activate();
    try {
      assert.equal(await session.run({ kind: 'import', content: JSON.stringify(dataset()) }), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().accepted!.record, null);
      assert.equal(await session.run(request()), true, session.getSnapshot().error ?? '');
      const record = session.getSnapshot().accepted!.record!;
      assert.equal(await session.run({ kind: 'replay', content: serializeAnalysisRecord(record) }), true, session.getSnapshot().error ?? '');
      assert.equal(session.getSnapshot().accepted!.verified, true);
      assert.equal(session.getSnapshot().accepted!.record!.resultId, record.resultId);
    } finally { session.deactivate(); }
  }, 20000);

  it('terminates a started computation before publishing partial evidence', async () => {
    const session = new EpistasisEvidenceSession(() => new Worker(new URL('./epistasis-evidence.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); let started = false;
    const stop = session.subscribe(() => {
      if (!started && session.getSnapshot().phase?.startsWith('Computing supplied')) { started = true; session.cancel(); }
    });
    try {
      assert.equal(await session.run(request()), false); assert.equal(started, true);
      assert.equal(session.getSnapshot().accepted, null); assert.equal(session.getSnapshot().busy, false);
    } finally { stop(); session.deactivate(); }
  }, 20000);
});
