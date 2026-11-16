import React from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComparisonJob, ComparisonWorkerMessage } from '../../workers/types';
import { compareGenomes, computeSequenceDiff, estimateKmerIdentity } from '@phage-explorer/comparison';
import { ComparisonDiffView, ComparisonKmerIdentity, ComparisonSummaryStatus, runWebComparison } from './ComparisonOverlay';

describe('comparison identity evidence rendering', () => {
  it('renders absent resolved evidence as unavailable in both identity and summary', async () => {
    const result = await compareGenomes({ id: 1, name: 'A', accession: 'A' },
      { id: 2, name: 'B', accession: 'B' }, 'N'.repeat(30), 'N'.repeat(30));
    const html = renderToStaticMarkup(<><ComparisonKmerIdentity estimate={result.biological.kmerIdentity} />
      <ComparisonSummaryStatus summary={result.summary} /></>);
    expect(html).toContain('Unavailable');
    expect(html).toContain('Insufficient resolved sequence');
    expect(html).toContain('insufficient k-mer evidence');
    expect(html).toContain('Resolved windows A: 0/10 (0.0%)');
    expect(html).not.toContain('100.00%');
    expect(html).not.toContain('Distantly Related');
  });

  it('shows actual numerical estimates alongside support and model limits', () => {
    const html = renderToStaticMarkup(<ComparisonKmerIdentity estimate={estimateKmerIdentity('AAACCC', 'AAAGGG', 3)} />);
    expect(html).toContain('76.90%');
    expect(html).toContain('Exact canonical 3-mers');
    expect(html).toContain('shared 2');
    expect(html).toContain('not aligned nucleotide identity or a species assignment');
    expect(html).not.toContain('ANI Score');
  });
});

describe('comparison diff result rendering', () => {
  it('renders real budget exhaustion as unavailable, never identical', () => {
    const sequenceA = 'A'.repeat(3000), sequenceB = 'C'.repeat(3001);
    const diff = computeSequenceDiff(sequenceA, sequenceB);
    const html = renderToStaticMarkup(<ComparisonDiffView diff={diff} sequenceA={sequenceA} sequenceB={sequenceB} />);
    expect(html).toContain('Exact sequence diff unavailable'); expect(html).toContain('budget');
    expect(html).not.toContain('comparison-identical'); expect(html).not.toContain('Sequences appear identical');
  });

  it('claims symbol equality only after complete zero-edit alignment and discloses ambiguity', () => {
    const sequenceA = 'ACNT', sequenceB = 'acnt';
    const html = renderToStaticMarkup(<ComparisonDiffView diff={computeSequenceDiff(sequenceA, sequenceB)} sequenceA={sequenceA} sequenceB={sequenceB} />);
    expect(html).toContain('comparison-identical'); expect(html).toContain('identical symbols');
    expect(html).toContain('1 columns contain ambiguous bases');
  });

  it('renders exact aligned indels and their coordinates for equal-length shifted inputs', () => {
    const sequenceA = 'ACGT', sequenceB = 'CGTA';
    const html = renderToStaticMarkup(<ComparisonDiffView diff={computeSequenceDiff(sequenceA, sequenceB)} sequenceA={sequenceA} sequenceB={sequenceB} />);
    expect(html).not.toContain('comparison-identical'); expect(html).toContain('Aligned sequence edit coordinates');
    expect(html).toContain('deletion'); expect(html).toContain('insertion'); expect(html).toContain('60.00');
    expect(html).toContain('between bases 4 and 5');
  });
});

const comparisonJob = {
  jobId: 'owned-comparison',
  phageA: { id: -1, name: 'Reference', accession: 'local-reference' },
  phageB: { id: -2, name: 'Query', accession: 'local-query' },
  sequenceA: 'AAACCCGGGTTT',
  sequenceB: 'AAACCCGAGTTT',
  genesA: [], genesB: [],
} satisfies ComparisonJob & { jobId: string };

