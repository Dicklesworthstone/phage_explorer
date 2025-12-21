/**
 * StructureConstraintOverlay - Structure Constraints
 *
 * Two views:
 * - RNA signals: detects ribosome binding sites (RBS), transcription terminators,
 *   and a lightweight folding-energy proxy along the genome.
 * - Protein constraints: heuristic fragility scan for capsid/tail proteins
 *   (fast, no-dependency; not a substitute for real structural models).
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  analyzeStructuralConstraints,
  predictMutationEffect,
  type AminoAcid,
  type PhageFull,
} from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment, GenomeTrackInteraction } from './primitives/types';

type ViewMode = 'rna' | 'protein';

// RNA element types
type ElementType = 'rbs' | 'terminator' | 'stemloop';

interface RNAElement {
  type: ElementType;
  start: number;
  end: number;
  score: number;
  sequence: string;
  details: string;
}

// Shine-Dalgarno (SD) consensus sequences for RBS detection
const SD_PATTERNS = [
  { pattern: 'AGGAGG', score: 100 },
  { pattern: 'AGGAG', score: 90 },
  { pattern: 'AGGA', score: 80 },
  { pattern: 'GGAGG', score: 80 },
  { pattern: 'GAGG', score: 70 },
  { pattern: 'AGAG', score: 60 },
  { pattern: 'AGG', score: 50 },
  { pattern: 'GGA', score: 50 },
];

// Start codons
const START_CODONS = ['ATG', 'GTG', 'TTG'];

const FRAGILITY_BLOCKS = ['░', '▒', '▓', '█'] as const;

function fragilityBlock(score: number): string {
  if (score >= 0.8) return FRAGILITY_BLOCKS[3];
  if (score >= 0.6) return FRAGILITY_BLOCKS[2];
  if (score >= 0.4) return FRAGILITY_BLOCKS[1];
  return FRAGILITY_BLOCKS[0];
}

const AMINO_ACIDS: ReadonlyArray<AminoAcid> = [
  'A', 'R', 'N', 'D', 'C',
  'Q', 'E', 'G', 'H', 'I',
  'L', 'K', 'M', 'F', 'P',
  'S', 'T', 'W', 'Y', 'V',
];

// Find RBS candidates (Shine-Dalgarno sequences upstream of start codons)
function findRBS(sequence: string): RNAElement[] {
  const results: RNAElement[] = [];
  const upper = sequence.toUpperCase();

  // Find all potential start codons
  for (const startCodon of START_CODONS) {
    let pos = 0;
    while ((pos = upper.indexOf(startCodon, pos)) !== -1) {
      if (pos < 4) {
        pos++;
        continue;
      }

      // Scan -20 to -4 upstream for SD sequence
      const upstreamStart = Math.max(0, pos - 20);
      const upstreamEnd = pos - 4;
      const upstream = upper.slice(upstreamStart, upstreamEnd);

      // Check each SD pattern
      for (const sd of SD_PATTERNS) {
        const sdPos = upstream.indexOf(sd.pattern);
        if (sdPos !== -1) {
          const rbsStart = upstreamStart + sdPos;
          const rbsEnd = rbsStart + sd.pattern.length;
          const spacing = pos - rbsEnd;

          // Optimal spacing is 5-9 nt
          const spacingScore = spacing >= 5 && spacing <= 9 ? 20 : spacing >= 3 && spacing <= 12 ? 10 : 0;
          const totalScore = sd.score + spacingScore;

          if (totalScore >= 60) {
            results.push({
              type: 'rbs',
              start: rbsStart,
              end: pos + 3,
              score: Math.min(100, totalScore),
              sequence: upper.slice(rbsStart, pos + 3),
              details: `SD: ${sd.pattern}, spacing: ${spacing} nt to ${startCodon}`,
            });
            break; // Found best SD for this start codon
          }
        }
      }
      pos++;
    }
  }

  // Remove overlaps (keep highest scoring)
  return deduplicateElements(results);
}

// Find rho-independent transcription terminators
function findTerminators(sequence: string): RNAElement[] {
  const results: RNAElement[] = [];
  const upper = sequence.toUpperCase();

  // Look for stem-loop structures followed by U-tract
  for (let i = 0; i < upper.length - 50; i++) {
    // Search for inverted repeat (potential stem)
    const potentialStem = findBestStem(upper.slice(i, i + 40));

    if (potentialStem && potentialStem.score >= 30) {
      const stemEnd = i + potentialStem.end;

      // Check for poly-U tract (at least 4 U's within 10 nt)
      const downstream = upper.slice(stemEnd, stemEnd + 15);
      const uCount = (downstream.match(/T/g) || []).length; // T in DNA = U in RNA

      if (uCount >= 4) {
        const totalScore = potentialStem.score + (uCount * 5);

        results.push({
          type: 'terminator',
          start: i,
          end: stemEnd + 10,
          score: Math.min(100, totalScore),
          sequence: upper.slice(i, stemEnd + 10),
          details: `Stem: ${potentialStem.stemLength}bp, loop: ${potentialStem.loopLength}nt, U-tract: ${uCount}`,
        });
      }
    }
  }

  return deduplicateElements(results);
}

// Find best stem-loop in a window
function findBestStem(window: string): { stemLength: number; loopLength: number; end: number; score: number } | null {
  const complement: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };
  let best: { stemLength: number; loopLength: number; end: number; score: number } | null = null;

  for (let stemLen = 6; stemLen <= 15 && stemLen * 2 + 4 <= window.length; stemLen++) {
    for (let loopLen = 3; loopLen <= 8 && stemLen * 2 + loopLen <= window.length; loopLen++) {
      const leftStem = window.slice(0, stemLen);
      const rightStart = stemLen + loopLen;
      const rightStem = window.slice(rightStart, rightStart + stemLen);

      // Count base pairs
      let pairs = 0;
      let gcPairs = 0;
      for (let j = 0; j < stemLen; j++) {
        if (complement[leftStem[j]] === rightStem[stemLen - 1 - j]) {
          pairs++;
          if (leftStem[j] === 'G' || leftStem[j] === 'C') gcPairs++;
        }
      }

      // Score based on pairs, GC content, and stem length
      if (pairs >= stemLen * 0.7) {
        const score = (pairs * 5) + (gcPairs * 3) + (stemLen - loopLen);
        if (!best || score > best.score) {
          best = { stemLength: stemLen, loopLength: loopLen, end: rightStart + stemLen, score };
        }
      }
    }
  }

  return best;
}

// Compute local RNA folding potential (simplified energy landscape)
function computeEnergyLandscape(
  sequence: string,
  windowSize: number = 100,
  stepSize: number = 50
): { position: number; energy: number }[] {
  const results: { position: number; energy: number }[] = [];
  const upper = sequence.toUpperCase();

  for (let i = 0; i <= upper.length - windowSize; i += stepSize) {
    const window = upper.slice(i, i + windowSize);

    // Estimate folding energy based on GC content and dinucleotide composition
    // Higher GC = more stable structures (more negative ΔG)
    const gc = (window.match(/[GC]/g) || []).length / window.length;

    // Count potential base-pair forming dinucleotides
    let pairPotential = 0;
    for (let j = 0; j < window.length - 1; j++) {
      const di = window.slice(j, j + 2);
      // These dinucleotides tend to form stable pairs
      if (['GC', 'CG', 'GG', 'CC', 'AU', 'UA', 'AT', 'TA'].includes(di)) {
        pairPotential++;
      }
    }

    // Energy estimate (more negative = more structured)
    const energy = -(gc * 30) - (pairPotential / window.length * 20);

    results.push({
      position: i + windowSize / 2,
      energy,
    });
  }

  return results;
}

// Find potential stem-loops (hairpins) throughout sequence
function findStemLoops(sequence: string): RNAElement[] {
  const results: RNAElement[] = [];
  const upper = sequence.toUpperCase();

  // Scan with overlapping windows
  for (let i = 0; i < upper.length - 30; i += 20) {
    const window = upper.slice(i, Math.min(i + 50, upper.length));
    const stem = findBestStem(window);

    if (stem && stem.score >= 40) {
      results.push({
        type: 'stemloop',
        start: i,
        end: i + stem.end,
        score: stem.score,
        sequence: window.slice(0, stem.end),
        details: `Stem: ${stem.stemLength}bp, loop: ${stem.loopLength}nt`,
      });
    }
  }

  return deduplicateElements(results);
}

// Remove overlapping elements, keeping highest scoring
function deduplicateElements(elements: RNAElement[]): RNAElement[] {
  const sorted = [...elements].sort((a, b) => b.score - a.score);
  const filtered: RNAElement[] = [];

  for (const elem of sorted) {
    const overlaps = filtered.some(
      e => (elem.start >= e.start && elem.start < e.end) ||
           (elem.end > e.start && elem.end <= e.end) ||
           (elem.start <= e.start && elem.end >= e.end)
    );
    if (!overlaps) {
      filtered.push(elem);
    }
  }

  return filtered.sort((a, b) => a.start - b.start);
}

// Convert elements to track segments
function elementsToSegments(
  elements: RNAElement[],
  type: ElementType,
  color: string
): GenomeTrackSegment[] {
  return elements
    .filter(e => e.type === type)
    .map(e => ({
      start: e.start,
      end: e.end,
      color,
      height: Math.max(6, e.score / 6),
      label: e.details,
      data: e,
    }));
}

interface StructureConstraintOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Tooltip component
function ElementTooltip({
  element,
  colors,
}: {
  element: RNAElement;
  colors: { textMuted: string; textDim: string; text: string };
}): React.ReactElement {
  const typeLabels: Record<ElementType, string> = {
    rbs: 'Ribosome Binding Site',
    terminator: 'Transcription Terminator',
    stemloop: 'Stem-Loop Structure',
  };

  return (
    <>
      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
        {typeLabels[element.type]}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        {element.start.toLocaleString()} - {element.end.toLocaleString()} bp
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        Score: {element.score.toFixed(0)}
      </div>
      <div style={{ marginTop: '0.25rem', color: colors.textDim, fontSize: '0.65rem' }}>
        {element.details}
      </div>
      <div style={{ marginTop: '0.25rem', fontFamily: 'monospace', fontSize: '0.55rem', color: colors.text, wordBreak: 'break-all' }}>
        {element.sequence.slice(0, 35)}{element.sequence.length > 35 ? '...' : ''}
      </div>
    </>
  );
}

export function StructureConstraintOverlay({
  repository,
  currentPhage,
}: StructureConstraintOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('rna');

  // Toggle states for element types
  const [showRBS, setShowRBS] = useState(true);
  const [showTerminators, setShowTerminators] = useState(true);
  const [showStemLoops, setShowStemLoops] = useState(true);
  const [showEnergy, setShowEnergy] = useState(true);

  // Hover state
  const [hoverInfo, setHoverInfo] = useState<GenomeTrackInteraction | null>(null);

  // Hotkey to toggle overlay (Alt+R)
  useHotkey(
    { key: 'r', modifiers: { alt: true } },
    'Structure Constraints (RNA + capsid/tail proteins)',
    () => toggle('structureConstraint'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'power' }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('structureConstraint')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    // Check cache first
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

  // Detect RNA structural elements
  const analysis = useMemo(() => {
    if (viewMode !== 'rna') return null;
    if (!sequence || sequence.length < 100) return null;

    const rbs = findRBS(sequence);
    const terminators = findTerminators(sequence);
    const stemloops = findStemLoops(sequence);
    const energyLandscape = computeEnergyLandscape(sequence);

    return {
      rbs,
      terminators,
      stemloops,
      energyLandscape,
      total: rbs.length + terminators.length + stemloops.length,
    };
  }, [sequence, viewMode]);

  const proteinReport = useMemo(() => {
    if (viewMode !== 'protein') return null;
    if (!sequence || !currentPhage) return null;
    return analyzeStructuralConstraints(sequence, currentPhage.genes ?? []);
  }, [viewMode, sequence, currentPhage]);

  const sortedProteins = useMemo(() => {
    if (!proteinReport) return [];
    return [...proteinReport.proteins].sort((a, b) => b.avgFragility - a.avgFragility);
  }, [proteinReport]);

  const [selectedProteinId, setSelectedProteinId] = useState<number | null>(null);
  const [mutationPosition, setMutationPosition] = useState<number | null>(null);
  const [mutationTarget, setMutationTarget] = useState<AminoAcid>('W');

  useEffect(() => {
    if (viewMode !== 'protein') return;
    if (!sortedProteins.length) return;

    const selected = selectedProteinId ? sortedProteins.find(p => p.geneId === selectedProteinId) : null;
    if (!selected) {
      const top = sortedProteins[0];
      setSelectedProteinId(top.geneId);
      setMutationPosition(top.hotspots[0]?.position ?? 0);
      return;
    }

    if (mutationPosition === null) {
      setMutationPosition(selected.hotspots[0]?.position ?? 0);
    }
  }, [viewMode, sortedProteins, selectedProteinId, mutationPosition]);

  const selectedProtein = useMemo(() => {
    if (!sortedProteins.length) return null;
    if (selectedProteinId === null) return sortedProteins[0] ?? null;
    return sortedProteins.find(p => p.geneId === selectedProteinId) ?? null;
  }, [sortedProteins, selectedProteinId]);

  const mutationResidue = useMemo(() => {
    if (!selectedProtein || mutationPosition === null) return null;
    return selectedProtein.residues.find(r => r.position === mutationPosition) ?? null;
  }, [selectedProtein, mutationPosition]);

  const mutationEffect = useMemo(() => {
    if (!mutationResidue) return null;
    return predictMutationEffect(mutationResidue.aa, mutationTarget, mutationResidue.fragility);
  }, [mutationResidue, mutationTarget]);

  // Build track segments
  const rbsSegments = useMemo(() => {
    if (!analysis || !showRBS) return [];
    return elementsToSegments(analysis.rbs, 'rbs', '#22c55e'); // Green
  }, [analysis, showRBS]);

  const terminatorSegments = useMemo(() => {
    if (!analysis || !showTerminators) return [];
    return elementsToSegments(analysis.terminators, 'terminator', '#ef4444'); // Red
  }, [analysis, showTerminators]);

  const stemLoopSegments = useMemo(() => {
    if (!analysis || !showStemLoops) return [];
    return elementsToSegments(analysis.stemloops, 'stemloop', '#8b5cf6'); // Purple
  }, [analysis, showStemLoops]);

  // Energy landscape as segments (for mini visualization)
  const energySegments = useMemo((): GenomeTrackSegment[] => {
    if (!analysis || !showEnergy) return [];

    const minEnergy = Math.min(...analysis.energyLandscape.map(e => e.energy));
    const maxEnergy = Math.max(...analysis.energyLandscape.map(e => e.energy));
    const range = maxEnergy - minEnergy || 1;

    return analysis.energyLandscape.map((point) => {
      const normalized = (point.energy - minEnergy) / range;
      // More negative (stable) = darker blue
      const intensity = 1 - normalized;
      return {
        start: point.position - 25,
        end: point.position + 25,
        color: `rgba(59, 130, 246, ${0.2 + intensity * 0.8})`,
        height: 8 + intensity * 8,
        data: { energy: point.energy, position: point.position },
      };
    });
  }, [analysis, showEnergy]);

  // Handle hover
  const handleHover = useCallback((info: GenomeTrackInteraction | null) => {
    setHoverInfo(info);
  }, []);

  if (!isOpen('structureConstraint')) return null;

  return (
    <Overlay id="structureConstraint" title="STRUCTURE CONSTRAINTS" hotkey="Alt+R" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* View switcher */}
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setViewMode('rna')}
            style={{
              padding: '0.35rem 0.6rem',
              borderRadius: '6px',
              border: `1px solid ${viewMode === 'rna' ? colors.accent : colors.borderLight}`,
              background: viewMode === 'rna' ? colors.backgroundAlt : colors.background,
              color: viewMode === 'rna' ? colors.accent : colors.text,
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
            aria-pressed={viewMode === 'rna'}
          >
            RNA signals
          </button>
          <button
            type="button"
            onClick={() => setViewMode('protein')}
            style={{
              padding: '0.35rem 0.6rem',
              borderRadius: '6px',
              border: `1px solid ${viewMode === 'protein' ? colors.accent : colors.borderLight}`,
              background: viewMode === 'protein' ? colors.backgroundAlt : colors.background,
              color: viewMode === 'protein' ? colors.accent : colors.text,
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
            aria-pressed={viewMode === 'protein'}
          >
            Capsid/tail constraints
          </button>
          {viewMode === 'protein' ? (
            <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
              {proteinReport?.proteins.length ?? 0} structural proteins
            </div>
          ) : (
            <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
              {analysis?.total ?? 0} RNA elements
            </div>
          )}
        </div>

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
          {viewMode === 'protein' ? (
            <>
              <strong style={{ color: colors.accent }}>Capsid/tail constraints</strong>: Heuristic
              fragility scan for structural proteins (high = likely buried/bulky positions that are
              more mutation-sensitive). This is a fast proxy, not a real contact map or ΔΔG model.
            </>
          ) : (
            <>
              <strong style={{ color: colors.accent }}>RNA signals</strong>: Detects ribosome
              binding sites (Shine-Dalgarno), transcription terminators (stem-loop + U-tract),
              and potential secondary structures affecting gene expression.
            </>
          )}
        </div>

        {loading ? (
          <AnalysisPanelSkeleton />
        ) : !sequence ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            No sequence loaded
          </div>
        ) : viewMode === 'rna' && !analysis ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            Sequence too short for analysis
          </div>
        ) : (
          <>
            {viewMode === 'protein' ? (
              <>
                {!proteinReport || sortedProteins.length === 0 ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
                    No capsid/tail proteins detected (requires gene annotations with structural product names).
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    {/* Protein list */}
                    <div style={{ minWidth: 240, flex: '0 0 240px' }}>
                      <div style={{ fontSize: '0.75rem', color: colors.textDim, marginBottom: '0.5rem' }}>
                        Proteins (sorted by avg fragility)
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {sortedProteins.map((p) => (
                          <button
                            key={p.geneId}
                            type="button"
                            onClick={() => {
                              setSelectedProteinId(p.geneId);
                              setMutationPosition(p.hotspots[0]?.position ?? 0);
                            }}
                            style={{
                              textAlign: 'left',
                              padding: '0.5rem',
                              borderRadius: '6px',
                              border: `1px solid ${selectedProtein?.geneId === p.geneId ? colors.accent : colors.borderLight}`,
                              background: selectedProtein?.geneId === p.geneId ? colors.backgroundAlt : colors.background,
                              color: colors.text,
                              cursor: 'pointer',
                            }}
                          >
                            <div style={{ fontSize: '0.8rem', fontWeight: 700 }}>
                              {p.name}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>
                              {p.role}{p.locusTag ? ` • ${p.locusTag}` : ''} • {(p.avgFragility * 100).toFixed(1)}%
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Detail panel */}
                    <div style={{ flex: '1 1 420px', minWidth: 320 }}>
                      {selectedProtein ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: colors.text }}>
                              {selectedProtein.name}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                              Role: {selectedProtein.role}{selectedProtein.locusTag ? ` • ${selectedProtein.locusTag}` : ''} • Avg fragility {(selectedProtein.avgFragility * 100).toFixed(1)}%
                            </div>
                            <div style={{ fontSize: '0.75rem', color: colors.textDim }}>
                              Fragility: ░ robust → █ fragile
                            </div>
                          </div>

                          <div style={{ padding: '0.6rem', borderRadius: '6px', border: `1px solid ${colors.borderLight}`, background: colors.backgroundAlt }}>
                            <div style={{ fontSize: '0.75rem', color: colors.textDim, marginBottom: '0.35rem' }}>
                              Heat strip (first 140 aa)
                            </div>
                            <pre
                              style={{
                                margin: 0,
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                                fontSize: '0.72rem',
                                lineHeight: 1.1,
                                color: colors.text,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                              }}
                            >
                              {selectedProtein.residues.slice(0, 140).map(r => fragilityBlock(r.fragility)).join('')}
                              {selectedProtein.residues.length > 140 ? '…' : ''}
                            </pre>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: colors.text }}>
                              Hotspots
                            </div>
                            {selectedProtein.hotspots.length === 0 ? (
                              <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>None detected</div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                {selectedProtein.hotspots.slice(0, 5).map((h) => (
                                  <div
                                    key={`${selectedProtein.geneId}-${h.position}`}
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      gap: '0.75rem',
                                      padding: '0.45rem 0.5rem',
                                      borderRadius: '6px',
                                      border: `1px solid ${colors.borderLight}`,
                                      background: colors.backgroundAlt,
                                      fontSize: '0.75rem',
                                      color: colors.text,
                                    }}
                                  >
                                    <div>
                                      <span style={{ fontWeight: 800 }}>{h.position + 1}</span>{' '}
                                      <span style={{ color: colors.textMuted }}>({h.aa})</span>{' '}
                                      <span style={{ color: colors.textDim }}>{h.warnings.length ? `• ${h.warnings.join(', ')}` : ''}</span>
                                    </div>
                                    <div style={{ color: colors.textMuted }}>{(h.fragility * 100).toFixed(1)}%</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div style={{ padding: '0.6rem', borderRadius: '6px', border: `1px solid ${colors.borderLight}`, background: colors.backgroundAlt }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: colors.text, marginBottom: '0.35rem' }}>
                              Mutation sandbox (heuristic)
                            </div>
                            {!mutationResidue ? (
                              <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                                Select a protein and residue.
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                  <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', fontSize: '0.75rem', color: colors.textMuted }}>
                                    Position
                                    <select
                                      value={mutationPosition ?? 0}
                                      onChange={(e) => setMutationPosition(Number(e.target.value))}
                                      style={{ background: colors.background, color: colors.text, border: `1px solid ${colors.borderLight}`, borderRadius: '6px', padding: '0.2rem 0.35rem' }}
                                    >
                                      {selectedProtein.residues
                                        .filter(r => r.position % 5 === 0)
                                        .slice(0, 120)
                                        .map(r => (
                                          <option key={r.position} value={r.position}>
                                            {r.position + 1} ({r.aa})
                                          </option>
                                        ))}
                                    </select>
                                  </label>

                                  <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', fontSize: '0.75rem', color: colors.textMuted }}>
                                    Mutate to
                                    <select
                                      value={mutationTarget}
                                      onChange={(e) => setMutationTarget(e.target.value as AminoAcid)}
                                      style={{ background: colors.background, color: colors.text, border: `1px solid ${colors.borderLight}`, borderRadius: '6px', padding: '0.2rem 0.35rem' }}
                                    >
                                      {AMINO_ACIDS.map(aa => (
                                        <option key={aa} value={aa}>
                                          {aa}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </div>

                                {mutationEffect ? (
                                  <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                                    Δstability {(mutationEffect.deltaStability * 100).toFixed(0)}% • contact penalty {(mutationEffect.contactPenalty * 100).toFixed(0)}% • volume change {(mutationEffect.volumeChange * 100).toFixed(0)}% •{' '}
                                    <span style={{ color: mutationEffect.allowed ? '#22c55e' : '#ef4444', fontWeight: 800 }}>
                                      {mutationEffect.allowed ? 'allowed-ish' : 'risky'}
                                    </span>
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Toggle controls */}
                <div
                  style={{
                    display: 'flex',
                    gap: '1rem',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}>
                    <input
                      type="checkbox"
                      checked={showRBS}
                      onChange={(e) => setShowRBS(e.target.checked)}
                    />
                    <span style={{ color: '#22c55e' }}>RBS</span>
                    <span style={{ color: colors.textMuted }}>({analysis ? analysis.rbs.length : 0})</span>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}>
                    <input
                      type="checkbox"
                      checked={showTerminators}
                      onChange={(e) => setShowTerminators(e.target.checked)}
                    />
                    <span style={{ color: '#ef4444' }}>Terminators</span>
                    <span style={{ color: colors.textMuted }}>({analysis ? analysis.terminators.length : 0})</span>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}>
                    <input
                      type="checkbox"
                      checked={showStemLoops}
                      onChange={(e) => setShowStemLoops(e.target.checked)}
                    />
                    <span style={{ color: '#8b5cf6' }}>Stem-Loops</span>
                    <span style={{ color: colors.textMuted }}>({analysis ? analysis.stemloops.length : 0})</span>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}>
                    <input
                      type="checkbox"
                      checked={showEnergy}
                      onChange={(e) => setShowEnergy(e.target.checked)}
                    />
                    <span style={{ color: '#3b82f6' }}>Energy Landscape</span>
                  </label>
                </div>

                {/* Track visualizations */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                    position: 'relative',
                  }}
                >
                  {/* RBS track */}
                  {showRBS && (
                    <div>
                      <div style={{ fontSize: '0.7rem', color: '#22c55e', marginBottom: '0.25rem' }}>
                        Ribosome Binding Sites (Shine-Dalgarno)
                      </div>
                      <GenomeTrack
                        genomeLength={sequence.length}
                        segments={rbsSegments}
                        width={520}
                        height={35}
                        onHover={handleHover}
                        ariaLabel="RBS predictions track"
                      />
                    </div>
                  )}

                  {/* Terminator track */}
                  {showTerminators && (
                    <div>
                      <div style={{ fontSize: '0.7rem', color: '#ef4444', marginBottom: '0.25rem' }}>
                        Transcription Terminators
                      </div>
                      <GenomeTrack
                        genomeLength={sequence.length}
                        segments={terminatorSegments}
                        width={520}
                        height={35}
                        onHover={handleHover}
                        ariaLabel="Terminator predictions track"
                      />
                    </div>
                  )}

                  {/* Stem-loop track */}
                  {showStemLoops && (
                    <div>
                      <div style={{ fontSize: '0.7rem', color: '#8b5cf6', marginBottom: '0.25rem' }}>
                        Potential Stem-Loop Structures
                      </div>
                      <GenomeTrack
                        genomeLength={sequence.length}
                        segments={stemLoopSegments}
                        width={520}
                        height={35}
                        onHover={handleHover}
                        ariaLabel="Stem-loop predictions track"
                      />
                    </div>
                  )}

                  {/* Energy landscape track */}
                  {showEnergy && (
                    <div>
                      <div style={{ fontSize: '0.7rem', color: '#3b82f6', marginBottom: '0.25rem' }}>
                        Folding Energy Landscape (darker = more stable)
                      </div>
                      <GenomeTrack
                        genomeLength={sequence.length}
                        segments={energySegments}
                        width={520}
                        height={35}
                        onHover={handleHover}
                        ariaLabel="RNA folding energy landscape"
                      />
                    </div>
                  )}

                  {/* Hover tooltip */}
                  {hoverInfo?.segment?.data ? (() => {
                    const data = hoverInfo.segment.data;
                    if (typeof data === 'object' && data !== null && 'type' in data) {
                      const element = data as RNAElement;
                      return (
                        <div
                          style={{
                            position: 'absolute',
                            left: Math.min(hoverInfo.clientX - 280, 250),
                            top: 0,
                            backgroundColor: colors.backgroundAlt,
                            border: `1px solid ${colors.borderLight}`,
                            borderRadius: '4px',
                            padding: '0.5rem',
                            fontSize: '0.75rem',
                            color: colors.text,
                            pointerEvents: 'none',
                            zIndex: 10,
                            maxWidth: '250px',
                          }}
                        >
                          <ElementTooltip element={element} colors={colors} />
                        </div>
                      );
                    } else if (typeof data === 'object' && data !== null && 'energy' in data) {
                      const energyData = data as { energy: number; position: number };
                      return (
                        <div
                          style={{
                            position: 'absolute',
                            left: Math.min(hoverInfo.clientX - 280, 300),
                            top: 0,
                            backgroundColor: colors.backgroundAlt,
                            border: `1px solid ${colors.borderLight}`,
                            borderRadius: '4px',
                            padding: '0.5rem',
                            fontSize: '0.75rem',
                            color: colors.text,
                            pointerEvents: 'none',
                            zIndex: 10,
                          }}
                        >
                          <div style={{ fontWeight: 'bold' }}>Folding Energy</div>
                          <div style={{ color: colors.textMuted }}>
                            Position: {energyData.position.toLocaleString()} bp
                          </div>
                          <div style={{ color: colors.textMuted }}>
                            Relative ΔG: {energyData.energy.toFixed(1)} (arbitrary units)
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })() : null}
                </div>

                {/* Summary stats */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '0.5rem',
                    fontSize: '0.75rem',
                  }}
                >
                  <div
                    style={{
                      padding: '0.5rem',
                      backgroundColor: colors.backgroundAlt,
                      borderRadius: '4px',
                      borderLeft: '3px solid #22c55e',
                    }}
                  >
                    <div style={{ color: '#22c55e', fontWeight: 'bold' }}>RBS Sites</div>
                    <div style={{ color: colors.textMuted }}>
                      {analysis ? analysis.rbs.length : 0} found
                      {analysis && analysis.rbs.length > 0 && (
                        <span> (avg score: {(analysis.rbs.reduce((a, b) => a + b.score, 0) / analysis.rbs.length).toFixed(0)})</span>
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      padding: '0.5rem',
                      backgroundColor: colors.backgroundAlt,
                      borderRadius: '4px',
                      borderLeft: '3px solid #ef4444',
                    }}
                  >
                    <div style={{ color: '#ef4444', fontWeight: 'bold' }}>Terminators</div>
                    <div style={{ color: colors.textMuted }}>
                      {analysis ? analysis.terminators.length : 0} found
                    </div>
                  </div>

                  <div
                    style={{
                      padding: '0.5rem',
                      backgroundColor: colors.backgroundAlt,
                      borderRadius: '4px',
                      borderLeft: '3px solid #8b5cf6',
                    }}
                  >
                    <div style={{ color: '#8b5cf6', fontWeight: 'bold' }}>Stem-Loops</div>
                    <div style={{ color: colors.textMuted }}>
                      {analysis ? analysis.stemloops.length : 0} found
                    </div>
                  </div>
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
                  <strong>Interpretation:</strong>{' '}
                  <span style={{ color: '#22c55e' }}>RBS</span> sites mark translation initiation.{' '}
                  <span style={{ color: '#ef4444' }}>Terminators</span> end transcription.{' '}
                  <span style={{ color: '#8b5cf6' }}>Stem-loops</span> may be regulatory elements.{' '}
                  <span style={{ color: '#3b82f6' }}>Darker regions</span> indicate more stable RNA structures.
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Overlay>
  );
}

export default StructureConstraintOverlay;
