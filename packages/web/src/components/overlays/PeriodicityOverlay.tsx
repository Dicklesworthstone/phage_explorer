/**
 * PeriodicityOverlay - Periodicity & Tandem Repeat Spectrogram
 *
 * Visualizes windowed autocorrelation of a binary-encoded genome (GC or purine/pyrimidine)
 * as a period-vs-position heatmap, and extracts high-confidence candidate repeat regions.
 *
 * Part of: phage_explorer-axn (Advanced: Periodicity & Tandem Repeat Wavelet Spectrogram)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import {
  analyzePeriodicity,
  type PeriodicityAnalysis,
  type PeriodicityEncoding,
} from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { HeatmapCanvas } from '../primitives/HeatmapCanvas';
import {
  OverlayLoadingState,
  OverlayEmptyState,
} from './primitives';
import { DEFAULT_HEATMAP_SCALE } from '../primitives/colorScales';
import type { HeatmapHover } from '../primitives/types';

interface PeriodicityOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

function formatBp(n: number): string {
  return n.toLocaleString();
}

export function PeriodicityOverlay({
  repository,
  currentPhage,
}: PeriodicityOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());

  const [sequence, setSequence] = useState('');
  const [loadingSequence, setLoadingSequence] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [analysis, setAnalysis] = useState<PeriodicityAnalysis | null>(null);
  const [hover, setHover] = useState<HeatmapHover | null>(null);

  // Controls
  const [encoding, setEncoding] = useState<PeriodicityEncoding>('purine');
  const [windowSize, setWindowSize] = useState(2048);
  const [maxPeriod, setMaxPeriod] = useState(80);
  const [candidateThreshold, setCandidateThreshold] = useState(0.65);

  const minPeriod = 2;
  const stepSize = Math.max(1, Math.floor(windowSize / 4));

  // Hotkey (Alt+W)
  useHotkey(
    ActionIds.OverlayPeriodicity,
    () => toggle('periodicity'),
    { modes: ['NORMAL'] }
  );

  // Fetch full genome when overlay opens
  useEffect(() => {
    if (!isOpen('periodicity')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setAnalysis(null);
      setLoadingSequence(false);
      setLoadingAnalysis(false);
      setHover(null);
      return;
    }

    const phageId = currentPhage.id;
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      setLoadingSequence(false);
      setLoadingAnalysis(false);
      return;
    }

    let cancelled = false;
    setLoadingSequence(true);
    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        if (cancelled) return;
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => {
        if (cancelled) return;
        setSequence('');
      })
      .finally(() => {
        if (!cancelled) setLoadingSequence(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Compute spectrogram + candidates
  useEffect(() => {
    if (!isOpen('periodicity')) {
      setAnalysis(null);
      setLoadingAnalysis(false);
      setHover(null);
      return;
    }
    if (!sequence) {
      setAnalysis(null);
      setLoadingAnalysis(false);
      return;
    }

    setLoadingAnalysis(true);
    setHover(null);

    // Yield to allow overlay paint before compute.
    let cancelled = false;
    const handle = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const res = analyzePeriodicity(sequence, {
          encoding,
          windowSize,
          stepSize,
          minPeriod,
          maxPeriod,
          candidateThreshold,
        });
        setAnalysis(res);
      } finally {
        if (!cancelled) setLoadingAnalysis(false);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
      setLoadingAnalysis(false);
    };
  }, [candidateThreshold, encoding, isOpen, maxPeriod, sequence, stepSize, windowSize]);

  const spectrum = analysis?.spectrum ?? null;
  const hoverLabel = useMemo(() => {
    if (!hover || !spectrum) return null;
    const period = spectrum.periods[hover.row] ?? 0;
    const start = spectrum.windowStarts[hover.col] ?? 0;
    const end = Math.min(spectrum.genomeLength, start + spectrum.windowSize);
    return {
      period,
      start,
      end,
      value: hover.value ?? 0,
    };
  }, [hover, spectrum]);

  const heatmapSize = useMemo(() => {
    if (!spectrum) return { width: 760, height: 340 };
    const width = Math.min(900, Math.max(520, Math.round(spectrum.cols * 2)));
    const height = Math.min(440, Math.max(240, Math.round(spectrum.rows * 4)));
    return { width, height };
  }, [spectrum]);

  if (!isOpen('periodicity')) return null;

  const selectStyle: React.CSSProperties = {
    backgroundColor: colors.backgroundAlt,
    color: colors.text,
    border: `1px solid ${colors.borderLight}`,
    borderRadius: '4px',
    padding: '0.35rem 0.5rem',
    fontSize: '0.8rem',
  };

  return (
    <Overlay
      id="periodicity"
      title="Periodicity Spectrogram"
      hotkey="Alt+W"
      size="xl"
    >
      <div
        style={{
          padding: '1rem',
          color: colors.text,
          fontSize: '0.85rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        {/* Loading */}
        {loadingSequence && (
          <OverlayLoadingState message="Loading sequence data...">
            <AnalysisPanelSkeleton rows={3} />
          </OverlayLoadingState>
        )}
        {!loadingSequence && loadingAnalysis && (
          <OverlayLoadingState message="Computing periodicity spectrogram...">
            <AnalysisPanelSkeleton rows={3} />
          </OverlayLoadingState>
        )}

        {/* Controls + description */}
        {!loadingSequence && (
          <div
            style={{
              padding: '0.75rem',
              backgroundColor: colors.backgroundAlt,
              borderRadius: '6px',
              border: `1px solid ${colors.borderLight}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div style={{ color: colors.textDim, fontSize: '0.8rem' }}>
              This view scans the genome for repeating structure by measuring windowed autocorrelation of a
              coarse base encoding. Peaks often reflect coding 3-bp structure, helix pitch (~10–11 bp),
              and tandem-repeat regions.
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.7rem', color: colors.textMuted }}>Encoding</label>
                <select
                  value={encoding}
                  onChange={(e) => setEncoding(e.target.value as PeriodicityEncoding)}
                  style={selectStyle}
                >
                  <option value="purine">Purine/Pyrimidine (A/G vs C/T)</option>
                  <option value="gc">GC vs AT</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.7rem', color: colors.textMuted }}>Window</label>
                <select
                  value={windowSize}
                  onChange={(e) => setWindowSize(Number(e.target.value))}
                  style={selectStyle}
                >
                  <option value={1024}>1024 bp (detail)</option>
                  <option value={2048}>2048 bp (default)</option>
                  <option value={4096}>4096 bp (smooth)</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.7rem', color: colors.textMuted }}>Max period</label>
                <select
                  value={maxPeriod}
                  onChange={(e) => setMaxPeriod(Number(e.target.value))}
                  style={selectStyle}
                >
                  <option value={40}>40 bp</option>
                  <option value={60}>60 bp</option>
                  <option value={80}>80 bp</option>
                  <option value={120}>120 bp</option>
                  <option value={160}>160 bp</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <label style={{ fontSize: '0.7rem', color: colors.textMuted }}>Repeat threshold</label>
                <select
                  value={candidateThreshold}
                  onChange={(e) => setCandidateThreshold(Number(e.target.value))}
                  style={selectStyle}
                >
                  <option value={0.55}>0.55</option>
                  <option value={0.65}>0.65</option>
                  <option value={0.75}>0.75</option>
                  <option value={0.85}>0.85</option>
                </select>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: '0.5rem',
                fontSize: '0.75rem',
              }}
            >
              <div style={{ padding: '0.5rem', borderRadius: '4px', backgroundColor: colors.background }}>
                <div style={{ color: colors.textMuted }}>Genome</div>
                <div className="font-data" style={{ color: colors.text }}>{formatBp(sequence.length)} bp</div>
              </div>
              <div style={{ padding: '0.5rem', borderRadius: '4px', backgroundColor: colors.background }}>
                <div style={{ color: colors.textMuted }}>Windows</div>
                <div className="font-data" style={{ color: colors.text }}>{formatBp(spectrum?.cols ?? 0)}</div>
              </div>
              <div style={{ padding: '0.5rem', borderRadius: '4px', backgroundColor: colors.background }}>
                <div style={{ color: colors.textMuted }}>Period range</div>
                <div className="font-data" style={{ color: colors.text }}>
                  {minPeriod}–{spectrum?.maxPeriod ?? maxPeriod} bp
                </div>
              </div>
              <div style={{ padding: '0.5rem', borderRadius: '4px', backgroundColor: colors.background }}>
                <div style={{ color: colors.textMuted }}>Candidates</div>
                <div className="font-data" style={{ color: colors.text }}>{analysis?.candidates.length ?? 0}</div>
              </div>
            </div>
          </div>
        )}

        {/* Main view */}
        {!loadingSequence && !loadingAnalysis && (!analysis || !spectrum || spectrum.rows === 0) ? (
          <OverlayEmptyState
            message={!sequence ? 'No sequence loaded' : 'Sequence too short for spectrogram'}
            hint={!sequence ? 'Select a phage to analyze.' : 'The sequence must be long enough to compute windowed autocorrelation.'}
          />
        ) : null}

        {!loadingSequence && !loadingAnalysis && spectrum && spectrum.rows > 0 ? (
          <>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                  Period (rows) vs genome position (cols) — window {formatBp(spectrum.windowSize)} bp, step{' '}
                  {formatBp(spectrum.stepSize)} bp
                </div>
                <HeatmapCanvas
                  width={heatmapSize.width}
                  height={heatmapSize.height}
                  matrix={{
                    rows: spectrum.rows,
                    cols: spectrum.cols,
                    values: spectrum.values,
                    min: spectrum.min,
                    max: spectrum.max,
                  }}
                  colorScale={DEFAULT_HEATMAP_SCALE}
                  onHover={setHover}
                  ariaLabel="Periodicity spectrogram heatmap"
                />

                <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: colors.textMuted }}>
                  {hoverLabel ? (
                    <>
                      period <span className="font-data" style={{ color: colors.text }}>{hoverLabel.period} bp</span> • window{' '}
                      <span className="font-data" style={{ color: colors.text }}>
                        {formatBp(hoverLabel.start)}–{formatBp(hoverLabel.end)}
                      </span>{' '}
                      • score <span className="font-data" style={{ color: colors.text }}>{hoverLabel.value.toFixed(3)}</span>
                    </>
                  ) : (
                    'Hover a cell to see period / position / score'
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '1rem' }}>
              {/* Top periods */}
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                }}
              >
                <div style={{ color: colors.primary, marginBottom: '0.5rem' }}>Top periods</div>
                {(analysis?.topPeriods ?? []).length === 0 ? (
                  <div style={{ color: colors.textMuted }}>No peaks (try smaller window / lower threshold)</div>
                ) : (
                  <div className="font-data" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {analysis?.topPeriods.map((p) => (
                      <div
                        key={p.period}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: '0.75rem',
                          alignItems: 'baseline',
                        }}
                      >
                        <div style={{ color: colors.text }}>
                          {p.period} bp{p.label ? ` — ${p.label}` : ''}
                        </div>
                        <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                          mean {p.meanScore.toFixed(2)} • max {p.maxScore.toFixed(2)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Candidates */}
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                }}
              >
                <div style={{ color: colors.primary, marginBottom: '0.5rem' }}>Repeat candidates</div>
                {(analysis?.candidates ?? []).length === 0 ? (
                  <div style={{ color: colors.textMuted }}>No candidates above threshold</div>
                ) : (
                  <div className="font-data" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {analysis?.candidates.map((c, idx) => (
                      <div
                        key={`${c.start}-${c.end}-${idx}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: '0.75rem',
                          alignItems: 'baseline',
                        }}
                      >
                        <div style={{ color: colors.text }}>
                          {formatBp(c.start)}–{formatBp(c.end)} ({formatBp(c.end - c.start)} bp) • {c.period} bp
                          {c.label ? ` — ${c.label}` : ''}
                        </div>
                        <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                          peak {c.peakScore.toFixed(2)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Overlay>
  );
}

export default PeriodicityOverlay;
