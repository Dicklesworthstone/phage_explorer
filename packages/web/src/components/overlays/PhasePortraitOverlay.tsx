/**
 * PhasePortraitOverlay - Amino Acid Property PCA Scatter Plot
 *
 * Visualizes protein property patterns using sliding window PCA analysis.
 * Shows hydropathy, charge, aromaticity, flexibility, and disorder patterns
 * across the translated genome, revealing functional domains and potential HGT events.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { ScatterCanvas } from './primitives/ScatterCanvas';
import { computePhasePortrait, translateSequence } from '@phage-explorer/core';
import type { DominantProperty, PortraitPoint } from '@phage-explorer/core';
import type { ScatterPoint, ScatterHover } from './primitives/types';

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
  hydrophobic: 'Hydrophobic core / membrane interaction',
  charged: 'Charged surface / ion binding',
  aromatic: 'Aromatic clusters / stacking interactions',
  flexible: 'Flexible loops / hinge regions',
  disordered: 'Intrinsically disordered / signaling',
  flat: 'No dominant property',
};

// Helper component for tooltip content to avoid TypeScript issues with unknown data
function TooltipContent({ point, colors }: { point: PortraitPoint; colors: { textMuted: string; textDim: string } }): React.ReactElement {
  return (
    <>
      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
        Residues {point.start} - {point.end}
      </div>
      <div style={{ color: PROPERTY_COLORS[point.dominant] }}>
        {point.dominant.toUpperCase()}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        {PROPERTY_DESCRIPTIONS[point.dominant]}
      </div>
      <div style={{ marginTop: '0.25rem', color: colors.textDim }}>
        Hydropathy: {point.hydropathy.toFixed(2)}<br />
        Charge: {point.charge.toFixed(2)}<br />
        Disorder: {point.disorder.toFixed(2)}
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
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Hover state for tooltip
  const [hoveredPoint, setHoveredPoint] = useState<ScatterHover | null>(null);

  // Analysis parameters
  const [windowSize, setWindowSize] = useState(30);
  const [stepSize] = useState(5);
  const [colorBy, setColorBy] = useState<'dominant' | 'hydropathy' | 'disorder'>('dominant');

  // Hotkey to toggle overlay (Alt+Shift+P)
  useHotkey(
    { key: 'p', modifiers: { alt: true, shift: true } },
    'Phase Portrait (Amino Acid Properties)',
    () => toggle('phasePortrait'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('phasePortrait')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      return;
    }

    const phageId = currentPhage.id;

    // Check cache first
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      return;
    }

    setLoading(true);
    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => setSequence(''))
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  // Translate sequence and compute phase portrait
  const analysis = useMemo(() => {
    if (!sequence || sequence.length < 100) return null;

    // Translate the DNA sequence to amino acids
    const aaSequence = translateSequence(sequence, 0);
    if (aaSequence.length < windowSize) return null;

    // Compute phase portrait using core function
    const result = computePhasePortrait(aaSequence, windowSize, stepSize);
    return { ...result, aaSequence };
  }, [sequence, windowSize, stepSize]);

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
        label: `Window ${point.start}-${point.end}`,
        value,
        color,
        size: 4,
        data: point,
      };
    });
  }, [analysis, colorBy]);

  // Handle hover
  const handleHover = useCallback((hover: ScatterHover | null) => {
    setHoveredPoint(hover);
  }, []);

  // Handle click - could navigate to position in main viewer
  const handleClick = useCallback((hover: ScatterHover | null) => {
    if (hover?.point?.data) {
      const point = hover.point.data as PortraitPoint;
      console.log(`Navigate to amino acid position ${point.start}`);
    }
  }, []);

  if (!isOpen('phasePortrait')) return null;

  const legendItems = Object.entries(PROPERTY_COLORS).map(([key, color]) => ({
    label: key.charAt(0).toUpperCase() + key.slice(1),
    color,
  }));

  return (
    <Overlay
      id="phasePortrait"
      title="PHASE PORTRAIT (Amino Acid Properties)"
      icon="*"
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
          properties across the proteome. Points represent sliding windows of {windowSize} amino acids.
          Clusters reveal functional domains; outliers may indicate HGT or specialized functions.
        </div>

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            Loading sequence...
          </div>
        ) : !analysis ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            {!sequence ? 'No sequence loaded' : 'Sequence too short for analysis'}
          </div>
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
              {hoveredPoint?.point?.data != null && (
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
                  <TooltipContent point={hoveredPoint.point.data as PortraitPoint} colors={colors} />
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
              <strong>Interpretation:</strong> Tight clusters = conserved functional domains.
              Outliers = potential HGT, recent acquisitions, or specialized functions.
              PC1 typically captures hydrophobicity; PC2 reflects charge/size patterns.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default PhasePortraitOverlay;
