/**
 * EpistasisOverlay - Fitness Landscape & Epistasis Explorer
 *
 * Visualizes pairwise epistasis for phage proteins using BLOSUM62-based
 * pseudo-likelihood scoring. Shows:
 * - Epistasis heatmap (position × position)
 * - Single mutant fitness distribution
 * - Robust vs fragile regions
 * - Potential escape routes (compensatory mutations)
 */

import React, { useMemo, useState, useEffect, useRef } from 'react';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  analyzeFitnessLandscape,
  classifyProteinType,
  type FitnessLandscape,
  type EpistasisPair,
  type SingleMutantEffect,
  type FitnessRegion,
  type EscapeRoute,
  type ProteinType,
} from '@phage-explorer/core';

// ============================================================================
// Types
// ============================================================================

interface EpistasisOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

type ViewMode = 'heatmap' | 'mutants' | 'regions' | 'escape';

interface ProteinCandidate {
  gene: GeneInfo;
  type: ProteinType;
  sequence: string;
}

// ============================================================================
// Styling Helpers
// ============================================================================

function epistasisColor(score: number): string {
  // Antagonistic (compensatory) = green, Synergistic = red, Additive = gray
  if (score > 0.5) {
    const intensity = Math.min(1, score / 3);
    return `rgba(34, 197, 94, ${0.3 + intensity * 0.7})`; // Green
  } else if (score < -0.5) {
    const intensity = Math.min(1, Math.abs(score) / 3);
    return `rgba(239, 68, 68, ${0.3 + intensity * 0.7})`; // Red
  }
  return 'rgba(107, 114, 128, 0.3)'; // Gray
}

function fitnessColor(deltaG: number): string {
  // Negative = deleterious (red), Positive = beneficial (green)
  if (deltaG > 0) {
    const intensity = Math.min(1, deltaG / 3);
    return `rgba(34, 197, 94, ${0.3 + intensity * 0.7})`;
  } else {
    const intensity = Math.min(1, Math.abs(deltaG) / 6);
    return `rgba(239, 68, 68, ${0.3 + intensity * 0.7})`;
  }
}

function regionColor(type: 'robust' | 'fragile' | 'neutral'): string {
  switch (type) {
    case 'robust':
      return '#22c55e';
    case 'fragile':
      return '#ef4444';
    case 'neutral':
      return '#6b7280';
  }
}

// ============================================================================
// Sub-components
// ============================================================================

function ProteinSelector({
  proteins,
  selected,
  onSelect,
  colors,
}: {
  proteins: ProteinCandidate[];
  selected: number;
  onSelect: (idx: number) => void;
  colors: { text: string; textMuted: string; accent: string; border: string };
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
      {proteins.map((p, idx) => (
        <button
          key={idx}
          onClick={() => onSelect(idx)}
          style={{
            padding: '6px 12px',
            borderRadius: '4px',
            border: `1px solid ${selected === idx ? colors.accent : colors.border}`,
            background: selected === idx ? colors.accent + '20' : 'transparent',
            color: colors.text,
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          <span style={{ fontWeight: 500 }}>{p.gene.gene || `Gene ${p.gene.start}`}</span>
          <span style={{ color: colors.textMuted, marginLeft: '6px' }}>
            ({p.type}, {p.sequence.length}aa)
          </span>
        </button>
      ))}
    </div>
  );
}

function EpistasisHeatmap({
  pairs,
  colors,
}: {
  pairs: EpistasisPair[];
  colors: { text: string; textMuted: string; border: string };
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredPair] = useState<EpistasisPair | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || pairs.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = 300;
    canvas.width = size;
    canvas.height = size;

    // Find position range
    const allPos = pairs.flatMap((p) => [p.pos1, p.pos2]);
    const minPos = Math.min(...allPos);
    const maxPos = Math.max(...allPos);
    const range = maxPos - minPos + 1;
    const cellSize = size / Math.min(range, 50);

    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, size, size);

    // Draw diagonal
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, size);
    ctx.stroke();

    // Draw epistasis pairs
    for (const pair of pairs) {
      const x = ((pair.pos1 - minPos) / range) * size;
      const y = ((pair.pos2 - minPos) / range) * size;
      const r = Math.max(3, Math.min(cellSize / 2, 8));

      ctx.fillStyle = epistasisColor(pair.epistasisScore);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // Mirror across diagonal
      ctx.beginPath();
      ctx.arc(y, x, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [pairs, colors]);

  return (
    <div>
      <div style={{ marginBottom: '8px', fontSize: '12px', color: colors.textMuted }}>
        Epistasis Heatmap (position × position)
      </div>
      <canvas
        ref={canvasRef}
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: '4px',
        }}
      />
      <div style={{ display: 'flex', gap: '16px', marginTop: '8px', fontSize: '11px' }}>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: '12px',
              height: '12px',
              background: 'rgba(34, 197, 94, 0.8)',
              borderRadius: '2px',
              marginRight: '4px',
            }}
          />
          Antagonistic (ε &gt; 0)
        </span>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: '12px',
              height: '12px',
              background: 'rgba(239, 68, 68, 0.8)',
              borderRadius: '2px',
              marginRight: '4px',
            }}
          />
          Synergistic (ε &lt; 0)
        </span>
      </div>
      {hoveredPair && (
        <div style={{ marginTop: '8px', fontSize: '12px' }}>
          Pos {hoveredPair.pos1 + 1} × Pos {hoveredPair.pos2 + 1}: ε ={' '}
          {hoveredPair.epistasisScore.toFixed(2)}
        </div>
      )}
    </div>
  );
}

