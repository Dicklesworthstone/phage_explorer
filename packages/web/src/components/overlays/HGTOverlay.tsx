/**
 * HGTOverlay - Horizontal Gene Transfer Provenance Tracer
 *
 * Enhanced HGT island detection with "passport stamp" visualization:
 * - GC% deviation from genome average
 * - Dinucleotide bias anomalies (Karlin signature)
 * - Donor lineage inference via k-mer similarity
 * - Hallmark gene detection (integrase, transposase, etc.)
 * - Amelioration timing (recent/intermediate/ancient)
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment, GenomeTrackInteraction } from './primitives/types';
import {
  analyzeHGTProvenance,
  type HGTAnalysis,
  type PassportStamp,
} from '@phage-explorer/comparison';

// Amelioration-based colors (time since transfer)
type Amelioration = 'recent' | 'intermediate' | 'ancient' | 'unknown';

function ameliorationColor(amelioration: Amelioration): string {
  switch (amelioration) {
    case 'recent': return '#ef4444';      // Red - recently acquired
    case 'intermediate': return '#f59e0b'; // Orange - some time ago
    case 'ancient': return '#22c55e';      // Green - well-integrated
    default: return '#6b7280';             // Gray - unknown
  }
}

function ameliorationLabel(amelioration: Amelioration): string {
  switch (amelioration) {
    case 'recent': return 'Recently acquired (strong GC deviation)';
    case 'intermediate': return 'Intermediate age (moderate deviation)';
    case 'ancient': return 'Ancient transfer (mostly ameliorated)';
    default: return 'Unknown timing';
  }
}

// Calculate GC content of a sequence
function calculateGC(seq: string): number {
  const upper = seq.toUpperCase();
  let gc = 0;
  let total = 0;
  for (const c of upper) {
    if ('ACGT'.includes(c)) {
      total++;
      if (c === 'G' || c === 'C') gc++;
    }
  }
  return total > 0 ? gc / total : 0.5;
}

// Get color for GC deviation
function gcDeviationColor(deviation: number): string {
  const absDeviation = Math.abs(deviation);
  if (absDeviation > 0.08) return deviation > 0 ? '#3b82f6' : '#ef4444';
  if (absDeviation > 0.04) return deviation > 0 ? '#60a5fa' : '#f87171';
  return '#9ca3af';
}

interface HGTOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Passport Stamp card for provenance view
function PassportStampCard({
  stamp,
  colors,
  onClose,
}: {
  stamp: PassportStamp;
  colors: { text: string; textMuted: string; textDim: string; backgroundAlt: string; accent: string };
  onClose: () => void;
}): React.ReactElement {
  const island = stamp.island;
  const amelColor = ameliorationColor(stamp.amelioration);

  return (
    <div
      style={{
        padding: '0.75rem',
        backgroundColor: colors.backgroundAlt,
        border: `2px solid ${amelColor}`,
        borderRadius: '6px',
        fontSize: '0.8rem',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
        <div>
          <div style={{ fontWeight: 'bold', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Passport Stamp
            <span
              style={{
                fontSize: '0.7rem',
                padding: '0.1rem 0.4rem',
                backgroundColor: amelColor,
                color: '#fff',
                borderRadius: '3px',
              }}
            >
              {stamp.amelioration.toUpperCase()}
            </span>
          </div>
          <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
            {island.start.toLocaleString()} - {island.end.toLocaleString()} bp ({((island.end - island.start) / 1000).toFixed(1)} kb)
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: '1rem' }}
        >
          x
        </button>
      </div>

      {/* GC & Compositional Info */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <div>
          <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>GC Content</div>
          <div style={{ fontWeight: 'bold' }}>
            {island.gc.toFixed(1)}%
            <span style={{ color: stamp.gcDelta > 0 ? '#3b82f6' : '#ef4444', marginLeft: '0.25rem' }}>
              ({stamp.gcDelta > 0 ? '+' : ''}{stamp.gcDelta.toFixed(1)}% vs genome)
            </span>
          </div>
        </div>
        <div>
          <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>Z-Score</div>
          <div style={{ fontWeight: 'bold' }}>{island.zScore.toFixed(2)}</div>
        </div>
      </div>

      {/* Amelioration Timing */}
      <div style={{ marginBottom: '0.5rem' }}>
        <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>Transfer Timing</div>
        <div style={{ color: amelColor, fontWeight: 'bold' }}>
          {ameliorationLabel(stamp.amelioration)}
        </div>
      </div>

      {/* Donor Candidates */}
      {stamp.donorDistribution.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ color: colors.textMuted, fontSize: '0.7rem', marginBottom: '0.25rem' }}>
            Putative Donors (k-mer similarity)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            {stamp.donorDistribution.slice(0, 3).map((d, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div
                  style={{
                    width: `${Math.max(20, d.similarity * 100)}%`,
                    height: '8px',
                    backgroundColor: d.confidence === 'high' ? '#22c55e' : d.confidence === 'medium' ? '#f59e0b' : '#6b7280',
                    borderRadius: '2px',
                  }}
                />
                <span style={{ fontSize: '0.7rem' }}>
                  {d.taxon} ({(d.similarity * 100).toFixed(0)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hallmark Genes */}
      {stamp.hallmarks.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ color: colors.textMuted, fontSize: '0.7rem', marginBottom: '0.25rem' }}>
            Hallmark Genes ({stamp.hallmarks.length})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
            {stamp.hallmarks.slice(0, 5).map((h, i) => (
              <span
                key={i}
                style={{
                  fontSize: '0.65rem',
                  padding: '0.1rem 0.3rem',
                  backgroundColor: colors.accent,
                  color: '#fff',
                  borderRadius: '2px',
                }}
              >
                {h.length > 25 ? h.slice(0, 22) + '...' : h}
              </span>
            ))}
            {stamp.hallmarks.length > 5 && (
              <span style={{ fontSize: '0.65rem', color: colors.textMuted }}>
                +{stamp.hallmarks.length - 5} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Genes in Island */}
      {island.genes.length > 0 && (
        <div>
          <div style={{ color: colors.textMuted, fontSize: '0.7rem', marginBottom: '0.25rem' }}>
            Genes in Island ({island.genes.length})
          </div>
          <div style={{ fontSize: '0.7rem', color: colors.textDim, maxHeight: '4rem', overflowY: 'auto' }}>
            {island.genes.slice(0, 6).map((g, i) => (
              <div key={i}>
                {g.locusTag || g.name || `Gene ${g.id}`}: {g.product || 'hypothetical protein'}
              </div>
            ))}
            {island.genes.length > 6 && (
              <div style={{ color: colors.textMuted }}>+{island.genes.length - 6} more genes</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function HGTOverlay({
  repository,
  currentPhage,
}: HGTOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('hgt');
  const windowSelectId = 'hgt-window-size';
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const genesCache = useRef<Map<number, GeneInfo[]>>(new Map());

  const [sequence, setSequence] = useState<string>('');
  const [genes, setGenes] = useState<GeneInfo[]>([]);
  const [loading, setLoading] = useState(false);

  // Analysis parameters
  const [windowSize, setWindowSize] = useState(2000);

  // Selected stamp for details
  const [selectedStamp, setSelectedStamp] = useState<PassportStamp | null>(null);

  // Hover state
  const [hoverInfo, setHoverInfo] = useState<GenomeTrackInteraction | null>(null);

  // Hotkey to toggle overlay (Alt+H)
  useHotkey(
    { key: 'h', modifiers: { alt: true } },
    'HGT Provenance Tracer',
    () => toggle('hgt'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'power' }
  );

  // Fetch full genome and genes when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('hgt')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setGenes([]);
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    // Check cache first
    if (sequenceCache.current.has(phageId) && genesCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      setGenes(genesCache.current.get(phageId) ?? []);
      setLoading(false);
      return;
    }

    setLoading(true);
    Promise.all([
      repository.getFullGenomeLength(phageId).then((length: number) => repository.getSequenceWindow(phageId, 0, length)),
      repository.getGenes(phageId),
    ])
      .then(([seq, geneList]) => {
        sequenceCache.current.set(phageId, seq);
        genesCache.current.set(phageId, geneList);
        setSequence(seq);
        setGenes(geneList);
      })
      .catch(() => {
        setSequence('');
        setGenes([]);
      })
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  // Run enhanced HGT provenance analysis
  const provenanceAnalysis = useMemo((): HGTAnalysis | null => {
    if (!sequence || sequence.length < windowSize * 2) return null;
    return analyzeHGTProvenance(sequence, genes, {}, { window: windowSize, step: windowSize / 2 });
  }, [sequence, genes, windowSize]);

  // Convert stamps to track segments (colored by amelioration)
  const islandSegments = useMemo((): GenomeTrackSegment[] => {
    if (!provenanceAnalysis) return [];
    return provenanceAnalysis.stamps.map((stamp, idx) => ({
      start: stamp.island.start,
      end: stamp.island.end,
      label: `${stamp.amelioration} (${stamp.hallmarks.length} hallmarks)`,
      color: ameliorationColor(stamp.amelioration),
      height: Math.max(12, Math.min(24, 12 + stamp.hallmarks.length * 2)),
      data: { stamp, idx },
    }));
  }, [provenanceAnalysis]);

  // Create GC deviation segments from windows
  const gcSegments = useMemo((): GenomeTrackSegment[] => {
    if (!sequence || !provenanceAnalysis) return [];
    const genomeGC = provenanceAnalysis.genomeGC;
    const step = windowSize / 2;
    const segments: GenomeTrackSegment[] = [];
    for (let start = 0; start + windowSize <= sequence.length; start += step) {
      const windowSeq = sequence.slice(start, start + windowSize);
      const gc = calculateGC(windowSeq);
      const deviation = gc - genomeGC / 100;
      segments.push({
        start,
        end: start + windowSize,
        label: `GC: ${(gc * 100).toFixed(1)}%`,
        color: gcDeviationColor(deviation),
        height: Math.min(20, Math.abs(deviation) * 200),
        data: { gc, deviation },
      });
    }
    return segments;
  }, [sequence, provenanceAnalysis, windowSize]);

  // Handle track hover
  const handleHover = useCallback((info: GenomeTrackInteraction | null) => {
    setHoverInfo(info);
  }, []);

  // Handle track click
  const handleClick = useCallback((info: GenomeTrackInteraction) => {
    if (info.segment?.data?.stamp) {
      setSelectedStamp(info.segment.data.stamp as PassportStamp);
    }
  }, []);

  if (!isOpen('hgt')) return null;

  return (
    <Overlay
      id="hgt"
      title="HGT PROVENANCE TRACER"
      hotkey="Alt+H"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Description */}
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.85rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong style={{ color: colors.accent }}>HGT Provenance Tracer</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about horizontal gene transfer"
                tooltip={overlayHelp?.summary ?? 'HGT moves genes between organisms. This tool creates passport stamps for each island.'}
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'horizontal-gene-transfer')}
              />
            )}
          </div>
          <div>
            Detects genomic islands and creates &quot;passport stamps&quot; showing donor lineage, hallmark genes,
            and amelioration timing (how long ago the transfer occurred).
          </div>
        </div>

        {loading ? (
          <AnalysisPanelSkeleton />
        ) : !provenanceAnalysis ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            {!sequence ? 'No sequence loaded' : 'Sequence too short for analysis'}
          </div>
        ) : (
          <>
            {/* Controls */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                fontSize: '0.8rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor={windowSelectId} style={{ color: colors.textMuted }}>
                  Window:
                </label>
                <select
                  id={windowSelectId}
                  value={windowSize}
                  onChange={(e) => setWindowSize(Number(e.target.value))}
                  style={{
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value={1000}>1000 bp</option>
                  <option value={2000}>2000 bp</option>
                  <option value={5000}>5000 bp</option>
                </select>
              </div>

              <span style={{ color: colors.textMuted }}>
                Genome GC: {provenanceAnalysis.genomeGC.toFixed(1)}% |{' '}
                {provenanceAnalysis.islands.length} island{provenanceAnalysis.islands.length !== 1 ? 's' : ''} detected
              </span>
            </div>

            {/* Island Track */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <span>HGT Islands (click for passport stamp)</span>
              </div>
              <GenomeTrack
                genomeLength={sequence.length}
                segments={islandSegments}
                width={540}
                height={50}
                onHover={handleHover}
                onClick={handleClick}
                ariaLabel="HGT island track"
              />
            </div>

            {/* GC Deviation Track */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.25rem',
                }}
              >
                GC% Deviation (blue = high GC, red = low GC)
              </div>
              <GenomeTrack
                genomeLength={sequence.length}
                segments={gcSegments}
                width={540}
                height={40}
                onHover={handleHover}
                ariaLabel="GC deviation track"
              />
            </div>

            {/* Hover tooltip */}
            {hoverInfo && (
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                }}
              >
                Position: {Math.round(hoverInfo.position).toLocaleString()} bp
                {hoverInfo.segment && (
                  <span style={{ marginLeft: '1rem', color: colors.textMuted }}>
                    {hoverInfo.segment.label}
                  </span>
                )}
              </div>
            )}

            {/* Selected passport stamp */}
            {selectedStamp && (
              <PassportStampCard
                stamp={selectedStamp}
                colors={colors}
                onClose={() => setSelectedStamp(null)}
              />
            )}

            {/* Legend */}
            <div
              style={{
                display: 'flex',
                gap: '1.5rem',
                fontSize: '0.75rem',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span style={{ width: '12px', height: '12px', backgroundColor: '#ef4444', borderRadius: '2px' }} />
                <span style={{ color: colors.textMuted }}>Recent</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span style={{ width: '12px', height: '12px', backgroundColor: '#f59e0b', borderRadius: '2px' }} />
                <span style={{ color: colors.textMuted }}>Intermediate</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span style={{ width: '12px', height: '12px', backgroundColor: '#22c55e', borderRadius: '2px' }} />
                <span style={{ color: colors.textMuted }}>Ancient</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span style={{ width: '12px', height: '12px', backgroundColor: '#6b7280', borderRadius: '2px' }} />
                <span style={{ color: colors.textMuted }}>Unknown</span>
              </div>
            </div>

            {/* Summary */}
            {provenanceAnalysis.stamps.length > 0 && (
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  color: colors.textDim,
                }}
              >
                <strong>Summary:</strong>{' '}
                {provenanceAnalysis.stamps.filter(s => s.amelioration === 'recent').length} recent,{' '}
                {provenanceAnalysis.stamps.filter(s => s.amelioration === 'intermediate').length} intermediate,{' '}
                {provenanceAnalysis.stamps.filter(s => s.amelioration === 'ancient').length} ancient transfers.{' '}
                {provenanceAnalysis.stamps.reduce((sum, s) => sum + s.hallmarks.length, 0)} total hallmark genes.
              </div>
            )}
          </>
        )}
      </div>
    </Overlay>
  );
}

export default HGTOverlay;
