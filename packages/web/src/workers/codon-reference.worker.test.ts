import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { importLocalGenomes, referenceGenomeFromPhage, serializeAnalysisRecord, type ReferenceCodonExperiment } from '@phage-explorer/core';
import { executeCodonReferenceRequest, runCodonReferenceTask, type CodonReferenceRequest,
  type CodonReferenceResponse, type CodonReferenceWorkerPort } from './codon-reference.worker';

const source = `LOCUS       WORKER_QUERY 6 bp DNA linear
FEATURES             Location/Qualifiers
     CDS             1..6
                     /locus_tag="one"
ORIGIN
        1 aaaaag
//
`;
const referenceText = JSON.stringify({ format: 'phage-explorer-codon-reference', version: 1, name: 'Worker test counts',
  organism: 'Synthetic fixture', geneticCode: 11, source: { citation: 'Hand-counted numerical fixture', version: '1' }, counts: { AAA: 8, AAG: 2 } });
async function request(): Promise<CodonReferenceRequest> {
  const genome = (await importLocalGenomes({ name: 'worker.gb', text: source })).genomes[0];
  return { type: 'analyze', genome: referenceGenomeFromPhage(genome.phage), sequence: genome.sequence, referenceText, options: {} };
}
class Port implements CodonReferenceWorkerPort {
  onmessage: ((event: MessageEvent<CodonReferenceResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = 0;
  sent: CodonReferenceRequest | null = null;
  postMessage(value: CodonReferenceRequest) { this.sent = value; }
  terminate() { this.terminated++; }
  result(experiment: ReferenceCodonExperiment) { this.onmessage?.({ data: { type: 'result', experiment } } as MessageEvent<CodonReferenceResponse>); }
}

describe('reference-analysis worker and client boundary', () => {
  it('executes actual import-to-score-to-saved-replay requests', async () => {
    const result = await executeCodonReferenceRequest(await request());
    assert.equal(result.analysis.genes[0].cai, 0.5);
    assert.equal(result.record.inputs.find(input => input.id === 'reference')!.data, referenceText);
    const replay = await executeCodonReferenceRequest({ type: 'verify', content: serializeAnalysisRecord(result.record) });
    assert.deepEqual(replay, result);
  });
  it('rejects unsupported requests, missing references and changed saved values', async () => {
    await assert.rejects(executeCodonReferenceRequest(null as unknown as CodonReferenceRequest), /Missing/);
    await assert.rejects(executeCodonReferenceRequest({ type: 'execute' } as unknown as CodonReferenceRequest), /Unsupported/);
    const input = await request();
    if (input.type !== 'analyze') throw new Error('Expected analyze request');
    await assert.rejects(executeCodonReferenceRequest({ ...input, referenceText: '{}' }));
    const result = await executeCodonReferenceRequest(input);
    result.record.fields.summary.value = { cai: 0.9 };
    await assert.rejects(executeCodonReferenceRequest({ type: 'verify', content: serializeAnalysisRecord(result.record) }), /checksum/);
  });
  it('transports actual numerical output and terminates the successful owner', async () => {
    const port = new Port(), input = await request();
    const task = runCodonReferenceTask(() => port, input, new AbortController().signal);
    assert.deepEqual(port.sent, input);
    port.result(await executeCodonReferenceRequest(port.sent!));
    assert.equal((await task).analysis.summary.cai, 0.5);
    assert.equal(port.terminated, 1); assert.equal(port.onmessage, null);
  });
  it('does not create a worker for already cancelled work', async () => {
    const controller = new AbortController(); controller.abort(); let created = 0;
    await assert.rejects(runCodonReferenceTask(() => { created++; return new Port(); }, await request(), controller.signal), { name: 'AbortError' });
    assert.equal(created, 0);
  });
  it('aborts promptly and ignores a captured late callback without affecting a new task', async () => {
    const input = await request(), old = new Port(), next = new Port(), controller = new AbortController();
    const first = runCodonReferenceTask(() => old, input, controller.signal);
    const late = old.onmessage!;
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(old.terminated, 1);
    const second = runCodonReferenceTask(() => next, input, new AbortController().signal);
    const real = await executeCodonReferenceRequest(input);
    late({ data: { type: 'result', experiment: real } } as MessageEvent<CodonReferenceResponse>);
    assert.equal(old.terminated, 1); assert.equal(next.terminated, 0);
    next.result(real); assert.equal((await second).record.resultId, real.record.resultId);
    assert.equal(next.terminated, 1);
  });
  it('reports initialization, posting, execution, decoding and unexpected-message failures', async () => {
    const input = await request();
    await assert.rejects(runCodonReferenceTask(() => { throw new Error('disabled'); }, input, new AbortController().signal), /could not start/);
    for (const failure of ['post', 'error', 'decode', 'invalid', 'computed']) {
      const port = new Port();
      if (failure === 'post') port.postMessage = () => { throw new Error('clone failure'); };
      const task = runCodonReferenceTask(() => port, input, new AbortController().signal);
      if (failure === 'error') port.onerror!({ preventDefault() {} } as ErrorEvent);
      if (failure === 'decode') port.onmessageerror!({} as MessageEvent);
      if (failure === 'invalid') port.onmessage!({ data: { type: 'result', experiment: {} } } as MessageEvent<CodonReferenceResponse>);
      if (failure === 'computed') port.onmessage!({ data: { type: 'error', message: 'Reference lacks observations' } } as MessageEvent<CodonReferenceResponse>);
      await assert.rejects(task);
      assert.equal(port.terminated, 1); assert.equal(port.onmessage, null);
    }
  });
  it('keeps fully absent reference coverage unavailable through the transport', async () => {
    const input = await request();
    if (input.type !== 'analyze') throw new Error('Expected analyze request');
    const reference = JSON.parse(input.referenceText); reference.counts = { TTT: 2, TTC: 1 };
    const result = await executeCodonReferenceRequest({ ...input, referenceText: JSON.stringify(reference) });
    assert.equal(result.analysis.summary.cai, null);
    assert.equal(result.record.fields.pooledCai.kind, 'unavailable');
    assert.deepEqual(result.analysis.genes[0].missingReferenceCodons, { AAA: 1, AAG: 1 });
  });
});
