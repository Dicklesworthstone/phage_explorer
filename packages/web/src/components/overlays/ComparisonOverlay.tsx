import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOverlay } from './OverlayProvider';
import { Overlay } from './Overlay';
import { Badge } from '../ui/Badge';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import type { PhageRepository } from '../../db';
import type { PhageSummary } from '@phage-explorer/core';
import type { ComparisonSummary, GenomeComparisonResult, KmerIdentityEstimate, SequenceDiffResult, StructuralVariantCall, StructuralVariantType } from '@phage-explorer/comparison';
import { formatSimilarity } from '@phage-explorer/comparison';
import { usePhageStore } from '@phage-explorer/state';
import DiffHighlighter from '../DiffHighlighter';
import { OverlayEmptyState, OverlayErrorState, OverlayLoadingState, OverlayStack } from './primitives';
import { SharedSequencePool } from '../../workers/SharedSequencePool';
import type { ComparisonJob, ComparisonWorkerMessage } from '../../workers/types';

function formatBpRange(start: number, end: number): string {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return `${lo.toLocaleString()}–${hi.toLocaleString()}`;
}

function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return '—';
  return `${Math.round(confidence * 100)}%`;
}

function svBadgeVariant(type: StructuralVariantType): 'info' | 'warning' | 'error' | 'success' {
  switch (type) {
    case 'deletion':
      return 'error';
    case 'insertion':
      return 'info';
    case 'inversion':
      return 'warning';
    case 'duplication':
      return 'warning';
    case 'translocation':
      return 'warning';
  }
}

function sortSvCalls(a: StructuralVariantCall, b: StructuralVariantCall): number {
  const conf = (b.confidence ?? 0) - (a.confidence ?? 0);
  if (conf !== 0) return conf;
  const sizeA = Math.max(a.sizeA ?? 0, a.sizeB ?? 0);
  const sizeB = Math.max(b.sizeA ?? 0, b.sizeB ?? 0);
  return sizeB - sizeA;
}

interface ComparisonOverlayProps {
  repository: PhageRepository | null;
}

type ComparisonWorkerPayload = {
  result: GenomeComparisonResult;
  diff: SequenceDiffResult;
};

