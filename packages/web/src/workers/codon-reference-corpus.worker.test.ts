import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { executeCodonReferenceRequest, runCodonReferenceTask, type CodonReferenceRequest,
  type CodonReferenceWorkerPort, type CodonReferenceResponse } from './codon-reference.worker';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { importLocalGenomes } from '../../../core/src/genome-import';
import { referenceGenomeFromPhage } from '../../../core/src/analysis/codon-reference';
import type { CodonCorpusOptions } from '../../../core/src/analysis/codon-reference-corpus';

const options: CodonCorpusOptions = { name: 'Worker corpus', organism: 'Synthetic fixture', geneticCode: 1,
  citation: 'Worker numerical fixture', version: '1' };
const source = { name: 'source.gb', text: 'LOCUS       REF 12 bp DNA linear\nACCESSION   REF\nFEATURES             Location/Qualifiers\n     CDS             1..12\nORIGIN\n        1 atgaaaaagtaa\n//\n' };
function port() {
  let stopped = 0;
  const messages: CodonReferenceRequest[] = [];
  const worker: CodonReferenceWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: request => { messages.push(structuredClone(request)); }, terminate: () => { stopped++; } };
  return { worker, messages, stopped: () => stopped, send: (data: CodonReferenceResponse) => worker.onmessage?.({ data } as MessageEvent<CodonReferenceResponse>) };
}

describe('reference corpus worker integration', () => {
  it('builds and verifies source-derived counts through the same request handler as browser workers', async () => {
    const result = await executeCodonReferenceRequest({ type: 'build-reference', input: source, options });
    assert.equal(result.reference.counts.AAA, 1); assert.equal(result.summary.codons, 4);
    const replay = await executeCodonReferenceRequest({ type: 'verify-reference', content: serializeAnalysisRecord(result.record) });
    assert.deepEqual(replay, result);
    const genome = (await importLocalGenomes(source)).genomes[0];
    const score = await executeCodonReferenceRequest({ type: 'analyze', genome: referenceGenomeFromPhage(genome.phage),
      sequence: genome.sequence, referenceText: serializeAnalysisRecord(result.record), options: {} });
    assert.equal(score.analysis.summary.cai, 1); assert.equal(score.record.method.version, '2');
    assert.deepEqual((await executeCodonReferenceRequest({ type: 'verify', content: serializeAnalysisRecord(score.record) })).record, score.record);
  });
  it('releases the owned worker on success and checks the response shape for the requested task', async () => {
    const corpus = await executeCodonReferenceRequest({ type: 'build-reference', input: source, options });
    const p = port(), task = runCodonReferenceTask(() => p.worker, { type: 'build-reference', input: source, options }, new AbortController().signal);
    p.send({ type: 'result', experiment: corpus }); assert.deepEqual(await task, corpus); assert.equal(p.stopped(), 1);
    const wrong = port(), invalid = runCodonReferenceTask(() => wrong.worker, { type: 'verify', content: '{}' }, new AbortController().signal);
    wrong.send({ type: 'result', experiment: corpus }); await assert.rejects(invalid, /Invalid reference-analysis worker response/); assert.equal(wrong.stopped(), 1);
  });
  it('cancels one request promptly, ignores its late response and leaves an independent request running', async () => {
    const a = port(), b = port(), controller = new AbortController();
    const old = runCodonReferenceTask(() => a.worker, { type: 'build-reference', input: source, options }, controller.signal);
    const late = a.worker.onmessage;
    const active = runCodonReferenceTask(() => b.worker, { type: 'build-reference', input: source, options }, new AbortController().signal);
    controller.abort(); await assert.rejects(old, { name: 'AbortError' }); assert.equal(a.stopped(), 1); assert.equal(b.stopped(), 0);
    const corpus = await executeCodonReferenceRequest({ type: 'build-reference', input: source, options });
    late?.({ data: { type: 'result', experiment: corpus } } as MessageEvent<CodonReferenceResponse>);
    assert.equal(a.stopped(), 1);
    b.send({ type: 'result', experiment: corpus }); assert.deepEqual(await active, corpus); assert.equal(b.stopped(), 1);
  });
  it('rejects invalid inputs without returning counts and terminates after posting, decode and creation errors', async () => {
    await assert.rejects(executeCodonReferenceRequest({ type: 'build-reference', input: { name: 'fasta', text: '>x\nATGAAA' }, options }), /FASTA/);
    await assert.rejects(runCodonReferenceTask(() => { throw new Error('unavailable'); }, { type: 'build-reference', input: source, options }, new AbortController().signal), /could not start/);
    const posting = port(); posting.worker.postMessage = () => { throw new Error('post failure'); };
    await assert.rejects(runCodonReferenceTask(() => posting.worker, { type: 'build-reference', input: source, options }, new AbortController().signal), /post failure/);
    assert.equal(posting.stopped(), 1);
    const decoding = port(), task = runCodonReferenceTask(() => decoding.worker, { type: 'verify-reference', content: '{}' }, new AbortController().signal);
    decoding.worker.onmessageerror?.({} as MessageEvent); await assert.rejects(task, /decoded/); assert.equal(decoding.stopped(), 1);
  });
});
