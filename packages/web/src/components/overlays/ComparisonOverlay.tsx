import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOverlay } from './OverlayProvider';
import { Overlay } from './Overlay';
import { useTheme } from '../../hooks/useTheme';
import type { PhageRepository } from '../../db';
import type { GenomeComparisonResult } from '@phage-explorer/comparison';
import { formatSimilarity } from '@phage-explorer/comparison';
import { usePhageStore } from '@phage-explorer/state';
import DiffHighlighter, { type DiffStats as DiffStatsType } from '../DiffHighlighter';

interface ComparisonOverlayProps {
  repository: PhageRepository | null;
}

export const ComparisonOverlay: React.FC<ComparisonOverlayProps> = ({ repository }) => {
  const { isOpen, close } = useOverlay();
  const { theme } = useTheme();
  const colors = theme.colors;

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

  const phageA = phageAIndex !== null ? phages[phageAIndex] : null;
  const phageB = phageBIndex !== null ? phages[phageBIndex] : null;

  // Create worker once
  useEffect(() => {
    const worker = new Worker(new URL('../../workers/comparison.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    return () => {
      worker.terminate();
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

      setSequenceA(seqA);
      setSequenceB(seqB);

      const job = {
        phageA: { id: phageA.id, name: phageA.name, accession: phageA.accession },
        phageB: { id: phageB.id, name: phageB.name, accession: phageB.accession },
        sequenceA: seqA,
        sequenceB: seqB,
        genesA: fullA.genes ?? [],
        genesB: fullB.genes ?? [],
        codonUsageA: fullA.codonUsage ?? null,
        codonUsageB: fullB.codonUsage ?? null,
      };

      const worker = workerRef.current;
      let result: GenomeComparisonResult | null = null;
      if (worker) {
        result = await new Promise<GenomeComparisonResult>((resolve, reject) => {
          const handleMessage = (event: MessageEvent<{
            ok: boolean;
            result?: GenomeComparisonResult;
            diffMask?: Uint8Array | ArrayBuffer;
            diffPositions?: number[];
            diffStats?: DiffStatsType;
            error?: string;
          }>) => {
            worker.removeEventListener('message', handleMessage);
            if (event.data.ok && event.data.result) {
              if (event.data.diffMask) {
                const mask =
                  event.data.diffMask instanceof Uint8Array
                    ? event.data.diffMask
                    : new Uint8Array(event.data.diffMask);
                setDiffMask(mask);
              }
              setDiffPositions(event.data.diffPositions ?? []);
              setDiffStats(event.data.diffStats ?? null);
              resolve(event.data.result);
            } else {
              reject(new Error(event.data.error ?? 'Worker comparison failed'));
            }
          };
          worker.addEventListener('message', handleMessage);
          worker.postMessage(job);
        });
      }
      if (!result) {
        throw new Error('Worker comparison failed');
      }
      setComparisonResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Comparison failed';
      setError(msg);
    } finally {
      setComparisonLoading(false);
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
        <button className="btn" type="button" onClick={() => void runComparison()} disabled={comparisonLoading}>
          {comparisonLoading ? 'Comparing…' : 'Run'}
        </button>
      </div>
    );
  }, [comparisonLoading, phageAIndex, phageBIndex, phages, runComparison, setComparisonPhageA, setComparisonPhageB]);

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
    if (error) {
      return <div style={{ color: colors.error }}>Error: {error}</div>;
    }
    if (comparisonLoading) {
      return <div className="text-dim">Running comparison…</div>;
    }
    if (!comparisonResult) {
      return <div className="text-dim">Select two phages and run comparison.</div>;
    }
    const summary = comparisonResult.summary;
    if (comparisonTab === 'summary') {
      return (
        <div className="panel">
          <div className="panel-header">
            <h3>Overall Similarity</h3>
            <span className="badge">{formatSimilarity(summary.overallSimilarity)}</span>
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
            {summary.insights.map((insight) => (
              <li key={insight.text}>{insight.text}</li>
            ))}
          </ul>
        </div>
      );
    }
    if (comparisonTab === 'diff') {
      if (!sequenceA || !sequenceB || !diffMask || diffPositions.length === 0 || !diffStats) {
        return <div className="text-dim">Run a comparison to view diff highlights.</div>;
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
  }, [
    colors.error,
    comparisonLoading,
    comparisonResult,
    comparisonTab,
    diffMask,
    diffPositions,
    diffStats,
    error,
    sequenceA,
    sequenceB,
  ]);

  return (
    <Overlay
      id="comparison"
      title="Comparison"
      size="xl"
      onClose={() => closeComparison()}
      showBackdrop
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
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
          <button className="btn" type="button" onClick={() => void runComparison()} disabled={comparisonLoading || !phageA || !phageB}>
            {comparisonLoading ? 'Running…' : 'Re-run'}
          </button>
          <button className="btn-secondary" type="button" onClick={() => close('comparison')}>
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
};

export default ComparisonOverlay;

