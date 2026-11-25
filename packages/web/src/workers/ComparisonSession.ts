/** Owned browser execution for the shared, portable genome-comparison method. */
import { analysisJson, serializeAnalysisRecord, type AnalysisRecord, type PhageSummary } from '@phage-explorer/core';
import { GENOME_COMPARISON_LIMITS, GENOME_COMPARISON_METHOD, genomeComparisonResultData,
  resolveGenomeComparisonOptions, type ComparisonGenomeInput, type GenomeComparisonExperiment } from '@phage-explorer/comparison';
import type { PhageRepository } from '../db';
import type { ComparisonAnalysisJob, ComparisonJob, ComparisonWorkerMessage, SequenceBytesRef } from './types';

export interface ComparisonWorker {
  postMessage: (job: ComparisonJob, transfer: Transferable[]) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<ComparisonWorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
const cancelled = () => new DOMException('Comparison cancelled.', 'AbortError');
const defaultFactory = (): ComparisonWorker => new Worker(new URL('./comparison.worker.ts', import.meta.url), { type: 'module' });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const numbers = (value: unknown, keys: readonly string[]): boolean => object(value) && keys.every(key => finite(value[key]));
const nullableNumbers = (value: unknown, keys: readonly string[]): boolean => object(value) && keys.every(key => value[key] === null || finite(value[key]));
const nullableText = (value: unknown): boolean => value === null || typeof value === 'string';
const same = (a: unknown, b: unknown): boolean => JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));
const index = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;

/** Capture transport bytes before postMessage can detach them. Shared buffers
 * are copied here as well, so a later buffer edit cannot relabel an accepted run.
 */
function submittedSequence(ref: SequenceBytesRef): string {
  const bytes = new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength);
  if (!index(ref.length, bytes.length)) throw new Error('Comparison sequence byte length does not match its buffer.');
  const snapshot = new Uint8Array(bytes.subarray(0, ref.length));
  if (ref.encoding === 'ascii') return new TextDecoder().decode(snapshot);
  if (ref.encoding !== 'acgt05') throw new Error('Unsupported comparison sequence encoding.');
  return new TextDecoder().decode(snapshot.map(code => code === 0 ? 65 : code === 1 ? 67 : code === 2 ? 71 : code === 3 ? 84 : 78));
}
function submittedGenomes(job: ComparisonAnalysisJob): [ComparisonGenomeInput, ComparisonGenomeInput] {
  return [
    { phage: job.phageA, source: job.sourceA, sequence: 'sequenceA' in job ? job.sequenceA : submittedSequence(job.sequenceARef),
      genes: job.genesA, codonUsage: job.codonUsageA },
    { phage: job.phageB, source: job.sourceB, sequence: 'sequenceB' in job ? job.sequenceB : submittedSequence(job.sequenceBRef),
      genes: job.genesB, codonUsage: job.codonUsageB },
  ];
}

