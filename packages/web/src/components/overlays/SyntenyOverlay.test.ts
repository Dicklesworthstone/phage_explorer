import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import { serializeAnalysisRecord } from '../../../../core/src/analysis-result';
import { analyzeSyntenyExperiment } from '../../../../comparison/src/synteny-experiment';
import type { SyntenyRequest, SyntenyWorkerJob, SyntenyWorkerMessage } from '../../workers/synteny-worker';
import { runSyntenyTask, type SyntenyWorker } from '../../workers/SyntenySession';

const genes: GeneInfo[] = ['alpha', 'beta', 'gamma'].map((name, index) => ({
  id: index + 1, name, locusTag: null, product: null, startPos: index * 20,
  endPos: index * 20 + 10, strand: '+', type: 'CDS',
}));
const request: SyntenyRequest = { kind: 'analyze', input: {
  query: { id: 1, name: 'Query', accession: 'Q', length: 60, source: 'local', contentId: 'query', annotationMetadata: null },
  reference: { id: 2, name: 'Reference', accession: 'R', length: 60, source: 'local', contentId: 'reference', annotationMetadata: null },
  genesQuery: genes, genesReference: genes,
} };

class ControlledWorker implements SyntenyWorker {
  onmessage: ((event: MessageEvent<SyntenyWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: SyntenyWorkerJob | null = null;
  terminated = 0;
  failPost = false;
  postMessage(value: SyntenyWorkerJob) { if (this.failPost) throw new Error('cannot post job'); this.posted = value; }
  terminate() { this.terminated++; }
}
const factory = (worker: ControlledWorker) => () => worker;

describe('owned synteny worker', () => {
  it('computes an actual worker result for the submitted annotation pair', async () => {
    const experiment = await runSyntenyTask(request), result = experiment.result;
    expect(result.heatmap.rows).toBe(3); expect(result.heatmap.cols).toBe(3);
    expect(result.heatmap.values).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(result.stats.blockCount).toBe(1);
    expect(result.stats.globalScore).toBe(1);
    expect(result.stats.coverageQuery).toBe(50);
    expect(result.blocksBp[0]).toMatchObject({ startBpQuery: 0, endBpQuery: 50,
      startBpReference: 0, endBpReference: 50 });
    expect(experiment.record.fields.synteny.value).toEqual(result);
  });

  it('accepts repeated-label DTW results with more blocks than query annotations', async () => {
    if (request.kind !== 'analyze') throw new Error('Expected annotation request fixture.');
    const repeated = await runSyntenyTask({ kind: 'analyze', input: { ...request.input,
      genesQuery: [genes[0]], genesReference: genes.map(gene => ({ ...gene, name: 'alpha' })) } });
    expect(repeated.result.heatmap.values).toEqual([1, 1, 1]);
    expect(repeated.result.stats.blockCount).toBe(3);
    expect(repeated.result.stats.globalScore).toBe(1);
    expect(repeated.record.fields.synteny.value).toEqual(repeated.result);
  });

  it('does not start cancelled work and terminates an active request exactly once', async () => {
    const worker = new ControlledWorker(), before = new AbortController(); before.abort();
    await expect(runSyntenyTask(request, before.signal, 1000, factory(worker))).rejects.toHaveProperty('name', 'AbortError');
    expect(worker.posted).toBeNull(); expect(worker.terminated).toBe(0);
    const active = new AbortController();
    const pending = runSyntenyTask(request, active.signal, 1000, factory(worker));
    const queued = worker.onmessage!;
    active.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    queued({ data: { jobId: worker.posted!.jobId, kind: 'error', message: 'obsolete failure' } } as MessageEvent<SyntenyWorkerMessage>);
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull(); expect(worker.onmessageerror).toBeNull();
  });

  it('settles construction, transfer, runtime and unreadable-response failures', async () => {
    await expect(runSyntenyTask(request, undefined, 1000, () => { throw new Error('worker unavailable'); })).rejects.toThrow('worker unavailable');
    for (const failure of ['post', 'error', 'messageerror'] as const) {
      const worker = new ControlledWorker(); worker.failPost = failure === 'post';
      const pending = runSyntenyTask(request, undefined, 1000, factory(worker));
      if (failure === 'error') worker.onerror!({ preventDefault() {} } as ErrorEvent);
      if (failure === 'messageerror') worker.onmessageerror!({} as MessageEvent);
      await expect(pending).rejects.toThrow(failure === 'post' ? 'cannot post' : failure === 'error' ? 'worker failed' : 'unreadable');
      expect(worker.terminated).toBe(1);
    }
  });

  it('bounds silent jobs and immediately settles malformed or mismatched responses', async () => {
    const silent = new ControlledWorker();
    await expect(runSyntenyTask(request, undefined, 5, factory(silent))).rejects.toThrow('timed out');
    expect(silent.terminated).toBe(1);
    const computed = await runSyntenyTask(request);
    const changedInput = structuredClone(computed);
    changedInput.input.genesQuery[0].name = 'different';
    const otherExperiment = await analyzeSyntenyExperiment(changedInput.input);
    const malformedAnnotations = { ...computed.input,
      genesQuery: [{ ...computed.input.genesQuery[0], name: { label: 'invalid' } }, ...computed.input.genesQuery.slice(1)] };
    const responses: unknown[] = [
      { kind: 'result', jobId: 'obsolete-job', value: computed },
      { kind: 'result', value: { ...computed, result: { ...computed.result, heatmap: { ...computed.result.heatmap, rows: 4 } } } },
      { kind: 'result', value: { ...computed, result: { ...computed.result,
        heatmap: { ...computed.result.heatmap, values: [NaN, ...computed.result.heatmap.values.slice(1)] } } } },
      { kind: 'result', value: { ...computed, result: { ...computed.result, stats: { ...computed.result.stats, dtwDistance: undefined } } } },
      { kind: 'result', value: { ...computed, result: { ...computed.result, stats: { ...computed.result.stats, globalScore: '1' } } } },
      { kind: 'result', value: { ...computed, result: { ...computed.result,
        blocksBp: [{ ...computed.result.blocksBp[0], score: undefined }] } } },
      { kind: 'result', value: { ...computed, record: {} } },
      { kind: 'result', value: { ...computed, record: { ...computed.record, method: null } } },
      { kind: 'result', value: { ...computed, record: { ...computed.record, inputs: null } } },
      { kind: 'result', value: { ...computed, record: { ...computed.record, fields: undefined } } },
      { kind: 'result', value: { ...computed, record: { ...computed.record,
        fields: { ...computed.record.fields, synteny: { ...computed.record.fields.synteny, limitations: null } } } } },
      { kind: 'result', value: { ...computed, input: { ...computed.input, query: undefined } } },
      { kind: 'result', value: { ...computed, input: malformedAnnotations } },
      { kind: 'result', value: changedInput },
      // Internally valid evidence still belongs to a different request/file.
      { kind: 'result', value: otherExperiment },
      { kind: 'result' },
      { kind: 'error', message: 'Missing gene data' },
    ];
    const requests: SyntenyRequest[] = [request, { kind: 'replay', content: serializeAnalysisRecord(computed.record) }];
    for (const submitted of requests) for (const response of responses) {
      const worker = new ControlledWorker();
      const pending = runSyntenyTask(submitted, undefined, 1000, factory(worker));
      const data = { jobId: worker.posted!.jobId, ...(response as object) };
      expect(() => worker.onmessage!({ data } as MessageEvent<SyntenyWorkerMessage>)).not.toThrow();
      // A shape error must terminate now, not throw from the handler and leave a timeout behind.
      expect(worker.terminated).toBe(1);
      await expect(pending).rejects.toThrow();
      expect(worker.onmessage).toBeNull();
    }
  });
});
