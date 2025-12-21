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
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
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
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [showConstellation, setShowConstellation] = useState(true);
  const constellationRef = useRef<HTMLCanvasElement>(null);

  // Hotkey to toggle overlay
  useHotkey(
    { key: 'p' },
    'Promoter & RBS Sites',
    () => toggle('promoter'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'intermediate' }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('promoter')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    // Check cache
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      setLoading(false);
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

  return (
    <Overlay
      id="promoter"
      title="REGULATORY SIGNALS"
      hotkey="p"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Loading State */}
        {loading && (
          <AnalysisPanelSkeleton message="Loading sequence data..." rows={3} />
        )}

        {/* Description */}
        {!loading && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.9rem',
          }}>
            <strong style={{ color: colors.primary }}>Regulatory Signal Detection</strong> identifies promoters
            (σ70, σ32, σ54 motifs), ribosome binding sites (Shine-Dalgarno sequences), and intrinsic terminators
            (rho-independent hairpin + poly-U).
          </div>
        )}

        {/* Stats */}
        {!loading && sequence.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '1rem',
          }}>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.success, fontSize: '0.75rem' }}>Promoters (σ70/σ32/σ54)</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{promoters.length}</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.info, fontSize: '0.75rem' }}>RBS Sites</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{rbsSites.length}</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.warning, fontSize: '0.75rem' }}>Terminators</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{terminators.length}</div>
            </div>
          </div>
        )}

        {/* Constellation Visualization */}
        {!loading && sequence.length > 0 && edges.length > 0 && (
          <div style={{
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '4px',
            overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.5rem 0.75rem',
              backgroundColor: colors.backgroundAlt,
              borderBottom: `1px solid ${colors.borderLight}`,
            }}>
              <div style={{ color: colors.primary, fontSize: '0.85rem', fontWeight: 600 }}>
                Regulatory Constellation ({edges.length} operon edges)
              </div>
              <button
                onClick={() => setShowConstellation(!showConstellation)}
                style={{
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.75rem',
                  backgroundColor: 'transparent',
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                  color: colors.textDim,
                  cursor: 'pointer',
                }}
              >
                {showConstellation ? 'Hide' : 'Show'}
              </button>
            </div>
            {showConstellation && (
              <canvas
                ref={constellationRef}
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
        {!loading && sequence.length > 0 && (() => {
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
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ backgroundColor: colors.backgroundAlt, position: 'sticky', top: 0 }}>
                    <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Type</th>
                    <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Position</th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', color: colors.textDim }}>Strand</th>
                    <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Motif</th>
                    <th style={{ padding: '0.5rem', textAlign: 'right', color: colors.textDim }}>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {allSites.map((site, idx) => (
                    <tr
                      key={idx}
                      style={{
                        borderTop: `1px solid ${colors.borderLight}`,
                        backgroundColor: idx % 2 === 0 ? 'transparent' : colors.backgroundAlt,
                      }}
                    >
                      <td style={{ padding: '0.5rem' }}>
                        <span style={{ color: getColor(site.kind), fontWeight: 'bold' }}>
                          {getIcon(site.kind)} {getLabel(site.kind)}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: colors.text }}>
                        {site.pos.toLocaleString()}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center', fontFamily: 'monospace', color: colors.accent }}>
                        {site.strand}
                      </td>
                      <td style={{ padding: '0.5rem', color: colors.textDim }}>
                        {site.motif}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'right' }}>
                        <span style={{
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
                          backgroundColor: `rgba(${site.score > 0.7 ? '92, 184, 92' : '240, 173, 78'}, 0.2)`,
                          color: site.score > 0.7 ? colors.success : colors.warning,
                          fontSize: '0.8rem',
                        }}>
                          {(site.score * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                  {allSites.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
                        No regulatory sites found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          );
        })()}

        {!loading && sequence.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem', color: colors.textMuted }}>
            No sequence data available. Select a phage to analyze.
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default PromoterOverlay;
