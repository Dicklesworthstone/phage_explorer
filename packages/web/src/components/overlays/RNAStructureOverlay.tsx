/**
 * RNAStructureOverlay - RNA Structure & Packaging Signal Explorer
 *
 * Displays bounded maximum-pairing structures and descriptive motif observations.
 * Coding intervals can additionally compare synonymous pairing scores.
 */

import React, { useMemo, useState, useEffect, useRef, useSyncExternalStore } from 'react';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import type { ThemePalette } from '../../theme/types';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import {
  serializeAnalysisRecord,
  RNA_STRUCTURE_LIMITS,
  extractGeneSequence,
  type RNAStructureAnalysis,
  type CodonStress,
  type RegulatoryHypothesis,
} from '@phage-explorer/core';
import { RNAStructureSession, parseRNAInterval, type RNAStructureRequest } from '../../workers/RNAStructureSession';
import { downloadString } from '../../utils/export';

// ============================================================================
// Styling Helpers
// ============================================================================

function stressColor(stress: number): string {
  // Relative synonymous pairing-score variability, not fitness or stability.
  if (stress >= 0.8) return '#ef4444'; // Constrained
  if (stress >= 0.6) return '#f97316';
  if (stress >= 0.4) return '#eab308';
  if (stress >= 0.2) return '#22c55e';
  return '#3b82f6'; // Lower variability
}

function mfeColor(mfe: number): string {
  // More negative means more pairs in the stated maximum-pairing objective.
  if (mfe < -10) return '#7c3aed';
  if (mfe < -5) return '#a855f7';
  if (mfe < -2) return '#c084fc';
  return '#e9d5ff'; // Less stable
}

function regulatoryTypeIcon(type: RegulatoryHypothesis['type']): string {
  switch (type) {
    case 'stem-loop': return '🔁';
    case 'riboswitch': return '🎚️';
    case 'attenuator': return '🛑';
    case 'packaging-signal': return '📦';
    case 'slippery-site': return '🔀';
    case 'rbs': return '🧬';
    case 'terminator': return '🛑';
    default: return '❓';
  }
}

function regulatoryTypeLabel(type: RegulatoryHypothesis['type']): string {
  switch (type) {
    case 'stem-loop': return 'Stem-Loop';
    case 'riboswitch': return 'Riboswitch';
    case 'attenuator': return 'Attenuator';
    case 'packaging-signal': return 'Packaging Signal';
    case 'slippery-site': return 'Slippery Site Candidate';
    case 'rbs': return 'Ribosome Binding Site Candidate';
    case 'terminator': return 'Terminator Candidate';
    default: return 'Unknown';
  }
}

// ============================================================================
// Sub-components
// ============================================================================

interface StressHeatStripProps {
  stressData: CodonStress[];
  width: number;
  height: number;
  onHover?: (codon: CodonStress | null) => void;
  colors: ThemePalette;
}

function StressHeatStrip({
  stressData,
  width,
  height,
  onHover,
  colors,
}: StressHeatStripProps): React.ReactElement {
  const cellWidth = width / Math.max(stressData.length, 1);

  return (
    <div style={{ position: 'relative', width, height }}>
      <svg width={width} height={height}>
        {stressData.map((codon, i) => (
          <rect
            key={i}
            x={i * cellWidth}
            y={0}
            width={Math.max(cellWidth, 1)}
            height={height}
            fill={stressColor(codon.stress)}
            opacity={0.8}
            onMouseEnter={() => onHover?.(codon)}
            onMouseLeave={() => onHover?.(null)}
            style={{ cursor: 'pointer' }}
          />
        ))}
      </svg>
      {/* Axis labels */}
      <div
        style={{
          position: 'absolute',
          bottom: -16,
          left: 0,
          fontSize: '0.65rem',
          color: colors.textMuted,
        }}
      >
        {(stressData[0]?.position ?? 0) + 1}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: -16,
          right: 0,
          fontSize: '0.65rem',
          color: colors.textMuted,
        }}
      >
        {(stressData[stressData.length - 1]?.position ?? 0) + 1} (transcript codon)
      </div>
    </div>
  );
}

interface MFEPlotProps {
  windows: RNAStructureAnalysis['windows'];
  width: number;
  height: number;
  colors: ThemePalette;
}