function MutantDistribution({
  mutants,
  colors,
}: {
  mutants: SingleMutantEffect[];
  colors: { text: string; textMuted: string; border: string };
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Group by position and compute average
  const positionStats = useMemo(() => {
    const byPos = new Map<number, number[]>();
    for (const m of mutants) {
      const list = byPos.get(m.position) || [];
      list.push(m.deltaFitness);
      byPos.set(m.position, list);
    }

    return Array.from(byPos.entries())
      .map(([pos, values]) => ({
        position: pos,
        avgFitness: values.reduce((a, b) => a + b, 0) / values.length,
        minFitness: Math.min(...values),
        maxFitness: Math.max(...values),
      }))
      .sort((a, b) => a.position - b.position);
  }, [mutants]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || positionStats.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 400;
    const height = 120;
    canvas.width = width;
    canvas.height = height;

    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, width, height);

    // Find range
    const minFit = Math.min(...positionStats.map((p) => p.minFitness));
    const maxFit = Math.max(...positionStats.map((p) => p.maxFitness));
    const range = maxFit - minFit || 1;

    // Draw zero line
    const zeroY = height - ((0 - minFit) / range) * (height - 20);
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(width, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw bars
    const barWidth = Math.max(1, (width - 20) / positionStats.length);
    for (let i = 0; i < positionStats.length; i++) {
      const stat = positionStats[i];
      const x = 10 + i * barWidth;
      const avgY = height - ((stat.avgFitness - minFit) / range) * (height - 20);

      ctx.fillStyle = fitnessColor(stat.avgFitness);
      ctx.fillRect(x, Math.min(zeroY, avgY), barWidth - 1, Math.abs(avgY - zeroY));
    }

    // Labels
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px monospace';
    ctx.fillText('0', 2, zeroY - 2);
    ctx.fillText(`${minFit.toFixed(1)}`, 2, height - 2);
    ctx.fillText(`${maxFit.toFixed(1)}`, 2, 10);
  }, [positionStats, colors]);

  // Histogram of fitness values
  const histogram = useMemo(() => {
    const bins = Array(20).fill(0);
    const min = -8;
    const max = 2;
    const binSize = (max - min) / 20;

    for (const m of mutants) {
      const binIdx = Math.floor((m.deltaFitness - min) / binSize);
      if (binIdx >= 0 && binIdx < 20) {
        bins[binIdx]++;
      }
    }

    return bins;
  }, [mutants]);

  return (
    <div>
      <div style={{ marginBottom: '8px', fontSize: '12px', color: colors.textMuted }}>
        Position-wise Average Fitness (ΔG)
      </div>
      <canvas
        ref={canvasRef}
        style={{
          border: `1px solid ${colors.border}`,
          borderRadius: '4px',
        }}
      />
      <div style={{ marginTop: '16px' }}>
        <div style={{ fontSize: '12px', color: colors.textMuted, marginBottom: '4px' }}>
          Fitness Distribution
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', height: '40px', gap: '1px' }}>
          {histogram.map((count, i) => {
            const max = Math.max(...histogram);
            const height = max > 0 ? (count / max) * 40 : 0;
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: `${height}px`,
                  background: i < 16 ? 'rgba(239, 68, 68, 0.6)' : 'rgba(34, 197, 94, 0.6)',
                  borderRadius: '1px 1px 0 0',
                }}
              />
            );
          })}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '10px',
            color: colors.textMuted,
          }}
        >
          <span>Deleterious</span>
          <span>Neutral</span>
          <span>Beneficial</span>
        </div>
      </div>
    </div>
  );
}

