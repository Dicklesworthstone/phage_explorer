/**
 * RNAStructureOverlay - RNA Structure & Packaging Signal Explorer
 *
 * Visualizes how synonymous changes affect mRNA folding/ΔG along coding regions.
 * Identifies structure-constrained segments and potential regulatory elements.
 */

import React, { useMemo, useState, useEffect, useRef } from 'react';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import type { ThemePalette } from '../../theme/types';
import {
  OverlayLoadingState,
  OverlayEmptyState,
} from './primitives';
import {
  analyzeRNAStructure,
  type RNAStructureAnalysis,
  type CodonStress,
  type RegulatoryHypothesis,
} from '@phage-explorer/core';

// ============================================================================
// Styling Helpers
// ============================================================================

function stressColor(stress: number): string {
  // Red = high stress (structure-constrained), Blue = low stress (freely variable)
  if (stress >= 0.8) return '#ef4444'; // Constrained
  if (stress >= 0.6) return '#f97316';
  if (stress >= 0.4) return '#eab308';
  if (stress >= 0.2) return '#22c55e';
  return '#3b82f6'; // Freely variable
}

function mfeColor(mfe: number): string {
  // More negative = more stable structure
  if (mfe < -10) return '#7c3aed'; // Very stable
  if (mfe < -5) return '#a855f7';
  if (mfe < -2) return '#c084fc';
  return '#e9d5ff'; // Less stable
}

function regulatoryTypeIcon(type: RegulatoryHypothesis['type']): string {
  switch (type) {
    case 'stem-loop': return '🔁';
    case 'riboswitch': return '🎚️';
    case 'attenuator': return '🛑';
    case 'packaging-signal': return '📦';
    case 'slippery-site': return '🔀';
    default: return '❓';
  }
}

function regulatoryTypeLabel(type: RegulatoryHypothesis['type']): string {
  switch (type) {
    case 'stem-loop': return 'Stem-Loop';
    case 'riboswitch': return 'Riboswitch';
    case 'attenuator': return 'Attenuator';
    case 'packaging-signal': return 'Packaging Signal';
    case 'slippery-site': return 'Slippery Site (Frameshift)';
    default: return 'Unknown';
  }
}

// ============================================================================
// Sub-components
// ============================================================================

interface StressHeatStripProps {
  stressData: CodonStress[];
  width: number;
  height: number;
  onHover?: (codon: CodonStress | null) => void;
  colors: ThemePalette;
}

function StressHeatStrip({
  stressData,
  width,
  height,
  onHover,
  colors,
}: StressHeatStripProps): React.ReactElement {
  const cellWidth = width / Math.max(stressData.length, 1);

  return (
    <div style={{ position: 'relative', width, height }}>
      <svg width={width} height={height}>
        {stressData.map((codon, i) => (
          <rect
            key={i}
            x={i * cellWidth}
            y={0}
            width={Math.max(cellWidth, 1)}
            height={height}
            fill={stressColor(codon.stress)}
            opacity={0.8}
            onMouseEnter={() => onHover?.(codon)}
            onMouseLeave={() => onHover?.(null)}
            style={{ cursor: 'pointer' }}
          />
        ))}
      </svg>
      {/* Axis labels */}
      <div
        style={{
          position: 'absolute',
          bottom: -16,
          left: 0,
          fontSize: '0.65rem',
          color: colors.textMuted,
        }}
      >
        0
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: -16,
          right: 0,
          fontSize: '0.65rem',
          color: colors.textMuted,
        }}
      >
        {stressData.length} codons
      </div>
    </div>
  );
}

interface MFEPlotProps {
  windows: RNAStructureAnalysis['windows'];
  width: number;
  height: number;
  colors: ThemePalette;
}

