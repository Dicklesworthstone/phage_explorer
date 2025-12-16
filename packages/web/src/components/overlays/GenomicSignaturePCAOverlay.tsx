/**
 * GenomicSignaturePCAOverlay - Tetranucleotide Frequency PCA
 *
 * Visualizes genomic signatures using PCA of tetranucleotide (4-mer) frequencies.
 * Projects all phages in the database into 2D space for alignment-free
 * phylogenetic comparison.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { ScatterCanvas } from './primitives/ScatterCanvas';
import {
  computeKmerFrequencies,
  computeGcContent,
  performPCA,
  getTopLoadings,
} from '@phage-explorer/core';
import type { PCAResult, KmerVector, PCAProjection } from '@phage-explorer/core';
import type { ScatterPoint, ScatterHover } from './primitives/types';

// Color scale for GC content (blue=low, red=high)
function gcColor(gcContent: number): string {
  const hue = (1 - gcContent) * 240;
  return `hsl(${hue}, 70%, 50%)`;
}

// Color scale for genome length (short=green, long=purple)
function lengthColor(length: number, minLen: number, maxLen: number): string {
  const range = maxLen - minLen || 1;
  const normalized = (length - minLen) / range;
  const hue = 120 - normalized * 180; // green to purple
  return `hsl(${hue}, 60%, 50%)`;
}

interface GenomicSignaturePCAOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Tooltip component
function TooltipContent({
  projection,
  colors,
}: {
  projection: PCAProjection;
  colors: { textMuted: string; textDim: string };
}): React.ReactElement {
  return (
    <>
      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
        {projection.name}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        PC1: {projection.pc1.toFixed(4)}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        PC2: {projection.pc2.toFixed(4)}
      </div>
      <div style={{ marginTop: '0.25rem', color: colors.textDim }}>
        GC: {(projection.gcContent * 100).toFixed(1)}%
      </div>
      <div style={{ color: colors.textDim }}>
        Length: {projection.genomeLength.toLocaleString()} bp
      </div>
    </>
  );
}

export function GenomicSignaturePCAOverlay({
  repository,
  currentPhage,
}: GenomicSignaturePCAOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  // Cache for computed vectors
  const vectorCache = useRef<Map<number, KmerVector>>(new Map());

  const [kmerVectors, setKmerVectors] = useState<KmerVector[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Hover state for tooltip
  const [hoveredPoint, setHoveredPoint] = useState<ScatterHover | null>(null);

  // Analysis parameters
  const [colorBy, setColorBy] = useState<'gc' | 'length'>('gc');
  const [highlightCurrent, setHighlightCurrent] = useState(true);

  // Hotkey to toggle overlay (Alt+P for PCA)
  useHotkey(
    { key: 'p', modifiers: { alt: true } },
    'Genomic Signature PCA',
    () => toggle('genomicSignaturePCA'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Load all phages and compute k-mer vectors when overlay opens
  useEffect(() => {
    if (!isOpen('genomicSignaturePCA')) return;
    if (!repository) {
      setError('No repository available');
      return;
    }

    let cancelled = false;

    async function loadAndCompute() {
      setLoading(true);
      setError(null);
      setProgress(0);

      try {
        // Get all phage metadata
        const allPhages = await repository!.listPhages();

        if (cancelled) return;

        const vectors: KmerVector[] = [];
        const total = allPhages.length;

        for (let i = 0; i < allPhages.length; i++) {
          if (cancelled) return;

          const phage = allPhages[i];

          // Check cache first
          if (vectorCache.current.has(phage.id)) {
            vectors.push(vectorCache.current.get(phage.id)!);
          } else {
            // Fetch sequence and compute
            const length = await repository!.getFullGenomeLength(phage.id);
            const sequence = await repository!.getSequenceWindow(phage.id, 0, length);

            const frequencies = computeKmerFrequencies(sequence, {
              k: 4,
              normalize: true,
              includeReverseComplement: true,
            });

            const vector: KmerVector = {
              phageId: phage.id,
              name: phage.name,
              frequencies,
              gcContent: computeGcContent(sequence),
              genomeLength: length,
            };

            vectorCache.current.set(phage.id, vector);
            vectors.push(vector);
          }

          setProgress(Math.round(((i + 1) / total) * 100));
        }

        if (cancelled) return;

        setKmerVectors(vectors);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to compute signatures');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadAndCompute();

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository]);

  // Perform PCA on vectors
  const pcaResult = useMemo((): PCAResult | null => {
    if (kmerVectors.length < 3) return null;
    return performPCA(kmerVectors, { numComponents: 3 });
  }, [kmerVectors]);

  // Top loadings for interpretation
  const topLoadings = useMemo(() => {
    if (!pcaResult || pcaResult.loadings.length === 0) return [];
    return getTopLoadings(pcaResult.loadings, 4, 8);
  }, [pcaResult]);

  // Convert to scatter points
  const scatterPoints = useMemo((): ScatterPoint[] => {
    if (!pcaResult) return [];

    const lengths = pcaResult.projections.map(p => p.genomeLength);
    const minLen = Math.min(...lengths);
    const maxLen = Math.max(...lengths);

    return pcaResult.projections.map(proj => {
      let color: string;
      let value: number;

      switch (colorBy) {
        case 'length':
          value = proj.genomeLength;
          color = lengthColor(value, minLen, maxLen);
          break;
        case 'gc':
        default:
          value = proj.gcContent;
          color = gcColor(value);
          break;
      }

      // Highlight current phage
      const isCurrent = currentPhage && proj.phageId === currentPhage.id;
      const size = isCurrent && highlightCurrent ? 8 : 4;

      return {
        x: proj.pc1,
        y: proj.pc2,
        id: `phage-${proj.phageId}`,
        label: proj.name,
        value,
        color: isCurrent && highlightCurrent ? colors.accent : color,
        size,
        data: { projection: proj, isCurrent },
      };
    });
  }, [pcaResult, colorBy, currentPhage, highlightCurrent, colors.accent]);

  // Handle hover
  const handleHover = useCallback((hover: ScatterHover | null) => {
    setHoveredPoint(hover);
  }, []);

  // Handle click - could be used to select a phage
  const handleClick = useCallback((hover: ScatterHover | null) => {
    if (hover?.point?.data) {
      const data = hover.point.data as { projection: PCAProjection };
      console.log(`Selected phage: ${data.projection.name} (ID: ${data.projection.phageId})`);
    }
  }, []);

  if (!isOpen('genomicSignaturePCA')) return null;

  return (
    <Overlay
      id="genomicSignaturePCA"
      title="GENOMIC SIGNATURE PCA (Tetranucleotide Frequencies)"
      hotkey="Alt+P"
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
          <strong style={{ color: colors.accent }}>Genomic Signature PCA</strong>:
          Alignment-free phylogenetic comparison using tetranucleotide (4-mer) frequencies.
          Each phage is represented by 256 frequency values, reduced to 2D via PCA.
          Similar signatures suggest related evolutionary history or similar host environments.
        </div>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <AnalysisPanelSkeleton />
            <div style={{ color: colors.textMuted, textAlign: 'center', fontSize: '0.85rem' }}>
              Computing tetranucleotide frequencies... {progress}%
            </div>
          </div>
        ) : error ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.error }}>
            {error}
          </div>
        ) : !pcaResult ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            Need at least 3 phages for PCA analysis
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
                Color by:
                <select
                  value={colorBy}
                  onChange={e => setColorBy(e.target.value as typeof colorBy)}
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
                  <option value="length">Genome Length</option>
                </select>
              </label>

              <label style={{ color: colors.textMuted, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={highlightCurrent}
                  onChange={e => setHighlightCurrent(e.target.checked)}
                  style={{ accentColor: colors.accent }}
                />
                Highlight current phage
              </label>

              <span style={{ color: colors.textMuted }}>
                {pcaResult.projections.length} phages |
                PC1: {(pcaResult.varianceExplained[0] * 100).toFixed(1)}%,
                PC2: {(pcaResult.varianceExplained[1] * 100).toFixed(1)}%
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
                width={600}
                height={400}
                points={scatterPoints}
                backgroundColor={colors.background}
                xLabel="PC1 (Tetranucleotide Bias)"
                yLabel="PC2"
                pointSize={4}
                onHover={handleHover}
                onClick={handleClick}
                ariaLabel="Genomic signature PCA scatter plot"
              />

              {/* Tooltip */}
              {hoveredPoint?.point?.data != null && (() => {
                const data = hoveredPoint.point.data as { projection: PCAProjection };
                return (
                  <div
                    style={{
                      position: 'absolute',
                      left: Math.min(hoveredPoint.canvasX + 10, 480),
                      top: Math.max(hoveredPoint.canvasY - 80, 10),
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
                    <TooltipContent projection={data.projection} colors={colors} />
                  </div>
                );
              })()}
            </div>

            {/* Top loadings */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '0.5rem',
                fontSize: '0.75rem',
              }}
            >
              {topLoadings.slice(0, 2).map((loadings, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                  }}
                >
                  <div style={{ fontWeight: 'bold', marginBottom: '0.25rem', color: colors.text }}>
                    PC{idx + 1} Top Loadings ({(pcaResult.varianceExplained[idx] * 100).toFixed(1)}%)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                    {loadings.slice(0, 6).map(({ kmer, loading }) => (
                      <span
                        key={kmer}
                        style={{
                          color: loading > 0 ? '#22c55e' : '#ef4444',
                          fontFamily: 'monospace',
                        }}
                      >
                        {kmer}:{loading > 0 ? '+' : ''}{loading.toFixed(3)}
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
                alignItems: 'center',
                fontSize: '0.75rem',
                color: colors.textMuted,
              }}
            >
              {colorBy === 'gc' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: '#3b82f6' }}>Low GC</span>
                  <div
                    style={{
                      width: '80px',
                      height: '8px',
                      background: 'linear-gradient(to right, #3b82f6, #22c55e, #eab308, #ef4444)',
                      borderRadius: '2px',
                    }}
                  />
                  <span style={{ color: '#ef4444' }}>High GC</span>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: 'hsl(120, 60%, 50%)' }}>Short</span>
                  <div
                    style={{
                      width: '80px',
                      height: '8px',
                      background: 'linear-gradient(to right, hsl(120, 60%, 50%), hsl(60, 60%, 50%), hsl(-60, 60%, 50%))',
                      borderRadius: '2px',
                    }}
                  />
                  <span style={{ color: 'hsl(-60, 60%, 50%)' }}>Long</span>
                </div>
              )}
              {highlightCurrent && currentPhage && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <span
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      backgroundColor: colors.accent,
                    }}
                  />
                  <span>Current: {currentPhage.name}</span>
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
              <strong>Interpretation:</strong> Phages clustered together share similar
              tetranucleotide usage patterns, suggesting similar evolutionary pressures or host
              codon adaptation. Outliers may represent novel lineages or horizontal gene transfer events.
              PC1 often correlates with GC content; PC2 captures other compositional biases.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default GenomicSignaturePCAOverlay;
