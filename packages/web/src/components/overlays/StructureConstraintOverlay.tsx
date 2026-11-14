/**
 * StructureConstraintOverlay - Structure Constraints
 *
 * Two views:
 * - RNA signals: detects ribosome binding sites (RBS), transcription terminators,
 *   and bounded maximum-pairing windows in an explicitly selected interval.
 * - Protein constraints: heuristic fragility scan for capsid/tail proteins
 *   (fast, no-dependency; not a substitute for real structural models).
 */

import React, { useMemo, useState, useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  analyzeStructuralConstraints,
  serializeAnalysisRecord,
  RNA_STRUCTURE_LIMITS,
  predictMutationEffect,
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
  OverlayErrorState,
} from './primitives';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment, GenomeTrackInteraction } from './primitives/types';
import { RNAStructureSession, parseRNAInterval, mapRNAInterval, type RNAStructureRequest } from '../../workers/RNAStructureSession';
import { downloadString } from '../../utils/export';

type ViewMode = 'rna' | 'protein';

// RNA element types
type ElementType = 'rbs' | 'terminator' | 'paired-window';

interface RNAElement {
  type: ElementType;
  start: number;
  end: number;
  score: number | null;
  sequence: string;
  details: string;
  structure?: string;
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
  color: string,
  offset: number
): GenomeTrackSegment[] {
  return elements
    .filter(e => e.type === type)
    .map(e => ({
      start: e.start - offset,
      end: e.end - offset,
      color,
      height: 10,
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
    'paired-window': 'Independently Folded Window',
  };

  return (
    <>
      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
        {typeLabels[element.type]}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        {(element.start + 1).toLocaleString()}–{element.end.toLocaleString()} bp (inclusive)
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        {element.type === 'paired-window' ? 'One exact maximum-pairing solution; no thermodynamic interpretation.' : 'Sequence-pattern candidate; confidence is not calibrated.'}
      </div>
      <div style={{ marginTop: '0.25rem', color: colors.textDim, fontSize: '0.65rem' }}>
        {element.details}
      </div>
      <div style={{ marginTop: '0.25rem', fontFamily: 'monospace', fontSize: '0.55rem', color: colors.text, wordBreak: 'break-all' }}>
        {element.sequence.slice(0, 35)}{element.sequence.length > 35 ? '...' : ''}
      </div>
      {element.structure && <pre style={{ marginTop: '.25rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '.6rem' }}>
        {element.structure}
      </pre>}
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
  const isActive = isOpen('structureConstraint');
  const [loaded, setLoaded] = useState<{ repository: PhageRepository; phage: PhageFull; sequence: string } | null>(null);
  const sequence = loaded?.repository === repository && loaded?.phage === currentPhage ? loaded.sequence : '';
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('rna');
  const [strand, setStrand] = useState<'+' | '-'>('+');

  // Toggle states for element types
  const [showRBS, setShowRBS] = useState(true);
  const [showTerminators, setShowTerminators] = useState(true);
  const [showStemLoops, setShowStemLoops] = useState(true);
  const [showEnergy, setShowEnergy] = useState(true);

  // Hover state
  const [hoverState, setHoverState] = useState<{ request: RNAStructureRequest; info: GenomeTrackInteraction } | null>(null);

  // Hotkey to toggle overlay (Alt+Shift+R)
  useHotkey(
    ActionIds.OverlayStructureConstraint,
    () => toggle('structureConstraint'),
    { modes: ['NORMAL'] }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isActive) return;
    setLoaded(null);
    setError(null);
    setHoverState(null);
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
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isActive, repository, currentPhage]);

  const [rangeDraft, setRangeDraft] = useState<{ input: object; start: string; end: string } | null>(null);
  const [rangeSelection, setRangeSelection] = useState<{ input: object; start: number; end: number } | null>(null);
  const [rangeError, setRangeError] = useState<{ input: object; message: string } | null>(null);
  const rangeStart = rangeDraft?.input === loaded ? rangeDraft.start : '1';
  const rangeEnd = rangeDraft?.input === loaded ? rangeDraft.end : String(Math.min(sequence.length, 600));
  const rnaRequest = useMemo<RNAStructureRequest | null>(() => {
    if (!isActive || viewMode !== 'rna' || !sequence || !loaded || !currentPhage) return null;
    const interval = rangeSelection?.input === loaded ? rangeSelection : { start: 0, end: Math.min(sequence.length, 600) };
    return { sequence: sequence.slice(interval.start, interval.end),
      source: { name: currentPhage.name, accession: currentPhage.accession || null,
        source: currentPhage.localGenome ? 'local' : 'catalog', coordinateSystem: 'genome-forward',
        sourceLength: sequence.length, start: interval.start, end: interval.end, strand, gene: null },
      options: { windowSize: Math.min(120, interval.end - interval.start), stepSize: Math.min(30, interval.end - interval.start),
        frame: 0, includeSynonymousStress: false, minLoopSize: 3, allowWobble: true } };
  }, [isActive, viewMode, sequence, loaded, currentPhage, rangeSelection, strand]);
  const rnaSession = useMemo(() => new RNAStructureSession(() =>
    new Worker(new URL('../../workers/rna-structure.worker.ts', import.meta.url), { type: 'module' })), []);
  const rnaSnapshot = useSyncExternalStore(rnaSession.subscribe, rnaSession.getSnapshot, rnaSession.getSnapshot);
  useEffect(() => { if (isActive) rnaSession.activate(); else rnaSession.deactivate(); return rnaSession.deactivate; }, [isActive, rnaSession]);
  useEffect(() => { if (rnaRequest) void rnaSession.run(rnaRequest); else rnaSession.cancel(); return rnaSession.cancel; }, [rnaRequest, rnaSession]);
  const rnaState = rnaSnapshot.input === rnaRequest ? rnaSnapshot : null;
  const acceptedRNA = rnaState?.accepted ?? null;
  const rnaBusy = !!rnaState?.busy || !!rnaRequest && rnaSnapshot.input !== rnaRequest;
  const hoverInfo = hoverState?.request === rnaRequest ? hoverState.info : null;
  const submitInterval = (event: React.FormEvent) => {
    event.preventDefault(); if (!loaded || !sequence) return;
    try {
      const interval = parseRNAInterval(rangeStart, rangeEnd, sequence.length);
      setRangeError(null); setRangeSelection({ input: loaded, ...interval });
    } catch (cause) { setRangeError({ input: loaded, message: cause instanceof Error ? cause.message : String(cause) }); }
  };
  const exportRNA = () => {
    if (!acceptedRNA || !loaded) return;
    try { downloadString(serializeAnalysisRecord(acceptedRNA.record), 'rna-signals-analysis.json', 'application/json'); }
    catch (cause) { setRangeError({ input: loaded, message: cause instanceof Error ? cause.message : String(cause) }); }
  };

  // Only coordinate projection occurs during rendering; the owned worker computes all RNA results.
  const analysis = useMemo(() => {
    if (!acceptedRNA || !rnaRequest) return null;
    const result = acceptedRNA.analysis, source = rnaState!.request!.source;
    const mapHypothesis = (hypothesis: RegulatoryHypothesis): RNAElement => ({
      type: hypothesis.type === 'rbs' ? 'rbs' : 'terminator',
      ...mapRNAInterval(source, hypothesis.start, hypothesis.end), score: null,
      sequence: hypothesis.sequence, details: hypothesis.description,
    });
    const rbs = result.regulatoryHypotheses.filter(item => item.type === 'rbs').map(mapHypothesis);
    const terminators = result.regulatoryHypotheses.filter(item => item.type === 'terminator').map(mapHypothesis);
    const pairedWindows: RNAElement[] = result.windows.filter(window => window.pairCount > 0).map(window => ({
      type: 'paired-window', ...mapRNAInterval(source, window.start, window.end), score: null,
      sequence: window.sequence, structure: window.structure,
      details: window.pairCount + ' noncrossing pairs in this independent window; dot-bracket is in the selected strand direction.',
    }));
    const energyLandscape = result.windows.map(window => {
      const interval = mapRNAInterval(source, window.start, window.end);
      return { ...interval, position: (interval.start + interval.end) / 2, energy: -window.pairCount };
    });
    return { rbs, terminators, pairedWindows, energyLandscape, offset: source.start, length: source.end - source.start,
      total: rbs.length + terminators.length + pairedWindows.length };
  }, [acceptedRNA, rnaRequest, rnaState]);

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
    return elementsToSegments(analysis.rbs, 'rbs', '#22c55e', analysis.offset); // Green
  }, [analysis, showRBS]);

  const terminatorSegments = useMemo(() => {
    if (!analysis || !showTerminators) return [];
    return elementsToSegments(analysis.terminators, 'terminator', '#ef4444', analysis.offset); // Red
  }, [analysis, showTerminators]);

  const stemLoopSegments = useMemo(() => {
    if (!analysis || !showStemLoops) return [];
    return elementsToSegments(analysis.pairedWindows, 'paired-window', '#8b5cf6', analysis.offset); // Purple
  }, [analysis, showStemLoops]);

  // Energy landscape as segments (for mini visualization)
  const energySegments = useMemo((): GenomeTrackSegment[] => {
    if (!analysis || !showEnergy) return [];

    const minEnergy = Math.min(...analysis.energyLandscape.map(e => e.energy));
    const maxEnergy = Math.max(...analysis.energyLandscape.map(e => e.energy));
    const range = maxEnergy - minEnergy || 1;

    return analysis.energyLandscape.map((point) => {
      const normalized = (point.energy - minEnergy) / range;
      // More pairs in this window = darker blue.
      const intensity = 1 - normalized;
      return {
        start: point.start - analysis.offset,
        end: point.end - analysis.offset,
        color: `rgba(59, 130, 246, ${0.2 + intensity * 0.8})`,
        height: 8 + intensity * 8,
        data: { energy: point.energy, position: point.position },
      };
    });
  }, [analysis, showEnergy]);

  // Handle hover
  const handleHover = useCallback((info: GenomeTrackInteraction | null) => {
    setHoverState(info && rnaRequest ? { request: rnaRequest, info } : null);
  }, [rnaRequest]);

  if (!isActive) return null;

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
              <strong style={{ color: colors.accent }}>RNA signals</strong>: Inspect sequence-pattern
              candidates and exact noncrossing maximum-pairing windows in the selected interval.
              Windows are folded independently, not as one consistent whole-genome structure.
              Pair counts and motif observations do not establish free energy or regulatory function.
            </>
          )}
        </div>

        {viewMode === 'rna' && !!sequence && loaded && <form onSubmit={submitInterval} aria-label="RNA signals interval controls">
          <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <label>Start (1-based) <input aria-label="RNA signals interval start" inputMode="numeric" value={rangeStart}
              onChange={event => setRangeDraft({ input: loaded, start: event.target.value, end: rangeEnd })} style={{ width: 100 }} /></label>
            <label>End (inclusive) <input aria-label="RNA signals interval end" inputMode="numeric" value={rangeEnd}
              onChange={event => setRangeDraft({ input: loaded, start: rangeStart, end: event.target.value })} style={{ width: 100 }} /></label>
            <button type="submit">Analyze RNA interval</button>
            <button type="button" disabled={!rnaBusy} onClick={rnaSession.cancel}>Cancel RNA analysis</button>
            <button type="button" disabled={!acceptedRNA || rnaBusy} onClick={exportRNA}>Export RNA analysis</button>
          </div>
          <p style={{ color: colors.textMuted, fontSize: '.8rem' }}>
            Both endpoints are included and refer to forward genomic coordinates on either strand.
            Initially analyze the first {Math.min(sequence.length, 600)} of {sequence.length.toLocaleString()} bases;
            select up to {RNA_STRUCTURE_LIMITS.sequenceBases.toLocaleString()} bases.
            Draft edits do not relabel accepted results.
          </p>
          {rangeError?.input === loaded && <OverlayErrorState message="Invalid RNA interval" details={rangeError.message} />}
        </form>}
        {viewMode === 'rna' && acceptedRNA && rnaRequest && <p data-testid="rna-signals-accepted-interval" style={{ color: colors.textDim }}>
          Analyzed {rnaState!.request!.source.start + 1}–{rnaState!.request!.source.end} on the {rnaState!.request!.source.strand} strand.
          Tracks show offsets within this interval; tooltips show original genomic coordinates.
          Window {acceptedRNA.analysis.parameters.windowSize}, step {acceptedRNA.analysis.parameters.stepSize}; score = minus pair count.
          Synonymous scores require a coding gene and are not inferred from a genomic frame.
        </p>}

        {loading || rnaBusy ? (
          <OverlayLoadingState message="Loading sequence for structure analysis...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : error ? (
          <OverlayErrorState message="Could not load sequence" details={error} />
        ) : viewMode === 'rna' && rnaState?.error ? (
          <OverlayErrorState message="RNA analysis unavailable" details={rnaState.error} />
        ) : !sequence ? (
          <OverlayEmptyState
            message="No sequence loaded"
            hint={!currentPhage ? 'Select a phage to analyze structure constraints.' : 'Unable to load sequence data.'}
          />
        ) : viewMode === 'rna' && !analysis ? (
          <OverlayEmptyState
            message={rnaState?.cancelled ? "RNA analysis cancelled" : "No RNA interval result"}
            hint="Choose Analyze RNA interval to compute a bounded result."
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
                    <span style={{ color: '#8b5cf6' }}>Paired Windows</span>
                    <span style={{ color: colors.textMuted }}>({analysis ? analysis.pairedWindows.length : 0})</span>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}>
                    <input
                      type="checkbox"
                      checked={showEnergy}
                      onChange={(e) => setShowEnergy(e.target.checked)}
                    />
                    {/* Unitless maximum-pairing objective, not a thermodynamic energy. */}
                    <span style={{ color: '#3b82f6' }}>Pairing Landscape</span>
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
                        genomeLength={analysis?.length ?? 1}
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
                        genomeLength={analysis?.length ?? 1}
                        segments={terminatorSegments}
                        width={520}
                        height={35}
                        onHover={handleHover}
                        ariaLabel="Terminator predictions track"
                      />
                    </div>
                  )}

                  {/* Independently folded windows */}
                  {showStemLoops && (
                    <div>
                      <div style={{ fontSize: '0.7rem', color: '#8b5cf6', marginBottom: '0.25rem' }}>
                        Windows with Noncrossing Base Pairs
                      </div>
                      <GenomeTrack
                        genomeLength={analysis?.length ?? 1}
                        segments={stemLoopSegments}
                        width={520}
                        height={35}
                        onHover={handleHover}
                        ariaLabel="Independent RNA pairing windows"
                      />
                    </div>
                  )}

                  {/* Energy landscape track */}
                  {showEnergy && (
                    <div>
                      <div style={{ fontSize: '0.7rem', color: '#3b82f6', marginBottom: '0.25rem' }}>
                        Maximum-pairing Landscape (darker = more pairs)
                      </div>
                      <GenomeTrack
                        genomeLength={analysis?.length ?? 1}
                        segments={energySegments}
                        width={520}
                        height={35}
                        onHover={handleHover}
                        ariaLabel="RNA base-pairing landscape"
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
                          <div style={{ fontWeight: 'bold' }}>Maximum-pairing score</div>
                          <div style={{ color: colors.textMuted }}>
                            Window center: {(energyData.position + 0.5).toLocaleString()} bp
                          </div>
                          <div style={{ color: colors.textMuted }}>
                            Score: {energyData.energy.toFixed(0)} (minus pair count)
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
                    <div style={{ color: '#8b5cf6', fontWeight: 'bold' }}>Paired Windows</div>
                    <div style={{ color: colors.textMuted }}>
                      {analysis ? analysis.pairedWindows.length : 0} found
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
                  Motif labels describe sequence-pattern candidates, not verified regulatory functions.{' '}
                  <span style={{ color: '#3b82f6' }}>Darker regions</span> have more pairs under the stated noncrossing objective.{' '}
                  {acceptedRNA?.analysis.method.limitations}
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