function MFEPlot({ windows, width, height, colors }: MFEPlotProps): React.ReactElement {
  if (windows.length === 0) {
    return <div style={{ color: colors.textMuted }}>No windows</div>;
  }

  // Windows with no stem carry null and are excluded from the scale rather
  // than plotted at zero, which would put "nothing found" in the middle of the
  // axis alongside genuinely unstructured-but-scored windows.
  const scored = windows.map(w => w.pairingScore).filter((v): v is number => v !== null);
  const minMFE = scored.length > 0 ? Math.min(...scored) : 0;
  const maxMFE = scored.length > 0 ? Math.max(...scored) : 0;
  const range = maxMFE - minMFE || 1;

  const cellWidth = width / windows.length;

  // Create path for MFE line
  const points = windows.map((w, i) => {
    const x = i * cellWidth + cellWidth / 2;
    const y = height - (((w.pairingScore ?? minMFE) - minMFE) / range) * height;
    return `${x},${y}`;
  });

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height}>
        {/* Background bars for pairing density */}
        {windows.map((w, i) => (
          <rect
            key={i}
            x={i * cellWidth}
            y={0}
            width={cellWidth}
            height={height}
            fill={w.pairingScore === null ? colors.textDim : mfeColor(w.pairingScore)}
            opacity={w.pairingDensity * 0.6 + 0.2}
          />
        ))}
        {/* MFE line */}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke={colors.accent}
          strokeWidth={1.5}
        />
        {/* Zero line */}
        <line
          x1={0}
          y1={height - ((0 - minMFE) / range) * height}
          x2={width}
          y2={height - ((0 - minMFE) / range) * height}
          stroke={colors.textMuted}
          strokeDasharray="4,4"
          strokeWidth={0.5}
        />
      </svg>
      {/* Y-axis labels */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: -35,
          fontSize: '0.6rem',
          color: colors.textMuted,
        }}
      >
        {maxMFE.toFixed(1)}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: -35,
          fontSize: '0.6rem',
          color: colors.textMuted,
        }}
      >
        {minMFE.toFixed(1)}
      </div>
    </div>
  );
}

interface RegulatoryCardProps {
  hypothesis: RegulatoryHypothesis;
  colors: ThemePalette;
}

function RegulatoryCard({ hypothesis, colors }: RegulatoryCardProps): React.ReactElement {
  // null means no confidence can be computed, which is not the same as low
  // confidence. Exact motif matches carried the constants 0.7 and 0.3.
  const confidencePercent =
    hypothesis.confidence === null ? null : (hypothesis.confidence * 100).toFixed(0);

  return (
    <div
      style={{
        padding: '0.5rem',
        backgroundColor: colors.backgroundAlt,
        borderRadius: '4px',
        border: `1px solid ${colors.borderLight}`,
        fontSize: '0.8rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <span>{regulatoryTypeIcon(hypothesis.type)}</span>
        <span style={{ fontWeight: 'bold', color: colors.text }}>
          {regulatoryTypeLabel(hypothesis.type)}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            padding: '0.1rem 0.4rem',
            backgroundColor:
              hypothesis.confidence === null
                ? 'transparent'
                : hypothesis.confidence > 0.6
                  ? '#22c55e33'
                  : '#f5970033',
            borderRadius: '10px',
            fontSize: '0.7rem',
            color:
              hypothesis.confidence === null
                ? colors.textDim
                : hypothesis.confidence > 0.6
                  ? '#22c55e'
                  : '#f59700',
          }}
        >
          {confidencePercent === null ? 'motif match' : `${confidencePercent}% conf`}
        </span>
      </div>
      <div style={{ color: colors.textDim, marginBottom: '0.25rem' }}>
        {hypothesis.description}
      </div>
      <div style={{ display: 'flex', gap: '1rem', fontSize: '0.7rem', color: colors.textMuted }}>
        <span>Position: {hypothesis.start.toLocaleString()}-{hypothesis.end.toLocaleString()}</span>
      </div>
      <div
        style={{
          marginTop: '0.25rem',
          fontFamily: 'monospace',
          fontSize: '0.65rem',
          color: colors.textMuted,
          wordBreak: 'break-all',
        }}
      >
        {hypothesis.sequence.slice(0, 40)}{hypothesis.sequence.length > 40 ? '...' : ''}
      </div>
    </div>
  );
}

