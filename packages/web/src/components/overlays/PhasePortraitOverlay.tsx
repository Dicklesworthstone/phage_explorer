/**
 * PhasePortraitOverlay - Amino Acid Property PCA Scatter Plot
 *
 * Visualizes protein property patterns using sliding window PCA analysis.
 * Shows hydropathy, charge, aromaticity, flexibility, and disorder patterns
 * across an explicitly selected, verified annotated CDS.
 */

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { prepareCdsPhasePortraitInput, mapCdsResidueRange, PHASE_PROPERTY_LABELS, type CdsPhasePortraitInput, type PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import { ScatterCanvas } from './primitives/ScatterCanvas';
import type { DominantProperty, PhasePortraitResult, PortraitPoint } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import type { ScatterPoint, ScatterHover } from './primitives/types';
import { ComputeOrchestrator } from '../../workers/ComputeOrchestrator';

// Color mapping for dominant properties
const PROPERTY_COLORS: Record<DominantProperty, string> = {
  hydrophobic: '#3b82f6', // Blue
  charged: '#ef4444',     // Red
  aromatic: '#a855f7',    // Purple
  flexible: '#22c55e',    // Green
  disordered: '#f97316',  // Orange
  flat: '#6b7280',        // Gray
};

// Property descriptions for tooltip
const PROPERTY_DESCRIPTIONS: Record<DominantProperty, string> = {
  hydrophobic: 'Window hydropathy score',
  charged: 'Window charged-residue balance',
  aromatic: 'Window aromatic-residue fraction',
  flexible: 'Window flexibility propensity score',
  disordered: 'Window disorder propensity score',
  flat: 'No dominant property',
};

// Helper component for tooltip content to avoid TypeScript issues with unknown data
function TooltipContent({ point, input, colors }: { point: PortraitPoint; input: CdsPhasePortraitInput; colors: { textMuted: string; textDim: string } }): React.ReactElement {
  return (
    <>
      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
        CDS residues {point.start + 1} - {point.end}
      </div>
      <div style={{ color: PROPERTY_COLORS[point.dominant] }}>
        {PHASE_PROPERTY_LABELS[point.dominant]}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        {PROPERTY_DESCRIPTIONS[point.dominant]}
      </div>
      <div style={{ marginTop: '0.25rem', color: colors.textDim }}>
        Hydropathy: {point.hydropathy.toFixed(2)}<br />
        Charge: {point.charge.toFixed(2)}<br />
        Disorder score: {point.disorder.toFixed(2)}
      </div>
      <div style={{ marginTop: '0.25rem', color: colors.textDim }}>
        Genome (1-based): {mapCdsResidueRange(input.reference, point.start, point.end)
          .map(segment => `${segment.start + 1}-${segment.end} (${segment.strand})`).join(', ')}
      </div>
    </>
  );
}

interface PhasePortraitOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function PhasePortraitOverlay({ repository, currentPhage }: PhasePortraitOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const overlayOpen = isOpen('phasePortrait');
  const setViewMode = usePhageStore((s) => s.setViewMode);
  const setScrollPosition = usePhageStore((s) => s.setScrollPosition);
  const [loaded, setLoaded] = useState<{ repository: PhageRepository; phage: PhageFull; sequence: string; genes: PhageFull['genes'] } | null>(null);
  const source = overlayOpen && loaded?.repository === repository && loaded?.phage === currentPhage ? loaded : null;
  const sequence = source?.sequence ?? '';
  const genes = useMemo(() => (source?.genes ?? []).filter(gene => gene.type === 'CDS'), [source]);
  const [selectedGeneId, setSelectedGeneId] = useState<number | null>(null);
  const gene = genes.find(candidate => candidate.id === selectedGeneId) ?? genes[0];
  const portraitInput = useMemo(() => sequence && gene ? prepareCdsPhasePortraitInput(sequence, gene) : null, [sequence, gene]);
  const [loading, setLoading] = useState(false);
  const [computed, setComputed] = useState<{ input: typeof loaded; cds: typeof portraitInput; windowSize: number; stepSize: number; result: PhasePortraitResult } | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ analysis: PhasePortraitResult; point: ScatterHover } | null>(null);
  const [windowSize, setWindowSize] = useState(30);
  const [stepSize] = useState(5);
  const [colorBy, setColorBy] = useState<'dominant' | 'hydropathy' | 'disorder'>('dominant');
  const analysis = sequence && portraitInput?.protein && computed?.input === loaded && computed.cds === portraitInput
    && computed.windowSize === windowSize && computed.stepSize === stepSize ? computed.result : null;
  const hoveredPoint = hovered?.analysis === analysis ? hovered.point : null;

  useHotkey(
    ActionIds.OverlayPhasePortrait,
    () => toggle('phasePortrait'),
    { modes: ['NORMAL'] }
  );

  // Sequence and canonical annotations are accepted together for one repository/selection.
  useEffect(() => {
    if (!overlayOpen) return;
    if (!repository || !currentPhage) {
      setLoaded(null);
      setLoading(false);
      setLoadError(null);
      return;
    }
    const phage = currentPhage;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    repository.getFullGenomeLength(phage.id)
      .then(length => cancelled ? null : Promise.all([
        repository.getSequenceWindow(phage.id, 0, length),
        repository.getGenes(phage.id),
      ]))
      .then(result => {
        if (cancelled || result === null) return;
        const [sequence, genes] = result;
        setLoaded({ repository, phage, sequence, genes });
      })
      .catch(error => {
        if (cancelled) return;
        setLoaded(null);
        setLoadError(error instanceof Error ? error.message : 'Could not load the selected genome and CDS annotations.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [overlayOpen, repository, currentPhage]);

  // The worker receives the exact supported protein, never a genome frame-zero translation.
  useEffect(() => {
    if (!overlayOpen || !portraitInput?.protein || !loaded || portraitInput.protein.length < windowSize) {
      setComputed(null);
      setAnalysisLoading(false);
      setAnalysisError(null);
      return;
    }
    const controller = new AbortController();
    setAnalysisLoading(true);
    setAnalysisError(null);
    ComputeOrchestrator.getInstance()
      .computeProteinPhasePortrait(portraitInput.protein, windowSize, stepSize, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setComputed(result ? { input: loaded, cds: portraitInput, windowSize, stepSize, result } : null);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setComputed(null);
        setAnalysisError(error instanceof Error ? error.message : 'Failed to compute phase portrait');
      })
      .finally(() => { if (!controller.signal.aborted) setAnalysisLoading(false); });
    return () => controller.abort();
  }, [overlayOpen, portraitInput, loaded, windowSize, stepSize]);

  // Convert portrait points to scatter points for visualization
  const scatterPoints = useMemo((): ScatterPoint[] => {
    if (!analysis?.points?.length) return [];

    return analysis.points.map((point: PortraitPoint, index: number) => {
      let color: string;
      let value: number;

      switch (colorBy) {
        case 'hydropathy':
          // Normalize hydropathy to 0-1 range
          value = (point.hydropathy + 4.5) / 9; // Typical range -4.5 to 4.5
          color = value > 0.5 ? '#3b82f6' : '#ef4444'; // Blue for hydrophobic, red for hydrophilic
          break;
        case 'disorder':
          value = point.disorder;
          color = `hsl(${(1 - value) * 120}, 70%, 50%)`; // Green to red
          break;
        default:
          value = 0;
          color = PROPERTY_COLORS[point.dominant] ?? PROPERTY_COLORS.flat;
      }

      return {
        x: point.coord.x,
        y: point.coord.y,
        id: `point-${index}`,
        label: `CDS residues ${point.start + 1}-${point.end}`,
        value,
        color,
        size: 4,
        data: point,
      };
    });
  }, [analysis, colorBy]);

  // Handle hover
  const handleHover = useCallback((hover: ScatterHover | null) => {
    setHovered(hover && analysis ? { analysis, point: hover } : null);
  }, [analysis]);

  // Select the actual first coding base, including reverse/split codons. The raw
  // genome AA view is a separate reading-frame visualization, so navigate in DNA.
  const handleClick = useCallback((hover: ScatterHover | null) => {
    if (!analysis || !portraitInput || !hover?.point?.data) return;
    const point = hover.point.data as PortraitPoint;
    if (analysis.points[point.index] !== point) return;
    const [segment] = mapCdsResidueRange(portraitInput.reference, point.start, point.end);
    if (!segment) return;
    setViewMode('dna');
    setScrollPosition(segment.strand === '-' ? segment.end - 1 : segment.start);
  }, [analysis, portraitInput, setScrollPosition, setViewMode]);

  if (!overlayOpen) return null;

  const legendItems = Object.entries(PROPERTY_COLORS).map(([key, color]) => ({
    label: PHASE_PROPERTY_LABELS[key as DominantProperty],
    color,
  }));

  return (
    <Overlay
      id="phasePortrait"
      title="PHASE PORTRAIT (Amino Acid Properties)"
      hotkey="Alt+Shift+P"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Description */}
        <div style={{
          padding: '0.75rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
          color: colors.textDim,
          fontSize: '0.85rem',
        }}>
          <strong style={{ color: colors.accent }}>Phase Portrait</strong>: PCA projection of amino acid
          properties in one annotated CDS. Points represent complete windows of {windowSize} protein residues.
          Translation follows its joined segments, strand, codon_start and declared genetic code.
          Click a window to view its first coding base in the DNA viewer.
        </div>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center', fontSize: '0.8rem' }}>
          <label style={{ color: colors.textMuted }}>
            Annotated CDS:
            <select value={gene?.id ?? ''} disabled={!genes.length} onChange={event => setSelectedGeneId(Number(event.target.value))}
              style={{ marginLeft: '0.5rem', maxWidth: '100%', backgroundColor: colors.backgroundAlt, color: colors.text }}>
              {!genes.length && <option value="">No annotated CDS</option>}
              {genes.map(candidate => <option key={candidate.id} value={candidate.id}>
                {candidate.locusTag || candidate.name || `CDS ${candidate.id}`} — {candidate.product || 'No product annotation'}
              </option>)}
            </select>
          </label>
              <label style={{ color: colors.textMuted }}>
                Window:
                <select
                  value={windowSize}
                  onChange={(e) => setWindowSize(Number(e.target.value))}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value={15}>15 residues</option>
                  <option value={30}>30 residues</option>
                  <option value={50}>50 residues</option>
                  <option value={100}>100 residues</option>
                </select>
              </label>
        </div>
        {portraitInput && (
          <p data-testid="phase-portrait-cds" style={{ color: colors.textDim, fontSize: '0.8rem' }}>
            {portraitInput.reference.name} · NCBI table {portraitInput.reference.geneticCode} · codon_start {portraitInput.reference.codonStart}
            {' '}· {portraitInput.protein?.length ?? 0} protein residues; terminal stop excluded.
          </p>
        )}

        {loading || analysisLoading ? (
          <OverlayLoadingState message={loading ? 'Loading sequence data...' : 'Computing phase portrait...'}>
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : analysisError || loadError ? (
          <OverlayErrorState
            message="Phase portrait analysis failed"
            details={analysisError ?? loadError ?? undefined}
          />
        ) : !analysis ? (
          <OverlayEmptyState
            message={!sequence ? 'No sequence loaded' : !gene ? 'No annotated CDS available'
              : !portraitInput?.protein ? 'Selected CDS is unavailable' : 'Protein is shorter than the selected window'}
            hint={!sequence ? 'Select a phage to analyze amino acid properties.' : !gene ? 'Import a GenBank record with CDS features.'
              : !portraitInput?.protein ? portraitInput?.reference.reasons.join(' ') : 'Lower the window size or choose another CDS.'}
          />
        ) : (
          <>
            {/* Controls */}
            <div style={{
              display: 'flex',
              gap: '1rem',
              flexWrap: 'wrap',
              alignItems: 'center',
              fontSize: '0.8rem',
            }}>
              <label style={{ color: colors.textMuted }}>
                Color by:
                <select
                  value={colorBy}
                  onChange={(e) => setColorBy(e.target.value as typeof colorBy)}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value="dominant">Dominant Property</option>
                  <option value="hydropathy">Hydropathy</option>
                  <option value="disorder">Disorder</option>
                </select>
              </label>

              <span style={{ color: colors.textMuted }}>
                {analysis.points.length} windows |
                PC1: {(analysis.explained[0] * 100).toFixed(1)}%,
                PC2: {(analysis.explained[1] * 100).toFixed(1)}%
              </span>
            </div>

            {/* Scatter plot */}
            <div style={{
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              overflow: 'hidden',
              position: 'relative',
            }}>
              <ScatterCanvas
                width={500}
                height={350}
                points={scatterPoints}
                backgroundColor={colors.background}
                xLabel="PC1"
                yLabel="PC2"
                pointSize={4}
                onHover={handleHover}
                onClick={handleClick}
                ariaLabel="Amino acid phase portrait scatter plot"
              />

              {/* Tooltip */}
              {hoveredPoint &&
                hoveredPoint.point.data !== undefined &&
                hoveredPoint.point.data !== null && (
                <div
                  style={{
                    position: 'absolute',
                    left: Math.min(hoveredPoint.canvasX + 10, 400),
                    top: Math.max(hoveredPoint.canvasY - 60, 10),
                    backgroundColor: colors.backgroundAlt,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '4px',
                    padding: '0.5rem',
                    fontSize: '0.75rem',
                    color: colors.text,
                    pointerEvents: 'none',
                    zIndex: 10,
                    maxWidth: '200px',
                  }}
                >
                  <TooltipContent point={hoveredPoint.point.data as PortraitPoint} input={portraitInput!} colors={colors} />
                </div>
              )}
            </div>

            {/* Legend */}
            {colorBy === 'dominant' && (
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.75rem',
                fontSize: '0.75rem',
              }}>
                {legendItems.map(({ label, color }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{
                      width: '10px',
                      height: '10px',
                      backgroundColor: color,
                      borderRadius: '2px',
                    }} />
                    <span style={{ color: colors.textMuted }}>{label}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Interpretation guide */}
            <div style={{
              padding: '0.5rem',
              backgroundColor: colors.backgroundAlt,
              borderRadius: '4px',
              fontSize: '0.75rem',
              color: colors.textDim,
            }}>
              <strong>Interpretation:</strong> Distances describe the five window property scores in this selected protein.
              PCA axes depend on this input and its settings. Clusters and outliers do not establish functional domains,
              conservation, disorder, or horizontal gene transfer.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default PhasePortraitOverlay;