class ControlledComparisonWorker {
  onmessage: ((event: MessageEvent<ComparisonWorkerMessage>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: ComparisonJob | null = null;
  transfers: Transferable[] = [];
  terminated = 0;
  failPost = false;
  postMessage(job: ComparisonJob, transfer: Transferable[]) {
    if (this.failPost) throw new Error('transfer failed');
    this.posted = job; this.transfers = transfer;
  }
  terminate() { this.terminated++; }
  reply(message: ComparisonWorkerMessage) { this.onmessage?.({ data: message } as MessageEvent<ComparisonWorkerMessage>); }
}
const factory = (worker: ControlledComparisonWorker): (() => Worker) => () => worker as unknown as Worker;
async function actualComparisonReply(): Promise<ComparisonWorkerMessage> {
  const job = comparisonJob;
  return { jobId: job.jobId, ok: true,
    result: await compareGenomes(job.phageA, job.phageB, job.sequenceA, job.sequenceB),
    diff: computeSequenceDiff(job.sequenceA, job.sequenceB) };
}

describe('owned browser comparison worker', () => {
  it('transports an actual computed result and the exact diff together, then frees its worker', async () => {
    const worker = new ControlledComparisonWorker();
    const transfer = [new ArrayBuffer(4)];
    const pending = runWebComparison(comparisonJob, transfer, undefined, 1000, factory(worker));
    expect(worker.posted).toBe(comparisonJob); expect(worker.transfers).toBe(transfer);
    worker.reply(await actualComparisonReply());
    const payload = await pending;
    expect(payload.result.biological.lengthA).toBe(12);
    expect(payload.diff.status).toBe('complete');
    if (payload.diff.status === 'complete') expect(payload.diff.stats).toMatchObject({ distance: 1, substitutions: 1, matches: 11 });
    expect(worker.terminated).toBe(1); expect(worker.onmessage).toBeNull();
  });

  it('does not construct a cancelled worker and aborts an already posted job', async () => {
    const controller = new AbortController(); controller.abort();
    const worker = new ControlledComparisonWorker();
    let created = 0;
    await expect(runWebComparison(comparisonJob, [], controller.signal, 1000, () => {
      created++; return factory(worker)();
    })).rejects.toHaveProperty('name', 'AbortError');
    expect(created).toBe(0);

    const active = new AbortController();
    const pending = runWebComparison(comparisonJob, [], active.signal, 1000, factory(worker));
    const queuedReply = worker.onmessage!;
    active.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    // A queued message handler cannot turn a settled cancellation into success.
    queuedReply({ data: await actualComparisonReply() } as MessageEvent<ComparisonWorkerMessage>);
    expect(worker.terminated).toBe(1); expect(worker.onmessage).toBeNull();
  });

  it('keeps other metrics when the exact diff explicitly reports unavailable', async () => {
    const worker = new ControlledComparisonWorker();
    const pending = runWebComparison(comparisonJob, [], undefined, 1000, factory(worker));
    const message = await actualComparisonReply();
    message.diff = computeSequenceDiff(comparisonJob.sequenceA, comparisonJob.sequenceB, { maxStates: 0 });
    worker.reply(message);
    const result = await pending;
    expect(result.diff.status).toBe('unavailable');
    expect(result.result.phageA.accession).toBe('local-reference');
  });

  it('rejects replies for the wrong request, genome or sequence instead of accepting their numbers', async () => {
    for (const change of [
      (message: ComparisonWorkerMessage) => { message.jobId = 'obsolete'; },
      (message: ComparisonWorkerMessage) => { message.result!.phageA.accession = 'different-source'; },
      (message: ComparisonWorkerMessage) => { message.result!.biological.lengthB = 11; },
      (message: ComparisonWorkerMessage) => { if (message.diff?.status === 'complete') message.diff.stats.lengthA = 11; },
      (message: ComparisonWorkerMessage) => { if (message.diff?.status === 'complete') message.diff.mask = new Uint8Array(1); },
    ]) {
      const worker = new ControlledComparisonWorker();
      const pending = runWebComparison(comparisonJob, [], undefined, 1000, factory(worker));
      const message = structuredClone(await actualComparisonReply());
      change(message); worker.reply(message);
      await expect(pending).rejects.toThrow('different');
      expect(worker.terminated).toBe(1);
    }
  });

  it('settles missing results, worker failures, unreadable messages and failed transfers', async () => {
    for (const failure of ['missing', 'error', 'messageerror', 'post'] as const) {
      const worker = new ControlledComparisonWorker();
      worker.failPost = failure === 'post';
      const pending = runWebComparison(comparisonJob, [], undefined, 1000, factory(worker));
      if (failure === 'missing') worker.reply({ ok: true, jobId: comparisonJob.jobId });
      else if (failure === 'error') worker.onerror!();
      else if (failure === 'messageerror') worker.onmessageerror!();
      await expect(pending).rejects.toThrow();
      expect(worker.terminated).toBe(1); expect(worker.onmessage).toBeNull();
    }
    const unavailable = new Error('worker construction failed');
    await expect(runWebComparison(comparisonJob, [], undefined, 1000, () => { throw unavailable; })).rejects.toBe(unavailable);
  });

  it('expires a silent worker and rejects invalid deadlines before starting work', async () => {
    const worker = new ControlledComparisonWorker();
    await expect(runWebComparison(comparisonJob, [], undefined, 1, factory(worker))).rejects.toThrow('timed out');
    expect(worker.terminated).toBe(1);
    const unused = new ControlledComparisonWorker();
    await expect(runWebComparison(comparisonJob, [], undefined, 0, factory(unused))).rejects.toThrow('positive integer');
    expect(unused.posted).toBeNull(); expect(unused.terminated).toBe(0);
  });
});