interface CodonDetailProps {
  codon: CodonStress;
  colors: ThemePalette;
}

function CodonDetail({ codon, colors }: CodonDetailProps): React.ReactElement {
  return (
    <div
      style={{
        padding: '0.75rem',
        backgroundColor: colors.backgroundAlt,
        borderRadius: '4px',
        border: `1px solid ${colors.borderLight}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
        <div>
          <span style={{ fontWeight: 'bold', fontFamily: 'monospace', fontSize: '1.1rem' }}>
            {codon.codon}
          </span>
          <span style={{ color: colors.textMuted, marginLeft: '0.5rem' }}>
            ({codon.aminoAcid})
          </span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          <div
            style={{
              padding: '0.2rem 0.5rem',
              backgroundColor: stressColor(codon.stress) + '33',
              borderRadius: '4px',
              fontSize: '0.8rem',
            }}
          >
            Stress: {(codon.stress * 100).toFixed(0)}%
          </div>
          {codon.isConstrained && (
            <span
              style={{
                padding: '0.2rem 0.5rem',
                backgroundColor: '#ef444433',
                borderRadius: '4px',
                color: '#ef4444',
                fontSize: '0.75rem',
                fontWeight: 'bold',
              }}
            >
              CONSTRAINED
            </span>
          )}
        </div>
      </div>

      <div style={{ fontSize: '0.8rem', color: colors.textDim, marginBottom: '0.5rem' }}>
        {/* No kcal/mol: this is the same greedy pairing score as everywhere
            else in this overlay, not a free energy. */}
        Position: codon {codon.position} | wild-type pairing score:{' '}
        {codon.wildTypeDeltaG.toFixed(2)}
      </div>

      {codon.variants.length > 0 && (
        <div>
          <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
            Synonymous alternatives:
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {codon.variants.map(v => (
              <div
                key={v.codon}
                style={{
                  padding: '0.2rem 0.5rem',
                  backgroundColor: v.deltaG < -0.5 ? '#22c55e22' : v.deltaG > 0.5 ? '#ef444422' : colors.backgroundAlt,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                }}
              >
                {v.codon}
                <span style={{ color: colors.textMuted, marginLeft: '0.25rem' }}>
                  {v.deltaG > 0 ? '+' : ''}{v.deltaG.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

interface RNAStructureOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function RNAStructureOverlay({
  repository,
  currentPhage,
}: RNAStructureOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const sequenceCache = useRef<Map<number, { sequence: string; genes: GeneInfo[] }>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [genes, setGenes] = useState<GeneInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const [selectedGene, setSelectedGene] = useState<GeneInfo | null>(null);
  const [hoveredCodon, setHoveredCodon] = useState<CodonStress | null>(null);
  const [viewMode, setViewMode] = useState<'genome' | 'gene'>('genome');

  // Hotkey to toggle overlay (Alt+R for RNA)
  useHotkey(
    ActionIds.OverlayRNAStructure,
    () => toggle('rnaStructure'),
    { modes: ['NORMAL'] }
  );

  // Fetch sequence and genes when overlay opens
  useEffect(() => {
    if (!isOpen('rnaStructure')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setGenes([]);
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;
    const cached = sequenceCache.current.get(phageId);
    if (cached) {
      setSequence(cached.sequence);
      setGenes(cached.genes.length > 0 ? cached.genes : (currentPhage.genes ?? []));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([
      repository.getFullGenomeLength(phageId).then(length => repository.getSequenceWindow(phageId, 0, length)),
      repository.getGenes(phageId),
    ])
      .then(([seq, geneList]) => {
        if (cancelled) return;
        sequenceCache.current.set(phageId, { sequence: seq, genes: geneList });
        setSequence(seq);
        setGenes(geneList);
      })
      .catch(() => {
        if (cancelled) return;
        setSequence('');
        setGenes([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Compute RNA structure analysis
  const analysis = useMemo((): RNAStructureAnalysis | null => {
    if (!sequence || sequence.length < 300) return null;

    if (viewMode === 'gene' && selectedGene) {
      const geneSeq = sequence.slice(selectedGene.startPos, selectedGene.endPos);
      if (geneSeq.length < 60) return null;
      return analyzeRNAStructure(geneSeq, { windowSize: 60, stepSize: 15 });
    }

    // Genome-wide analysis with larger windows
    return analyzeRNAStructure(sequence, { windowSize: 200, stepSize: 50 });
  }, [sequence, viewMode, selectedGene]);

  // Compute summary stats
  const summary = useMemo(() => {
    if (!analysis) return null;

    const constrainedCount = analysis.codonStress.filter(c => c.isConstrained).length;
    const constrainedPercent = (constrainedCount / Math.max(analysis.codonStress.length, 1)) * 100;

    return {
      totalCodons: analysis.codonStress.length,
      constrainedCount,
      constrainedPercent,
      highStressRegions: analysis.highStressRegions.length,
      regulatoryHypotheses: analysis.regulatoryHypotheses.length,
      globalMFE: analysis.globalMFE,
      avgStress: analysis.avgSynonymousStress * 100,
    };
  }, [analysis]);

  if (!isOpen('rnaStructure')) return null;

  return (
    <Overlay
      id="rnaStructure"
      title="RNA STRUCTURE & PACKAGING SIGNAL EXPLORER"
      hotkey="Alt+R"
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
          <strong style={{ color: colors.accent }}>Synonymous Stress Analysis</strong>:
          Maps how synonymous (silent) mutations would alter mRNA folding stability (ΔG).
          <strong style={{ color: '#ef4444' }}> High stress</strong> = structure-constrained (mutations destabilize structure).
          <strong style={{ color: '#3b82f6' }}> Low stress</strong> = freely variable.
          Identifies riboswitches, attenuators, and packaging signals.
        </div>

        {/* View mode and gene selection */}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ color: colors.textMuted, fontSize: '0.8rem' }}>
            View:
            <select
              value={viewMode}
              onChange={e => setViewMode(e.target.value as typeof viewMode)}
              style={{
                marginLeft: '0.5rem',
                padding: '0.25rem',
                backgroundColor: colors.backgroundAlt,
                color: colors.text,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '3px',
              }}
            >
              <option value="genome">Whole Genome</option>
              <option value="gene">Single Gene</option>
            </select>
          </label>

          {viewMode === 'gene' && (
            <label style={{ color: colors.textMuted, fontSize: '0.8rem' }}>
              Gene:
              <select
                value={selectedGene ? (selectedGene.locusTag ?? String(selectedGene.id)) : ''}
                onChange={(e) => {
                  const value = e.target.value;
                  const gene = genes.find((g) => (g.locusTag ?? String(g.id)) === value);
                  setSelectedGene(gene ?? null);
                }}
                style={{
                  marginLeft: '0.5rem',
                  padding: '0.25rem',
                  backgroundColor: colors.backgroundAlt,
                  color: colors.text,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '3px',
                  maxWidth: '200px',
                }}
              >
                <option value="">Select a gene...</option>
                {genes.map((g) => (
                  <option key={g.id} value={g.locusTag ?? String(g.id)}>
                    {g.name || g.locusTag} ({g.startPos.toLocaleString()}-{g.endPos.toLocaleString()})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {loading ? (
          <OverlayLoadingState message="Analyzing RNA structure...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : !analysis || !summary ? (
          <OverlayEmptyState
            message={
              !sequence
                ? 'No sequence loaded'
                : viewMode === 'gene' && !selectedGene
                  ? 'Select a gene to analyze'
                  : 'Sequence too short for analysis'
            }
            hint={
              !sequence
                ? 'Select a phage to analyze.'
                : viewMode === 'gene' && !selectedGene
                  ? 'Choose a gene from the dropdown above.'
                  : 'RNA structure analysis requires at least 300 bp.'
            }
          />
        ) : (
          <>
            {/* Summary metrics */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                gap: '0.5rem',
                fontSize: '0.8rem',
              }}
            >
              {[
                { label: 'Total Codons', value: summary.totalCodons.toLocaleString() },
                { label: 'Constrained', value: `${summary.constrainedCount} (${summary.constrainedPercent.toFixed(1)}%)`, highlight: summary.constrainedPercent > 20 },
                { label: 'Avg Stress', value: `${summary.avgStress.toFixed(1)}%` },
                {
                  // Was "Global MFE ... kcal/mol". The underlying value is a
                  // greedy stem-pairing score with toy constants, not a free
                  // energy: it could be positive, which is impossible for an
                  // MFE, and it was 0 when nothing was found. No unit, and an
                  // em dash where no stem formed.
                  label: 'Pairing score',
                  value:
                    summary.globalPairingScore === null
                      ? '\u2014 no stems found'
                      : summary.globalPairingScore.toFixed(1),
                },
                { label: 'High-Stress Regions', value: summary.highStressRegions.toString() },
                { label: 'Regulatory Hits', value: summary.regulatoryHypotheses.toString() },
              ].map(({ label, value, highlight }) => (
                <div
                  key={label}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>{label}</div>
                  <div
                    style={{
                      fontSize: '1rem',
                      fontWeight: 'bold',
                      color: highlight ? '#ef4444' : colors.text,
                    }}
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>

            {/* Stress heat strip */}
            <div>
              <div style={{ fontSize: '0.8rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                Synonymous Stress Along Sequence
              </div>
              <div style={{ backgroundColor: colors.backgroundAlt, padding: '0.5rem', borderRadius: '4px' }}>
                <StressHeatStrip
                  stressData={analysis.codonStress}
                  width={560}
                  height={24}
                  onHover={setHoveredCodon}
                  colors={colors}
                />
              </div>
              {/* Legend */}
              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '0.7rem', color: colors.textMuted }}>
                <span><span style={{ display: 'inline-block', width: 12, height: 12, backgroundColor: '#ef4444', borderRadius: 2, marginRight: 4 }} />Constrained (high stress)</span>
                <span><span style={{ display: 'inline-block', width: 12, height: 12, backgroundColor: '#3b82f6', borderRadius: 2, marginRight: 4 }} />Variable (low stress)</span>
              </div>
            </div>

            {/* Hovered codon detail */}
            {hoveredCodon && <CodonDetail codon={hoveredCodon} colors={colors} />}

            {/* MFE plot */}
            <div>
              <div style={{ fontSize: '0.8rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                Sliding window pairing score (unitless) &mdash; lower = more base pairing
              </div>
              <div
                style={{
                  backgroundColor: colors.backgroundAlt,
                  padding: '0.5rem 0.5rem 0.5rem 2.5rem',
                  borderRadius: '4px',
                }}
              >
                <MFEPlot windows={analysis.windows} width={540} height={60} colors={colors} />
              </div>
            </div>

            {/* Regulatory hypotheses */}
            {analysis.regulatoryHypotheses.length > 0 && (
              <div>
                <div style={{ fontSize: '0.8rem', color: colors.textMuted, marginBottom: '0.5rem' }}>
                  Regulatory Element Hypotheses ({analysis.regulatoryHypotheses.length})
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                    maxHeight: '200px',
                    overflowY: 'auto',
                  }}
                >
                  {analysis.regulatoryHypotheses.slice(0, 10).map((h, i) => (
                    <RegulatoryCard key={i} hypothesis={h} colors={colors} />
                  ))}
                </div>
              </div>
            )}

            {/* Interpretation */}
            <div
              style={{
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
                fontSize: '0.75rem',
                color: colors.textDim,
              }}
            >
              <strong>Interpretation:</strong> High-stress codons indicate positions where synonymous
              mutations would destabilize local RNA structure. These are often under selection to
              maintain secondary structures important for translation regulation, ribosome pausing,
              or packaging. Slippery sites can cause programmed frameshifts. Packaging signals
              near termini help virion assembly.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default RNAStructureOverlay;