/** Validate render/export shape without rerunning numerical analysis on the UI thread. */
function validateExperiment(value: unknown): GenomeComparisonExperiment {
  function invalid(): never { throw new Error('Comparison worker returned incomplete or inconsistent evidence.'); }
  if (!object(value)) invalid();
  const experiment = value as unknown as GenomeComparisonExperiment;
  const { genomeA, genomeB, result, record } = experiment;
  serializeAnalysisRecord(record); // Includes all metadata consumed by AnalysisRecordDetails and the 10 MiB limit.
  for (const genome of [genomeA, genomeB]) {
    if (!object(genome) || !object(genome.phage) || !Number.isSafeInteger(genome.phage.id)
      || typeof genome.phage.name !== 'string' || typeof genome.phage.accession !== 'string'
      || typeof genome.source !== 'string' || !['catalog', 'local', 'external'].includes(genome.source)
      || typeof genome.sequence !== 'string' || !genome.sequence.length || genome.sequence.length > GENOME_COMPARISON_LIMITS.sequenceBases
      || /[^ACGTRYSWKMBDHVNacgtryswkmbdhvn]/.test(genome.sequence) || !Array.isArray(genome.genes)
      || genome.genes.length > GENOME_COMPARISON_LIMITS.genes || genome.codonUsage !== null && !object(genome.codonUsage)) invalid();
  }
  if (!object(experiment.options)) invalid();
  const options = resolveGenomeComparisonOptions(experiment.options);
  if (!same(options, experiment.options) || !object(result) || !same(result.phageA, genomeA.phage) || !same(result.phageB, genomeB.phage)
    || !numbers(result, ['computedAt', 'computeTimeMs']) || !object(result.summary)
    || !nullableNumbers(result.summary, ['overallSimilarity'])
    || !numbers(result.summary, ['sequenceSimilarity', 'compositionSimilarity', 'codonUsageSimilarity', 'geneContentSimilarity'])
    || typeof result.summary.similarityCategory !== 'string' || !Array.isArray(result.summary.insights)
    || result.summary.insights.some(row => !object(row) || !['category', 'message', 'significance'].every(key => typeof row[key] === 'string'))
    || !Array.isArray(result.kmerAnalysis) || result.kmerAnalysis.length !== options.kmerSizes.length
    || result.kmerAnalysis.some((row, i) => !numbers(row, ['k', 'jaccardIndex', 'containmentAinB', 'containmentBinA', 'cosineSimilarity',
      'sharedKmers', 'uniqueKmersA', 'uniqueKmersB']) || row.k !== options.kmerSizes[i])) invalid();
  const info = result.informationTheory, rank = result.rankCorrelation, bio = result.biological;
  if (!object(info) || !numbers(info, ['k', 'klProbabilityFloor']) || !numbers(info.coverage, ['totalWindowsA', 'totalWindowsB',
    'resolvedWindowsA', 'resolvedWindowsB', 'pairedWindowSlots', 'resolvedWindowPairs'])
    || !nullableNumbers(info, ['entropyA', 'entropyB', 'pairedEntropyA', 'pairedEntropyB', 'jointEntropy', 'mutualInformation',
      'normalizedMI', 'jensenShannonDivergence', 'kullbackLeiblerAtoB', 'kullbackLeiblerBtoA'])
    || !nullableText(info.normalizedMIUnavailableReason)
    || !numbers(rank, ['spearmanRho', 'spearmanPValue', 'kendallTau', 'kendallPValue', 'hoeffdingD'])
    || typeof rank.spearmanStrength !== 'string' || typeof rank.kendallStrength !== 'string'
    || !numbers(bio, ['gcContentA', 'gcContentB', 'gcResolvedBasesA', 'gcResolvedBasesB', 'gcDifference', 'lengthA', 'lengthB', 'lengthRatio'])
    || bio.lengthA !== genomeA.sequence.length || bio.lengthB !== genomeB.sequence.length) invalid();
  const identity = bio.kmerIdentity;
  if (!object(identity) || !numbers(identity, ['k', 'sharedKmers']) || !nullableNumbers(identity, ['percent', 'distance', 'jaccard'])
    || !numbers(identity.coverageA, ['totalWindows', 'validWindows', 'distinctKmers', 'validWindowFraction'])
    || !numbers(identity.coverageB, ['totalWindows', 'validWindows', 'distinctKmers', 'validWindowFraction'])
    || !strings(identity.warnings) || !nullableText(identity.unavailableReason)) invalid();
  const codon = result.codonUsage, genes = result.geneContent;
  if (!numbers(codon, ['rscuCosineSimilarity', 'chiSquareStatistic', 'degreesOfFreedom', 'chiSquareExpectedBelowFive',
    'resolvedCodonsA', 'resolvedCodonsB', 'excludedCodonsA', 'excludedCodonsB']) || !nullableNumbers(codon, ['chiSquarePValue', 'caiA', 'caiB', 'caiCorrelation'])
    || !strings(codon.caiSharedFamilies)
    || !nullableText(codon.chiSquareUnavailableReason) || !Array.isArray(codon.topDifferentCodons)
    || codon.topDifferentCodons.some(row => !numbers(row, ['frequencyA', 'frequencyB', 'difference'])
      || typeof row.codon !== 'string' || typeof row.aminoAcid !== 'string')
    || !numbers(result.aminoAcidUsage, ['cosineSimilarity', 'hydrophobicSimilarity'])
    || !numbers(genes, ['genesA', 'genesB', 'sharedGeneNames', 'uniqueToA', 'uniqueToB', 'geneDensityA', 'geneDensityB',
      'geneNameJaccard', 'avgGeneLengthA', 'avgGeneLengthB']) || !strings(genes.topSharedGenes) || !strings(genes.uniqueAGenes) || !strings(genes.uniqueBGenes)) invalid();
  for (const [score, coverage, total] of [[codon.caiA, codon.caiCoverageA, codon.resolvedCodonsA],
    [codon.caiB, codon.caiCoverageB, codon.resolvedCodonsB]] as const) {
    if (!object(coverage) || !['eligibleCodons', 'scoredCodons', 'zeroWeightCodons', 'excludedSingletonCodons', 'excludedStopCodons']
      .every(key => index(coverage[key], total)) || !strings(coverage.missingReferenceFamilies) || !nullableText(coverage.unavailableReason)
      || coverage.eligibleCodons + coverage.excludedSingletonCodons + coverage.excludedStopCodons !== total
      || coverage.scoredCodons > coverage.eligibleCodons || coverage.zeroWeightCodons > coverage.scoredCodons
      || (coverage.missingReferenceFamilies.length > 0) !== (coverage.scoredCodons < coverage.eligibleCodons)
      || (score === null) !== (coverage.unavailableReason !== null)
      || (score === null) !== (coverage.eligibleCodons === 0 || coverage.missingReferenceFamilies.length > 0)
      || score !== null && (score < 0 || score > 1 || coverage.zeroWeightCodons > 0 && score !== 0)) invalid();
  }
  const diff = result.sequenceDiff, n = genomeA.sequence.length, m = genomeB.sequence.length;
  if (!object(diff) || typeof diff.method !== 'string') invalid();
  if (diff.status === 'complete') {
    if (!(diff.mask instanceof Uint8Array) || diff.mask.length !== n || diff.mask.some(code => code > 3)
      || !Array.isArray(diff.positions) || diff.positions.some(position => !index(position, n - 1))
      || !numbers(diff.stats, ['insertions', 'deletions', 'substitutions', 'matches', 'lengthA', 'lengthB', 'identity', 'alignmentColumns', 'ambiguousColumns', 'distance'])
      || diff.stats.lengthA !== n || diff.stats.lengthB !== m || !Array.isArray(diff.runs)
      || diff.runs.some(row => !object(row) || !['match', 'substitution', 'insertion', 'deletion'].includes(row.operation)
        || !index(row.startA, n) || !index(row.endA, n) || row.endA < row.startA
        || !index(row.startB, m) || !index(row.endB, m) || row.endB < row.startB)) invalid();
  } else if (diff.status !== 'unavailable' || typeof diff.reason !== 'string' || !diff.reason) invalid();
  const sv = result.structuralVariants;
  if (!object(sv) || typeof sv.method !== 'string' || !finite(sv.minGapBp) || !strings(sv.limitations) || !Array.isArray(sv.calls)) invalid();
  if (sv.status === 'complete') {
    if (!numbers(sv.counts, ['insertion', 'deletion']) || !numbers(sv.alignment, ['ambiguousColumns'])
      || !numbers(sv, ['belowThreshold', 'unresolved']) || sv.calls.some(row => !object(row)
        || typeof row.id !== 'string' || !['insertion', 'deletion'].includes(row.type)
        || !numbers(row, ['startA', 'endA', 'startB', 'endB', 'sizeA', 'sizeB'])
        || !strings(row.evidence) || !strings(row.affectedGenesA) || !strings(row.affectedGenesB))) invalid();
  } else if (sv.status !== 'unavailable' || typeof sv.reason !== 'string' || !sv.reason || sv.calls.length !== 0) invalid();
  if (!same(record.method, GENOME_COMPARISON_METHOD) || record.inputs.length !== 2 || !same(record.parameters, options)
    || record.inputs[0].id !== 'genomeA' || record.inputs[1].id !== 'genomeB'
    || record.fields.comparison?.kind !== 'sequence-score' || !same(record.fields.comparison.value, genomeComparisonResultData(result))) invalid();
  for (const [i, genome] of [genomeA, genomeB].entries()) {
    if (record.inputs[i].source !== genome.source || record.inputs[i].accession !== genome.phage.accession || !same(record.inputs[i].data, genome)) invalid();
  }
  return experiment;
}

