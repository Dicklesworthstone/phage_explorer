/**
 * NicheNetworkOverlay - Metagenomic Co-Occurrence Network
 *
 * Visualizes ecological niche inference from compositional correlations.
 * Force-directed network layout with niche coloring from NMF decomposition.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  analyzeNiches,
  generateDemoAbundanceTable,
  type NicheAnalysisResult,
  type CoOccurrenceNetwork,
  type NicheProfile,
} from '@phage-explorer/core';

// =============================================================================
// Force Layout Types
// =============================================================================

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  niche: number;
  degree: number;
  strength: number;
}

interface LayoutEdge {
  source: number;
  target: number;
  weight: number;
  type: 'positive' | 'negative';
}

// =============================================================================
// Force-Directed Layout
// =============================================================================

function runForceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  width: number,
  height: number,
  iterations = 100
): LayoutNode[] {
  const n = nodes.length;
  if (n === 0) return nodes;

  // Initialize positions in a circle
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n;
    const radius = Math.min(width, height) * 0.35;
    node.x = width / 2 + radius * Math.cos(angle);
    node.y = height / 2 + radius * Math.sin(angle);
    node.vx = 0;
    node.vy = 0;
  });

  const k = Math.sqrt((width * height) / n); // Optimal distance
  const temperature = width / 10;
  let t = temperature;

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsive forces (all pairs)
    for (let i = 0; i < n; i++) {
      nodes[i].vx = 0;
      nodes[i].vy = 0;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        // Repulsive force
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        nodes[i].vx -= fx;
        nodes[i].vy -= fy;
        nodes[j].vx += fx;
        nodes[j].vy += fy;
      }
    }

    // Attractive forces (edges)
    for (const edge of edges) {
      const ni = nodes[edge.source];
      const nj = nodes[edge.target];
      const dx = nj.x - ni.x;
      const dy = nj.y - ni.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      // Attractive force (stronger for higher correlation)
      const force = (dist * dist) / k * Math.abs(edge.weight);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      ni.vx += fx * 0.5;
      ni.vy += fy * 0.5;
      nj.vx -= fx * 0.5;
      nj.vy -= fy * 0.5;
    }

    // Apply forces with cooling
    for (const node of nodes) {
      const mag = Math.sqrt(node.vx * node.vx + node.vy * node.vy) || 1;
      const capped = Math.min(mag, t);
      node.x += (node.vx / mag) * capped;
      node.y += (node.vy / mag) * capped;

      // Keep within bounds
      const margin = 30;
      node.x = Math.max(margin, Math.min(width - margin, node.x));
      node.y = Math.max(margin, Math.min(height - margin, node.y));
    }

    // Cool down
    t = t * 0.95;
  }

  return nodes;
}

// =============================================================================
// Niche Colors
// =============================================================================

const NICHE_COLORS = [
  '#FF6B6B', // Red
  '#4ECDC4', // Teal
  '#45B7D1', // Blue
  '#96CEB4', // Green
  '#FFEAA7', // Yellow
  '#DDA0DD', // Plum
  '#98D8C8', // Mint
  '#F7DC6F', // Gold
];

function getNicheColor(niche: number): string {
  return NICHE_COLORS[niche % NICHE_COLORS.length];
}

// =============================================================================
// Component
// =============================================================================

export function NicheNetworkOverlay(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const [loading, setLoading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<NicheAnalysisResult | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [numNiches, setNumNiches] = useState(4);
  const [correlationThreshold, setCorrelationThreshold] = useState(0.3);
  const [showNegative, setShowNegative] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutNodesRef = useRef<LayoutNode[]>([]);

  // Hotkey to toggle overlay
  useHotkey(
    { key: 'N', modifiers: { shift: true, ctrl: true } },
    'Niche Co-Occurrence Network',
    () => toggle('nicheNetwork'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'power' }
  );

  // Track overlay open state
  const overlayIsOpen = isOpen('nicheNetwork');

  // Run analysis when overlay opens or parameters change
  useEffect(() => {
    if (!overlayIsOpen) return;

    setLoading(true);

    // Use setTimeout to avoid blocking UI
    const timeoutId = setTimeout(() => {
      try {
        // Generate demo data (in production, this would come from user upload)
        const abundanceTable = generateDemoAbundanceTable(25, 60, numNiches);

        const result = analyzeNiches(abundanceTable, undefined, {
          numNiches,
          correlationThreshold,
          includeNegative: showNegative,
          bootstrapIterations: 50, // Fewer for faster demo
        });

        setAnalysisResult(result);
      } catch (error) {
        console.error('Niche analysis failed:', error);
      } finally {
        setLoading(false);
      }
    }, 50);

    return () => clearTimeout(timeoutId);
  }, [overlayIsOpen, numNiches, correlationThreshold, showNegative]);

  // Build layout when network changes
  const layoutData = useMemo(() => {
    if (!analysisResult) return null;

    const { network } = analysisResult;
    const nodeIndexMap = new Map<string, number>();

    const layoutNodes: LayoutNode[] = network.nodes.map((node, i) => {
      nodeIndexMap.set(node.taxon, i);
      return {
        id: node.taxon,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        niche: node.primaryNiche,
        degree: node.degree,
        strength: node.strength,
      };
    });

    const layoutEdges: LayoutEdge[] = network.edges.map(edge => ({
      source: nodeIndexMap.get(edge.source) ?? 0,
      target: nodeIndexMap.get(edge.target) ?? 0,
      weight: edge.correlation,
      type: edge.type,
    }));

    return { nodes: layoutNodes, edges: layoutEdges };
  }, [analysisResult]);

  // Draw network on canvas
  const drawNetwork = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layoutData) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Run layout if not done
    if (layoutNodesRef.current.length !== layoutData.nodes.length) {
      layoutNodesRef.current = runForceLayout(
        [...layoutData.nodes],
        layoutData.edges,
        width,
        height,
        150
      );
    }

    const nodes = layoutNodesRef.current;
    const edges = layoutData.edges;

    // Clear canvas
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Draw edges
    for (const edge of edges) {
      const source = nodes[edge.source];
      const target = nodes[edge.target];
      if (!source || !target) continue;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);

      // Color: positive = green, negative = red
      const alpha = Math.min(1, Math.abs(edge.weight) * 1.5);
      if (edge.type === 'positive') {
        ctx.strokeStyle = `rgba(76, 175, 80, ${alpha * 0.5})`;
      } else {
        ctx.strokeStyle = `rgba(244, 67, 54, ${alpha * 0.5})`;
      }
      ctx.lineWidth = Math.abs(edge.weight) * 3;
      ctx.stroke();
    }

    // Draw nodes
    for (const node of nodes) {
      const isSelected = node.id === selectedNode;
      const radius = 6 + node.degree * 1.5;

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = getNicheColor(node.niche);
      ctx.fill();

      // Border for selected node
      if (isSelected) {
        ctx.strokeStyle = colors.text;
        ctx.lineWidth = 3;
        ctx.stroke();
      } else {
        ctx.strokeStyle = colors.borderLight;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Label for high-degree nodes or selected
      if (node.degree > 3 || isSelected) {
        ctx.fillStyle = colors.text;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(node.id, node.x, node.y - radius - 4);
      }
    }

    // Legend
    const legendY = 20;
    const nicheCount = analysisResult?.nmfResult.k ?? numNiches;
    for (let i = 0; i < nicheCount; i++) {
      const x = 20 + i * 80;
      ctx.fillStyle = getNicheColor(i);
      ctx.fillRect(x, legendY, 12, 12);
      ctx.fillStyle = colors.textDim;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`Niche ${i + 1}`, x + 16, legendY + 10);
    }
  }, [layoutData, colors, selectedNode, numNiches, analysisResult]);

  // Handle canvas click
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const nodes = layoutNodesRef.current;
    for (const node of nodes) {
      const radius = 6 + node.degree * 1.5;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < radius * radius) {
        setSelectedNode(node.id === selectedNode ? null : node.id);
        return;
      }
    }
    setSelectedNode(null);
  }, [selectedNode]);

  // Draw on layout changes
  useEffect(() => {
    drawNetwork();
  }, [drawNetwork]);

  // Redraw on window resize
  useEffect(() => {
    const handleResize = () => {
      layoutNodesRef.current = []; // Force relayout
      drawNetwork();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawNetwork]);

  if (!overlayIsOpen) {
    return null;
  }

  // Get selected node profile
  const selectedProfile = selectedNode
    ? analysisResult?.nicheProfiles.find(p => p.taxon === selectedNode)
    : null;

  return (
    <Overlay
      id="nicheNetwork"
      title="NICHE CO-OCCURRENCE NETWORK"
      hotkey="Ctrl+Shift+N"
      size="xl"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Description */}
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.9rem',
          }}
        >
          <strong style={{ color: colors.primary }}>Ecological Niche Inference</strong>{' '}
          from metagenomic co-occurrence. Nodes colored by NMF-derived niche assignments.
          Green edges = positive correlation, red = negative (exclusion).
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ color: colors.textDim, fontSize: '0.85rem' }}>
            Niches:
            <select
              value={numNiches}
              onChange={e => {
                setNumNiches(Number(e.target.value));
                layoutNodesRef.current = [];
              }}
              style={{
                marginLeft: '0.5rem',
                padding: '0.25rem',
                backgroundColor: colors.backgroundAlt,
                color: colors.text,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
              }}
            >
              {[2, 3, 4, 5, 6].map(k => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>

          <label style={{ color: colors.textDim, fontSize: '0.85rem' }}>
            Corr. threshold:
            <input
              type="range"
              min="0.1"
              max="0.7"
              step="0.05"
              value={correlationThreshold}
              onChange={e => {
                setCorrelationThreshold(Number(e.target.value));
                layoutNodesRef.current = [];
              }}
              style={{ marginLeft: '0.5rem', width: '80px' }}
            />
            <span style={{ marginLeft: '0.25rem', fontFamily: 'monospace' }}>
              {correlationThreshold.toFixed(2)}
            </span>
          </label>

          <label style={{ color: colors.textDim, fontSize: '0.85rem', display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={showNegative}
              onChange={e => {
                setShowNegative(e.target.checked);
                layoutNodesRef.current = [];
              }}
              style={{ marginRight: '0.25rem' }}
            />
            Show negative
          </label>
        </div>

        {loading ? (
          <AnalysisPanelSkeleton />
        ) : (
          <div style={{ display: 'flex', gap: '1rem' }}>
            {/* Network Canvas */}
            <div
              style={{
                flex: 2,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
                overflow: 'hidden',
              }}
            >
              <canvas
                ref={canvasRef}
                onClick={handleCanvasClick}
                style={{
                  width: '100%',
                  height: '350px',
                  display: 'block',
                  cursor: 'pointer',
                }}
              />
            </div>

            {/* Stats Panel */}
            <div
              style={{
                flex: 1,
                minWidth: '200px',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              {/* Network Stats */}
              {analysisResult && (
                <div
                  style={{
                    padding: '0.75rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                  }}
                >
                  <div style={{ color: colors.primary, fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                    Network Statistics
                  </div>
                  <div style={{ color: colors.textDim, fontSize: '0.75rem' }}>
                    <div>Nodes: {analysisResult.network.stats.nodeCount}</div>
                    <div>Edges: {analysisResult.network.stats.edgeCount}</div>
                    <div>Density: {(analysisResult.network.stats.density * 100).toFixed(1)}%</div>
                    <div>Positive: {(analysisResult.network.stats.positiveRatio * 100).toFixed(0)}%</div>
                    <div>NMF Error: {analysisResult.nmfResult.error.toFixed(2)}</div>
                  </div>
                </div>
              )}

              {/* Selected Node Profile */}
              {selectedProfile && (
                <div
                  style={{
                    padding: '0.75rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                  }}
                >
                  <div style={{ color: colors.primary, fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                    {selectedProfile.taxon}
                  </div>
                  <div style={{ color: colors.textDim, fontSize: '0.75rem' }}>
                    <div>
                      Primary Niche:{' '}
                      <span style={{ color: getNicheColor(selectedProfile.primaryNiche) }}>
                        #{selectedProfile.primaryNiche + 1}
                      </span>
                      {' '}({(selectedProfile.nicheConfidence * 100).toFixed(0)}%)
                    </div>
                    <div style={{ marginTop: '0.5rem' }}>
                      Niche Weights:
                      <div style={{ display: 'flex', gap: '2px', marginTop: '2px' }}>
                        {selectedProfile.nicheWeights.map((w, i) => (
                          <div
                            key={i}
                            style={{
                              flex: w,
                              height: '8px',
                              backgroundColor: getNicheColor(i),
                              borderRadius: '2px',
                            }}
                            title={`Niche ${i + 1}: ${(w * 100).toFixed(0)}%`}
                          />
                        ))}
                      </div>
                    </div>
                    {selectedProfile.coOccurringTaxa.length > 0 && (
                      <div style={{ marginTop: '0.5rem' }}>
                        Top co-occurring:
                        {selectedProfile.coOccurringTaxa.slice(0, 5).map((t, i) => (
                          <div
                            key={i}
                            style={{
                              color: t.correlation > 0 ? colors.success : colors.error,
                              fontSize: '0.7rem',
                            }}
                          >
                            {t.taxon} ({t.correlation > 0 ? '+' : ''}{t.correlation.toFixed(2)})
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Instructions */}
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  color: colors.textMuted,
                  fontSize: '0.7rem',
                }}
              >
                Click nodes to inspect. Adjust threshold to filter edges.
                Node size = degree. Colors = NMF niche assignment.
              </div>
            </div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default NicheNetworkOverlay;
