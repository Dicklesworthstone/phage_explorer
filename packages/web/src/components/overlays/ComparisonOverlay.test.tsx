import React from 'react';
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComparisonJob, ComparisonWorkerMessage } from '../../workers/types';
import { analyzeInformationTheory, analyzeStructuralVariants, compareCodonUsage, compareGenomes, computeSequenceDiff, estimateKmerIdentity,
  createGenomeComparisonExperiment, DEFAULT_GENOME_COMPARISON_OPTIONS } from '@phage-explorer/comparison';
import { serializeAnalysisRecord } from '@phage-explorer/core';
import { ComparisonCodonAdaptation, ComparisonDiffView, ComparisonInformationTheory, ComparisonKmerIdentity, ComparisonStructuralVariants, ComparisonSummaryStatus } from './ComparisonOverlay';
import { runWebComparison } from '../../workers/ComparisonSession';

describe('comparison information evidence rendering', () => {
  it('renders actual 5-mer MI in coherent units and NMI at 100%, not 500%', () => {
    const html = renderToStaticMarkup(<ComparisonInformationTheory info={analyzeInformationTheory('ACGTACGT', 'ACGTACGT', 5)} />);
    expect(html).toContain('100.0%');
    expect(html).not.toContain('500');
    expect(html).toContain('0.400');
    expect(html).toContain('mutual information (bits/base)');
    expect(html).toContain('Jointly resolved pairs: 4/4');
    expect(html).toContain('not nucleotide identity');
  });

  it('keeps full-input divergence separate from absent paired observations', () => {
    const html = renderToStaticMarkup(<ComparisonInformationTheory info={analyzeInformationTheory('AN', 'NA', 1)} />);
    expect(html).toContain('Unavailable');
    expect(html).toContain('No jointly resolved');
    expect(html).toContain('Jointly resolved pairs: 0/2');
    expect(html).toContain('Resolved windows A: 1/2; B: 1/2');
    expect(html).toContain('JSD (bits/k-mer)');
    expect(html).not.toContain('100.0%');
    expect(html).not.toContain('0.0%');
  });

  it('reports zero-entropy normalization separately from wholly unresolved inputs', () => {
    const constant = renderToStaticMarkup(<ComparisonInformationTheory info={analyzeInformationTheory('AAAA', 'TTTT', 1)} />);
    expect(constant).toContain('constant');
    expect(constant).toContain('observed MI is zero');
    expect(constant).toContain('Jointly resolved pairs: 4/4');
    const missing = renderToStaticMarkup(<ComparisonInformationTheory info={analyzeInformationTheory('NRY', 'NRY', 1)} />);
    expect(missing).toContain('Unavailable');
    expect(missing).toContain('Jointly resolved pairs: 0/3');
    expect(missing).not.toContain('0.000');
    expect(missing).not.toContain('constant');
  });
});

describe('comparison codon reference coverage rendering', () => {
  it('distinguishes missing reference families, exact zero weights and supported scores', () => {
    const missing = renderToStaticMarkup(<ComparisonCodonAdaptation codon={compareCodonUsage({ AAA: 1, TTT: 1 }, { AAA: 8, AAG: 2 })} />);
    expect(missing).toContain('CAI A relative to B: Unavailable');
    expect(missing).toContain('Scored synonymous codons: 1/2');
    expect(missing).toContain('no observations for target amino-acid families: F');
    const zero = renderToStaticMarkup(<ComparisonCodonAdaptation codon={compareCodonUsage({ AAA: 1, AAG: 1 }, { AAA: 8 })} />);
    expect(zero).toContain('CAI A relative to B: 0.000'); expect(zero).toContain('zero weights: 1');
    const half = renderToStaticMarkup(<ComparisonCodonAdaptation codon={compareCodonUsage({ AAA: 1, AAG: 1, ATG: 10, TAA: 1 }, { AAA: 8, AAG: 2 })} />);
    expect(half).toContain('CAI A relative to B: 0.500'); expect(half).toContain('excluded Met/Trp: 10; stops: 1');
    expect(half).toContain('not a validated host expression reference');
    const small = renderToStaticMarkup(<ComparisonCodonAdaptation codon={compareCodonUsage({ AAG: 1 }, { AAA: 100_000_000, AAG: 1 })} />);
    expect(small).toContain('CAI A relative to B: 1.000e-8');
    expect(small).not.toContain('CAI A relative to B: 0.000');
  });
});

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

describe('comparison aligned indel rendering', () => {
  it('shows actual sequence-only indels, correctly converted coordinates and no invented confidence', async () => {
    const result = await compareGenomes({ id: 1, name: 'Reference', accession: 'A' },
      { id: 2, name: 'Query', accession: 'B' }, 'CCGG', 'CC' + 'A'.repeat(60) + 'GG');
    const html = renderToStaticMarkup(<ComparisonStructuralVariants report={result.structuralVariants!} />);
    expect(html).toContain('Aligned insertions and deletions');
    expect(html).toContain('insertion runs');
    expect(html).toContain('A after base 2');
    expect(html).toContain('B 3–62');
    expect(html).toContain('60 resolved bases in one insertion run');
    expect(html).toContain('Overlapping annotations');
    expect(html).not.toContain('conf ');
    expect(html).not.toContain('100%');
    expect(html).not.toContain('Anchors used');
  });

  it('never renders a failed alignment as a zero-variant result', () => {
    const report = analyzeStructuralVariants('ACGT', 'TGCA', [], [], { maxStates: 0 });
    const html = renderToStaticMarkup(<ComparisonStructuralVariants report={report} />);
    expect(html).toContain('Aligned indel evidence unavailable');
    expect(html).toContain('budget');
    expect(html).not.toContain('insertion runs');
    expect(html).not.toContain('No resolved insertion');
    expect(html).not.toContain('No structural variant');
  });

  it('discloses unresolved alleles and distinguishes the size threshold from absence of all variation', () => {
    const ambiguous = analyzeStructuralVariants('CCGG', 'CC' + 'N'.repeat(60) + 'GG');
    const html = renderToStaticMarkup(<ComparisonStructuralVariants report={ambiguous} />);
    expect(html).toContain('1 with unresolved alleles');
    expect(html).toContain('60 alignment columns contain ambiguous bases');
    expect(html).toContain('50 bp threshold in this alignment');
  });
});