function MFEPlot({ windows, width, height, colors }: MFEPlotProps): React.ReactElement {
  if (windows.length === 0) {
    return <div style={{ color: colors.textMuted }}>No windows</div>;
  }

  // The exact pair count is zero when no permitted base pair exists.
  const scores = windows.map(w => -w.pairCount);
  const minMFE = Math.min(0, ...scores);
  const maxMFE = 0;
  const range = maxMFE - minMFE || 1;

  const cellWidth = width / windows.length;

  // Create path for MFE line
  const points = windows.map((w, i) => {
    const x = i * cellWidth + cellWidth / 2;
    const y = height - ((-w.pairCount - minMFE) / range) * height;
    return `${x},${y}`;
  });

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height}>
        {/* Background bars for pairing density */}
        {windows.map((w, i) => (
          <rect
            key={i}
            x={i * cellWidth}
            y={0}
            width={cellWidth}
            height={height}
            fill={w.pairingScore === null ? colors.textDim : mfeColor(w.pairingScore)}
            opacity={w.pairingDensity * 0.6 + 0.2}
          />
        ))}
        {/* MFE line */}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke={colors.accent}
          strokeWidth={1.5}
        />
        {/* Zero line */}
        <line
          x1={0}
          y1={height - ((0 - minMFE) / range) * height}
          x2={width}
          y2={height - ((0 - minMFE) / range) * height}
          stroke={colors.textMuted}
          strokeDasharray="4,4"
          strokeWidth={0.5}
        />
      </svg>
      {/* Y-axis labels */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: -35,
          fontSize: '0.6rem',
          color: colors.textMuted,
        }}
      >
        {maxMFE.toFixed(1)}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: -35,
          fontSize: '0.6rem',
          color: colors.textMuted,
        }}
      >
        {minMFE.toFixed(1)}
      </div>
    </div>
  );
}

interface RegulatoryCardProps {
  hypothesis: RegulatoryHypothesis;
  colors: ThemePalette;
}

function RegulatoryCard({ hypothesis, colors }: RegulatoryCardProps): React.ReactElement {
  // null means no confidence can be computed, which is not the same as low
  // confidence. Exact motif matches carried the constants 0.7 and 0.3.
  const confidencePercent =
    hypothesis.confidence === null ? null : (hypothesis.confidence * 100).toFixed(0);

  return (
    <div
      style={{
        padding: '0.5rem',
        backgroundColor: colors.backgroundAlt,
        borderRadius: '4px',
        border: `1px solid ${colors.borderLight}`,
        fontSize: '0.8rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <span>{regulatoryTypeIcon(hypothesis.type)}</span>
        <span style={{ fontWeight: 'bold', color: colors.text }}>
          {regulatoryTypeLabel(hypothesis.type)}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            padding: '0.1rem 0.4rem',
            backgroundColor:
              hypothesis.confidence === null
                ? 'transparent'
                : hypothesis.confidence > 0.6
                  ? '#22c55e33'
                  : '#f5970033',
            borderRadius: '10px',
            fontSize: '0.7rem',
            color:
              hypothesis.confidence === null
                ? colors.textDim
                : hypothesis.confidence > 0.6
                  ? '#22c55e'
                  : '#f59700',
          }}
        >
          {confidencePercent === null ? 'motif match' : `${confidencePercent}% conf`}
        </span>
      </div>
      <div style={{ color: colors.textDim, marginBottom: '0.25rem' }}>
        {hypothesis.description}
      </div>
      <div style={{ display: 'flex', gap: '1rem', fontSize: '0.7rem', color: colors.textMuted }}>
        <span>Position: {(hypothesis.start + 1).toLocaleString()}–{hypothesis.end.toLocaleString()} (inclusive)</span>
      </div>
      <div
        style={{
          marginTop: '0.25rem',
          fontFamily: 'monospace',
          fontSize: '0.65rem',
          color: colors.textMuted,
          wordBreak: 'break-all',
        }}
      >
        {hypothesis.sequence.slice(0, 40)}{hypothesis.sequence.length > 40 ? '...' : ''}
      </div>
    </div>
  );
}

interface CodonDetailProps {
  codon: CodonStress;
  colors: ThemePalette;
}