/** One request owns one worker, including its deadline and cancellation. */
export function runWebComparison(job: ComparisonJob, transfer: Transferable[] = [], signal?: AbortSignal,
  timeoutMs = 300000, createWorker: () => ComparisonWorker = defaultFactory): Promise<GenomeComparisonExperiment> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { reject(new Error('Comparison timeout must be a positive integer.')); return; }
    let worker: ComparisonWorker, expected: unknown, expectedRecord: string | null = null;
    try {
      if (job.kind === 'analyze') expected = analysisJson([...submittedGenomes(job), resolveGenomeComparisonOptions(job.options)]);
      else if (job.kind === 'replay') {
        if (typeof job.content !== 'string' || new TextEncoder().encode(job.content).length > GENOME_COMPARISON_LIMITS.recordBytes) {
          throw new Error('Saved comparison exceeds 10 MiB.');
        }
        expectedRecord = serializeAnalysisRecord(JSON.parse(job.content.replace(/^\uFEFF/, '')) as AnalysisRecord);
      } else throw new Error('Unsupported comparison operation.');
      worker = createWorker();
    } catch (cause) { reject(cause); return; }
    let settled = false;
    const finish = (error?: Error, experiment?: GenomeComparisonExperiment) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Preserve the computation outcome when cleanup fails. */ }
      if (error) reject(error); else resolve(experiment!);
    };
    const onAbort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Comparison worker timed out. Select Run to retry.')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = event => {
      if (settled) return;
      try {
        const message = event.data;
        if (!message || message.jobId !== job.jobId) throw new Error('Comparison worker returned a result for a different request.');
        if (message.ok !== true || !message.experiment) throw new Error(message.error || 'Comparison worker returned no complete response.');
        const experiment = validateExperiment(message.experiment);
        if (job.kind === 'analyze' ? !same(expected, [experiment.genomeA, experiment.genomeB, experiment.options])
          : serializeAnalysisRecord(experiment.record) !== expectedRecord) {
          throw new Error('Comparison worker returned evidence for different inputs or settings.');
        }
        finish(undefined, experiment);
      } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
    };
    worker.onerror = () => finish(new Error('The comparison worker failed. Select Run to retry.'));
    worker.onmessageerror = () => finish(new Error('The comparison worker returned unreadable data. Select Run to retry.'));
    try { if (signal?.aborted) onAbort(); else worker.postMessage(job, transfer); }
    catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

