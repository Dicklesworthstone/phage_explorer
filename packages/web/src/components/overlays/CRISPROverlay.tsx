import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PhageFull, CRISPRAnalysisResult, SpacerHit, AcrCandidate } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useOverlay } from './OverlayProvider';
import { Overlay } from './Overlay';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackInteraction, GenomeTrackSegment } from './primitives/types';
import { ComplexAnalysisSkeleton } from '../ui/Skeleton';

interface CRISPROverlayProps {
  repository: PhageRepository | null;
  phage: PhageFull | null;
}

interface WorkerResultMessage {
  ok: boolean;
  result?: CRISPRAnalysisResult;
  error?: string;
}

const PRESSURE_MEDIUM = 4;
const PRESSURE_HIGH = 7;

function pressureColor(value: number, palette: { success: string; warning: string; error: string }): string {
  if (value >= PRESSURE_HIGH) return palette.error;
  if (value >= PRESSURE_MEDIUM) return palette.warning;
  return palette.success;
}

function pamColor(
  pamStatus: SpacerHit['pamStatus'],
  palette: { success: string; warning: string; textMuted: string }
): string {
  if (pamStatus === 'valid') return palette.success;
  if (pamStatus === 'invalid') return palette.warning;
  return palette.textMuted;
}

export function CRISPROverlay({ repository, phage }: CRISPROverlayProps): React.ReactElement | null {
  const { isOpen, toggle } = useOverlay();
  const { theme } = useTheme();
  const colors = theme.colors;

  const [sequence, setSequence] = useState<string>('');
  const [analysis, setAnalysis] = useState<CRISPRAnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedHit, setSelectedHit] = useState<SpacerHit | null>(null);
  const [hoverInfo, setHoverInfo] = useState<GenomeTrackInteraction | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const sequenceCache = useRef<Map<number, string>>(new Map());

  useHotkey(
    { key: 'c', modifiers: { alt: true } },
    'CRISPR Pressure Map',
    () => toggle('crispr'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Create worker once
  useEffect(() => {
    const worker = new Worker(new URL('../../workers/crispr.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Fetch sequence when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('crispr')) return;
    if (!repository || !phage) {
      setSequence('');
      setAnalysis(null);
      return;
    }

    const phageId = phage.id;
    const cached = sequenceCache.current.get(phageId);
    if (cached) {
      setSequence(cached);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    repository
      .getFullGenomeLength(phageId)
      .then((length) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq) => {
        if (cancelled) return;
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => {
        if (cancelled) return;
        setSequence('');
        setError('Unable to load genome sequence for CRISPR analysis.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, phage]);

  // Run analysis in worker
  useEffect(() => {
    if (!isOpen('crispr')) return;
    if (!sequence || !phage?.genes) return;
    if (!workerRef.current) {
      setError('CRISPR analysis worker unavailable.');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setAnalysis(null);
    const worker = workerRef.current;

    const handleMessage = (event: MessageEvent<WorkerResultMessage>) => {
      if (cancelled) return;
      const message = event.data;
      if (message.ok && message.result) {
        setAnalysis(message.result);
      } else {
        setError(message.error ?? 'CRISPR analysis failed.');
      }
      setLoading(false);
    };

    worker.addEventListener('message', handleMessage);
    worker.postMessage({ sequence, genes: phage.genes });

    return () => {
      cancelled = true;
      worker.removeEventListener('message', handleMessage);
    };
  }, [isOpen, sequence, phage]);

  const pressureSegments = useMemo<GenomeTrackSegment[]>(() => {
    if (!analysis) return [];
    return analysis.pressureWindows.map((w) => ({
      start: w.start,
      end: w.end,
      label: `Pressure ${w.pressureIndex.toFixed(1)} (${w.spacerCount} spacers)`,
      color: pressureColor(w.pressureIndex, {
        success: colors.success,
        warning: colors.warning,
        error: colors.error,
      }),
      height: Math.max(8, Math.min(24, w.pressureIndex * 1.6)),
      data: w,
    }));
  }, [analysis, colors.error, colors.success, colors.warning]);

  const spacerSegments = useMemo<GenomeTrackSegment[]>(() => {
    if (!analysis) return [];
    return analysis.spacerHits.map((hit) => ({
      start: hit.position,
      end: hit.position + Math.max(1, hit.sequence.length),
      label: `${hit.host} (${hit.crisprType})`,
      color: pamColor(hit.pamStatus, {
        success: colors.success,
        warning: colors.warning,
        textMuted: colors.textMuted,
      }),
      height: 10,
      data: hit,
    }));
  }, [analysis, colors.success, colors.textMuted, colors.warning]);

  const topHits = useMemo<SpacerHit[]>(() => {
    if (!analysis) return [];
    return [...analysis.spacerHits].sort((a, b) => b.matchScore - a.matchScore).slice(0, 6);
  }, [analysis]);

  const topAcr = useMemo<AcrCandidate[]>(() => {
    if (!analysis) return [];
    return analysis.acrCandidates.slice(0, 5);
  }, [analysis]);

  const genomeLength = phage?.genomeLength ?? sequence.length;

  if (!isOpen('crispr')) return null;

  return (
    <Overlay
      id="crispr"
      title="CRISPR PRESSURE MAP"
      hotkey="Alt+C"
      size="xl"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.9rem',
          }}
        >
          <strong style={{ color: colors.accent }}>CRISPR Pressure & Anti-CRISPR</strong>{' '}
          highlights spacer targeting across the genome and surfaces candidate anti-CRISPR genes.
        </div>

        {error && (
          <div style={{ color: colors.error, padding: '0.5rem', border: `1px solid ${colors.error}`, borderRadius: '4px' }}>
            {error}
          </div>
        )}

        {loading ? (
          <ComplexAnalysisSkeleton showTrack showHeatmap={false} showScatter={false} showTable />
        ) : !analysis ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            {sequence ? 'Analysis pending…' : 'Load a phage to run CRISPR analysis.'}
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '0.75rem',
              }}
            >
              <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Spacer hits</div>
                <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.4rem' }}>
                  {analysis.spacerHits.length.toLocaleString()}
                </div>
              </div>
              <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Max pressure</div>
                <div style={{ color: colors.error, fontFamily: 'monospace', fontSize: '1.4rem' }}>
                  {analysis.maxPressure.toFixed(1)}
                </div>
              </div>
              <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px', textAlign: 'center' }}>
                <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Acr candidates</div>
                <div style={{ color: colors.success, fontFamily: 'monospace', fontSize: '1.4rem' }}>
                  {analysis.acrCandidates.length.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Pressure track */}
            <div>
              <div style={{ fontSize: '0.8rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                Spacer pressure (darker = higher pressure)
              </div>
              <GenomeTrack
                genomeLength={genomeLength}
                segments={pressureSegments}
                width={560}
                height={56}
                onHover={setHoverInfo}
                ariaLabel="CRISPR pressure track"
              />
            </div>

            {/* Spacer hits */}
            <div>
              <div style={{ fontSize: '0.8rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                Spacer hits (click to inspect)
              </div>
              <GenomeTrack
                genomeLength={genomeLength}
                segments={spacerSegments}
                width={560}
                height={40}
                onHover={setHoverInfo}
                onClick={(info) => {
                  const data = info.segment?.data;
                  if (data && typeof data === 'object' && 'sequence' in data) {
                    setSelectedHit(data as SpacerHit);
                  }
                }}
                ariaLabel="Spacer hit track"
              />
              {hoverInfo && (
                <div
                  style={{
                    marginTop: '0.35rem',
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                  }}
                >
                  Position: {Math.round(hoverInfo.position).toLocaleString()} bp
                  {hoverInfo.segment?.label && (
                    <span style={{ marginLeft: '0.5rem', color: colors.textMuted }}>{hoverInfo.segment.label}</span>
                  )}
                </div>
              )}
            </div>

            {/* Selected hit details */}
            {selectedHit && (
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  border: `1px solid ${pamColor(selectedHit.pamStatus, {
                    success: colors.success,
                    warning: colors.warning,
                    textMuted: colors.textMuted,
                  })}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ color: colors.accent, fontWeight: 600 }}>
                    Spacer at {selectedHit.position.toLocaleString()} bp — {selectedHit.host}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedHit(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: colors.textDim,
                      cursor: 'pointer',
                    }}
                    aria-label="Close spacer details"
                  >
                    ×
                  </button>
                </div>
                <div style={{ marginTop: '0.35rem', color: colors.text }}>
                  Sequence: <span style={{ fontFamily: 'monospace' }}>{selectedHit.sequence}</span>
                </div>
                <div style={{ marginTop: '0.25rem', color: colors.textDim, fontSize: '0.85rem' }}>
                  Type {selectedHit.crisprType} · PAM: {selectedHit.pamStatus} · Score:{' '}
                  {selectedHit.matchScore.toFixed(2)} · Strand: {selectedHit.strand}
                </div>
              </div>
            )}

            {/* Tables */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem', alignItems: 'start' }}>
              <div className="panel">
                <div className="panel-header">
                  <h3>Spacer hits (top)</h3>
                  <span className="text-dim">{analysis.spacerHits.length.toLocaleString()} total</span>
                </div>
                <div className="table">
                  <div className="table-row table-head">
                    <div>Pos</div>
                    <div>Host</div>
                    <div>PAM</div>
                    <div>Score</div>
                  </div>
                  {topHits.map((hit, idx) => (
                    <div className="table-row" key={`${hit.position}-${idx}`}>
                      <div>{hit.position.toLocaleString()}</div>
                      <div>{hit.host}</div>
                      <div style={{ color: pamColor(hit.pamStatus, { success: colors.success, warning: colors.warning, textMuted: colors.textMuted }) }}>
                        {hit.pamStatus}
                      </div>
                      <div>{hit.matchScore.toFixed(2)}</div>
                    </div>
                  ))}
                  {topHits.length === 0 && <div className="table-row text-dim">No spacer hits detected.</div>}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <h3>Acr candidates</h3>
                  <span className="text-dim">Ranked by score</span>
                </div>
                <div className="table">
                  <div className="table-row table-head">
                    <div>Gene</div>
                    <div>Score</div>
                    <div>Family</div>
                  </div>
                  {topAcr.map((acr) => (
                    <div className="table-row" key={acr.geneId}>
                      <div>{acr.geneName}</div>
                      <div style={{ color: acr.score >= 60 ? colors.success : acr.score >= 45 ? colors.warning : colors.text }}>
                        {acr.score.toFixed(1)} ({acr.confidence})
                      </div>
                      <div>{acr.family}</div>
                    </div>
                  ))}
                  {topAcr.length === 0 && <div className="table-row text-dim">No anti-CRISPR candidates predicted.</div>}
                </div>
              </div>
            </div>

            <div
              style={{
                padding: '0.6rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
                color: colors.textDim,
                fontSize: '0.8rem',
              }}
            >
              High-pressure regions suggest strong spacer targeting and possible escape mutations. Combine spacer density with
              gene context and Acr predictions to evaluate host range and resistance.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default CRISPROverlay;
