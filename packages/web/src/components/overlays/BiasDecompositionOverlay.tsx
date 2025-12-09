/**
 * BiasDecompositionOverlay - Codon/Dinucleotide Bias PCA
 *
 * Visualizes compositional bias patterns using PCA decomposition.
 * Shows sliding windows in PC1/PC2 space to reveal mutational biases,
 * host adaptation signals, and potential HGT events.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { ScatterCanvas } from './primitives/ScatterCanvas';
import {
  decomposeBias,
  computeDinucleotideFrequencies,
  DINUCLEOTIDES,
} from '@phage-explorer/core';
import type { BiasDecomposition, BiasProjection } from '@phage-explorer/core';
import type { ScatterPoint, ScatterHover } from './primitives/types';

// Color scale for GC content
function gcColor(gcContent: number): string {
  // Low GC = blue, High GC = red
  const hue = (1 - gcContent) * 240; // 240 = blue, 0 = red
  return `hsl(${hue}, 70%, 50%)`;
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

interface BiasDecompositionOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Tooltip component
function TooltipContent({
  projection,
  gcContent,
  colors,
}: {
  projection: BiasProjection;
  gcContent: number;
  colors: { textMuted: string; textDim: string };
}): React.ReactElement {
  return (
    <>
      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
        {projection.name}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        PC1: {projection.coords[0].toFixed(3)}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        PC2: {projection.coords[1].toFixed(3)}
      </div>
      <div style={{ marginTop: '0.25rem', color: colors.textDim }}>
        GC: {(gcContent * 100).toFixed(1)}%
      </div>
    </>
  );
}

export function BiasDecompositionOverlay({
  repository,
  currentPhage,
}: BiasDecompositionOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Hover state for tooltip
  const [hoveredPoint, setHoveredPoint] = useState<ScatterHover | null>(null);

  // Analysis parameters
  const [windowSize, setWindowSize] = useState(1000);
  const [stepSize] = useState(500);
  const [colorBy, setColorBy] = useState<'gc' | 'position'>('gc');

  // Hotkey to toggle overlay (Alt+B)
  useHotkey(
    { key: 'b', modifiers: { alt: true } },
    'Bias Decomposition (Dinucleotide PCA)',
    () => toggle('biasDecomposition'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('biasDecomposition')) return;
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

  // Compute bias decomposition
  const analysis = useMemo((): {
    decomposition: BiasDecomposition;
    gcContents: number[];
    positions: number[];
  } | null => {
    if (!sequence || sequence.length < windowSize * 2) return null;

    // Create sliding windows
    const windows: Array<{ name: string; vector: number[]; gc: number; pos: number }> = [];

    for (let start = 0; start + windowSize <= sequence.length; start += stepSize) {
      const windowSeq = sequence.slice(start, start + windowSize);
      const vector = computeDinucleotideFrequencies(windowSeq);
      const gc = calculateGC(windowSeq);
      windows.push({
        name: `${start}-${start + windowSize}`,
        vector,
        gc,
        pos: start,
      });
    }

    if (windows.length < 3) return null;

    const decomposition = decomposeBias(windows);
    if (!decomposition) return null;

    return {
      decomposition,
      gcContents: windows.map((w) => w.gc),
      positions: windows.map((w) => w.pos),
    };
  }, [sequence, windowSize, stepSize]);

  // Convert to scatter points
  const scatterPoints = useMemo((): ScatterPoint[] => {
    if (!analysis) return [];

    const { decomposition, gcContents, positions } = analysis;
    const maxPos = Math.max(...positions, 1);

    return decomposition.projections.map((proj, index) => {
      let color: string;
      let value: number;

      switch (colorBy) {
        case 'position':
          value = positions[index] / maxPos;
          color = `hsl(${value * 300}, 70%, 50%)`; // Rainbow by position
          break;
        case 'gc':
        default:
          value = gcContents[index];
          color = gcColor(value);
          break;
      }

      return {
        x: proj.coords[0],
        y: proj.coords[1],
        id: `window-${index}`,
        label: proj.name,
        value,
        color,
        size: 4,
        data: { projection: proj, gc: gcContents[index], pos: positions[index] },
      };
    });
  }, [analysis, colorBy]);

  // Handle hover
  const handleHover = useCallback((hover: ScatterHover | null) => {
    setHoveredPoint(hover);
  }, []);

  // Handle click - could navigate to position
  const handleClick = useCallback((hover: ScatterHover | null) => {
    if (hover?.point?.data) {
      const data = hover.point.data as { pos: number };
      console.log(`Navigate to position ${data.pos}`);
    }
  }, []);

  if (!isOpen('biasDecomposition')) return null;

  return (
    <Overlay
      id="biasDecomposition"
      title="BIAS DECOMPOSITION (Dinucleotide PCA)"
      icon="B"
      hotkey="Alt+B"
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
          <strong style={{ color: colors.accent }}>Bias Decomposition</strong>: PCA of
          dinucleotide frequencies across sliding windows. PC1 typically captures GC content;
          PC2 reveals other compositional biases. Outliers may indicate HGT or unusual regions.
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
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                fontSize: '0.8rem',
              }}
            >
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
                  <option value={500}>500 bp</option>
                  <option value={1000}>1000 bp</option>
                  <option value={2000}>2000 bp</option>
                  <option value={5000}>5000 bp</option>
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
                  <option value="gc">GC Content</option>
                  <option value="position">Genome Position</option>
                </select>
              </label>

              <span style={{ color: colors.textMuted }}>
                {analysis.decomposition.projections.length} windows |
                PC1: {(analysis.decomposition.components[0].explained * 100).toFixed(1)}%,
                PC2: {(analysis.decomposition.components[1].explained * 100).toFixed(1)}%
              </span>
            </div>

            {/* Scatter plot */}
            <div
              style={{
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <ScatterCanvas
                width={500}
                height={350}
                points={scatterPoints}
                backgroundColor={colors.background}
                xLabel="PC1 (GC bias)"
                yLabel="PC2 (other bias)"
                pointSize={4}
                onHover={handleHover}
                onClick={handleClick}
                ariaLabel="Dinucleotide bias PCA scatter plot"
              />

              {/* Tooltip */}
              {hoveredPoint?.point?.data != null && (() => {
                const data = hoveredPoint.point.data as {
                  projection: BiasProjection;
                  gc: number;
                };
                return (
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
                    <TooltipContent
                      projection={data.projection}
                      gcContent={data.gc}
                      colors={colors}
                    />
                  </div>
                );
              })()}
            </div>

            {/* Loading vectors display */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '0.5rem',
                fontSize: '0.75rem',
              }}
            >
              {analysis.decomposition.components.map((comp, idx) => (
                <div
                  key={comp.id}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                  }}
                >
                  <div style={{ fontWeight: 'bold', marginBottom: '0.25rem', color: colors.text }}>
                    PC{idx + 1} Loadings ({(comp.explained * 100).toFixed(1)}%)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                    {DINUCLEOTIDES.slice(0, 8).map((dn, i) => (
                      <span
                        key={dn}
                        style={{
                          color: comp.loadings[i] > 0 ? '#22c55e' : '#ef4444',
                          fontFamily: 'monospace',
                        }}
                      >
                        {dn}:{comp.loadings[i].toFixed(2)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Legend */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.75rem',
                color: colors.textMuted,
              }}
            >
              {colorBy === 'gc' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: '#3b82f6' }}>Low GC</span>
                  <div
                    style={{
                      width: '60px',
                      height: '8px',
                      background: 'linear-gradient(to right, #3b82f6, #22c55e, #eab308, #ef4444)',
                      borderRadius: '2px',
                    }}
                  />
                  <span style={{ color: '#ef4444' }}>High GC</span>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>5&apos; end</span>
                  <div
                    style={{
                      width: '60px',
                      height: '8px',
                      background: 'linear-gradient(to right, hsl(0,70%,50%), hsl(150,70%,50%), hsl(300,70%,50%))',
                      borderRadius: '2px',
                    }}
                  />
                  <span>3&apos; end</span>
                </div>
              )}
            </div>

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
              <strong>Interpretation:</strong> Tight clusters = consistent compositional signature.
              Outliers = potential HGT, prophages, or atypical regions. PC1 correlates with GC%;
              PC2 often reflects dinucleotide over/under-representation patterns.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default BiasDecompositionOverlay;
