import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useOverlay } from './OverlayProvider';
import { Overlay } from './Overlay';
import { Badge } from '../ui/Badge';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import type { PhageRepository } from '../../db';
import { serializeAnalysisRecord, type PhageSummary } from '@phage-explorer/core';
import type { ComparisonSummary, GenomeComparisonResult, KmerIdentityEstimate, SequenceDiffResult, StructuralVariantCall, StructuralVariantReport } from '@phage-explorer/comparison';
import { DEFAULT_GENOME_COMPARISON_OPTIONS, GENOME_COMPARISON_LIMITS, formatSimilarity, resolveGenomeComparisonOptions,
  type GenomeComparisonExperiment, type GenomeComparisonOptions } from '@phage-explorer/comparison';
import { usePhageStore } from '@phage-explorer/state';
import DiffHighlighter from '../DiffHighlighter';
import { OverlayEmptyState, OverlayErrorState, OverlayLoadingState, OverlayStack } from './primitives';
import { SharedSequencePool } from '../../workers/SharedSequencePool';
import { ComparisonReplaySession, readComparisonPair, runWebComparison } from '../../workers/ComparisonSession';
import { downloadString } from '../../utils/export';
import { SavedResearchPanel } from './SavedResearchPanel';
import { replaySavedResearch } from '../../db/research-storage';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';

function formatBpRange(start: number, end: number): string {
  if (start === end) return start === 0 ? 'before base 1' : `after base ${start.toLocaleString()}`;
  return `${(start + 1).toLocaleString()}–${end.toLocaleString()}`;
}

function sortSvCalls(a: StructuralVariantCall, b: StructuralVariantCall): number {
  return Math.max(b.sizeA, b.sizeB) - Math.max(a.sizeA, a.sizeB) || a.startA - b.startA || a.startB - b.startB;
}

/** The actual Genes-tab indel view, also exercised with sequence-derived reports. */
export function ComparisonStructuralVariants({ report }: { report: StructuralVariantReport }): React.ReactElement {
  return <section className="panel" aria-label="Aligned insertions and deletions" style={{ marginTop: '0.75rem' }}>
    <div className="panel-header"><h4>Aligned insertions and deletions</h4></div>
    <p className="text-dim">{report.method}. Minimum reported indel: {report.minGapBp.toLocaleString()} bp.</p>
    {report.status === 'unavailable' ? <p role="status">Aligned indel evidence unavailable: {report.reason}</p> : <>
      <div className="metrics-grid">
        {Object.entries(report.counts).map(([type, count]) => <div key={type} className="metric-card">
          <div className="metric-label">{type} runs</div><div className="metric-value">{count}</div>
        </div>)}
      </div>
      <p className="text-dim">Relative to genome A. Displayed base ranges are one-based and inclusive; insertion sites are between bases.</p>
      {report.calls.length ? <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {[...report.calls].sort(sortSvCalls).slice(0, 100).map(call => <details key={call.id} className="panel panel-compact">
          <summary style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', cursor: 'pointer' }}>
            <Badge variant={call.type === 'deletion' ? 'error' : 'info'}>{call.type}</Badge>
            <span>A {formatBpRange(call.startA, call.endA)}</span><span>B {formatBpRange(call.startB, call.endB)}</span>
            <span>{call.sizeA.toLocaleString()} / {call.sizeB.toLocaleString()} bp</span>
          </summary>
          <p className="text-dim"><strong>Evidence:</strong> {call.evidence.join(' · ')}</p>
          <p className="text-dim"><strong>Overlapping annotations (A, up to 8):</strong> {call.affectedGenesA.join(', ') || '—'}</p>
          <p className="text-dim"><strong>Overlapping annotations (B, up to 8):</strong> {call.affectedGenesB.join(', ') || '—'}</p>
        </details>)}
        {report.calls.length > 100 && <p>Showing the largest 100 of {report.calls.length.toLocaleString()} reported indels.</p>}
      </div> : <p>No resolved insertion or deletion runs meet the {report.minGapBp.toLocaleString()} bp threshold in this alignment.</p>}
      {(report.belowThreshold > 0 || report.unresolved > 0) && <p className="text-dim">
        Unreported indel runs: {report.belowThreshold.toLocaleString()} below threshold; {report.unresolved.toLocaleString()} with unresolved alleles.
      </p>}
      {report.alignment.ambiguousColumns > 0 && <p className="text-dim">
        {report.alignment.ambiguousColumns.toLocaleString()} alignment columns contain ambiguous bases; their positions can affect the chosen alignment.
      </p>}
    </>}
    {report.limitations.map(limit => <p className="text-dim" key={limit}>{limit}</p>)}
  </section>;
}