function CodonDetail({ codon, colors }: CodonDetailProps): React.ReactElement {
  return (
    <div
      style={{
        padding: '0.75rem',
        backgroundColor: colors.backgroundAlt,
        borderRadius: '4px',
        border: `1px solid ${colors.borderLight}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
        <div>
          <span style={{ fontWeight: 'bold', fontFamily: 'monospace', fontSize: '1.1rem' }}>
            {codon.codon}
          </span>
          <span style={{ color: colors.textMuted, marginLeft: '0.5rem' }}>
            ({codon.aminoAcid})
          </span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          <div
            style={{
              padding: '0.2rem 0.5rem',
              backgroundColor: stressColor(codon.stress) + '33',
              borderRadius: '4px',
              fontSize: '0.8rem',
            }}
          >
            Relative variability: {(codon.stress * 100).toFixed(0)}%
          </div>
          {codon.isConstrained && (
            <span
              style={{
                padding: '0.2rem 0.5rem',
                backgroundColor: '#ef444433',
                borderRadius: '4px',
                color: '#ef4444',
                fontSize: '0.75rem',
                fontWeight: 'bold',
              }}
            >
              HIGH SCORE VARIABILITY
            </span>
          )}
        </div>
      </div>

      <div style={{ fontSize: '0.8rem', color: colors.textDim, marginBottom: '0.5rem' }}>
        {/* Unitless maximum-pairing score, not a free energy. */}
        Transcript codon {codon.position + 1}
        {codon.nucleotideStart !== undefined && codon.nucleotideEnd !== undefined && <> (bases {codon.nucleotideStart + 1}–{codon.nucleotideEnd})</>}
        {' '}| wild-type pairing score:{' '}
        {codon.wildTypeDeltaG.toFixed(2)}
      </div>

      {codon.variants.length > 0 && (
        <div>
          <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
            Synonymous alternatives:
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {codon.variants.map(v => (
              <div
                key={v.codon}
                style={{
                  padding: '0.2rem 0.5rem',
                  backgroundColor: v.deltaG < -0.5 ? '#22c55e22' : v.deltaG > 0.5 ? '#ef444422' : colors.backgroundAlt,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                }}
              >
                {v.codon}
                <span style={{ color: colors.textMuted, marginLeft: '0.25rem' }}>
                  {v.deltaG > 0 ? '+' : ''}{v.deltaG.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

interface RNAStructureOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

interface RNAInput {
  repository: PhageRepository;
  phage: PhageFull;
}
interface RNAData { sequence: string; genes: GeneInfo[] }

export function RNAStructureOverlay({
  repository, currentPhage,
}: RNAStructureOverlayProps): React.ReactElement | null {
  const { theme } = useTheme(), colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const isActive = isOpen('rnaStructure');
  const input = useMemo<RNAInput | null>(() => repository && currentPhage ? { repository, phage: currentPhage } : null,
    [repository, currentPhage]);
  const [loaded, setLoaded] = useState<{ input: RNAInput; data: RNAData | null; error: string | null } | null>(null);
  const data = loaded?.input === input ? loaded.data : null;
  const readJob = useRef<{ cancelled: boolean } | null>(null);
  const reading = isActive && input !== null && loaded?.input !== input;
  const loadError = loaded?.input === input ? loaded.error : null;
  const [geneSelection, setGeneSelection] = useState<{ input: RNAInput; key: string } | null>(null);
  const [viewMode, setViewMode] = useState<'genome' | 'gene'>('genome');
  const codingGenes = useMemo(() => data?.genes.filter(gene => gene.type === 'CDS') ?? [], [data]);
  const selectedGene = useMemo(() => geneSelection?.input === input
    ? codingGenes.find(gene => String(gene.id) === geneSelection.key) ?? null : null,
  [codingGenes, geneSelection, input]);
  const extracted = useMemo(() => {
    if (!selectedGene || !data) return { sequence: '', error: null };
    try {
      // Extraction preserves transcript order; alternative codes are allowed for pairing only.
      const sequence = extractGeneSequence(selectedGene, data.sequence, [1, 4, 11, 15, 25]);
      return { sequence, error: sequence ? null : 'This CDS has unsupported coordinates, codon_start or genetic code. Select another CDS or a genomic interval.' };
    } catch (cause) {
      return { sequence: '', error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [selectedGene, data]);
  const [hover, setHover] = useState<{ analysis: RNAStructureAnalysis; codon: CodonStress } | null>(null);

  useHotkey(ActionIds.OverlayRNAStructure, () => toggle('rnaStructure'), { modes: ['NORMAL'] });
  useEffect(() => {
    if (!isActive || !input) return;
    const owner = { cancelled: false }; readJob.current = owner;
    setLoaded(null);
    void (async () => {
      try {
        const length = await input.repository.getFullGenomeLength(input.phage.id);
        if (owner.cancelled) return;
        const [sequence, genes] = await Promise.all([
          input.repository.getSequenceWindow(input.phage.id, 0, length),
          input.repository.getGenes(input.phage.id),
        ]);
        if (!owner.cancelled) setLoaded({ input, data: { sequence, genes }, error: null });
      } catch (cause) {
        if (!owner.cancelled) setLoaded({ input, data: null, error: cause instanceof Error ? cause.message : String(cause) });
      } finally { if (readJob.current === owner) readJob.current = null; }
    })();
    return () => { owner.cancelled = true; if (readJob.current === owner) readJob.current = null; };
  }, [isActive, input]);

  const target = useMemo(() => {
    if (!data?.sequence || !input || viewMode === 'gene' && !selectedGene) return null;
    const sequence = viewMode === 'gene' ? extracted.sequence : data.sequence;
    if (!sequence) return null;
    const rawTable = selectedGene?.qualifiers?.transl_table;
    const table = String(Array.isArray(rawTable) ? rawTable[0] : rawTable ?? '1');
    const hasException = ['transl_except', 'pseudo', 'pseudogene', 'exception', 'ribosomal_slippage', 'trans_splicing', 'artificial_location']
      .some(key => selectedGene?.qualifiers?.[key] !== undefined);
    const coding = viewMode === 'gene';
    return { input, sequence, coding, gene: coding ? String(selectedGene!.id) + ':' + (selectedGene!.locusTag ?? selectedGene!.name ?? 'CDS') : null,
      stressSupported: coding && ['1', '11'].includes(table) && !hasException };
  }, [data, input, viewMode, selectedGene, extracted]);
  const [draft, setDraft] = useState<{ target: object; start: string; end: string } | null>(null);
  const [submitted, setSubmitted] = useState<{ target: object; start: number; end: number } | null>(null);
  const [formError, setFormError] = useState<{ target: object; message: string } | null>(null);
  const startText = draft?.target === target ? draft.start : '1';
  const endText = draft?.target === target ? draft.end : String(Math.min(target?.sequence.length ?? 0, 600));
  const request = useMemo<RNAStructureRequest | null>(() => {
    if (!isActive || !target) return null;
    const interval = submitted?.target === target ? submitted : { start: 0, end: Math.min(target.sequence.length, 600) };
    return { sequence: target.sequence.slice(interval.start, interval.end),
      source: { name: target.input.phage.name, accession: target.input.phage.accession || null,
        source: target.input.phage.localGenome ? 'local' : 'catalog',
        coordinateSystem: target.coding ? 'cds-transcript' : 'genome-forward',
        sourceLength: target.sequence.length, start: interval.start, end: interval.end, strand: '+', gene: target.gene },
      options: { windowSize: Math.min(target.coding ? 60 : 120, interval.end - interval.start),
        stepSize: Math.min(target.coding ? 15 : 30, interval.end - interval.start),
        frame: 0, includeSynonymousStress: target.stressSupported, minLoopSize: 3, allowWobble: true } };
  }, [isActive, target, submitted]);
  const session = useMemo(() => new RNAStructureSession(() =>
    new Worker(new URL('../../workers/rna-structure.worker.ts', import.meta.url), { type: 'module' })), []);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => { if (isActive) session.activate(); else session.deactivate(); return session.deactivate; }, [isActive, session]);
  useEffect(() => { if (request) void session.run(request); else session.cancel(); return session.cancel; }, [request, session]);
  const state = snapshot.input === request ? snapshot : null;
  const accepted = state?.accepted ?? null;
  const ownedRequest = state?.request ?? null;
  const analysis = accepted?.analysis ?? null;
  const busy = reading || !!state?.busy || !!request && snapshot.input !== request;
  const hoveredCodon = hover?.analysis === analysis ? hover.codon : null;
  const codons = useMemo(() => analysis && ownedRequest ? analysis.codonStress.map(codon => ({
    ...codon, position: codon.position + Math.floor(ownedRequest.source.start / 3),
    nucleotideStart: codon.nucleotideStart === undefined ? undefined : codon.nucleotideStart + ownedRequest.source.start,
    nucleotideEnd: codon.nucleotideEnd === undefined ? undefined : codon.nucleotideEnd + ownedRequest.source.start,
  })) : [], [analysis, ownedRequest]);
  const source = ownedRequest?.source;
  const error = loadError ?? (viewMode === 'gene' ? extracted.error : null)
    ?? (formError?.target === target ? formError.message : null) ?? state?.error;
  const cancel = () => {
    if (readJob.current) {
      readJob.current.cancelled = true;
      if (input) setLoaded({ input, data: null, error: 'Sequence loading cancelled. Close and reopen this panel to load again.' });
    }
    session.cancel();
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); if (!target) return;
    try {
      const interval = parseRNAInterval(startText, endText, target.sequence.length, target.coding);
      setFormError(null); setSubmitted({ target, ...interval });
    } catch (cause) { setFormError({ target, message: cause instanceof Error ? cause.message : String(cause) }); }
  };
  const exportResult = () => {
    if (!accepted || !request) return;
    try { downloadString(serializeAnalysisRecord(accepted.record), 'rna-pairing-analysis.json', 'application/json'); }
    catch (cause) { if (target) setFormError({ target, message: cause instanceof Error ? cause.message : String(cause) }); }
  };
  const fieldStyle: React.CSSProperties = { background: colors.backgroundAlt, color: colors.text,
    border: '1px solid ' + colors.borderLight, borderRadius: 3, padding: '.25rem' };
  if (!isActive) return null;

  return <Overlay id="rnaStructure" title="RNA PAIRING & MOTIF EXPLORER" hotkey="Alt+R" size="lg">
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <p style={{ color: colors.textDim }}>
        Exact maximum-pairing dynamic programming within each bounded window: A–U/C–G and optional G–U pairs,
        noncrossing, one partner per base, with at least three intervening bases between paired positions.
        Each window is folded independently; their structures need not combine into one whole-transcript fold.
        Scores count pairs; they are not free energies or calibrated functional predictions.
      </p>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <label>View: <select value={viewMode} onChange={event => setViewMode(event.target.value as 'genome' | 'gene')} style={fieldStyle}>
          <option value="genome">Genome interval</option><option value="gene">Single Gene</option>
        </select></label>
        {viewMode === 'gene' && <label>Gene: <select
          value={selectedGene ? String(selectedGene.id) : ''}
          onChange={event => setGeneSelection(input && event.target.value ? { input, key: event.target.value } : null)}
          style={{ ...fieldStyle, maxWidth: 250 }}>
          <option value="">Select an annotated CDS...</option>
          {codingGenes.map(gene => <option key={gene.id} value={String(gene.id)}>
            {gene.name || gene.locusTag} ({gene.startPos.toLocaleString()}-{gene.endPos.toLocaleString()})
          </option>)}
        </select></label>}
      </div>
      {target && <form onSubmit={submit} aria-label="RNA interval controls">
        <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label>Start (1-based) <input aria-label="RNA interval start" inputMode="numeric" value={startText}
            onChange={event => setDraft({ target, start: event.target.value, end: endText })} style={{ ...fieldStyle, width: 100 }} /></label>
          <label>End (inclusive) <input aria-label="RNA interval end" inputMode="numeric" value={endText}
            onChange={event => setDraft({ target, start: startText, end: event.target.value })} style={{ ...fieldStyle, width: 100 }} /></label>
          <button type="submit">Analyze interval</button>
          <button type="button" disabled={!busy} onClick={cancel}>Cancel RNA analysis</button>
          <button type="button" disabled={!accepted || busy} onClick={exportResult}>Export RNA analysis</button>
        </div>
        <p style={{ color: colors.textMuted, fontSize: '.8rem' }}>
          Positions refer to {target.coding ? 'the extracted coding transcript, after codon_start; joined and reverse-strand CDS segments stay in transcript order' : 'the forward genomic sequence'}.
          The initial interval is the first {Math.min(target.sequence.length, 600)} of {target.sequence.length.toLocaleString()} bases;
          choose any interval up to {RNA_STRUCTURE_LIMITS.sequenceBases.toLocaleString()} bases.
          The exact work budget can require a smaller coding interval. Draft edits do not change accepted results.
        </p>
      </form>}
      {error && <OverlayErrorState message="RNA analysis unavailable" details={error} />}
      {busy ? <OverlayLoadingState message="Analyzing RNA structure..."><AnalysisPanelSkeleton /></OverlayLoadingState>
        : !analysis || !source ? <OverlayEmptyState message={state?.cancelled ? 'RNA analysis cancelled'
          : viewMode === 'gene' && !selectedGene ? 'Select a gene to analyze' : 'No sequence loaded'}
          hint={state?.cancelled ? 'Choose Analyze interval to start a new computation.'
            : viewMode === 'gene' ? 'Choose a gene with supported CDS coordinates, strand and codon_start.' : 'Select a phage to analyze.'} />
        : <>
          <p data-testid="rna-accepted-interval" style={{ color: colors.textDim }}>
            Analyzed {source.start + 1}–{source.end} of {source.sourceLength.toLocaleString()} {source.coordinateSystem === 'cds-transcript' ? 'coding-transcript' : 'genomic'} bases.
            {' '}{analysis.windows.length} windows; {analysis.coverage.ambiguousBases} ambiguous bases.
            {' '}Method {analysis.method.id} v{analysis.method.version}; window {analysis.parameters.windowSize}, step {analysis.parameters.stepSize}.
          </p>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <div><span>Total Codons</span><strong>{analysis.parameters.includeSynonymousStress ? codons.length : 'Not computed'}</strong></div>
            <div>Mean paired-window score: {analysis.globalPairingScore === null ? 'no pairs' : analysis.globalPairingScore.toFixed(2)}</div>
            <div>Motif candidates: {analysis.regulatoryHypotheses.length}</div>
          </div>
          {!analysis.parameters.includeSynonymousStress && <p style={{ color: colors.textMuted }}>
            {target?.coding ? 'Synonymous scores are unavailable for this CDS genetic code or exceptional/pseudogene annotation.'
              : 'Genomic coordinates do not establish a reading frame. Select a coding gene for synonymous scores.'}
          </p>}
          {codons.length > 0 && <div>
            <p>Relative synonymous pairing-score variability (unitless; not selection or fitness)</p>
            <StressHeatStrip stressData={codons} width={560} height={24} colors={colors}
              onHover={codon => setHover(codon ? { analysis, codon } : null)} />
          </div>}
          {hoveredCodon && <CodonDetail codon={hoveredCodon} colors={colors} />}
          <div style={{ padding: '.5rem .5rem .5rem 2.5rem', background: colors.backgroundAlt }}>
            <p>Maximum-pairing landscape: score = minus pair count</p>
            <MFEPlot windows={analysis.windows} width={540} height={80} colors={colors} />
          </div>
          <details>
            <summary>Inspect all {analysis.windows.length} window structures</summary>
            <div style={{ maxHeight: 300, overflow: 'auto' }}><table aria-label="RNA window structures">
              <thead><tr><th>Interval (inclusive)</th><th>Pairs</th><th>Paired fraction</th><th>Sequence and dot-bracket structure</th></tr></thead>
              <tbody>{analysis.windows.map(window => <tr key={window.start}>
                <td>{source.start + window.start + 1}–{source.start + window.end}</td>
                <td>{window.pairCount}</td><td>{window.pairingDensity.toFixed(3)}</td>
                <td><pre style={{ margin: 0 }}>{window.sequence + '\n' + window.structure}</pre></td>
              </tr>)}</tbody>
            </table></div>
          </details>
          {analysis.regulatoryHypotheses.length > 0 && <details>
            <summary>Inspect all {analysis.regulatoryHypotheses.length} motif candidates</summary>
            <p>Sequence-pattern observations are not calibrated probabilities or verified regulatory elements.</p>
            <div style={{ maxHeight: 300, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
              {analysis.regulatoryHypotheses.map((hypothesis, index) => <RegulatoryCard key={index} colors={colors}
                hypothesis={{ ...hypothesis, start: source.start + hypothesis.start, end: source.start + hypothesis.end }} />)}
            </div>
          </details>
          <p style={{ color: colors.textMuted }}>{analysis.method.limitations}</p>
        </>}
    </div>
  </Overlay>;
}

export default RNAStructureOverlay;