function RegionsList({
  robustRegions,
  fragileRegions,
  colors,
}: {
  robustRegions: FitnessRegion[];
  fragileRegions: FitnessRegion[];
  colors: { text: string; textMuted: string; border: string };
}): React.ReactElement {
  const allRegions = [
    ...robustRegions.map((r) => ({ ...r, type: 'robust' as const })),
    ...fragileRegions.map((r) => ({ ...r, type: 'fragile' as const })),
  ].sort((a, b) => a.start - b.start);

  return (
    <div>
      <div style={{ marginBottom: '8px', fontSize: '12px', color: colors.textMuted }}>
        Fitness Regions ({robustRegions.length} robust, {fragileRegions.length} fragile)
      </div>
      <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
        {allRegions.map((region, i) => (
          <div
            key={i}
            style={{
              padding: '8px',
              marginBottom: '4px',
              borderRadius: '4px',
              border: `1px solid ${colors.border}`,
              background: region.type === 'robust' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                {region.start + 1}–{region.end + 1}
              </span>
              <span
                style={{
                  padding: '2px 6px',
                  borderRadius: '3px',
                  fontSize: '10px',
                  fontWeight: 500,
                  background: regionColor(region.type),
                  color: 'white',
                }}
              >
                {region.type.toUpperCase()}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                gap: '12px',
                marginTop: '4px',
                fontSize: '11px',
                color: colors.textMuted,
              }}
            >
              <span>Avg ΔG: {region.averageFitness.toFixed(2)}</span>
              <span>Tolerance: {(region.mutationalTolerance * 100).toFixed(0)}%</span>
              <span>Conservation: {(region.conservationScore * 100).toFixed(0)}%</span>
            </div>
          </div>
        ))}
        {allRegions.length === 0 && (
          <div style={{ color: colors.textMuted, fontStyle: 'italic' }}>
            No distinct regions identified
          </div>
        )}
      </div>
    </div>
  );
}

function EscapeRoutesList({
  routes,
  colors,
}: {
  routes: EscapeRoute[];
  colors: { text: string; textMuted: string; border: string };
}): React.ReactElement {
  return (
    <div>
      <div style={{ marginBottom: '8px', fontSize: '12px', color: colors.textMuted }}>
        Potential Escape Routes (Compensatory Mutations)
      </div>
      <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
        {routes.map((route, i) => (
          <div
            key={i}
            style={{
              padding: '10px',
              marginBottom: '6px',
              borderRadius: '4px',
              border: `1px solid ${colors.border}`,
              background: 'rgba(34, 197, 94, 0.05)',
            }}
          >
            <div style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 500 }}>
              {route.pathDescription}
            </div>
            <div
              style={{
                display: 'flex',
                gap: '16px',
                marginTop: '6px',
                fontSize: '11px',
                color: colors.textMuted,
              }}
            >
              <span>
                Fitness gain:{' '}
                <span style={{ color: '#22c55e', fontWeight: 500 }}>
                  +{route.fitnessGain.toFixed(2)}
                </span>
              </span>
              <span>
                Escape probability:{' '}
                <span style={{ fontWeight: 500 }}>{(route.escapeProbability * 100).toFixed(0)}%</span>
              </span>
            </div>
          </div>
        ))}
        {routes.length === 0 && (
          <div style={{ color: colors.textMuted, fontStyle: 'italic' }}>
            No escape routes detected
          </div>
        )}
      </div>
    </div>
  );
}