function readWithin<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (cause?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (cause !== undefined) reject(cause); else resolve(value!);
    };
    const cancel = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Comparison input read timed out. Select Run to retry.')), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(value => finish(undefined, value), cause => finish(cause ?? new Error('Comparison input could not be read.')));
    if (signal.aborted) cancel();
  });
}

/** Snapshot metadata before sequence reads, then retain exactly the complete bases consumed. */
export function readComparisonPair(repository: Pick<PhageRepository, 'getPhageById' | 'getSequenceWindow'>,
  selectedA: PhageSummary, selectedB: PhageSummary, signal: AbortSignal, timeoutMs = 30000): Promise<[ComparisonGenomeInput, ComparisonGenomeInput]> {
  if (signal.aborted) return Promise.reject(cancelled());
  const controller = new AbortController(), stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  const reading = controller.signal;
  return readWithin((async () => {
    const [readA, readB] = await Promise.all([repository.getPhageById(selectedA.id), repository.getPhageById(selectedB.id)]);
    if (reading.aborted) throw cancelled();
    if (!readA || !readB) throw new Error('A selected genome is no longer available. Select the genomes again.');
    if (readA.id !== selectedA.id || readB.id !== selectedB.id || readA.accession !== selectedA.accession || readB.accession !== selectedB.accession) {
      throw new Error('The loaded genomes do not match the selected sources.');
    }
    const genomes = [structuredClone(readA), structuredClone(readB)] as const;
    for (const genome of genomes) if (!index(genome.genomeLength, GENOME_COMPARISON_LIMITS.sequenceBases) || !genome.genomeLength) {
      throw new Error('Both genomes need a known positive length of at most 1,000,000 bases.');
    }
    const sequences = await Promise.all(genomes.map(genome => repository.getSequenceWindow(genome.id, 0, genome.genomeLength!)));
    if (reading.aborted) throw cancelled();
    if (sequences.some((sequence, i) => sequence.length !== genomes[i].genomeLength)) throw new Error('A complete sequence could not be loaded for both genomes.');
    return genomes.map((genome, i) => ({ phage: { id: genome.id, name: genome.name, accession: genome.accession },
      source: genome.localGenome ? 'local' : 'catalog', sequence: sequences[i], genes: genome.genes ?? [],
      codonUsage: genome.codonUsage ?? null })) as [ComparisonGenomeInput, ComparisonGenomeInput];
  })(), reading, timeoutMs).finally(() => { controller.abort(); signal.removeEventListener('abort', stop); });
}