/** One request owns one worker, including its deadline and cancellation. */
export function runWebComparison(
  job: ComparisonJob & { jobId: string },
  transfer: Transferable[] = [],
  signal?: AbortSignal,
  timeoutMs = 300000,
  createWorker: () => Worker = () => new Worker(new URL('../../workers/comparison.worker.ts', import.meta.url), { type: 'module' }),
): Promise<ComparisonWorkerPayload> {
  return new Promise((resolve, reject) => {
    const cancelled = () => new DOMException('Comparison cancelled.', 'AbortError');
    if (signal?.aborted) { reject(cancelled()); return; }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      reject(new Error('Comparison timeout must be a positive integer.')); return;
    }
    let worker: Worker;
    try { worker = createWorker(); } catch (error) { reject(error); return; }
    let settled = false;
    const finish = (error?: Error, payload?: ComparisonWorkerPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(payload!);
    };
    const onAbort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Comparison worker timed out. Select Run to retry.')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<ComparisonWorkerMessage>) => {
      if (settled) return;
      const message = event.data;
      if (!message || message.jobId !== job.jobId) {
        finish(new Error('Comparison worker returned a result for a different request.')); return;
      }
      if (message.ok !== true || !message.result || !message.diff) {
        finish(new Error(message.error ?? 'Comparison worker returned no complete response.')); return;
      }
      const { result, diff } = message;
      const samePhage = (actual: GenomeComparisonResult['phageA'] | undefined, expected: ComparisonJob['phageA']) =>
        actual?.id === expected.id && actual.name === expected.name && actual.accession === expected.accession;
      const lengthA = 'sequenceA' in job ? job.sequenceA.length : job.sequenceARef.length;
      const lengthB = 'sequenceB' in job ? job.sequenceB.length : job.sequenceBRef.length;
      if (!samePhage(result.phageA, job.phageA) || !samePhage(result.phageB, job.phageB)
        || result.biological?.lengthA !== lengthA || result.biological?.lengthB !== lengthB
        || (diff.status !== 'complete' && diff.status !== 'unavailable')
        || diff.status === 'complete' && (diff.stats?.lengthA !== lengthA || diff.stats?.lengthB !== lengthB
          || !(diff.mask instanceof Uint8Array) || diff.mask.length !== lengthA
          || !Array.isArray(diff.positions) || !Array.isArray(diff.runs))
        || diff.status === 'unavailable' && (typeof diff.reason !== 'string' || !diff.reason)) {
        finish(new Error('Comparison worker returned a result for different inputs.')); return;
      }
      finish(undefined, { result, diff });
    };
    worker.onerror = () => finish(new Error('The comparison worker failed. Select Run to retry.'));
    worker.onmessageerror = () => finish(new Error('The comparison worker returned unreadable data. Select Run to retry.'));
    try { if (signal?.aborted) onAbort(); else worker.postMessage(job, transfer); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

interface OwnedComparison {
  repository: PhageRepository;
  phageA: PhageSummary;
  phageB: PhageSummary;
  revision: number;
  payload: ComparisonWorkerPayload | null;
  sequenceA: string;
  sequenceB: string;
  error: string | null;
  loading: boolean;
}

export function ComparisonSummaryStatus({ summary }: { summary: ComparisonSummary }): React.ReactElement {
  return <Badge>{summary.overallSimilarity === null || summary.similarityCategory === 'insufficient_data'
    ? 'Insufficient resolved sequence' : formatSimilarity(summary.overallSimilarity)}</Badge>;
}

/** The actual biological-tab card, also exercised with computed evidence. */
export function ComparisonKmerIdentity({ estimate }: { estimate: KmerIdentityEstimate }): React.ReactElement {
  const coverage = (input: KmerIdentityEstimate['coverageA']) =>
    `${input.validWindows.toLocaleString()}/${input.totalWindows.toLocaleString()} (${(input.validWindowFraction * 100).toFixed(1)}%)`;
  return <div className="metric-card">
    <div className="metric-label">Mash-style k-mer identity estimate</div>
    <div className="metric-value">{estimate.percent === null ? 'Unavailable' : `${estimate.percent.toFixed(2)}%`}</div>
    <div className="text-dim">Exact canonical {estimate.k}-mers · strand independent</div>
    <div className="text-dim">Distinct A/B: {estimate.coverageA.distinctKmers.toLocaleString()} / {estimate.coverageB.distinctKmers.toLocaleString()}
      {' '}· shared {estimate.sharedKmers.toLocaleString()}</div>
    <div className="text-dim">Resolved windows A: {coverage(estimate.coverageA)}; B: {coverage(estimate.coverageB)}</div>
    {estimate.unavailableReason && <p role="status">{estimate.unavailableReason}</p>}
    {estimate.warnings.map(warning => <p className="text-dim" key={warning}>{warning}</p>)}
  </div>;
}

export function ComparisonGcContent({ biological }: {
  biological: GenomeComparisonResult['biological'];
}): React.ReactElement {
  const hasA = biological.gcResolvedBasesA > 0;
  const hasB = biological.gcResolvedBasesB > 0;
  return <div className="metric-card">
    <div className="metric-label">GC content</div>
    <div className="metric-value">
      {hasA ? `${biological.gcContentA.toFixed(2)}%` : 'Unavailable'} /{' '}
      {hasB ? `${biological.gcContentB.toFixed(2)}%` : 'Unavailable'}
    </div>
    <div className="text-dim">Δ {hasA && hasB ? `${biological.gcDifference.toFixed(2)}%` : 'Unavailable'}</div>
    <div className="text-dim">
      Resolved A/C/G/T bases: A {biological.gcResolvedBasesA}/{biological.lengthA}; B{' '}
      {biological.gcResolvedBasesB}/{biological.lengthB}. Ambiguous bases are excluded from GC%.
    </div>
  </div>;
}

export function ComparisonDiffView({ diff, sequenceA, sequenceB }: {
  diff: SequenceDiffResult | null; sequenceA: string; sequenceB: string;
}): React.ReactElement {
  if (!diff) return <div className="text-dim">Run a comparison to view diff highlights.</div>;
  if (diff.status === 'unavailable') return <div role="status">
    <h3>Exact sequence diff unavailable</h3><p>{diff.reason}</p>
    <p className="text-dim">Other comparison metrics remain available. No partial or approximate diff is displayed.</p>
  </div>;
  const changes = diff.runs.filter(run => run.operation !== 'match');
  const interval = (start: number, end: number) => start === end ? `between bases ${start} and ${start + 1}`
    : `${(start + 1).toLocaleString()}–${end.toLocaleString()}`;
  return <div>
    <p>{diff.method}. Edit distance: <strong>{diff.stats.distance.toLocaleString()}</strong>.
      {' '}Each substituted, inserted or deleted base costs one.</p>
    <p className="text-dim">Alignment uses the submitted strand and origin. Alternative optimal alignments can place edits differently in repeats.
      {' '}Identity counts equal symbols over alignment columns; ambiguous IUPAC symbols match literally, without resolving their bases.
      {diff.stats.ambiguousColumns > 0 && ` ${diff.stats.ambiguousColumns.toLocaleString()} columns contain ambiguous bases.`}</p>
    {diff.stats.distance === 0 ? <p data-testid="comparison-identical">Sequences have identical symbols (ignoring letter case).</p>
      : <>
        <DiffHighlighter sequence={sequenceA} diffSequence={sequenceB} diffMask={diff.mask}
          diffPositions={diff.positions} stats={diff.stats} />
        <details><summary>Aligned edit coordinates ({changes.length.toLocaleString()} runs)</summary>
          <p>Base ranges are 1-based and inclusive. Insertions/deletions use interbase boundaries on the empty side.
            {' '}Insertion highlights anchor to the next A base, or the last A base at the end; these coordinates give the exact boundary.</p>
          {changes.length > 100 && <p>Showing the first 100 runs. Counts and highlights include the complete alignment.</p>}
          <table aria-label="Aligned sequence edit coordinates"><thead><tr><th>Change</th><th>Genome A</th><th>Genome B</th><th>Bases</th></tr></thead>
            <tbody>{changes.slice(0, 100).map((run, index) => <tr key={index}>
              <td>{run.operation}</td><td>{interval(run.startA, run.endA)}</td><td>{interval(run.startB, run.endB)}</td>
              <td>{Math.max(run.endA - run.startA, run.endB - run.startB).toLocaleString()}</td>
            </tr>)}</tbody>
          </table>
        </details>
      </>}
  </div>;
}

export const ComparisonOverlay: React.FC<ComparisonOverlayProps> = ({ repository }) => {
  const { isOpen, close } = useOverlay();

  const phages = usePhageStore((s) => s.phages);
  const phageAIndex = usePhageStore((s) => s.comparisonPhageAIndex);
  const phageBIndex = usePhageStore((s) => s.comparisonPhageBIndex);
  const comparisonTab = usePhageStore((s) => s.comparisonTab);
  const setComparisonPhageA = usePhageStore((s) => s.setComparisonPhageA);
  const setComparisonPhageB = usePhageStore((s) => s.setComparisonPhageB);
  const setComparisonResult = usePhageStore((s) => s.setComparisonResult);
  const setComparisonLoading = usePhageStore((s) => s.setComparisonLoading);
  const setComparisonTab = usePhageStore((s) => s.setComparisonTab);
  const closeComparison = usePhageStore((s) => s.closeComparison);

  const [comparison, setComparison] = useState<OwnedComparison | null>(null);
  const [revision, setRevision] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const defaulted = useRef(false);
  const overlayOpen = isOpen('comparison');
  const phageA = phageAIndex !== null ? phages[phageAIndex] : null;
  const phageB = phageBIndex !== null ? phages[phageBIndex] : null;
  const canCompare = Boolean(repository && phageA && phageB && phageA.id !== phageB.id);
  const source = useRef({ repository, phageA, phageB, revision, overlayOpen });
  source.current = { repository, phageA, phageB, revision, overlayOpen };
  // The store's result is also consumed outside this panel. Rendering additionally
  // requires the exact repository/pair that produced both metrics and diff bases.
  const owned = overlayOpen && comparison?.repository === repository && comparison.phageA === phageA
    && comparison.phageB === phageB && comparison.revision === revision ? comparison : null;
  const comparisonResult = owned?.payload?.result ?? null;
  const comparisonLoading = overlayOpen && canCompare && (!owned || owned.loading);
  const error = owned?.error ?? null;
  const diff = owned?.payload?.diff ?? null;
  const sequenceA = owned?.sequenceA ?? '';
  const sequenceB = owned?.sequenceB ?? '';

  // Choose defaults once per opening; an explicit empty selection stays empty.
  useEffect(() => {
    if (!overlayOpen) { defaulted.current = false; return; }
    if (defaulted.current || phages.length < 2) return;
    defaulted.current = true;
    if (phageAIndex === null) setComparisonPhageA(phageBIndex === 0 ? 1 : 0);
    if (phageBIndex === null) setComparisonPhageB(phageAIndex === 1 ? 0 : 1);
  }, [overlayOpen, phageAIndex, phageBIndex, phages.length, setComparisonPhageA, setComparisonPhageB]);

  const runComparison = useCallback(() => {
    operation.current?.abort();
    setRevision(value => value + 1);
  }, []);

  const handleClose = useCallback(() => {
    operation.current?.abort();
    setComparisonLoading(false);
    closeComparison();
    close('comparison');
  }, [close, closeComparison, setComparisonLoading]);

  // Reads, computation and publication share one owner. Invalid selections,
  // repository replacement, closure and retries all revoke the previous owner.
  useEffect(() => {
    setComparisonResult(null);
    if (!overlayOpen || !repository || !phageA || !phageB || phageA.id === phageB.id) {
      setComparison(null);
      setComparisonLoading(false);
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    const owner = { repository, phageA, phageB, revision };
    const current = () => {
      const state = usePhageStore.getState();
      return operation.current === controller && !controller.signal.aborted
        && source.current.overlayOpen && source.current.repository === repository
        && source.current.phageA === phageA && source.current.phageB === phageB
        && source.current.revision === revision
        && state.phages[state.comparisonPhageAIndex ?? -1] === phageA
        && state.phages[state.comparisonPhageBIndex ?? -1] === phageB;
    };
    setComparison({ ...owner, payload: null, sequenceA: '', sequenceB: '', error: null, loading: true });
    setComparisonLoading(true);
    void (async () => {
      try {
        const [fullA, fullB] = await Promise.all([
          repository.getPhageById(phageA.id),
          repository.getPhageById(phageB.id),
        ]);
        // An abandoned metadata read must not start another whole-genome read.
        if (!current()) return;
        if (!fullA || !fullB) {
          throw new Error('A selected genome is no longer available. Select the genomes again.');
        }
        if (fullA.id !== phageA.id || fullB.id !== phageB.id
          || fullA.accession !== phageA.accession || fullB.accession !== phageB.accession) {
          throw new Error('The loaded genomes do not match the selected sources.');
        }
        const lengthA = fullA.genomeLength ?? 0, lengthB = fullB.genomeLength ?? 0;
        if (!Number.isSafeInteger(lengthA) || !Number.isSafeInteger(lengthB) || lengthA <= 0 || lengthB <= 0) {
          throw new Error('Both genomes need a known, nonzero sequence length.');
        }
        const [seqA, seqB] = await Promise.all([
          repository.getSequenceWindow(phageA.id, 0, lengthA),
          repository.getSequenceWindow(phageB.id, 0, lengthB),
        ]);
        if (!current()) return;
        if (seqA.length !== lengthA || seqB.length !== lengthB) {
          throw new Error('A complete sequence could not be loaded for both genomes.');
        }
        const pool = SharedSequencePool.getInstance();
        const { ref: sequenceARef, transfer: transferA } = pool.getOrCreateRef(phageA.id, seqA);
        const { ref: sequenceBRef, transfer: transferB } = pool.getOrCreateRef(phageB.id, seqB);
        const job = {
          jobId: crypto.randomUUID(),
          phageA: { id: phageA.id, name: phageA.name, accession: phageA.accession },
          phageB: { id: phageB.id, name: phageB.name, accession: phageB.accession },
          sequenceARef, sequenceBRef,
          genesA: fullA.genes ?? [], genesB: fullB.genes ?? [],
          codonUsageA: fullA.codonUsage ?? null, codonUsageB: fullB.codonUsage ?? null,
        };
        const payload = await runWebComparison(job, [...transferA, ...transferB], controller.signal);
        if (!current()) return;
        setComparison({ ...owner, payload, sequenceA: seqA, sequenceB: seqB, error: null, loading: false });
        setComparisonResult(payload.result);
      } catch (cause) {
        if (current()) setComparison({ ...owner, payload: null, sequenceA: '', sequenceB: '', loading: false,
          error: cause instanceof Error ? cause.message : 'Comparison failed' });
      } finally {
        if (current()) setComparisonLoading(false);
      }
    })();
    return () => {
      controller.abort();
      if (operation.current === controller) {
        operation.current = null;
        setComparisonLoading(false);
        setComparisonResult(null);
      }
    };
  }, [overlayOpen, phageA, phageB, repository, revision, setComparisonLoading, setComparisonResult]);

  const header = useMemo(() => {
    return (
      <div className="comparison-header" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <select
          value={phageAIndex ?? ''}
          aria-label="Phage A"
          onChange={(e) => setComparisonPhageA(e.target.value === '' ? null : Number(e.target.value))}
          style={{ flex: 1, padding: '0.4rem' }}
        >
          <option value="">Select Phage A</option>
          {phages.map((p, idx) => (
            <option key={p.id} value={idx} disabled={idx === phageBIndex}>
              A: {p.name}
            </option>
          ))}
        </select>
        <select
          value={phageBIndex ?? ''}
          aria-label="Phage B"
          onChange={(e) => setComparisonPhageB(e.target.value === '' ? null : Number(e.target.value))}
          style={{ flex: 1, padding: '0.4rem' }}
        >
          <option value="">Select Phage B</option>
          {phages.map((p, idx) => (
            <option key={p.id} value={idx} disabled={idx === phageAIndex}>
              B: {p.name}
            </option>
          ))}
        </select>
        <button className="btn" type="button" onClick={() => void runComparison()} disabled={comparisonLoading || !canCompare}>
          {comparisonLoading ? 'Comparing…' : 'Run'}
        </button>
      </div>
    );
  }, [canCompare, comparisonLoading, phageAIndex, phageBIndex, phages, runComparison, setComparisonPhageA, setComparisonPhageB]);

  const tabs = useMemo(
    () => [
      { id: 'summary', label: 'Summary' },
      { id: 'kmer', label: 'K-mer' },
      { id: 'information', label: 'Info' },
      { id: 'correlation', label: 'Correlation' },
      { id: 'biological', label: 'Biological' },
      { id: 'genes', label: 'Genes' },
      { id: 'diff', label: 'Diff' },
    ],
    []
  );

  const content = useMemo(() => {
    if (!repository) {
      return (
        <OverlayEmptyState
          message="Database is still loading."
          hint="Wait a moment for the genome database to finish initializing, then try Comparison again."
        />
      );
    }

    if (error) {
      return (
        <OverlayErrorState
          message="Comparison failed."
          details={error}
          onRetry={() => void runComparison()}
        />
      );
    }
    if (comparisonLoading) {
      return (
        <OverlayLoadingState message="Running comparison…">
          <AnalysisPanelSkeleton rows={5} />
        </OverlayLoadingState>
      );
    }

    if (!phageA || !phageB) {
      return (
        <OverlayEmptyState
          message="Select two phages to compare."
          hint="Pick Phage A and Phage B above, then run the comparison."
        />
      );
    }

    if (phageA.id === phageB.id) {
      return (
        <OverlayEmptyState
          message="Pick two different phages."
          hint="Comparison requires two distinct genomes."
        />
      );
    }
    if (!comparisonResult) {
      return (
        <OverlayEmptyState
          message="Run a comparison to see results."
          hint="Press “Run” to compute similarity, k-mer overlap, and more."
          action={
            <button className="btn" type="button" onClick={() => void runComparison()}>
              Run comparison
            </button>
          }
        />
      );
    }
    const formatPct = (value: number, digits = 2) => `${value.toFixed(digits)}%`;
    const summary = comparisonResult.summary;
    const hasSequenceEvidence = summary.overallSimilarity !== null && summary.similarityCategory !== 'insufficient_data';
    const computedAt = new Date(comparisonResult.computedAt);
    if (comparisonTab === 'summary') {
      return (
        <div className="panel">
          <div className="panel-header">
            <h3>Overall Similarity</h3>
            <ComparisonSummaryStatus summary={summary} />
          </div>
          <p className="text-dim">{hasSequenceEvidence
            ? 'Descriptive aggregate of composition and annotation scores; no aligned identity or species inference.'
            : 'No overall similarity score is available without resolved k-mer evidence.'}</p>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">Sequence</div>
              <div className="metric-value">{hasSequenceEvidence ? formatSimilarity(summary.sequenceSimilarity) : 'Unavailable'}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Composition</div>
              <div className="metric-value">{hasSequenceEvidence ? formatSimilarity(summary.compositionSimilarity) : 'Unavailable'}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Codon usage</div>
              <div className="metric-value">{formatSimilarity(summary.codonUsageSimilarity)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Gene content</div>
              <div className="metric-value">{formatSimilarity(summary.geneContentSimilarity)}</div>
            </div>
          </div>
          <ul className="insights">
            {summary.insights.map((insight, idx) => (
              <li key={`${insight.category}-${idx}`}>
                <strong>{insight.category}:</strong> {insight.message}{' '}
                <span className="text-dim">({insight.significance})</span>
              </li>
            ))}
          </ul>
          <p className="text-dim">
            Runtime: {comparisonResult.computeTimeMs.toLocaleString()} ms · Computed:{' '}
            {computedAt.toLocaleString()}
          </p>
        </div>
      );
    }
    if (comparisonTab === 'kmer') {
      return (
        <div className="panel">
          <div className="panel-header">
            <h3>K-mer comparison</h3>
            <span className="text-dim">Sizes: {comparisonResult.kmerAnalysis.map(k => k.k).join(', ')}</span>
          </div>
          <div className="table">
            <div className="table-row table-head">
              <div>k</div>
              <div>Jaccard</div>
              <div>Contain A∈B</div>
              <div>Contain B∈A</div>
              <div>Cosine</div>
              <div>Shared</div>
              <div>Unique A/B</div>
            </div>
            {comparisonResult.kmerAnalysis.map((row) => (
              <div className="table-row" key={row.k}>
                <div>{row.k}</div>
                <div>{formatPct(row.jaccardIndex * 100)}</div>
                <div>{formatPct(row.containmentAinB * 100)}</div>
                <div>{formatPct(row.containmentBinA * 100)}</div>
                <div>{formatPct(row.cosineSimilarity * 100)}</div>
                <div>{row.sharedKmers.toLocaleString()}</div>
                <div>
                  {row.uniqueKmersA.toLocaleString()} / {row.uniqueKmersB.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (comparisonTab === 'information') {
      const info = comparisonResult.informationTheory;
      return (
        <div className="panel">
          <div className="panel-header">
            <h3>Information theory</h3>
            <span className="text-dim">Mutual information & divergence</span>
          </div>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">Normalized MI</div>
              <div className="metric-value">{formatPct(info.normalizedMI * 100)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Mutual information</div>
              <div className="metric-value">{info.mutualInformation.toFixed(3)} bits</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">JSD</div>
              <div className="metric-value">{info.jensenShannonDivergence.toFixed(3)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">KL A→B / B→A</div>
              <div className="metric-value">
                {info.kullbackLeiblerAtoB.toFixed(3)} / {info.kullbackLeiblerBtoA.toFixed(3)}
              </div>
            </div>
          </div>
          <p className="text-dim">
            Entropy A/B: {info.entropyA.toFixed(3)} / {info.entropyB.toFixed(3)} · Joint: {info.jointEntropy.toFixed(3)}
          </p>
        </div>
      );
    }
    if (comparisonTab === 'correlation') {
      const corr = comparisonResult.rankCorrelation;
      return (
        <div className="panel">
          <div className="panel-header">
            <h3>Rank correlation</h3>
            <span className="text-dim">Codon frequency concordance</span>
          </div>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">Spearman ρ</div>
              <div className="metric-value">{corr.spearmanRho.toFixed(3)}</div>
              <div className="text-dim">Strength: {corr.spearmanStrength}</div>
              <div className="text-dim">p={corr.spearmanPValue.toExponential(2)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Kendall τ</div>
              <div className="metric-value">{corr.kendallTau.toFixed(3)}</div>
              <div className="text-dim">Strength: {corr.kendallStrength}</div>
              <div className="text-dim">p={corr.kendallPValue.toExponential(2)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Hoeffding D</div>
              <div className="metric-value">{corr.hoeffdingD.toFixed(4)}</div>
            </div>
          </div>
        </div>
      );
    }
    if (comparisonTab === 'biological') {
      const bio = comparisonResult.biological;
      const codon = comparisonResult.codonUsage;
      const aa = comparisonResult.aminoAcidUsage;
      return (
        <div className="panel">
          <div className="panel-header">
            <h3>Biological metrics</h3>
            <span className="text-dim">K-mer identity estimate, GC, lengths, codon & amino acid usage</span>
          </div>
          <div className="metrics-grid">
            <ComparisonKmerIdentity estimate={bio.kmerIdentity} />
            <ComparisonGcContent biological={bio} />
            <div className="metric-card">
              <div className="metric-label">Genome length</div>
              <div className="metric-value">
                {bio.lengthA.toLocaleString()} / {bio.lengthB.toLocaleString()}
              </div>
              <div className="text-dim">Ratio {bio.lengthRatio.toFixed(2)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Codon usage</div>
              <div className="metric-value">{formatPct(codon.rscuCosineSimilarity * 100)}</div>
              <div className="text-dim">CAI A/B: {codon.caiA.toFixed(3)} / {codon.caiB.toFixed(3)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Amino Acid similarity</div>
              <div className="metric-value">{formatPct(aa.cosineSimilarity * 100)}</div>
              <div className="text-dim">Hydrophobic: {formatPct(aa.hydrophobicSimilarity * 100)}</div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <h4>Top codon differences</h4>
              <span className="text-dim">Largest RSCU deltas</span>
            </div>
            <div className="table">
              <div className="table-row table-head">
                <div>Codon</div>
                <div>A.A.</div>
                <div>RSCU Δ</div>
                <div>Freq A/B</div>
              </div>
              {codon.topDifferentCodons.slice(0, 6).map((c) => (
                <div className="table-row" key={c.codon}>
                  <div>{c.codon}</div>
                  <div>{c.aminoAcid}</div>
                  <div>{c.difference.toFixed(3)}</div>
                  <div>
                    {c.frequencyA.toFixed(3)} / {c.frequencyB.toFixed(3)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }
    if (comparisonTab === 'genes') {
      const genes = comparisonResult.geneContent;
      const structural = comparisonResult.structuralVariants;
      return (
        <div className="panel">
          <div className="panel-header">
            <h3>Gene content</h3>
            <span className="text-dim">Shared vs unique gene counts</span>
          </div>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">Total genes</div>
              <div className="metric-value">
                {genes.genesA} / {genes.genesB}
              </div>
              <div className="text-dim">Density: {genes.geneDensityA.toFixed(2)} / {genes.geneDensityB.toFixed(2)} per kb</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Shared names</div>
              <div className="metric-value">{genes.sharedGeneNames}</div>
              <div className="text-dim">Jaccard: {formatPct(genes.geneNameJaccard * 100)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Unique A / B</div>
              <div className="metric-value">
                {genes.uniqueToA} / {genes.uniqueToB}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Avg length</div>
              <div className="metric-value">
                {genes.avgGeneLengthA.toFixed(0)} / {genes.avgGeneLengthB.toFixed(0)} bp
              </div>
            </div>
          </div>
          <div className="table" style={{ marginTop: '0.5rem' }}>
            <div className="table-row table-head">
              <div>Shared genes (top)</div>
              <div>Unique to A</div>
              <div>Unique to B</div>
            </div>
            <div className="table-row">
              <div>{genes.topSharedGenes.slice(0, 6).join(', ') || '—'}</div>
              <div>{genes.uniqueAGenes.slice(0, 6).join(', ') || '—'}</div>
              <div>{genes.uniqueBGenes.slice(0, 6).join(', ') || '—'}</div>
            </div>
          </div>
          {structural && (
            <div className="panel" style={{ marginTop: '0.75rem' }}>
              <div className="panel-header">
                <h4>Structural variants</h4>
                <span className="text-dim">{structural.calls.length} calls</span>
              </div>
              <div className="metrics-grid">
                {Object.entries(structural.counts).map(([type, count]) => (
                  <div key={type} className="metric-card">
                    <div className="metric-label">{type}</div>
                    <div className="metric-value">{count}</div>
                  </div>
                ))}
                <div className="metric-card">
                  <div className="metric-label">Anchors used</div>
                  <div className="metric-value">{structural.anchorsUsed}</div>
                </div>
              </div>
              {structural.calls.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
                  {[...structural.calls].sort(sortSvCalls).map((call) => (
                    <details key={call.id} className="panel panel-compact">
                      <summary
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '0.75rem',
                          cursor: 'pointer',
                          listStyle: 'none',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                          <Badge variant={svBadgeVariant(call.type)}>{call.type}</Badge>
                          <span className="text-dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            conf {formatConfidence(call.confidence)}
                          </span>
                          <span className="text-dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            A {formatBpRange(call.startA, call.endA)}
                          </span>
                          <span className="text-dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            B {formatBpRange(call.startB, call.endB)}
                          </span>
                        </div>
                        <span className="text-dim" style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                          {call.sizeA.toLocaleString()} / {call.sizeB.toLocaleString()} bp
                        </span>
                      </summary>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                        <div className="text-dim">
                          <strong>Evidence:</strong> {call.evidence?.length ? call.evidence.join(' · ') : '—'}
                        </div>
                        <div className="text-dim">
                          <strong>Affected genes (A):</strong>{' '}
                          {call.affectedGenesA?.length ? call.affectedGenesA.join(', ') : '—'}
                        </div>
                        <div className="text-dim">
                          <strong>Affected genes (B):</strong>{' '}
                          {call.affectedGenesB?.length ? call.affectedGenesB.join(', ') : '—'}
                        </div>
                      </div>
                    </details>
                  ))}
                </div>
              ) : (
                <div className="text-dim" style={{ marginTop: '0.75rem' }}>
                  No structural variant calls detected with the current thresholds.
                </div>
              )}
            </div>
          )}
        </div>
      );
    }
    if (comparisonTab === 'diff') {
      return <ComparisonDiffView diff={diff} sequenceA={sequenceA} sequenceB={sequenceB} />;
    }
    return (
      <div className="text-dim">
        Tab <strong>{comparisonTab}</strong> not yet implemented. Results available in summary above.
      </div>
    );
  }, [comparisonLoading, comparisonResult, comparisonTab, diff, error, phageA, phageB, repository, runComparison, sequenceA, sequenceB]);

  return (
    <Overlay
      id="comparison"
      title="Comparison"
      size="xl"
      onClose={handleClose}
      showBackdrop
    >
      <OverlayStack gap="sm">
        {header}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`chip ${comparisonTab === t.id ? 'chip-active' : ''}`}
              type="button"
              onClick={() => setComparisonTab(t.id as typeof comparisonTab)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="panel" style={{ minHeight: '260px' }}>
          {content}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button
            className="btn"
            type="button"
            onClick={() => void runComparison()}
            disabled={comparisonLoading || !canCompare}
          >
            {comparisonLoading ? 'Running…' : 'Re-run'}
          </button>
          <button className="btn-secondary" type="button" onClick={handleClose}>
            Close
          </button>
        </div>
      </OverlayStack>
    </Overlay>
  );
};

export default ComparisonOverlay;