function ViewTabs({
  mode,
  onModeChange,
  colors,
}: {
  mode: ViewMode;
  onModeChange: (m: ViewMode) => void;
  colors: { text: string; textMuted: string; accent: string; border: string };
}): React.ReactElement {
  const tabs: Array<{ id: ViewMode; label: string }> = [
    { id: 'heatmap', label: 'Heatmap' },
    { id: 'mutants', label: 'Mutants' },
    { id: 'regions', label: 'Regions' },
    { id: 'escape', label: 'Escape' },
  ];

  return (
    <div
      style={{
        display: 'flex',
        gap: '4px',
        marginBottom: '12px',
        borderBottom: `1px solid ${colors.border}`,
        paddingBottom: '8px',
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onModeChange(tab.id)}
          style={{
            padding: '4px 12px',
            borderRadius: '4px 4px 0 0',
            border: 'none',
            background: mode === tab.id ? colors.accent + '20' : 'transparent',
            color: mode === tab.id ? colors.accent : colors.textMuted,
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: mode === tab.id ? 500 : 400,
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function EpistasisOverlay({
  repository,
  currentPhage,
}: EpistasisOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('heatmap');
  const [selectedProtein, setSelectedProtein] = useState(0);

  // Hotkey to toggle overlay
  useHotkey(
    { key: 'e', alt: true },
    'Epistasis Explorer',
    () => toggle('epistasis'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('epistasis')) return;
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
      .then((length) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq) => {
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => setSequence(''))
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  // Identify protein candidates (capsid, tail fiber, portal, polymerase)
  const proteinCandidates = useMemo((): ProteinCandidate[] => {
    if (!currentPhage?.genes || !sequence) return [];

    const candidates: ProteinCandidate[] = [];

    for (const gene of currentPhage.genes) {
      const type = classifyProteinType(gene);
      if (type === 'other') continue;

      // Extract protein sequence (translate CDS)
      const start = gene.start - 1;
      const end = gene.end;
      if (start < 0 || end > sequence.length) continue;

      let cds = sequence.slice(start, end);
      if (gene.strand === -1) {
        // Reverse complement
        cds = cds
          .split('')
          .reverse()
          .map((b) =>
            ({ A: 'T', T: 'A', C: 'G', G: 'C' })[b.toUpperCase()] || b
          )
          .join('');
      }

      // Simple translation (single letter codes)
      const codonTable: Record<string, string> = {
        TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
        TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
        TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*',
        TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
        CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
        CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
        CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
        CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
        ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
        ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
        AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
        AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
        GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
        GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
        GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
        GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
      };

      let protein = '';
      for (let i = 0; i + 2 < cds.length; i += 3) {
        const codon = cds.slice(i, i + 3).toUpperCase();
        const aa = codonTable[codon] || 'X';
        if (aa === '*') break;
        protein += aa;
      }

      if (protein.length >= 50) {
        candidates.push({ gene, type, sequence: protein });
      }
    }

    // Sort by priority: capsid > tail_fiber > portal > polymerase
    const priority: Record<ProteinType, number> = {
      capsid: 1,
      tail_fiber: 2,
      portal: 3,
      polymerase: 4,
      other: 5,
    };
    candidates.sort((a, b) => priority[a.type] - priority[b.type]);

    return candidates.slice(0, 8); // Limit to 8 proteins
  }, [currentPhage, sequence]);

  // Compute fitness landscape for selected protein
  const landscape = useMemo((): FitnessLandscape | null => {
    if (proteinCandidates.length === 0 || selectedProtein >= proteinCandidates.length) {
      return null;
    }

    const protein = proteinCandidates[selectedProtein];
    return analyzeFitnessLandscape(protein.gene.gene || `Gene${protein.gene.start}`, protein.sequence, {
      maxPositions: 150, // Limit for performance
      topEpistasisPairs: 100,
    });
  }, [proteinCandidates, selectedProtein]);

  if (!isOpen('epistasis')) return null;

  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '680px',
    maxWidth: '95vw',
    maxHeight: '85vh',
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    borderRadius: '8px',
    padding: '20px',
    color: colors.text,
    fontFamily: 'system-ui, sans-serif',
    overflowY: 'auto',
    zIndex: 9999,
  };

  return (
    <Overlay id="epistasis" title="Epistasis & Fitness Landscape">
      <div style={panelStyle}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '18px' }}>Epistasis Explorer</h2>
          <button
            onClick={() => toggle('epistasis')}
            style={{
              background: 'none',
              border: 'none',
              color: colors.textMuted,
              cursor: 'pointer',
              fontSize: '18px',
            }}
          >
            ×
          </button>
        </div>

        {loading && <AnalysisPanelSkeleton />}

        {!loading && !currentPhage && (
          <div style={{ color: colors.textMuted, fontStyle: 'italic' }}>
            Select a phage to analyze
          </div>
        )}

        {!loading && currentPhage && proteinCandidates.length === 0 && (
          <div style={{ color: colors.textMuted, fontStyle: 'italic' }}>
            No suitable proteins found (capsid, tail fiber, portal, polymerase)
          </div>
        )}

        {!loading && proteinCandidates.length > 0 && (
          <>
            <ProteinSelector
              proteins={proteinCandidates}
              selected={selectedProtein}
              onSelect={setSelectedProtein}
              colors={{ text: colors.text, textMuted: colors.textMuted, accent: colors.accent, border: colors.border }}
            />

            {landscape && (
              <>
                <div
                  style={{
                    display: 'flex',
                    gap: '16px',
                    marginBottom: '12px',
                    fontSize: '12px',
                    color: colors.textMuted,
                  }}
                >
                  <span>
                    Protein: <strong style={{ color: colors.text }}>{landscape.proteinName}</strong>
                  </span>
                  <span>
                    Length: <strong style={{ color: colors.text }}>{landscape.proteinSequence.length}aa</strong>
                  </span>
                  <span>
                    Avg ΔG: <strong style={{ color: colors.text }}>{landscape.averageFitness.toFixed(2)}</strong>
                  </span>
                </div>

                <ViewTabs
                  mode={viewMode}
                  onModeChange={setViewMode}
                  colors={{ text: colors.text, textMuted: colors.textMuted, accent: colors.accent, border: colors.border }}
                />

                {viewMode === 'heatmap' && (
                  <EpistasisHeatmap
                    pairs={landscape.epistasisPairs}
                    colors={{ text: colors.text, textMuted: colors.textMuted, border: colors.border }}
                  />
                )}

                {viewMode === 'mutants' && (
                  <MutantDistribution
                    mutants={landscape.singleMutants}
                    colors={{ text: colors.text, textMuted: colors.textMuted, border: colors.border }}
                  />
                )}

                {viewMode === 'regions' && (
                  <RegionsList
                    robustRegions={landscape.robustRegions}
                    fragileRegions={landscape.fragileRegions}
                    colors={{ text: colors.text, textMuted: colors.textMuted, border: colors.border }}
                  />
                )}

                {viewMode === 'escape' && (
                  <EscapeRoutesList
                    routes={landscape.escapeRoutes}
                    colors={{ text: colors.text, textMuted: colors.textMuted, border: colors.border }}
                  />
                )}
              </>
            )}
          </>
        )}

        <div style={{ marginTop: '16px', fontSize: '11px', color: colors.textMuted }}>
          Press <kbd style={{ padding: '2px 4px', background: colors.border, borderRadius: '3px' }}>Alt+E</kbd> to toggle
        </div>
      </div>
    </Overlay>
  );
}

export default EpistasisOverlay;
