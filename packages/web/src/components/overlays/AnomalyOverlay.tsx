/**
 * AnomalyOverlay - Statistical anomaly detection dashboard
 *
 * Renders a composite anomaly score track, multi-metric heatmap, PCA scatter,
 * and ranked anomaly regions derived from a worker-based analysis.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import {
  ColorLegend,
  createLinearColorScale,
  DEFAULT_HEATMAP_SCALE,
  HeatmapCanvas,
  ScatterCanvas,
} from './primitives';
import { ComplexAnalysisSkeleton } from '../ui/Skeleton';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { ScatterHover } from './primitives/types';
import type {
  AnomalyWorkerAPI,
  AnomalyWorkerResult,
  AnomalyWindow,
} from '../../workers/anomaly.worker';

const METRIC_LABELS: Record<string, string> = {
  gcContent: 'GC%',
  gcSkew: 'GC skew',
  atSkew: 'AT skew',
  entropy: 'Entropy',
  klDivergence: 'KL divergence',
  compressionRatio: 'Compression ratio',
  dinucDeviation: 'Dinucleotide deviation',
  codonBias: 'Codon bias',
};

interface AnomalyOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

function formatBp(value: number): string {
  return `${value.toLocaleString()} bp`;
}

export function AnomalyOverlay({
  repository,
  currentPhage,
}: AnomalyOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const workerRef = useRef<Worker | null>(null);
  const workerApiRef = useRef<Comlink.Remote<AnomalyWorkerAPI> | null>(null);

  const [sequence, setSequence] = useState<string>('');
  const [analysis, setAnalysis] = useState<AnomalyWorkerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const scoreScale = useMemo(
    () => createLinearColorScale(['#16a34a', '#eab308', '#ef4444']),
    []
  );

  // Hotkey Alt+Y for anomalY (Alt+A used by AMGPathwayOverlay)
  useHotkey(
    { key: 'y', modifiers: { alt: true } },
    'Anomaly overlay',
    () => toggle('anomaly'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Spin up worker once
  useEffect(() => {
    if (workerRef.current) return () => undefined;
    const worker = new Worker(new URL('../../workers/anomaly.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    workerApiRef.current = Comlink.wrap<AnomalyWorkerAPI>(worker);

    return () => {
      if (workerApiRef.current && 'releaseProxy' in workerApiRef.current) {
        // @ts-expect-error Comlink helper
        workerApiRef.current.releaseProxy?.();
      }
      workerRef.current?.terminate();
      workerRef.current = null;
      workerApiRef.current = null;
    };
  }, []);

  // Load full sequence when overlay opens
  useEffect(() => {
    if (!isOpen('anomaly')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      return;
    }

    let cancelled = false;
    const phageId = currentPhage.id;
    const cached = sequenceCache.current.get(phageId);
    if (cached) {
      setSequence(cached);
      return;
    }

    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const length = await repository.getFullGenomeLength(phageId);
        const seq = await repository.getSequenceWindow(phageId, 0, length);
        if (!cancelled) {
          sequenceCache.current.set(phageId, seq);
          setSequence(seq);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load sequence';
          setError(message);
          setSequence('');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentPhage, isOpen, repository]);

  // Run analysis when sequence is available
  useEffect(() => {
    if (!isOpen('anomaly')) return;
    if (!sequence) {
      setAnalysis(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (!workerApiRef.current) throw new Error('Anomaly worker not ready');
        const result = await workerApiRef.current.analyze(sequence, {
          windowSize: 500,
          stepSize: 250,
        });
        if (cancelled) return;
        setAnalysis(result);
        setThreshold(prev => prev ?? result.summary.threshold);
        if (result.summary.topRegions.length > 0) {
          const top = result.summary.topRegions[0];
          const topIndex = result.windows.findIndex(w => w.start === top.start && w.end === top.end);
          setSelectedIndex(topIndex >= 0 ? topIndex : 0);
        } else {
          setSelectedIndex(result.windows.length ? 0 : null);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Anomaly analysis failed';
          setError(message);
          setAnalysis(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, sequence]);

  const effectiveThreshold = threshold ?? analysis?.summary.threshold ?? 70;

  const flagged = useMemo(() => {
    if (!analysis) return [];
    return analysis.windows
      .map((w, idx) => ({ ...w, index: idx }))
      .filter(w => w.score >= effectiveThreshold);
  }, [analysis, effectiveThreshold]);

  const trackSegments = useMemo(() => {
    if (!analysis) return [];
    return analysis.windows.map((w, idx) => ({
      start: w.start,
      end: w.end,
      height: w.score >= effectiveThreshold ? 14 : 8,
      color: w.score >= effectiveThreshold ? scoreScale(w.score / 100) : colors.borderLight,
      data: { index: idx },
    }));
  }, [analysis, colors.borderLight, effectiveThreshold, scoreScale]);

  const selectedWindow: AnomalyWindow | null = useMemo(() => {
    if (!analysis || selectedIndex == null) return null;
    return analysis.windows[selectedIndex] ?? null;
  }, [analysis, selectedIndex]);

  const heatmapMatrix = analysis
    ? {
        rows: analysis.heatmap.rows,
        cols: analysis.heatmap.cols,
        values: analysis.heatmap.values,
        min: analysis.heatmap.min,
        max: analysis.heatmap.max,
      }
    : null;

  const scatterPoints = useMemo(() => {
    if (!analysis) return [];
    return analysis.scatter.points.map((p) => ({
      ...p,
      color: scoreScale(p.score / 100),
      size: p.windowIndex === selectedIndex ? 6 : 4,
    }));
  }, [analysis, scoreScale, selectedIndex]);

  const handleHeatmapClick = (hover: { row: number } | null) => {
    if (!hover || !analysis) return;
    const row = Math.max(0, Math.min(analysis.windows.length - 1, hover.row));
    setSelectedIndex(row);
  };

  const handleScatterClick = (hover: ScatterHover | null) => {
    if (!hover) return;
    const idx = (hover.point.data as { windowIndex?: number } | undefined)?.windowIndex;
    if (idx !== undefined) setSelectedIndex(idx);
  };

  if (!isOpen('anomaly')) return null;

  return (
    <Overlay
      id="anomaly"
      title="ANOMALY DETECTION"
      icon="⚠️"
      hotkey="Alt+Y"
      size="xl"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '6px',
            color: colors.textDim,
            lineHeight: 1.5,
          }}
        >
          Composite anomaly scanner highlighting composition shifts, low-complexity regions, and
          codon bias outliers. Score blends KL divergence, compression, skew metrics, and bias
          deviations. Adjust sensitivity to focus on the strongest signals.
        </div>

        {/* Controls */}
        <div
          style={{
            display: 'flex',
            gap: '1rem',
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '0.75rem',
            backgroundColor: colors.background,
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '6px',
          }}
        >
          <label style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
            Sensitivity (threshold): {Math.round(effectiveThreshold)}
            <input
              type="range"
              min={50}
              max={95}
              step={1}
              value={effectiveThreshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              style={{ marginLeft: '0.5rem', accentColor: colors.accent }}
            />
          </label>
          <div style={{ color: colors.textMuted, display: 'flex', gap: '0.75rem', fontSize: '0.9rem' }}>
            <span>Window: 500 bp</span>
            <span>Step: 250 bp</span>
            <span>Anomalies ≥ threshold: {flagged.length}</span>
          </div>
        </div>

        {(loading || !analysis) && (
          loading ? (
            <ComplexAnalysisSkeleton showTrack showHeatmap showScatter showTable />
          ) : (
            <div style={{ padding: '1rem', color: colors.textMuted }}>
              {error ?? 'No data available yet.'}
            </div>
          )
        )}

        {analysis && (
          <>
            {/* Score track */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
                Genome-wide anomaly score (highlighted when ≥ threshold)
              </div>
              <GenomeTrack
                genomeLength={analysis.summary.genomeLength}
                segments={trackSegments}
                currentPosition={selectedWindow?.start ?? null}
                onClick={(info) => {
                  const idx = (info.segment?.data as { index?: number } | undefined)?.index;
                  if (idx !== undefined) setSelectedIndex(idx);
                }}
              />
              <ColorLegend
                width={240}
                height={28}
                colorScale={scoreScale}
                tickCount={3}
                minLabel="Normal"
                maxLabel="High anomaly"
              />
            </div>

            {/* Heatmap + scatter */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1fr',
                gap: '1rem',
              }}
            >
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.background,
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                    color: colors.textMuted,
                  }}
                >
                  <span>Metric heatmap (z-scores, rows = windows)</span>
                  <span style={{ fontSize: '0.8rem' }}>Columns: {analysis.heatmap.metricLabels.map(m => METRIC_LABELS[m] ?? m).join(', ')}</span>
                </div>
                {heatmapMatrix ? (
                  <HeatmapCanvas
                    width={780}
                    height={320}
                    matrix={heatmapMatrix}
                    colorScale={DEFAULT_HEATMAP_SCALE}
                    onClick={(hover) => handleHeatmapClick(hover)}
                    onHover={() => undefined}
                  />
                ) : (
                  <div style={{ padding: '1rem', color: colors.textMuted }}>No heatmap data</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                  <ColorLegend
                    width={220}
                    height={28}
                    colorScale={DEFAULT_HEATMAP_SCALE}
                    tickCount={5}
                    minLabel="-3σ"
                    maxLabel="+3σ"
                  />
                </div>
              </div>

              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.background,
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                  minHeight: '360px',
                }}
              >
                <div style={{ color: colors.textMuted, marginBottom: '0.5rem' }}>
                  PCA of metric z-scores (color = anomaly score)
                </div>
                <ScatterCanvas
                  width={420}
                  height={320}
                  points={scatterPoints.map(p => ({
                    ...p,
                    data: { windowIndex: p.windowIndex },
                  }))}
                  onClick={handleScatterClick}
                  onHover={() => undefined}
                  xLabel={`PC1 (${(analysis.scatter.explained[0] * 100).toFixed(1)}%)`}
                  yLabel={`PC2 (${(analysis.scatter.explained[1] * 100).toFixed(1)}%)`}
                  showAxes
                  showGrid
                  backgroundColor={colors.background}
                />
              </div>
            </div>

            {/* Ranked anomalies */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.2fr 1fr',
                gap: '1rem',
              }}
            >
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.background,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '6px',
                }}
              >
                <div style={{ color: colors.text, fontWeight: 600, marginBottom: '0.5rem' }}>
                  Top anomaly regions
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.7fr 0.7fr', gap: '0.5rem', color: colors.textDim, fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                  <span>Position</span>
                  <span>Score</span>
                  <span>Type</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {analysis.windows
                    .map((w, idx) => ({ w, idx }))
                    .filter(({ w }) => w.score >= effectiveThreshold)
                    .sort((a, b) => b.w.score - a.w.score)
                    .slice(0, 8)
                    .map(({ w, idx }) => (
                      <button
                        key={`${w.start}-${idx}`}
                        onClick={() => setSelectedIndex(idx)}
                        type="button"
                        style={{
                          textAlign: 'left',
                          padding: '0.5rem',
                          borderRadius: '6px',
                          border: `1px solid ${idx === selectedIndex ? colors.accent : colors.borderLight}`,
                          background: idx === selectedIndex ? colors.backgroundAlt : 'transparent',
                          color: colors.text,
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.5fr 0.6fr', alignItems: 'center', gap: '0.5rem' }}>
                          <span>{formatBp(w.start)} – {formatBp(w.end)}</span>
                          <span style={{ color: colors.accent, fontFamily: 'monospace' }}>{w.score.toFixed(1)}</span>
                          <span style={{ color: colors.textMuted }}>{w.type}</span>
                        </div>
                        <div style={{ color: colors.textMuted, fontSize: '0.8rem', marginTop: '0.25rem' }}>
                          Drivers: {w.drivers.map(d => `${METRIC_LABELS[d.metric] ?? d.metric} (${d.z.toFixed(2)})`).join(', ')}
                        </div>
                      </button>
                    ))}
                  {flagged.length === 0 && (
                    <div style={{ color: colors.textMuted, padding: '0.5rem' }}>
                      No regions exceed the current threshold.
                    </div>
                  )}
                </div>
              </div>

              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.background,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '6px',
                }}
              >
                <div style={{ color: colors.text, fontWeight: 600, marginBottom: '0.5rem' }}>
                  Region details
                </div>
                {selectedWindow ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', color: colors.textDim }}>
                    <div>Position: {formatBp(selectedWindow.start)} – {formatBp(selectedWindow.end)}</div>
                    <div>Score: <span style={{ color: colors.accent }}>{selectedWindow.score.toFixed(1)}</span></div>
                    <div>Type: {selectedWindow.type}</div>
                    <div style={{ marginTop: '0.5rem' }}>Top drivers:</div>
                    <ul style={{ margin: 0, paddingLeft: '1rem', color: colors.text }}>
                      {selectedWindow.drivers.map((d) => (
                        <li key={d.metric}>
                          {METRIC_LABELS[d.metric] ?? d.metric}: z = {d.z.toFixed(2)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div style={{ color: colors.textMuted }}>Select a region to inspect details.</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default AnomalyOverlay;