const comparisonJob = {
  kind: 'analyze',
  jobId: 'owned-comparison',
  phageA: { id: -1, name: 'Reference', accession: 'local-reference' },
  phageB: { id: -2, name: 'Query', accession: 'local-query' },
  sequenceA: 'AAACCCGGGTTT',
  sequenceB: 'AAACCCGAGTTT',
  sourceA: 'local', sourceB: 'local', genesA: [], genesB: [], codonUsageA: null, codonUsageB: null,
  options: { ...DEFAULT_GENOME_COMPARISON_OPTIONS },
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
async function actualComparisonReply(job = comparisonJob): Promise<ComparisonWorkerMessage> {
  return { jobId: job.jobId, ok: true,
    experiment: await createGenomeComparisonExperiment(
      { phage: job.phageA, source: job.sourceA, sequence: job.sequenceA, genes: job.genesA, codonUsage: job.codonUsageA },
      { phage: job.phageB, source: job.sourceB, sequence: job.sequenceB, genes: job.genesB, codonUsage: job.codonUsageB }, job.options) };
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
    const diff = payload.result.sequenceDiff;
    expect(diff?.status).toBe('complete');
    if (diff?.status === 'complete') expect(diff.stats).toMatchObject({ distance: 1, substitutions: 1, matches: 11 });
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
    const job = { ...comparisonJob, sequenceA: 'A'.repeat(3000), sequenceB: 'C'.repeat(3001) };
    const pending = runWebComparison(job, [], undefined, 1000, factory(worker));
    const message = await actualComparisonReply(job);
    worker.reply(message);
    const result = await pending;
    expect(result.result.sequenceDiff?.status).toBe('unavailable');
    expect(result.result.phageA.accession).toBe('local-reference');
  });

  it('rejects replies for the wrong request, genome or sequence instead of accepting their numbers', async () => {
    for (const change of [
      (message: ComparisonWorkerMessage) => { message.jobId = 'obsolete'; },
      (message: ComparisonWorkerMessage) => { message.experiment!.result.phageA.accession = 'different-source'; },
      (message: ComparisonWorkerMessage) => { message.experiment!.result.biological.lengthB = 11; },
      (message: ComparisonWorkerMessage) => { const diff = message.experiment!.result.sequenceDiff; if (diff?.status === 'complete') diff.stats.lengthA = 11; },
      (message: ComparisonWorkerMessage) => { const diff = message.experiment!.result.sequenceDiff; if (diff?.status === 'complete') diff.mask = new Uint8Array(1); },
    ]) {
      const worker = new ControlledComparisonWorker();
      const pending = runWebComparison(comparisonJob, [], undefined, 1000, factory(worker));
      const message = structuredClone(await actualComparisonReply());
      change(message); worker.reply(message);
      await expect(pending).rejects.toThrow();
      expect(worker.terminated).toBe(1);
    }
  });

  it('settles malformed live and replay payloads immediately without losing worker ownership', async () => {
    const original = (await actualComparisonReply()).experiment!;
    const other = (await actualComparisonReply({ ...comparisonJob, sequenceB: 'G'.repeat(12) })).experiment!;
    const malformed = [
      { ...original, record: { ...original.record, inputs: null } },
      { ...original, record: { ...original.record, fields: undefined } },
      { ...original, genomeA: undefined },
      { ...original, result: { ...original.result, informationTheory: {} } },
      { ...original, result: { ...original.result, biological: { ...original.result.biological, kmerIdentity: null } } },
      { ...original, result: { ...original.result, codonUsage: { ...original.result.codonUsage, caiA: undefined } } },
      { ...original, result: { ...original.result, codonUsage: { ...original.result.codonUsage, caiCoverageA: undefined } } },
      { ...original, result: { ...original.result, codonUsage: { ...original.result.codonUsage,
        caiCoverageA: { ...original.result.codonUsage.caiCoverageA, scoredCodons: -1 } } } },
      { ...original, result: { ...original.result, summary: { ...original.result.summary, insights: null } } },
      { ...original, result: { ...original.result, rankCorrelation: { ...original.result.rankCorrelation, spearmanRho: NaN } } },
      { ...original, result: { ...original.result, geneContent: { ...original.result.geneContent, topSharedGenes: [null] } } },
      other,
    ];
    const jobs: ComparisonJob[] = [comparisonJob, { kind: 'replay', jobId: 'reopen', content: serializeAnalysisRecord(original.record) }];
    for (const job of jobs) for (const experiment of malformed) {
      const worker = new ControlledComparisonWorker();
      const pending = runWebComparison(job, [], undefined, 1000, factory(worker));
      expect(() => worker.reply({ jobId: job.jobId, ok: true, experiment } as ComparisonWorkerMessage)).not.toThrow();
      expect(worker.terminated).toBe(1);
      await expect(pending).rejects.toThrow();
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