export interface ComparisonReplaySnapshot {
  accepted: GenomeComparisonExperiment | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
}
/** Reopening is independent of the live selection; only successful fresh replay replaces it. */
export class ComparisonReplaySession {
  private active = false;
  private owner: { scope: object; controller: AbortController } | null = null;
  private listeners = new Set<() => void>();
  private snapshot: ComparisonReplaySnapshot = { accepted: null, busy: false, error: null, notice: null };
  constructor(private readonly factory: () => ComparisonWorker = defaultFactory,
    private readonly timeoutMs = 300000, private readonly readTimeoutMs = 30000) {}
  getSnapshot = (): ComparisonReplaySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ComparisonReplaySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }; for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (scope?: object): void => {
    if (!this.owner || scope && this.owner.scope !== scope) return;
    const owner = this.owner; this.owner = null; owner.controller.abort();
    this.publish({ busy: false, notice: 'Comparison replay cancelled; accepted evidence is unchanged.' });
  };
  run = async (scope: object, content: string | (() => Promise<string>)): Promise<boolean> => {
    if (!this.active) return false;
    this.cancel(); const owner = { scope, controller: new AbortController() }; this.owner = owner;
    const signal = owner.controller.signal, current = () => this.active && this.owner === owner && !signal.aborted;
    this.publish({ busy: true, error: null, notice: null });
    try {
      const text = await readWithin(typeof content === 'function' ? content() : Promise.resolve(content), signal, this.readTimeoutMs);
      if (!current()) return false;
      const accepted = await runWebComparison({ kind: 'replay', jobId: crypto.randomUUID(), content: text }, [], signal, this.timeoutMs, this.factory);
      if (!current()) return false;
      this.publish({ accepted, notice: 'Saved inputs, settings and complete comparison verified by fresh computation.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : 'Comparison replay failed.' });
      return false;
    } finally {
      if (current()) { this.owner = null; this.publish({ busy: false }); }
    }
  };
}
