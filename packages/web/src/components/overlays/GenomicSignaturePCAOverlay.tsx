/**
 * GenomicSignaturePCAOverlay - Genomic Signature PCA
 *
 * Visualizes genomic signatures using PCA of k-mer frequencies (optionally
 * including reverse complements).
 * Projects all phages in the database into 2D space for alignment-free
 * phylogenetic comparison.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull, PhageSummary } from '@phage-explorer/core';
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

function categoricalColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

interface GenomicSignaturePCAOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Tooltip component
function TooltipContent({
  projection,
  meta,
  colors,
}: {
  projection: PCAProjection;
  meta: PhageSummary | null;
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
      {meta && (
        <div style={{ marginTop: '0.25rem', color: colors.textDim }}>
          <div>Accession: {meta.accession}</div>
          {meta.host ? <div>Host: {meta.host}</div> : null}
          {meta.family ? <div>Family: {meta.family}</div> : null}
        </div>
      )}
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
  const vectorCache = useRef<Map<string, KmerVector>>(new Map());

  const [kmerVectors, setKmerVectors] = useState<KmerVector[]>([]);
  const [phageSummaries, setPhageSummaries] = useState<PhageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Hover state for tooltip
  const [hoveredPoint, setHoveredPoint] = useState<ScatterHover | null>(null);
  const [selectedPhageId, setSelectedPhageId] = useState<number | null>(null);

  // Analysis parameters
  const [colorBy, setColorBy] = useState<'gc' | 'length' | 'host' | 'family'>('gc');
  const [highlightCurrent, setHighlightCurrent] = useState(true);
  const [kmerSize, setKmerSize] = useState(4);
  const [includeReverseComplement, setIncludeReverseComplement] = useState(true);

  const overlayOpen = isOpen('genomicSignaturePCA');
  const kmerDims = 4 ** kmerSize;

  // Hotkey to toggle overlay (Alt+P for PCA)
  useHotkey(
    { key: 'p', modifiers: { alt: true } },
    'Genomic Signature PCA',
    () => toggle('genomicSignaturePCA'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  useHotkey(
    { key: 'l', modifiers: { alt: true } },
    'Recenter PCA selection',
    () => {
      if (!overlayOpen || !currentPhage) return;
      setSelectedPhageId(currentPhage.id);
    },
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Load all phages and compute k-mer vectors when overlay opens
  useEffect(() => {
    if (!overlayOpen) return;
    if (!repository) {
      setKmerVectors([]);
      setPhageSummaries([]);
      setError('No repository available');
      setLoading(false);
      setProgress(0);
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
        setPhageSummaries(allPhages);

        const vectors: KmerVector[] = [];
        const total = allPhages.length;

        for (let i = 0; i < allPhages.length; i++) {
          if (cancelled) return;

          const phage = allPhages[i];

          // Check cache first
          const cacheKey = `${phage.id}:${kmerSize}:${includeReverseComplement ? 1 : 0}`;
          if (vectorCache.current.has(cacheKey)) {
            vectors.push(vectorCache.current.get(cacheKey)!);
          } else {
            // Fetch sequence and compute
            const length = await repository!.getFullGenomeLength(phage.id);
            const sequence = await repository!.getSequenceWindow(phage.id, 0, length);

            const frequencies = computeKmerFrequencies(sequence, {
              k: kmerSize,
              normalize: true,
              includeReverseComplement,
            });

            const vector: KmerVector = {
              phageId: phage.id,
              name: phage.name,
              frequencies,
              gcContent: computeGcContent(sequence),
              genomeLength: length,
            };

            vectorCache.current.set(cacheKey, vector);
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
  }, [includeReverseComplement, kmerSize, overlayOpen, repository]);

  const phageMetaById = useMemo(() => {
    return new Map(phageSummaries.map(p => [p.id, p] as const));
  }, [phageSummaries]);

  // Perform PCA on vectors
  const pcaResult = useMemo((): PCAResult | null => {
    if (kmerVectors.length < 3) return null;
    return performPCA(kmerVectors, { numComponents: 3 });
  }, [kmerVectors]);

  useEffect(() => {
    if (!overlayOpen) return;
    if (!currentPhage) return;
    setSelectedPhageId(currentPhage.id);
  }, [currentPhage, overlayOpen]);

  // Top loadings for interpretation
  const topLoadings = useMemo(() => {
    if (!pcaResult || pcaResult.loadings.length === 0) return [];
    return getTopLoadings(pcaResult.loadings, kmerSize, 8);
  }, [kmerSize, pcaResult]);

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
        case 'host': {
          const host = phageMetaById.get(proj.phageId)?.host ?? 'Unknown host';
          value = 0;
          color = categoricalColor(host);
          break;
        }
        case 'family': {
          const family = phageMetaById.get(proj.phageId)?.family ?? 'Unknown family';
          value = 0;
          color = categoricalColor(family);
          break;
        }
        case 'gc':
        default:
          value = proj.gcContent;
          color = gcColor(value);
          break;
      }

      // Highlight current phage
      const isCurrent = currentPhage && proj.phageId === currentPhage.id;
      const isSelected = selectedPhageId != null && proj.phageId === selectedPhageId;
      const size = isCurrent && highlightCurrent ? 8 : isSelected ? 7 : 4;

      return {
        x: proj.pc1,
        y: proj.pc2,
        id: `phage-${proj.phageId}`,
        label: proj.name,
        value,
        color: isCurrent && highlightCurrent ? colors.accent : isSelected ? colors.warning : color,
        size,
        data: { projection: proj, isCurrent },
      };
    });
  }, [pcaResult, colorBy, currentPhage, highlightCurrent, selectedPhageId, colors.accent, colors.warning, phageMetaById]);

  const categoricalLegend = useMemo(() => {
    if (!pcaResult) return [];
    if (colorBy !== 'host' && colorBy !== 'family') return [];

    const keyFn =
      colorBy === 'host'
        ? (p: PCAProjection) => phageMetaById.get(p.phageId)?.host ?? 'Unknown host'
        : (p: PCAProjection) => phageMetaById.get(p.phageId)?.family ?? 'Unknown family';

    const seen = new Set<string>();
    const entries: Array<{ label: string; color: string }> = [];
    for (const p of pcaResult.projections) {
      const label = keyFn(p);
      if (seen.has(label)) continue;
      seen.add(label);
      entries.push({ label, color: categoricalColor(label) });
    }

    entries.sort((a, b) => a.label.localeCompare(b.label));
    return entries;
  }, [colorBy, pcaResult, phageMetaById]);

  // Handle hover
  const handleHover = useCallback((hover: ScatterHover | null) => {
    setHoveredPoint(hover);
  }, []);

  const selectedProjection = useMemo((): PCAProjection | null => {
    if (!pcaResult || selectedPhageId == null) return null;
    return pcaResult.projections.find(p => p.phageId === selectedPhageId) ?? null;
  }, [pcaResult, selectedPhageId]);

  const nearestNeighbors = useMemo(() => {
    if (!pcaResult || !selectedProjection) return [];

    const scored = pcaResult.projections
      .filter(p => p.phageId !== selectedProjection.phageId)
      .map(p => {
        const dx = p.pc1 - selectedProjection.pc1;
        const dy = p.pc2 - selectedProjection.pc2;
        const distance = Math.sqrt(dx * dx + dy * dy);
        return { projection: p, distance };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);

    return scored;
  }, [pcaResult, selectedProjection]);

  const projectionsByName = useMemo(() => {
    if (!pcaResult) return [];
    return pcaResult.projections.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [pcaResult]);

  // Handle click: select nearest point (or clear selection when clicked outside plot)
  const handleClick = useCallback((hover: ScatterHover | null) => {
    if (!hover?.point?.data) {
      setSelectedPhageId(null);
      return;
    }
    const data = hover.point.data as { projection: PCAProjection };
    setSelectedPhageId(data.projection.phageId);
  }, []);

  if (!overlayOpen) return null;

  const selectedMeta = selectedProjection ? phageMetaById.get(selectedProjection.phageId) ?? null : null;

  return (
    <Overlay
      id="genomicSignaturePCA"
      title={`GENOMIC SIGNATURE PCA (${kmerSize}-mer frequencies)`}
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
          Alignment-free phylogenetic comparison using {kmerSize}-mer frequencies.
          Each phage is represented by {kmerDims.toLocaleString()} frequency values, reduced to 2D via PCA.
          Similar signatures suggest related evolutionary history or similar host environments.
        </div>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <AnalysisPanelSkeleton />
            <div style={{ color: colors.textMuted, textAlign: 'center', fontSize: '0.85rem' }}>
              Computing {kmerSize}-mer frequencies... {progress}%
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
                  <option value="host">Host</option>
                  <option value="family">Family</option>
                </select>
              </label>

              <label style={{ color: colors.textMuted }}>
                k:
                <select
                  value={kmerSize}
                  onChange={e => setKmerSize(Number(e.target.value))}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value={3}>3-mer</option>
                  <option value={4}>4-mer</option>
                  <option value={5}>5-mer</option>
                  <option value={6}>6-mer</option>
                </select>
              </label>

              <label style={{ color: colors.textMuted, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={includeReverseComplement}
                  onChange={e => setIncludeReverseComplement(e.target.checked)}
                  style={{ accentColor: colors.accent }}
                />
                Include reverse complement
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

              <label style={{ color: colors.textMuted }}>
                Inspect:
                <select
                  value={selectedPhageId ?? ''}
                  onChange={e => setSelectedPhageId(e.target.value ? Number(e.target.value) : null)}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value="">(none)</option>
                  {projectionsByName.map(p => (
                    <option key={p.phageId} value={p.phageId}>
                      {p.name}
                      {phageMetaById.get(p.phageId)?.host ? ` — ${phageMetaById.get(p.phageId)?.host}` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                onClick={() => {
                  if (!currentPhage) return;
                  setSelectedPhageId(currentPhage.id);
                }}
                disabled={!currentPhage}
                style={{
                  padding: '0.25rem 0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  color: colors.text,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '3px',
                  cursor: currentPhage ? 'pointer' : 'not-allowed',
                  opacity: currentPhage ? 1 : 0.6,
                }}
                aria-label="Recenter selection on current phage (Alt+L)"
                title="Recenter selection on current phage (Alt+L)"
              >
                Recenter
              </button>

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
                xLabel="PC1 (k-mer bias)"
                yLabel="PC2"
                pointSize={4}
                onHover={handleHover}
                onClick={handleClick}
                ariaLabel="Genomic signature PCA scatter plot"
              />

              {/* Tooltip */}
	              {hoveredPoint?.point?.data != null && (() => {
	                const data = hoveredPoint.point.data as { projection: PCAProjection };
	                // Ensure tooltip stays within bounds (canvas width=600, tooltip width~200)
	                const leftPos = hoveredPoint.canvasX + 10;
	                const adjustedLeft = leftPos + 200 > 600 ? leftPos - 210 : leftPos;

	                return (
	                  <div
	                    style={{
	                      position: 'absolute',
	                      left: Math.max(10, adjustedLeft),
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
	                    <TooltipContent
	                      projection={data.projection}
	                      meta={phageMetaById.get(data.projection.phageId) ?? null}
	                      colors={colors}
	                    />
	                  </div>
	                );
	              })()}
            </div>

            {/* Selection panel */}
            <div
              style={{
                padding: '0.75rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
                fontSize: '0.8rem',
              }}
            >
              {selectedProjection ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
	                  <div>
	                    <div style={{ fontWeight: 'bold', color: colors.text }}>
	                      Selected: {selectedProjection.name}
	                    </div>
	                    <div style={{ color: colors.textMuted, marginTop: '0.25rem' }}>
	                      GC: {(selectedProjection.gcContent * 100).toFixed(1)}% · Length:{' '}
	                      {selectedProjection.genomeLength.toLocaleString()} bp
	                    </div>
	                    {selectedMeta && (
	                      <div style={{ color: colors.textDim, marginTop: '0.25rem' }}>
	                        <div>Accession: {selectedMeta.accession}</div>
	                        {selectedMeta.host ? <div>Host: {selectedMeta.host}</div> : null}
	                        {selectedMeta.family ? <div>Family: {selectedMeta.family}</div> : null}
	                      </div>
	                    )}
	                    <div style={{ color: colors.textDim, marginTop: '0.25rem' }}>
	                      PC1: {selectedProjection.pc1.toFixed(4)} · PC2: {selectedProjection.pc2.toFixed(4)}
	                    </div>
	                  </div>

                  <div>
                    <div style={{ fontWeight: 'bold', color: colors.text, marginBottom: '0.25rem' }}>
                      Nearest neighbors (PCA)
                    </div>
                    {nearestNeighbors.length === 0 ? (
                      <div style={{ color: colors.textMuted }}>No neighbors available.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        {nearestNeighbors.map(n => (
                          <button
                            key={n.projection.phageId}
                            type="button"
                            onClick={() => setSelectedPhageId(n.projection.phageId)}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: '0.75rem',
                              padding: '0.25rem 0.5rem',
                              backgroundColor: colors.background,
                              border: `1px solid ${colors.borderLight}`,
                              borderRadius: '3px',
                              color: colors.text,
	                              cursor: 'pointer',
	                              textAlign: 'left',
	                            }}
	                            aria-label={`Select neighbor ${n.projection.name}`}
	                          >
	                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
	                              {(() => {
	                                const meta = phageMetaById.get(n.projection.phageId);
	                                return meta?.host ? `${n.projection.name} — ${meta.host}` : n.projection.name;
	                              })()}
	                            </span>
	                            <span style={{ color: colors.textMuted, fontFamily: 'monospace' }}>
	                              d={n.distance.toFixed(3)}
	                            </span>
	                          </button>
	                        ))}
	                      </div>
	                    )}
	                  </div>
                </div>
              ) : (
                <div style={{ color: colors.textMuted }}>
                  Click a point (or use “Inspect”) to see neighbors.
                </div>
              )}
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
              ) : colorBy === 'length' ? (
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
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: colors.textMuted }}>
                    {colorBy === 'host' ? 'Host colors:' : 'Family colors:'}
                  </span>
                  {categoricalLegend.slice(0, 6).map(entry => (
                    <span key={entry.label} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span
                        style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: entry.color,
                        }}
                      />
                      <span>{entry.label}</span>
                    </span>
                  ))}
                  {categoricalLegend.length > 6 ? (
                    <span style={{ color: colors.textMuted }}>
                      …+{categoricalLegend.length - 6}
                    </span>
                  ) : null}
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
              k-mer usage patterns, suggesting similar evolutionary pressures or host
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
