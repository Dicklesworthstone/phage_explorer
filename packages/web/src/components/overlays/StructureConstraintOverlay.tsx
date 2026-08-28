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
  analyzeRNAStructure,
  predictMutationEffect,
  reverseComplement,
  type AminoAcid,
  type PhageFull,
  type RegulatoryHypothesis,
} from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  OverlayLoadingState,
  OverlayEmptyState,
} from './primitives';
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
  const [strand, setStrand] = useState<'+' | '-'>('+');

  // Toggle states for element types
  const [showRBS, setShowRBS] = useState(true);
  const [showTerminators, setShowTerminators] = useState(true);
  const [showStemLoops, setShowStemLoops] = useState(true);
  const [showEnergy, setShowEnergy] = useState(true);

  // Hover state
  const [hoverInfo, setHoverInfo] = useState<GenomeTrackInteraction | null>(null);

  // Hotkey to toggle overlay (Alt+Shift+R)
  useHotkey(
    ActionIds.OverlayStructureConstraint,
    () => toggle('structureConstraint'),
    { modes: ['NORMAL'] }
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

    let cancelled = false;
    setLoading(true);
    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        if (cancelled) return;
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => {
        if (cancelled) return;
        setSequence('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Detect RNA structural elements using shared core logic
  const analysis = useMemo(() => {
    if (viewMode !== 'rna') return null;
    if (!sequence || sequence.length < 100) return null;

    const len = sequence.length;
    // Map strand coordinates for analysis if needed (core handles analysis on provided string)
    // If strand is '-', we pass RC sequence to core.
    const targetSeq = strand === '+' ? sequence : reverseComplement(sequence);

    // Use core analysis which includes RBS, Terminators, and Stem-loops
    const result = analyzeRNAStructure(targetSeq);

    const mapHypothesis = (h: RegulatoryHypothesis): RNAElement => {
      // Map core types to UI types
      let type: ElementType = 'stemloop';
      if (h.type === 'rbs') type = 'rbs';
      if (h.type === 'terminator') type = 'terminator';
      
      // Map coordinates back to forward strand if needed
      let start = h.start;
      let end = h.end;
      
      if (strand === '-') {
        // [s, e) in RC -> [len - e, len - s) in FWD
        const origStart = start;
        start = len - end;
        end = len - origStart;
      }

      return {
        type,
        start,
        end,
        score: h.confidence * 100,
        sequence: h.sequence,
        details: h.description,
      };
    };

    const rbs = result.regulatoryHypotheses
      .filter(h => h.type === 'rbs')
      .map(mapHypothesis);

    const terminators = result.regulatoryHypotheses
      .filter(h => h.type === 'terminator')
      .map(mapHypothesis);

    const stemloops = result.regulatoryHypotheses
      .filter(h => h.type === 'stem-loop')
      .map(mapHypothesis);

    const energyLandscape = result.windows.map(w => ({
      position: strand === '+' ? (w.start + w.end) / 2 : len - (w.start + w.end) / 2,
      energy: w.mfe,
    }));

    return {
      rbs,
      terminators,
      stemloops,
      energyLandscape,
      total: rbs.length + terminators.length + stemloops.length,
    };
  }, [sequence, viewMode, strand]);

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
    <Overlay id="structureConstraint" title="STRUCTURE CONSTRAINTS" hotkey="Alt+Shift+R" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* View switcher */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
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
          </div>

          {viewMode === 'rna' && (
            <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', background: colors.background, padding: '0.2rem', borderRadius: '4px', border: `1px solid ${colors.borderLight}` }}>
              <button
                type="button"
                onClick={() => setStrand('+')}
                style={{
                  padding: '0.2rem 0.6rem',
                  borderRadius: '3px',
                  background: strand === '+' ? colors.accent : 'transparent',
                  color: strand === '+' ? colors.background : colors.textMuted,
                  border: 'none',
                  fontSize: '0.75rem',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                }}
              >
                + Strand
              </button>
              <button
                type="button"
                onClick={() => setStrand('-')}
                style={{
                  padding: '0.2rem 0.6rem',
                  borderRadius: '3px',
                  background: strand === '-' ? colors.accent : 'transparent',
                  color: strand === '-' ? colors.background : colors.textMuted,
                  border: 'none',
                  fontSize: '0.75rem',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                }}
              >
                - Strand
              </button>
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
          <OverlayLoadingState message="Loading sequence for structure analysis...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : !sequence ? (
          <OverlayEmptyState
            message="No sequence loaded"
            hint={!currentPhage ? 'Select a phage to analyze structure constraints.' : 'Unable to load sequence data.'}
          />
        ) : viewMode === 'rna' && !analysis ? (
          <OverlayEmptyState
            message="Sequence too short for analysis"
            hint="RNA structure analysis requires sufficient sequence length."
          />
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
