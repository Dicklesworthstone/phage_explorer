import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOverlay } from './OverlayProvider';
import { Overlay } from './Overlay';
import { Badge } from '../ui/Badge';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import type { PhageRepository } from '../../db';
import type { GenomeComparisonResult, StructuralVariantCall, StructuralVariantType } from '@phage-explorer/comparison';
import { formatSimilarity } from '@phage-explorer/comparison';
import { usePhageStore } from '@phage-explorer/state';
import DiffHighlighter, { type DiffStats as DiffStatsType } from '../DiffHighlighter';
import { OverlayEmptyState, OverlayErrorState, OverlayLoadingState, OverlayStack } from './primitives';
import { SharedSequencePool } from '../../workers/SharedSequencePool';
import type { ComparisonWorkerMessage } from '../../workers/types';

const formatPercent = (value: number | null | undefined, digits = 2): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
};

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
  diffMask?: Uint8Array;
  diffPositions?: number[];
  diffStats?: DiffStatsType | null;
};

export const ComparisonOverlay: React.FC<ComparisonOverlayProps> = ({ repository }) => {
  const { isOpen } = useOverlay();

  const phages = usePhageStore((s) => s.phages);
  const phageAIndex = usePhageStore((s) => s.comparisonPhageAIndex);
  const phageBIndex = usePhageStore((s) => s.comparisonPhageBIndex);
  const comparisonTab = usePhageStore((s) => s.comparisonTab);
  const comparisonResult = usePhageStore((s) => s.comparisonResult);
  const comparisonLoading = usePhageStore((s) => s.comparisonLoading);
  const setComparisonPhageA = usePhageStore((s) => s.setComparisonPhageA);
  const setComparisonPhageB = usePhageStore((s) => s.setComparisonPhageB);
  const setComparisonResult = usePhageStore((s) => s.setComparisonResult);
  const setComparisonLoading = usePhageStore((s) => s.setComparisonLoading);
  const setComparisonTab = usePhageStore((s) => s.setComparisonTab);
  const closeComparison = usePhageStore((s) => s.closeComparison);

  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [sequenceA, setSequenceA] = useState<string>('');
  const [sequenceB, setSequenceB] = useState<string>('');
  const [diffMask, setDiffMask] = useState<Uint8Array | null>(null);
  const [diffPositions, setDiffPositions] = useState<number[]>([]);
  const [diffStats, setDiffStats] = useState<DiffStatsType | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  const phageA = phageAIndex !== null ? phages[phageAIndex] : null;
  const phageB = phageBIndex !== null ? phages[phageBIndex] : null;
  const canCompare = Boolean(repository && phageA && phageB && phageA.id !== phageB.id);

  // Create worker once
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('../../workers/comparison.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      try {
        worker = new Worker(new URL('../../workers/comparison.worker.ts', import.meta.url));
      } catch {
        // Both worker variants failed; leave worker null.
      }
    }
    if (worker) workerRef.current = worker;
    return () => {
      worker?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Default selection when opened
  useEffect(() => {
    if (!isOpen('comparison')) return;
    if (phages.length >= 2) {
      if (phageAIndex === null) setComparisonPhageA(0);
      if (phageBIndex === null) setComparisonPhageB(1);
    }
  }, [isOpen, phageAIndex, phageBIndex, phages.length, setComparisonPhageA, setComparisonPhageB]);

  const runComparison = useCallback(async () => {
    if (!repository || !phageA || !phageB || phageA.id === phageB.id) return;
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    activeJobIdRef.current = jobId;
    setComparisonLoading(true);
    setError(null);
    setDiffMask(null);
    setDiffPositions([]);
    setDiffStats(null);
    try {
      const [fullA, fullB] = await Promise.all([
        repository.getPhageById(phageA.id),
        repository.getPhageById(phageB.id),
      ]);
      if (!fullA || !fullB) {
        throw new Error('Failed to load phage data');
      }
      const lengthA = fullA.genomeLength ?? 0;
      const lengthB = fullB.genomeLength ?? 0;
      const [seqA, seqB] = await Promise.all([
        repository.getSequenceWindow(phageA.id, 0, lengthA),
        repository.getSequenceWindow(phageB.id, 0, lengthB),
      ]);

      if (activeJobIdRef.current !== jobId) return;

      setSequenceA(seqA);
      setSequenceB(seqB);

      const pool = SharedSequencePool.getInstance();
      const { ref: sequenceARef, transfer: transferA } = pool.getOrCreateRef(phageA.id, seqA);
      const { ref: sequenceBRef, transfer: transferB } = pool.getOrCreateRef(phageB.id, seqB);

      const job = {
        jobId,
        phageA: { id: phageA.id, name: phageA.name, accession: phageA.accession },
        phageB: { id: phageB.id, name: phageB.name, accession: phageB.accession },
        sequenceARef,
        sequenceBRef,
        genesA: fullA.genes ?? [],
        genesB: fullB.genes ?? [],
        codonUsageA: fullA.codonUsage ?? null,
        codonUsageB: fullB.codonUsage ?? null,
      };

      const worker = workerRef.current;
      let payload: ComparisonWorkerPayload | null = null;
      if (worker) {
        payload = await new Promise<ComparisonWorkerPayload>((resolve, reject) => {
          const handleMessage = (event: MessageEvent<ComparisonWorkerMessage>) => {
            if (event.data.jobId && event.data.jobId !== jobId) return;
            worker.removeEventListener('message', handleMessage);
            if (event.data.ok && event.data.result) {
              resolve({
                result: event.data.result,
                diffMask: event.data.diffMask,
                diffPositions: event.data.diffPositions ?? [],
                diffStats: (event.data.diffStats as DiffStatsType | undefined) ?? null,
              });
            } else {
              reject(new Error(event.data.error ?? 'Worker comparison failed'));
            }
          };
          worker.addEventListener('message', handleMessage);
          worker.postMessage(job, [...transferA, ...transferB]);
        });
      }
      if (!payload) {
        throw new Error('Worker comparison failed');
      }
      if (activeJobIdRef.current !== jobId) return;
      if (payload.diffMask) {
        setDiffMask(payload.diffMask);
      }
      setDiffPositions(payload.diffPositions ?? []);
      setDiffStats(payload.diffStats ?? null);
      setComparisonResult(payload.result);
    } catch (err) {
      if (activeJobIdRef.current !== jobId) return;
      const msg = err instanceof Error ? err.message : 'Comparison failed';
      setError(msg);
    } finally {
      if (activeJobIdRef.current === jobId) {
        setComparisonLoading(false);
      }
    }
  }, [phageA, phageB, repository, setComparisonLoading, setComparisonResult]);

  // Auto-run when both phages selected and overlay open
  useEffect(() => {
    if (isOpen('comparison') && phageA && phageB && phageA.id !== phageB.id) {
      void runComparison();
    }
  }, [isOpen, phageA, phageB, runComparison]);

  const header = useMemo(() => {
    return (
      <div className="comparison-header" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <select
          value={phageAIndex ?? ''}
          onChange={(e) => setComparisonPhageA(Number(e.target.value))}
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
          onChange={(e) => setComparisonPhageB(Number(e.target.value))}
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
    const computedAt = new Date(comparisonResult.computedAt);
    if (comparisonTab === 'summary') {
      return (
        <div className="panel">
          <div className="panel-header">
            <h3>Overall Similarity</h3>
            <Badge>{formatSimilarity(summary.overallSimilarity)}</Badge>
          </div>
          <p className="text-dim">{summary.similarityCategory}</p>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">Sequence</div>
              <div className="metric-value">{formatSimilarity(summary.sequenceSimilarity)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Composition</div>
              <div className="metric-value">{formatSimilarity(summary.compositionSimilarity)}</div>
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
            <span className="text-dim">ANI, GC, lengths, codon & amino acid usage</span>
          </div>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">ANI</div>
              <div className="metric-value">{formatPct(bio.aniScore)}</div>
              <div className="text-dim">Method: {bio.aniMethod}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">GC content</div>
              <div className="metric-value">
                {bio.gcContentA.toFixed(2)}% / {bio.gcContentB.toFixed(2)}%
              </div>
              <div className="text-dim">Δ {bio.gcDifference.toFixed(2)}%</div>
            </div>
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
      const editDistance = comparisonResult.editDistance;
      if (!sequenceA || !sequenceB || !diffMask || !diffStats) {
        return <div className="text-dim">Run a comparison to view diff highlights.</div>;
      }
      if (diffPositions.length === 0) {
        return (
          <div className="text-dim">
            Sequences appear identical ({formatPercent(editDistance.levenshteinSimilarity * 100)} identity).
          </div>
        );
      }
      return (
        <DiffHighlighter
          sequence={sequenceA}
          diffSequence={sequenceB}
          diffMask={diffMask}
          diffPositions={diffPositions}
          stats={diffStats}
        />
      );
    }
    return (
      <div className="text-dim">
        Tab <strong>{comparisonTab}</strong> not yet implemented. Results available in summary above.
      </div>
    );
  }, [comparisonLoading, comparisonResult, comparisonTab, diffMask, diffPositions, diffStats, error, phageA, phageB, repository, runComparison, sequenceA, sequenceB]);

  return (
    <Overlay
      id="comparison"
      title="Comparison"
      size="xl"
      onClose={() => closeComparison()}
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
          <button className="btn-secondary" type="button" onClick={() => closeComparison()}>
            Close
          </button>
        </div>
      </OverlayStack>
    </Overlay>
  );
};

export default ComparisonOverlay;
