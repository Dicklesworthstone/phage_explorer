import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import type { SyntenyJob, WorkerResponse } from '../../workers/synteny-worker';
import { runWebSynteny } from './SyntenyOverlay';

const genes: GeneInfo[] = ['alpha', 'beta', 'gamma'].map((name, index) => ({
  id: index + 1, name, locusTag: null, product: null, startPos: index * 20,
  endPos: index * 20 + 10, strand: '+', type: 'CDS',
}));
const job: SyntenyJob & { jobId: string } = {
  jobId: 'owned-synteny', query: { id: 1, name: 'Query', length: 60 },
  reference: { id: 2, name: 'Reference', length: 60 }, genesQuery: genes, genesReference: genes,
};

class ControlledWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: SyntenyJob | null = null;
  terminated = 0;
  failPost = false;
  postMessage(value: SyntenyJob) { if (this.failPost) throw new Error('cannot post job'); this.posted = value; }
  terminate() { this.terminated++; }
}
const factory = (worker: ControlledWorker) => () => worker as unknown as Worker;

describe('owned synteny worker', () => {
  it('computes an actual worker result for the submitted annotation pair', async () => {
    const result = await runWebSynteny(job);
    expect(result.heatmap.rows).toBe(3); expect(result.heatmap.cols).toBe(3);
    expect([...result.heatmap.values]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(result.stats.blockCount).toBe(1);
    expect(result.stats.globalScore).toBe(1);
    expect(result.stats.coverageQuery).toBe(50);
    expect(result.blocksBp[0]).toMatchObject({ startBpQuery: 0, endBpQuery: 50,
      startBpReference: 0, endBpReference: 50 });
  });

  it('does not start cancelled work and terminates an active request exactly once', async () => {
    const worker = new ControlledWorker(), before = new AbortController(); before.abort();
    await expect(runWebSynteny(job, before.signal, 1000, factory(worker))).rejects.toHaveProperty('name', 'AbortError');
    expect(worker.posted).toBeNull(); expect(worker.terminated).toBe(0);
    const active = new AbortController();
    const pending = runWebSynteny(job, active.signal, 1000, factory(worker));
    const queued = worker.onmessage!;
    active.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    queued({ data: { jobId: job.jobId, ok: false, error: 'obsolete failure' } } as MessageEvent<WorkerResponse>);
    expect(worker.terminated).toBe(1);
    expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull(); expect(worker.onmessageerror).toBeNull();
  });

  it('settles construction, transfer, runtime and unreadable-response failures', async () => {
    await expect(runWebSynteny(job, undefined, 1000, () => { throw new Error('worker unavailable'); })).rejects.toThrow('worker unavailable');
    for (const failure of ['post', 'error', 'messageerror'] as const) {
      const worker = new ControlledWorker(); worker.failPost = failure === 'post';
      const pending = runWebSynteny(job, undefined, 1000, factory(worker));
      if (failure === 'error') worker.onerror!({ preventDefault() {} } as ErrorEvent);
      if (failure === 'messageerror') worker.onmessageerror!();
      await expect(pending).rejects.toThrow(failure === 'post' ? 'cannot post' : failure === 'error' ? 'worker failed' : 'unreadable');
      expect(worker.terminated).toBe(1);
    }
  });

  it('bounds silent jobs and rejects incomplete or mismatched responses', async () => {
    const silent = new ControlledWorker();
    await expect(runWebSynteny(job, undefined, 5, factory(silent))).rejects.toThrow('timed out');
    expect(silent.terminated).toBe(1);
    const computed = await runWebSynteny(job);
    const responses: WorkerResponse[] = [
      { ...computed, ok: true, jobId: 'obsolete-job' },
      { ...computed, ok: true, jobId: job.jobId, heatmap: { ...computed.heatmap, rows: 4 } },
      { ok: true, jobId: job.jobId },
      { ok: false, jobId: job.jobId, error: 'Missing gene data' },
    ];
    for (const response of responses) {
      const worker = new ControlledWorker();
      const pending = runWebSynteny(job, undefined, 1000, factory(worker));
      worker.onmessage!({ data: response } as MessageEvent<WorkerResponse>);
      await expect(pending).rejects.toThrow();
      expect(worker.terminated).toBe(1);
    }
  });
});
