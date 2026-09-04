/**
 * LatentSpaceAtlasOverlay - Pan-Phage Latent Space Atlas
 *
 * Visualizes the 2D latent space manifold of 2,039 protein embeddings from ESM-2
 * across all 24 catalogue phages (UMAP + HDBSCAN density clustering).
 * Enables functional neighborhood discovery without sequence homology and
 * spotlights "viral dark matter" (high-outlier proteins).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { PhageFull, LatentSpacePoint, LatentSpaceAtlasMetadata } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { ScatterCanvas } from './primitives/ScatterCanvas';
import type { ScatterPoint, ScatterHover } from './primitives/types';
import { HowDoIKnowThis } from './primitives/HowDoIKnowThis';
import { OverlayEmptyState, OverlayLoadingState } from './primitives';

interface LatentSpaceAtlasOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

type ColorMode = 'cluster' | 'outlier' | 'phage';
type ScopeFilter = 'all' | 'current';

function getClusterColor(clusterId: number, isDark: boolean): string {
  if (clusterId === -1) {
    return isDark ? 'rgba(148, 163, 184, 0.45)' : 'rgba(100, 116, 139, 0.45)';
  }
  // Golden ratio hue distribution for high distinctiveness between neighboring cluster IDs
  const hue = Math.round((clusterId * 137.508) % 360);
  return `hsl(${hue}, 78%, ${isDark ? '60%' : '45%'})`;
}

function getOutlierColor(outlierScore: number): string {
  // Color scale from calm cyan/blue (0.0) -> orange (0.6) -> vibrant red/magenta (1.0)
  if (outlierScore < 0.3) {
    return 'rgba(56, 189, 248, 0.5)';
  }
  if (outlierScore < 0.6) {
    return 'rgba(250, 204, 21, 0.7)';
  }
  if (outlierScore < 0.8) {
    return 'rgba(251, 146, 60, 0.85)';
  }
  return 'rgba(244, 63, 94, 0.95)';
}

function getPhageColor(phageId: number, isDark: boolean): string {
  const hue = (phageId * 47) % 360;
  return `hsl(${hue}, 70%, ${isDark ? '65%' : '40%'})`;
}

export function LatentSpaceAtlasOverlay({
  repository,
  currentPhage,
}: LatentSpaceAtlasOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const isDark = theme.id !== 'pastel';
  const { close } = useOverlay();

  const [loading, setLoading] = useState(true);
  const [points, setPoints] = useState<LatentSpacePoint[]>([]);
  const [metadata, setMetadata] = useState<LatentSpaceAtlasMetadata | null>(null);

  const [scope, setScope] = useState<ScopeFilter>('all');
  const [colorMode, setColorMode] = useState<ColorMode>('cluster');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<LatentSpacePoint | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<LatentSpacePoint | null>(null);
  const [onlyOutliers, setOnlyOutliers] = useState(false);
  const [outlierThreshold, setOutlierThreshold] = useState(0.7);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      if (!repository || !currentPhage) {
        setPoints([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const atlasData = repository.getLatentSpaceAtlas
          ? await repository.getLatentSpaceAtlas()
          : [];

        if (cancelled) return;
        setPoints(atlasData);

        if (repository.getAnnotationMeta) {
          const meta = await repository.getAnnotationMeta('latent_space_atlas');
          if (!cancelled && meta) {
            setMetadata({
              model: typeof meta.model === 'string' ? meta.model : 'facebook/esm2_t6_8M_UR50D',
              count: typeof meta.count === 'number' ? meta.count : atlasData.length,
              clusters: typeof meta.clusters === 'number' ? meta.clusters : 0,
              outliers: typeof meta.outliers === 'number' ? meta.outliers : 0,
              meanOutlierScore: typeof meta.mean_outlier_score === 'number' ? meta.mean_outlier_score : 0,
              maxOutlierScore: typeof meta.max_outlier_score === 'number' ? meta.max_outlier_score : 1,
              minOutlierScore: typeof meta.min_outlier_score === 'number' ? meta.min_outlier_score : 0,
            });
          }
        }
      } catch (err) {
        console.error('Failed to load latent space atlas:', err);
        if (!cancelled) setPoints([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, [repository, currentPhage]);

  // Filter points based on scope, search, and outlier settings
  const filteredPoints = useMemo(() => {
    let list = points;
    if (scope === 'current' && currentPhage) {
      list = list.filter((p) => p.phageId === currentPhage.id);
    }
    if (onlyOutliers) {
      list = list.filter((p) => p.outlierScore >= outlierThreshold || p.clusterId === -1);
    }
    if (selectedCluster !== null) {
      list = list.filter((p) => p.clusterId === selectedCluster);
    }
    return list;
  }, [points, scope, currentPhage, onlyOutliers, outlierThreshold, selectedCluster]);

  const searchNormalized = searchQuery.trim().toLowerCase();

  // Convert to ScatterPoint primitive format
  const scatterPoints: ScatterPoint[] = useMemo(() => {
    return filteredPoints.map((p) => {
      let color = '#38bdf8';
      if (colorMode === 'cluster') {
        color = getClusterColor(p.clusterId, isDark);
      } else if (colorMode === 'outlier') {
        color = getOutlierColor(p.outlierScore);
      } else if (colorMode === 'phage') {
        color = getPhageColor(p.phageId, isDark);
      }

      let size = p.clusterId === -1 ? 4.5 : 3.5;
      const matchesSearch =
        searchNormalized.length > 0 &&
        ((p.product && p.product.toLowerCase().includes(searchNormalized)) ||
          (p.geneName && p.geneName.toLowerCase().includes(searchNormalized)) ||
          (p.locusTag && p.locusTag.toLowerCase().includes(searchNormalized)) ||
          (p.phageName && p.phageName.toLowerCase().includes(searchNormalized)));

      const isCurrentPhage = currentPhage && p.phageId === currentPhage.id;

      if (searchNormalized.length > 0) {
        if (matchesSearch) {
          size = 7;
          color = '#f43f5e'; // Bright highlight for matching search
        } else {
          // Dim non-matching points
          color = isDark ? 'rgba(100, 116, 139, 0.2)' : 'rgba(203, 213, 225, 0.3)';
          size = 2;
        }
      } else if (selectedPoint && selectedPoint.id === p.id) {
        size = 8;
        color = '#ec4899';
      } else if (scope === 'all' && isCurrentPhage && colorMode !== 'phage') {
        // Subtle outline/size boost for current phage genes when browsing pan-phage
        size = Math.max(size, 4.5);
      }

      return {
        x: p.x,
        y: p.y,
        id: p.id,
        label: p.product || p.geneName || p.locusTag || 'Protein',
        color,
        size,
        data: p,
      };
    });
  }, [filteredPoints, colorMode, isDark, searchNormalized, selectedPoint, scope, currentPhage]);

  const handleHover = useCallback((hover: ScatterHover | null) => {
    if (!hover) {
      setHoveredPoint(null);
      return;
    }
    const pt = hover.point.data as LatentSpacePoint | undefined;
    if (pt) {
      setHoveredPoint(pt);
    }
  }, []);

  const handleClick = useCallback((hover: ScatterHover | null) => {
    if (!hover) {
      setSelectedPoint(null);
      return;
    }
    const pt = hover.point.data as LatentSpacePoint | undefined;
    if (pt) {
      setSelectedPoint(pt);
    }
  }, []);

  // Compute cluster statistics for drill-down
  const clusterStats = useMemo(() => {
    const map = new Map<number, { count: number; products: Map<string, number>; phages: Set<string> }>();
    for (const p of points) {
      if (p.clusterId === -1) continue;
      let stat = map.get(p.clusterId);
      if (!stat) {
        stat = { count: 0, products: new Map(), phages: new Set() };
        map.set(p.clusterId, stat);
      }
      stat.count++;
      if (p.phageName) stat.phages.add(p.phageName);
      if (p.product) {
        const prod = p.product.toLowerCase().trim();
        stat.products.set(prod, (stat.products.get(prod) ?? 0) + 1);
      }
    }
    return map;
  }, [points]);

  // Top outliers for "viral dark matter" panel
  const topOutliers = useMemo(() => {
    return [...points]
      .sort((a, b) => b.outlierScore - a.outlierScore)
      .slice(0, 15);
  }, [points]);

  const activePoint = hoveredPoint ?? selectedPoint;

  return (
    <Overlay id="latentSpaceAtlas" title="Pan-Phage Latent Space Atlas" size="full" onClose={() => close('latentSpaceAtlas')}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12, padding: '4px 8px' }}>
        {/* Top bar with description, HowDoIKnowThis, and statistics */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            borderBottom: `1px solid ${theme.colors.border}`,
            paddingBottom: 8,
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: theme.colors.textDim }}>
              ESM-2 Neural Manifold • 2,039 Proteins across 24 Catalogue Phages • UMAP & HDBSCAN
            </div>
            <div style={{ fontSize: 11, color: theme.colors.textDim, marginTop: 2 }}>
              Embeddings capture functional similarity without sequence homology. Points near each other perform related roles.
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <HowDoIKnowThis
              title="Pan-Phage Latent Space Atlas"
              computation="Mean-pooled 320-dimensional embeddings from ESM-2 (facebook/esm2_t6_8M_UR50D) across all 24 catalogue phages, projected to 2D via UMAP manifold learning (cosine metric, n_neighbors=15, min_dist=0.1) and clustered via HDBSCAN density clustering (min_cluster_size=5, min_samples=3) to map functional neighborhoods and identify uncharacterized outlier proteins."
              inputs={[
                { label: 'Catalogue Phages', value: '24 complete genomes' },
                { label: 'CDS Proteins', value: `${points.length} protein sequences` },
                { label: 'Embedding Checkpoint', value: 'facebook/esm2_t6_8M_UR50D (320d)' },
                { label: 'Manifold Parameters', value: 'UMAP n_neighbors=15, min_dist=0.1' },
                { label: 'Clustering', value: 'HDBSCAN min_cluster_size=5, min_samples=3' },
              ]}
              implementation={{
                engine: 'Pipeline Database',
                details: 'Precomputed into SQLite fold_embedding_coords table',
              }}
              annotationRelease={{
                database: 'ESM-2',
                version: 'esm2_t6_8M_UR50D',
                details: 'Meta AI Protein Language Model',
              }}
              citation="Lin, Z. et al. (2023). Evolutionary-scale prediction of atomic-level protein structure with a language model. Science 379(6637): 1123-1130; McInnes, L. et al. (2018). UMAP: Uniform Manifold Approximation and Projection for Dimension Reduction. arXiv:1802.03426; Campello, R. et al. (2013). Density-Based Clustering Based on Hierarchical Density Estimates. PAKDD: 160-172."
            />
          </div>
        </div>

        {/* Filter and control controls */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
            padding: '6px 10px',
            backgroundColor: isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(241, 245, 249, 0.8)',
            borderRadius: 6,
            border: `1px solid ${theme.colors.border}`,
          }}
        >
          {/* Scope selection */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ color: theme.colors.textDim, fontWeight: 600 }}>Scope:</span>
            <button
              onClick={() => setScope('all')}
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                backgroundColor: scope === 'all' ? theme.colors.accent : 'transparent',
                color: scope === 'all' ? '#ffffff' : theme.colors.text,
                fontSize: 12,
              }}
            >
              Pan-Phage (All 24)
            </button>
            <button
              onClick={() => setScope('current')}
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                backgroundColor: scope === 'current' ? theme.colors.accent : 'transparent',
                color: scope === 'current' ? '#ffffff' : theme.colors.text,
                fontSize: 12,
              }}
            >
              Current Phage ({currentPhage?.name?.split(' ')[0] ?? 'Active'})
            </button>
          </div>

          {/* Color Mode */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ color: theme.colors.textDim, fontWeight: 600 }}>Color By:</span>
            <select
              value={colorMode}
              onChange={(e) => setColorMode(e.target.value as ColorMode)}
              style={{
                padding: '3px 6px',
                borderRadius: 4,
                backgroundColor: isDark ? '#1e293b' : '#ffffff',
                color: theme.colors.text,
                border: `1px solid ${theme.colors.border}`,
                fontSize: 12,
              }}
            >
              <option value="cluster">HDBSCAN Cluster</option>
              <option value="outlier">Outlier Score (Dark Matter)</option>
              <option value="phage">Phage Source</option>
            </select>
          </div>

          {/* Search query */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, flex: 1, minWidth: 180 }}>
            <span style={{ color: theme.colors.textDim, fontWeight: 600 }}>Highlight:</span>
            <input
              type="text"
              placeholder="Search product e.g. terminase, tail, portal..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '3px 8px',
                borderRadius: 4,
                backgroundColor: isDark ? '#0f172a' : '#ffffff',
                color: theme.colors.text,
                border: `1px solid ${theme.colors.border}`,
                fontSize: 12,
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: theme.colors.textDim,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Outlier filter toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={onlyOutliers}
                onChange={(e) => setOnlyOutliers(e.target.checked)}
              />
              <span style={{ color: onlyOutliers ? '#f43f5e' : theme.colors.text }}>Outliers Only</span>
            </label>
            {onlyOutliers && (
              <input
                type="range"
                min="0.5"
                max="0.95"
                step="0.05"
                value={outlierThreshold}
                onChange={(e) => setOutlierThreshold(parseFloat(e.target.value))}
                title={`Threshold: ≥ ${outlierThreshold}`}
                style={{ width: 60 }}
              />
            )}
          </div>

          {/* Cluster filter reset */}
          {selectedCluster !== null && (
            <button
              onClick={() => setSelectedCluster(null)}
              style={{
                padding: '2px 6px',
                borderRadius: 4,
                backgroundColor: '#ef4444',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Clear Cluster #{selectedCluster}
            </button>
          )}
        </div>

        {/* Main body: Scatter canvas on left, inspection panels on right */}
        {loading ? (
          <OverlayLoadingState message="Loading Latent Space Atlas...">
            <div style={{ padding: 24, textAlign: 'center', color: theme.colors.textMuted }}>
              Loading precomputed ESM-2 latent space embeddings...
            </div>
          </OverlayLoadingState>
        ) : points.length === 0 ? (
          <OverlayEmptyState
            message="No Latent Space Atlas Data Available"
            hint="The database does not contain precomputed fold_embedding_coords for the ESM-2 model. Run the latent space atlas pipeline to compute 2D coordinates."
          />
        ) : (
          <div style={{ display: 'flex', flex: 1, gap: 14, minHeight: 0 }}>
            {/* Left/Center: Scatter Canvas */}
            <div
              style={{
                flex: 2.2,
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 6,
                border: `1px solid ${theme.colors.border}`,
                backgroundColor: isDark ? '#090d16' : '#f8fafc',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <div style={{ flex: 1, position: 'relative', minHeight: 380 }}>
                <ScatterCanvas
                  width={680}
                  height={500}
                  points={scatterPoints}
                  pointColor="#38bdf8"
                  pointSize={3.5}
                  padding={32}
                  backgroundColor={isDark ? '#090d16' : '#f8fafc'}
                  xLabel="UMAP Dimension 1"
                  yLabel="UMAP Dimension 2"
                  onHover={handleHover}
                  onClick={handleClick}
                  ariaLabel="Pan-Phage Latent Space Atlas Scatter Plot"
                />
              </div>

              {/* Status bar inside plot */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '4px 10px',
                  fontSize: 11,
                  color: theme.colors.textDim,
                  backgroundColor: isDark ? 'rgba(15, 23, 42, 0.7)' : 'rgba(226, 232, 240, 0.7)',
                  borderTop: `1px solid ${theme.colors.border}`,
                }}
              >
                <span>Showing {filteredPoints.length} of {points.length} proteins</span>
                <span>
                  {metadata ? `${metadata.clusters} clusters • ${metadata.outliers} outliers` : ''}
                </span>
              </div>
            </div>

            {/* Right side: Detailed inspector */}
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                minWidth: 280,
                overflowY: 'auto',
              }}
            >
              {/* Protein Inspector Card */}
              <div
                style={{
                  padding: 10,
                  borderRadius: 6,
                  border: `1px solid ${theme.colors.border}`,
                  backgroundColor: isDark ? '#1e293b' : '#ffffff',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: theme.colors.accent }}>
                  {activePoint ? 'Protein Details' : 'Point Inspector'}
                </div>

                {activePoint ? (
                  <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div>
                      <span style={{ color: theme.colors.textDim }}>Product: </span>
                      <strong style={{ color: theme.colors.text }}>{activePoint.product || 'Uncharacterized'}</strong>
                    </div>
                    <div>
                      <span style={{ color: theme.colors.textDim }}>Gene: </span>
                      <span>{activePoint.geneName || '—'} ({activePoint.locusTag || 'no locus tag'})</span>
                    </div>
                    <div>
                      <span style={{ color: theme.colors.textDim }}>Phage: </span>
                      <span>{activePoint.phageName || `Phage #${activePoint.phageId}`}</span>
                    </div>
                    <div>
                      <span style={{ color: theme.colors.textDim }}>Cluster: </span>
                      {activePoint.clusterId === -1 ? (
                        <span style={{ color: '#f43f5e', fontWeight: 600 }}>Outlier / Noise (-1)</span>
                      ) : (
                        <button
                          onClick={() => setSelectedCluster(activePoint.clusterId)}
                          style={{
                            background: 'none',
                            border: `1px solid ${theme.colors.border}`,
                            color: theme.colors.accent,
                            padding: '1px 5px',
                            borderRadius: 3,
                            cursor: 'pointer',
                            fontSize: 11,
                          }}
                          title="Click to filter to this cluster"
                        >
                          Cluster #{activePoint.clusterId} ↗
                        </button>
                      )}
                    </div>
                    <div>
                      <span style={{ color: theme.colors.textDim }}>Outlier Score: </span>
                      <span
                        style={{
                          fontWeight: 600,
                          color: activePoint.outlierScore > 0.7 ? '#f43f5e' : theme.colors.text,
                        }}
                      >
                        {activePoint.outlierScore.toFixed(4)}
                        {activePoint.outlierScore > 0.7 ? ' (Viral Dark Matter)' : ''}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: theme.colors.textDim }}>Coordinates: </span>
                      <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                        [{activePoint.x.toFixed(2)}, {activePoint.y.toFixed(2)}]
                      </span>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: theme.colors.textDim, fontStyle: 'italic' }}>
                    Hover over or click any point in the manifold to inspect protein annotation, cluster membership, and outlier score.
                  </div>
                )}
              </div>

              {/* Cluster Detail or Top Outliers List */}
              {selectedCluster !== null && clusterStats.has(selectedCluster) ? (
                <div
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    border: `1px solid ${theme.colors.border}`,
                    backgroundColor: isDark ? '#1e293b' : '#ffffff',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: theme.colors.accent }}>
                    Cluster #{selectedCluster} Breakdown
                  </div>
                  <div style={{ fontSize: 12, color: theme.colors.textDim }}>
                    Size: <strong>{clusterStats.get(selectedCluster)!.count}</strong> proteins across{' '}
                    <strong>{clusterStats.get(selectedCluster)!.phages.size}</strong> phages
                  </div>

                  <div style={{ fontSize: 11, fontWeight: 600, color: theme.colors.textDim, marginTop: 4 }}>
                    Top Products in this Cluster:
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                    {[...clusterStats.get(selectedCluster)!.products.entries()]
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 6)
                      .map(([prod, count]) => (
                        <li key={prod} style={{ marginBottom: 2 }}>
                          {prod} ({count})
                        </li>
                      ))}
                  </ul>
                </div>
              ) : (
                <div
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    border: `1px solid ${theme.colors.border}`,
                    backgroundColor: isDark ? '#1e293b' : '#ffffff',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    flex: 1,
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#f43f5e' }}>
                    Viral Dark Matter (Top Outliers)
                  </div>
                  <div style={{ fontSize: 11, color: theme.colors.textDim }}>
                    Proteins isolated from all known density clusters. Potential novel enzymatic functions or uncharacterized structural folds:
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', maxHeight: 240 }}>
                    {topOutliers.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => setSelectedPoint(p)}
                        style={{
                          padding: '4px 6px',
                          borderRadius: 4,
                          cursor: 'pointer',
                          backgroundColor: selectedPoint?.id === p.id ? (isDark ? '#334155' : '#e2e8f0') : 'transparent',
                          border: `1px solid ${selectedPoint?.id === p.id ? theme.colors.accent : 'transparent'}`,
                          fontSize: 11,
                        }}
                      >
                        <div style={{ fontWeight: 600, color: theme.colors.text }}>
                          {p.product || 'hypothetical protein'}
                        </div>
                        <div style={{ color: theme.colors.textDim, display: 'flex', justifyContent: 'space-between' }}>
                          <span>{p.phageName?.split(' ')[0]} ({p.locusTag || 'gene'})</span>
                          <span style={{ color: '#f43f5e', fontWeight: 600 }}>Score: {p.outlierScore.toFixed(3)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default LatentSpaceAtlasOverlay;