interface ComparisonOverlayProps {
  repository: PhageRepository | null;
}

interface OwnedComparison {
  repository: PhageRepository;
  phageA: PhageSummary;
  phageB: PhageSummary;
  revision: number;
  payload: GenomeComparisonExperiment | null;
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

/** Information-tab values retain the distinct full-input and paired samples. */
export function ComparisonInformationTheory({ info }: {
  info: GenomeComparisonResult['informationTheory'];
}): React.ReactElement {
  const value = (number: number | null) => number === null ? 'Unavailable' : number.toFixed(3);
  const coverage = info.coverage;
  return <div className="panel" aria-label="Information theory evidence">
    <div className="panel-header"><h3>Information theory</h3><span className="text-dim">Resolved {info.k}-mer observations</span></div>
    <div className="metrics-grid">
      <div className="metric-card"><div className="metric-label">Normalized MI</div>
        <div className="metric-value">{info.normalizedMI === null ? 'Unavailable' : `${(info.normalizedMI * 100).toFixed(1)}%`}</div></div>
      <div className="metric-card"><div className="metric-label">Position-paired mutual information (bits/base)</div>
        <div className="metric-value">{value(info.mutualInformation)}</div></div>
      <div className="metric-card"><div className="metric-label">JSD (bits/k-mer)</div>
        <div className="metric-value">{value(info.jensenShannonDivergence)}</div></div>
      <div className="metric-card"><div className="metric-label">Floored KL A→B / B→A (bits/k-mer)</div>
        <div className="metric-value">{value(info.kullbackLeiblerAtoB)} / {value(info.kullbackLeiblerBtoA)}</div></div>
    </div>
    {info.normalizedMIUnavailableReason && <p role="status">{info.normalizedMIUnavailableReason}</p>}
    <p className="text-dim">Resolved windows A: {coverage.resolvedWindowsA}/{coverage.totalWindowsA}; B: {coverage.resolvedWindowsB}/{coverage.totalWindowsB}.
      {' '}Jointly resolved pairs: {coverage.resolvedWindowPairs}/{coverage.pairedWindowSlots}.</p>
    <p className="text-dim">Full-input marginal entropy A/B (bits/base): {value(info.entropyA)} / {value(info.entropyB)}.
      {' '}Paired marginal entropy A/B (bits/base): {value(info.pairedEntropyA)} / {value(info.pairedEntropyB)};
      {' '}joint entropy (bits/base): {value(info.jointEntropy)}.</p>
    <p className="text-dim">MI and its normalization use the same jointly resolved windows at matching start positions in the common input prefix.
      This pairing does not establish homology; strand and origin affect it. NMI measures empirical dependence, not nucleotide identity.</p>
    <p className="text-dim">A/C/G/T windows only; ambiguity, gaps and other symbols break windows without shifting coordinates.
      JSD and KL compare each full input distribution, independent of position pairing. Missing distributions are unavailable.
      KL uses a denominator probability floor of {info.klProbabilityFloor}; it is a finite approximation when that floor applies.</p>
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
        <DiffHighlighter isolated sequence={sequenceA} diffSequence={sequenceB} diffMask={diff.mask}
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
  const [options, setOptions] = useState<GenomeComparisonOptions>(() => resolveGenomeComparisonOptions());
  const [draft, setDraft] = useState(() => ({ kmerSizes: DEFAULT_GENOME_COMPARISON_OPTIONS.kmerSizes.join(', '),
    maxEditDistanceLength: String(DEFAULT_GENOME_COMPARISON_OPTIONS.maxEditDistanceLength),
    editDistanceWindowSize: String(DEFAULT_GENOME_COMPARISON_OPTIONS.editDistanceWindowSize),
    editDistanceWindowCount: String(DEFAULT_GENOME_COMPARISON_OPTIONS.editDistanceWindowCount) }));
  const [mode, setMode] = useState<'live' | 'saved'>('live');
  const [libraryBusy, setLibraryBusy] = useState(false), [fileError, setFileError] = useState<string | null>(null);
  const replaySession = useMemo(() => new ComparisonReplaySession(), []);
  const replayScope = useMemo(() => ({}), []);
  const replay = useSyncExternalStore(replaySession.subscribe, replaySession.getSnapshot, replaySession.getSnapshot);
  const operation = useRef<AbortController | null>(null);
  const defaulted = useRef(false);
  const overlayOpen = isOpen('comparison');
  const phageA = phageAIndex !== null ? phages[phageAIndex] : null;
  const phageB = phageBIndex !== null ? phages[phageBIndex] : null;
  const canCompare = Boolean(repository && phageA && phageB && phageA.id !== phageB.id);
  const source = useRef({ repository, phageA, phageB, revision, overlayOpen, mode });
  source.current = { repository, phageA, phageB, revision, overlayOpen, mode };
  // The store's result is also consumed outside this panel. Rendering additionally
  // requires the exact repository/pair that produced both metrics and diff bases.
  const owned = overlayOpen && comparison?.repository === repository && comparison.phageA === phageA
    && comparison.phageB === phageB && comparison.revision === revision ? comparison : null;
  const accepted = mode === 'saved' ? replay.accepted : owned?.payload ?? null;
  const comparisonResult = accepted?.result ?? null;
  const comparisonLoading = mode === 'live' && overlayOpen && canCompare && (!owned || owned.loading);
  const busy = comparisonLoading || replay.busy || libraryBusy;
  const error = mode === 'live' ? owned?.error ?? null : null;
  const diff = comparisonResult?.sequenceDiff ?? null;
  const sequenceA = accepted?.genomeA.sequence ?? '';
  const sequenceB = accepted?.genomeB.sequence ?? '';

  useEffect(() => { replaySession.activate(); return replaySession.deactivate; }, [replaySession]);
  useEffect(() => { if (!overlayOpen) replaySession.cancel(); }, [overlayOpen, replaySession]);
  const restore = async (content: string, signal: AbortSignal): Promise<void> => {
    setFileError(null);
    await replaySavedResearch(signal, {
      run: () => replaySession.run(replayScope, content), cancel: () => replaySession.cancel(replayScope),
      error: () => replaySession.getSnapshot().error,
    });
    if (signal.aborted || !source.current.overlayOpen) throw new DOMException('Comparison restore cancelled.', 'AbortError');
    setMode('saved');
  };
  const importExperiment = (file: File) => {
    setFileError(null);
    void replaySession.run(replayScope, async () => {
      if (file.size > GENOME_COMPARISON_LIMITS.recordBytes) throw new Error('Saved comparison exceeds 10 MiB.');
      return file.text();
    }).then(ok => {
      if (!source.current.overlayOpen) return;
      if (ok) setMode('saved');
      else if (replaySession.getSnapshot().error) setFileError(replaySession.getSnapshot().error);
    });
  };
  const exportExperiment = () => {
    if (!accepted || busy) return;
    try {
      downloadString(serializeAnalysisRecord(accepted.record), 'genome-comparison.json', 'application/json');
      setFileError(null);
    } catch (cause) { setFileError(cause instanceof Error ? cause.message : 'Could not export comparison evidence.'); }
  };

  // Choose defaults once per opening; an explicit empty selection stays empty.
  useEffect(() => {
    if (!overlayOpen) { defaulted.current = false; return; }
    if (mode !== 'live' || defaulted.current || phages.length < 2) return;
    defaulted.current = true;
    if (phageAIndex === null) setComparisonPhageA(phageBIndex === 0 ? 1 : 0);
    if (phageBIndex === null) setComparisonPhageB(phageAIndex === 1 ? 0 : 1);
  }, [overlayOpen, phageAIndex, phageBIndex, phages.length, mode, setComparisonPhageA, setComparisonPhageB]);

  const runComparison = useCallback(() => {
    try {
      const number = (text: string) => text.trim() ? Number(text) : NaN;
      const next = resolveGenomeComparisonOptions({ kmerSizes: draft.kmerSizes.split(',').map(number),
        maxEditDistanceLength: number(draft.maxEditDistanceLength), editDistanceWindowSize: number(draft.editDistanceWindowSize),
        editDistanceWindowCount: number(draft.editDistanceWindowCount) });
      operation.current?.abort(); setFileError(null); setOptions(next);
      setRevision(value => value + 1);
    } catch (cause) { setFileError(cause instanceof Error ? cause.message : 'Invalid comparison settings.'); }
  }, [draft]);

  const handleClose = useCallback(() => {
    operation.current?.abort();
    replaySession.cancel();
    setComparisonLoading(false);
    closeComparison();
    close('comparison');
  }, [close, closeComparison, replaySession, setComparisonLoading]);

  // Reads, computation and publication share one owner. Invalid selections,
  // repository replacement, closure and retries all revoke the previous owner.
  useEffect(() => {
    setComparisonResult(null);
    if (mode !== 'live') { setComparisonLoading(false); return; }
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
        && source.current.overlayOpen && source.current.mode === 'live' && source.current.repository === repository
        && source.current.phageA === phageA && source.current.phageB === phageB
        && source.current.revision === revision
        && state.phages[state.comparisonPhageAIndex ?? -1] === phageA
        && state.phages[state.comparisonPhageBIndex ?? -1] === phageB;
    };
    setComparison({ ...owner, payload: null, error: null, loading: true });
    setComparisonLoading(true);
    void (async () => {
      try {
        const [genomeA, genomeB] = await readComparisonPair(repository, phageA, phageB, controller.signal);
        if (!current()) return;
        const pool = SharedSequencePool.getInstance();
        const { ref: sequenceARef, transfer: transferA } = pool.getOrCreateRef(phageA.id, genomeA.sequence);
        const { ref: sequenceBRef, transfer: transferB } = pool.getOrCreateRef(phageB.id, genomeB.sequence);
        const job = {
          kind: 'analyze' as const,
          jobId: crypto.randomUUID(),
          phageA: genomeA.phage, phageB: genomeB.phage, sourceA: genomeA.source, sourceB: genomeB.source,
          sequenceARef, sequenceBRef,
          genesA: genomeA.genes, genesB: genomeB.genes,
          codonUsageA: genomeA.codonUsage, codonUsageB: genomeB.codonUsage, options,
        };
        const payload = await runWebComparison(job, [...transferA, ...transferB], controller.signal);
        if (!current()) return;
        setComparison({ ...owner, payload, error: null, loading: false });
        setComparisonResult(payload.result);
      } catch (cause) {
        if (current()) setComparison({ ...owner, payload: null, loading: false,
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
  }, [overlayOpen, phageA, phageB, repository, revision, options, mode, setComparisonLoading, setComparisonResult]);

  const header = useMemo(() => {
    if (mode === 'saved' && accepted) return <section className="panel" aria-label="Reopened comparison sources">
      <h3>{accepted.genomeA.phage.name} ↔ {accepted.genomeB.phage.name}</h3>
      <p>Showing a freshly verified saved experiment. Its embedded genomes and annotations are independent of the current explorer selection.</p>
      <p>A: {accepted.genomeA.phage.accession} · {accepted.genomeA.source} · {accepted.genomeA.sequence.length.toLocaleString()} bp;
        {' '}B: {accepted.genomeB.phage.accession} · {accepted.genomeB.source} · {accepted.genomeB.sequence.length.toLocaleString()} bp.</p>
      <button type="button" className="btn" disabled={replay.busy || libraryBusy} onClick={() => { setMode('live'); setFileError(null); }}>
        Return to current genomes
      </button>
    </section>;
    return (
      <div className="comparison-header" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <select
          value={phageAIndex ?? ''}
          aria-label="Phage A"
          disabled={replay.busy || libraryBusy}
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
          disabled={replay.busy || libraryBusy}
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
        <button className="btn" type="button" onClick={() => void runComparison()} disabled={busy || !canCompare}>
          {comparisonLoading ? 'Comparing…' : 'Run'}
        </button>
        {comparisonLoading && <button type="button" className="btn" onClick={() => {
          operation.current?.abort();
          setComparison(previous => previous ? { ...previous, loading: false, error: 'Comparison cancelled. Select Run to retry.' } : null);
          setComparisonLoading(false);
        }}>Cancel comparison</button>}
      </div>
    );
  }, [accepted, mode, replay.busy, libraryBusy, busy, canCompare, comparisonLoading, phageAIndex, phageBIndex, phages,
    runComparison, setComparisonLoading, setComparisonPhageA, setComparisonPhageB]);

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
    if (mode === 'live' && !repository) {
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

    if (mode === 'live' && (!phageA || !phageB)) {
      return (
        <OverlayEmptyState
          message="Select two phages to compare."
          hint="Pick Phage A and Phage B above, then run the comparison."
        />
      );
    }

    if (mode === 'live' && phageA?.id === phageB?.id) {
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
      return <ComparisonInformationTheory info={comparisonResult.informationTheory} />;
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
              <div className="text-dim">{codon.chiSquarePValue === null
                ? `Chi-square unavailable: ${codon.chiSquareUnavailableReason}`
                : `Chi-square ${codon.chiSquareStatistic.toFixed(1)}, df=${codon.degreesOfFreedom}, asymptotic p=${codon.chiSquarePValue.toExponential(2)}`}</div>
              <div className="text-dim">Resolved codons A/B: {codon.resolvedCodonsA} / {codon.resolvedCodonsB};
                {' '}excluded triplets: {codon.excludedCodonsA} / {codon.excludedCodonsB}.</div>
              {codon.chiSquarePValue !== null && <div className="text-dim">
                Full codon distribution, including amino-acid composition; not synonymous bias alone.
              </div>}
              {codon.chiSquarePValue !== null && codon.chiSquareExpectedBelowFive > 0 && <div className="text-dim">
                {codon.chiSquareExpectedBelowFive} expected cells are below 5; the asymptotic p-value may be unreliable.
              </div>}
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
          {structural && <ComparisonStructuralVariants report={structural} />}
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
  }, [comparisonLoading, comparisonResult, comparisonTab, diff, error, phageA, phageB, repository, mode, runComparison, sequenceA, sequenceB]);

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
        {mode === 'live' && <details className="panel" aria-label="Comparison settings">
          <summary>Comparison settings</summary>
          <p>Draft changes apply when you select Run. A newly selected pair uses the last applied settings.</p>
          <fieldset disabled={busy} style={{ display: 'grid', gap: '.5rem' }}>
            <legend>Descriptive comparison parameters</legend>
            <label>K-mer sizes (comma-separated)
              <input value={draft.kmerSizes} onChange={event => setDraft(previous => ({ ...previous, kmerSizes: event.target.value }))} /></label>
            <label>Whole-sequence edit metric limit (bp)
              <input type="number" min="0" max="10000" step="1" value={draft.maxEditDistanceLength}
                onChange={event => setDraft(previous => ({ ...previous, maxEditDistanceLength: event.target.value }))} /></label>
            <label>Sampled edit window size (bp)
              <input type="number" min="1" max="2000" step="1" value={draft.editDistanceWindowSize}
                onChange={event => setDraft(previous => ({ ...previous, editDistanceWindowSize: event.target.value }))} /></label>
            <label>Sampled edit window count
              <input type="number" min="1" max="100" step="1" value={draft.editDistanceWindowCount}
                onChange={event => setDraft(previous => ({ ...previous, editDistanceWindowCount: event.target.value }))} /></label>
          </fieldset>
          <p>The edit metric samples windows above its length limit; zero always selects sampling. The Diff and aligned-indel views use a separate bounded exact alignment.
            A diff that exceeds its budget remains unavailable while other metrics are retained.</p>
        </details>}
        <section className="panel" aria-label="Portable comparison experiment" data-result-id={accepted?.record.resultId}>
          <h3>Portable experiment</h3>
          <p>Export both complete genomes, annotations, supplied codon counts, applied settings and every result, including all edit runs and mask positions.
            Imports are recomputed locally before acceptance. Up to 1,000,000 bases and 20,000 annotations per genome; the complete record must fit within 10 MiB.</p>
          <button type="button" className="btn" disabled={busy || !accepted} onClick={exportExperiment}>Export comparison JSON</button>{' '}
          <label>Reopen comparison JSON <input type="file" accept=".json,application/json" disabled={busy}
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) importExperiment(file); }} /></label>
          {replay.busy && <><p role="status">Recomputing saved comparison…</p>
            <button type="button" className="btn" onClick={() => replaySession.cancel(replayScope)}>Cancel comparison replay</button></>}
          {fileError && <p role="alert">{fileError}</p>}
          {replay.notice && <p role="status">{replay.notice}</p>}
          {accepted && <p>Accepted settings: k = {accepted.options.kmerSizes.join(', ')}; whole-sequence edit metric limit {accepted.options.maxEditDistanceLength.toLocaleString()} bp;
            {' '}{accepted.options.editDistanceWindowCount} sampled windows of {accepted.options.editDistanceWindowSize.toLocaleString()} bp.</p>}
        </section>
        <SavedResearchPanel kind="comparison" suggestedName={accepted
          ? `${accepted.genomeA.phage.name} vs ${accepted.genomeB.phage.name}` : 'Genome comparison'}
          disabled={comparisonLoading || replay.busy} onActivityChange={setLibraryBusy}
          capture={accepted ? () => serializeAnalysisRecord(accepted.record) : null} restore={restore} />
        {accepted && <AnalysisRecordDetails record={accepted.record} />}
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
          {mode === 'live' && <button
            className="btn"
            type="button"
            onClick={() => void runComparison()}
            disabled={busy || !canCompare}
          >
            {comparisonLoading ? 'Running…' : 'Re-run'}
          </button>}
          <button className="btn-secondary" type="button" onClick={handleClose}>
            Close
          </button>
        </div>
      </OverlayStack>
    </Overlay>
  );
};

export default ComparisonOverlay;
