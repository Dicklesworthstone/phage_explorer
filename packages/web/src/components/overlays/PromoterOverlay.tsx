/**
 * PromoterOverlay - Regulatory Signal Detection
 *
 * Displays predicted promoters (σ70, σ32, σ54), terminators, and RBS sites
 * using the sophisticated detection algorithms from @phage-explorer/core.
 */

import React, { useEffect, useMemo, useState, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import {
  computeRegulatoryConstellation,
  type PromoterHit,
  type TerminatorHit,
  type RegulatoryEdge,
} from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import {
  OverlayStack,
  OverlayDescription,
  OverlayStatGrid,
  OverlayStatCard,
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';

interface PromoterOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

interface RegulatoryAnalysis {
  promoters: PromoterHit[];
  terminators: TerminatorHit[];
  edges: RegulatoryEdge[];
}

function analyzeRegulatory(sequence: string): RegulatoryAnalysis {
  if (!sequence || sequence.length < 100) {
    return { promoters: [], terminators: [], edges: [] };
  }
  const constellation = computeRegulatoryConstellation(sequence);
  return {
    promoters: constellation.promoters,
    terminators: constellation.terminators,
    edges: constellation.edges,
  };
}

export function PromoterOverlay({
  repository,
  currentPhage,
}: PromoterOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const [loaded, setLoaded] = useState<{ repository: PhageRepository; phage: PhageFull; sequence: string } | null>(null);
  const sequence = loaded?.repository === repository && loaded?.phage === currentPhage ? loaded.sequence : '';
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showConstellation, setShowConstellation] = useState(true);
  const constellationRef = useRef<HTMLCanvasElement>(null);

  // Hotkey to toggle overlay
  useHotkey(
    ActionIds.OverlayPromoter,
    () => toggle('promoter'),
    { modes: ['NORMAL'] }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('promoter')) return;
    setLoaded(null);
    setError(null);
    if (!repository || !currentPhage) {
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    let cancelled = false;
    setLoading(true);

    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => cancelled ? '' : repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        if (cancelled) return;
        setLoaded({ repository, phage: currentPhage, sequence: seq });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoaded(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  const analysis = useMemo(() => analyzeRegulatory(sequence), [sequence]);

  // Separate RBS from other promoter types
  const promoters = analysis.promoters.filter(p => p.motif !== 'RBS');
  const rbsSites = analysis.promoters.filter(p => p.motif === 'RBS');
  const terminators = analysis.terminators;
  const edges = analysis.edges;

  // Draw constellation arc diagram
  useEffect(() => {
    if (!constellationRef.current || !showConstellation) return;
    if (edges.length === 0 || sequence.length === 0) return;

    const canvas = constellationRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const genomeLen = sequence.length;
    const padding = 40;
    const trackY = height - 30;
    const usableWidth = width - padding * 2;

    // Draw genome track
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding, trackY);
    ctx.lineTo(width - padding, trackY);
    ctx.stroke();

    // Position markers
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('0', padding, trackY + 15);
    ctx.fillText((genomeLen / 1000).toFixed(0) + 'kb', width - padding, trackY + 15);
    ctx.fillText((genomeLen / 2000).toFixed(0) + 'kb', width / 2, trackY + 15);

    // Map position to x coordinate
    const posToX = (pos: number) => padding + (pos / genomeLen) * usableWidth;

    // Draw promoters as triangles
    for (const p of analysis.promoters.filter(pr => pr.motif !== 'RBS')) {
      const x = posToX(p.pos);
      ctx.fillStyle = colors.success;
      ctx.beginPath();
      ctx.moveTo(x, trackY - 4);
      ctx.lineTo(x - 4, trackY - 12);
      ctx.lineTo(x + 4, trackY - 12);
      ctx.closePath();
      ctx.fill();
    }

    // Draw terminators as diamonds
    for (const t of analysis.terminators) {
      const x = posToX(t.pos);
      ctx.fillStyle = colors.warning;
      ctx.beginPath();
      ctx.moveTo(x, trackY - 4);
      ctx.lineTo(x - 3, trackY - 8);
      ctx.lineTo(x, trackY - 12);
      ctx.lineTo(x + 3, trackY - 8);
      ctx.closePath();
      ctx.fill();
    }

    // Draw edges as arcs
    const maxWeight = Math.max(...edges.map(e => e.weight), 0.001);
    for (const edge of edges) {
      const x1 = posToX(edge.source);
      const x2 = posToX(edge.target);
      const midX = (x1 + x2) / 2;
      const arcHeight = Math.min(80, Math.abs(x2 - x1) * 0.3);
      const alpha = 0.3 + (edge.weight / maxWeight) * 0.5;

      ctx.strokeStyle = `rgba(99, 102, 241, ${alpha})`;
      ctx.lineWidth = 1 + (edge.weight / maxWeight) * 2;
      ctx.beginPath();
      ctx.moveTo(x1, trackY - 12);
      ctx.quadraticCurveTo(midX, trackY - 12 - arcHeight, x2, trackY - 12);
      ctx.stroke();
    }

    // Legend
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('▲ Promoter', padding, 15);
    ctx.fillStyle = colors.warning;
    ctx.fillText('◆ Terminator', padding + 70, 15);
    ctx.fillStyle = 'rgba(99, 102, 241, 0.7)';
    ctx.fillText('⌒ Operon edge', padding + 160, 15);
  }, [analysis.promoters, analysis.terminators, colors, edges, sequence.length, showConstellation]);

  if (!isOpen('promoter')) {
    return null;
  }

  const hasData = sequence.length > 0;
  const isEmpty = !loading && !error && sequence.length === 0;

  return (
    <Overlay
      id="promoter"
      title="REGULATORY SIGNALS"
      hotkey="p"
      size="lg"
    >
      <OverlayStack>
        {error && <OverlayErrorState message="Could not load sequence" details={error} />}
        {/* Loading State */}
        {loading && (
          <OverlayLoadingState message="Loading sequence data...">
            <AnalysisPanelSkeleton rows={3} />
          </OverlayLoadingState>
        )}

        {/* Description */}
        {!loading && (
          <OverlayDescription title="Regulatory Signal Detection">
            Identifies promoters (σ70, σ32, σ54 motifs), ribosome binding sites (Shine-Dalgarno sequences),
            and intrinsic terminators (rho-independent hairpin + poly-U).
          </OverlayDescription>
        )}

        {/* Stats */}
        {!loading && hasData && (
          <OverlayStatGrid columns={3}>
            <OverlayStatCard
              label="Promoters (σ70/σ32/σ54)"
              value={promoters.length}
              labelColor="var(--color-success)"
            />
            <OverlayStatCard
              label="RBS Sites"
              value={rbsSites.length}
              labelColor="var(--color-info)"
            />
            <OverlayStatCard
              label="Terminators"
              value={terminators.length}
              labelColor="var(--color-warning)"
            />
          </OverlayStatGrid>
        )}

        {/* Constellation Visualization */}
        {!loading && hasData && edges.length > 0 && (
          <div style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.5rem 0.75rem',
              backgroundColor: 'var(--color-background-alt)',
              borderBottom: '1px solid var(--color-border-light)',
            }}>
              <div style={{ color: 'var(--color-primary)', fontSize: '0.85rem', fontWeight: 600 }}>
                Regulatory Constellation ({edges.length} operon edges)
              </div>
              <button
                onClick={() => setShowConstellation(!showConstellation)}
                style={{
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.75rem',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--color-border-light)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--color-text-dim)',
                  cursor: 'pointer',
                }}
              >
                {showConstellation ? 'Hide' : 'Show'}
              </button>
            </div>
            {showConstellation && (
              <canvas
                ref={constellationRef}
                role="img"
                aria-label="Regulatory constellation diagram showing operon relationships and transcriptional connections between genes"
                style={{
                  width: '100%',
                  height: '140px',
                  display: 'block',
                }}
              />
            )}
          </div>
        )}

        {/* Sites table */}
        {!loading && hasData && (() => {
          // Combine all sites into unified display structure
          type DisplaySite = {
            kind: 'promoter' | 'rbs' | 'terminator';
            pos: number;
            strand: '+' | '-';
            motif: string;
            score: number;
          };

          const allSites: DisplaySite[] = [
            ...promoters.map(p => ({
              kind: 'promoter' as const,
              pos: p.pos,
              strand: p.strand,
              motif: p.motif,
              score: p.strength,
            })),
            ...rbsSites.map(r => ({
              kind: 'rbs' as const,
              pos: r.pos,
              strand: r.strand,
              motif: r.motif,
              score: r.strength,
            })),
            ...terminators.map(t => ({
              kind: 'terminator' as const,
              pos: t.pos,
              strand: t.strand,
              motif: t.motif,
              score: t.efficiency,
            })),
          ].sort((a, b) => a.pos - b.pos);

          const getColor = (kind: DisplaySite['kind']) => {
            switch (kind) {
              case 'promoter': return colors.success;
              case 'rbs': return colors.info;
              case 'terminator': return colors.warning;
            }
          };

          const getIcon = (kind: DisplaySite['kind']) => {
            switch (kind) {
              case 'promoter': return '◉';
              case 'rbs': return '◎';
              case 'terminator': return '◇';
            }
          };

          const getLabel = (kind: DisplaySite['kind']) => {
            switch (kind) {
              case 'promoter': return 'Promoter';
              case 'rbs': return 'RBS';
              case 'terminator': return 'Terminator';
            }
          };

          return (
            <div style={{
              maxHeight: '300px',
              overflowY: 'auto',
              border: '1px solid var(--color-border-light)',
              borderRadius: 'var(--radius-sm)',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ backgroundColor: 'var(--color-background-alt)', position: 'sticky', top: 0 }}>
                    <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--color-text-dim)' }}>Type</th>
                    <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--color-text-dim)' }}>Position</th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', color: 'var(--color-text-dim)' }}>Strand</th>
                    <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--color-text-dim)' }}>Motif</th>
                    <th style={{ padding: '0.5rem', textAlign: 'right', color: 'var(--color-text-dim)' }}>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {allSites.map((site, idx) => (
                    <tr
                      key={idx}
                      style={{
                        borderTop: '1px solid var(--color-border-light)',
                        backgroundColor: idx % 2 === 0 ? 'transparent' : 'var(--color-background-alt)',
                      }}
                    >
                      <td style={{ padding: '0.5rem' }}>
                        <span style={{ color: getColor(site.kind), fontWeight: 'bold' }}>
                          {getIcon(site.kind)} {getLabel(site.kind)}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: 'var(--color-text)' }}>
                        {site.pos.toLocaleString()}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center', fontFamily: 'monospace', color: 'var(--color-accent)' }}>
                        {site.strand}
                      </td>
                      <td style={{ padding: '0.5rem', color: 'var(--color-text-dim)' }}>
                        {site.motif}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'right' }}>
                        <span style={{
                          padding: '0.2rem 0.5rem',
                          borderRadius: 'var(--radius-sm)',
                          backgroundColor: `rgba(${site.score > 0.7 ? '92, 184, 92' : '240, 173, 78'}, 0.2)`,
                          color: site.score > 0.7 ? 'var(--color-success)' : 'var(--color-warning)',
                          fontSize: '0.8rem',
                        }}>
                          {(site.score * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                  {allSites.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                        No regulatory sites found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          );
        })()}

        {/* Empty State */}
        {isEmpty && (
          <OverlayEmptyState
            message="No sequence data available."
            hint="Select a phage to analyze."
          />
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default PromoterOverlay;
