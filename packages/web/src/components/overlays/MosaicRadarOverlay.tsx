/**
 * MosaicRadarOverlay - Recombination & Mosaic Detection
 *
 * Compares local canonical k-mer similarity against a bounded reference panel.
 * Reference switches are exploratory evidence, not inferred recombination events.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds, getKeyboardManager, type HotkeyDefinition } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useIsTopOverlay, useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import {
  OverlayLoadingState,
  OverlayEmptyState,
} from './primitives';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment, GenomeTrackInteraction } from './primitives/types';
import {
  serializeAnalysisRecord, serializeMosaicDataset, exportMosaicTsv, resolveMosaicRadarConfig,
  type MosaicRadarConfig,
  type MosaicRadarResult,
  type MosaicSegment,
} from '@phage-explorer/core';
import { MosaicSession, readMosaicFile, readMosaicSequence, readRepositoryMosaicDataset,
  REPOSITORY_MOSAIC_PANEL } from '../../workers/MosaicSession';
import { downloadString } from '../../utils/export';

// Color palette for donors (distinct, accessible colors)
const DONOR_PALETTE = [
  '#3b82f6', // Blue
  '#22c55e', // Green
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#8b5cf6', // Purple
  '#06b6d4', // Cyan
  '#ec4899', // Pink
  '#f97316', // Orange
];

interface MosaicRadarOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

function segmentLabel(segment: MosaicSegment): string {
  if (segment.donor) return segment.donor;
  if (segment.status === 'ambiguous') return `Tied references: ${segment.tiedReferences.join(', ')}`;
  return segment.status === 'no-evidence' ? 'No comparable k-mers' : 'Below similarity threshold';
}

// Get donor statistics from result
function getDonorStats(result: MosaicRadarResult, genomeLength: number): Array<{
  donor: string;
  coverage: number;
  meanScore: number;
  color: string;
}> {
  const donorSet = new Set<string>();
  for (const seg of result.segments) {
    if (seg.donor) donorSet.add(seg.donor);
  }
  const donors = Array.from(donorSet);

  const stats = donors.map((donor, i) => {
    const segs = result.segments.filter((s) => s.donor === donor);
    const totalBp = segs.reduce((acc, s) => acc + (s.end - s.start), 0);
    const weightedScore = segs.reduce(
      (acc, s) => acc + s.meanScore * (s.end - s.start),
      0
    );
    return {
      donor,
      coverage: totalBp / Math.max(1, genomeLength),
      meanScore: weightedScore / Math.max(1, totalBp),
      color: DONOR_PALETTE[i % DONOR_PALETTE.length],
    };
  });

  return stats.sort((a, b) => b.coverage - a.coverage);
}

export function MosaicRadarOverlay({
  repository,
  currentPhage,
}: MosaicRadarOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const isTopmost = useIsTopOverlay('mosaicRadar');
  const overlayOpen = isOpen('mosaicRadar');
  const shouldCaptureHotkeys = overlayOpen && isTopmost;
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('mosaicRadar');

  // Repository and phage object identity matter: private repositories reuse numeric IDs.
  const scope = useMemo(() => ({ repository, currentPhage, overlayOpen }), [repository, currentPhage, overlayOpen]);
  const session = useMemo(() => new MosaicSession(() => new Worker(
    new URL('../../workers/mosaic.worker.ts', import.meta.url), { type: 'module' })), []);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const accepted = snapshot.scope === scope ? snapshot.accepted : null;
  const dataset = snapshot.scope === scope ? snapshot.dataset : null;
  const analysis = accepted?.result ?? null;
  const sequence = accepted?.dataset.query.sequence ?? '';
  const references = accepted?.dataset.references ?? [];
  const loading = snapshot.scope === scope && snapshot.busy;
  const [options, setOptions] = useState(() => resolveMosaicRadarConfig({ k: 5, window: 2000, step: 1000, minSimilarity: 0.05 }));
  const optionsRef = useRef(options);
  const [exportError, setExportError] = useState<string | null>(null);
  const { k, window: windowSize, minSimilarity } = options;
  const [showBreakpoints, setShowBreakpoints] = useState(true);

  const changeOptions = useCallback((change: (previous: Required<MosaicRadarConfig>) => MosaicRadarConfig) => {
    const state = session.getSnapshot();
    if (state.scope !== scope || !state.dataset) return;
    const next = resolveMosaicRadarConfig(change(optionsRef.current));
    optionsRef.current = next; setOptions(next); setExportError(null);
    void session.run(scope, { kind: 'analyze', dataset: state.dataset, options: next });
  }, [scope, session]);
  const setK = useCallback((update: (value: number) => number) => changeOptions(previous => ({ ...previous, k: update(previous.k) })), [changeOptions]);
  const setWindowSize = useCallback((update: (value: number) => number) => changeOptions(previous => {
    const window = update(previous.window); return { ...previous, window, step: Math.floor(window / 2) };
  }), [changeOptions]);
  const setMinSimilarity = useCallback((update: (value: number) => number) => changeOptions(previous => ({ ...previous, minSimilarity: update(previous.minSimilarity) })), [changeOptions]);

  const importFile = useCallback((kind: 'panel' | 'import' | 'replay', file: File) => {
    setExportError(null);
    void session.run(scope, async signal => {
      const content = await readMosaicFile(file);
      if (signal.aborted) throw new DOMException('Mosaic import cancelled.', 'AbortError');
      if (kind === 'replay') return { kind, content };
      if (kind === 'import') return { kind, content, options: optionsRef.current };
      const current = session.getSnapshot();
      const query = current.scope === scope ? current.dataset?.query : null;
      if (!query && (!repository || !currentPhage)) throw new Error('Select a query genome or import a complete mosaic dataset first.');
      return { kind, content, name: file.name, query: query ?? await readMosaicSequence(repository!, currentPhage!, signal), options: optionsRef.current };
    }).then(succeeded => {
      const current = session.getSnapshot();
      if (!succeeded || current.scope !== scope || !current.accepted) return;
      optionsRef.current = current.accepted.options; setOptions(current.accepted.options);
    });
  }, [currentPhage, repository, scope, session]);
  const exportResult = useCallback((kind: 'record' | 'dataset' | 'windows' | 'segments' | 'switches') => {
    if (!accepted || loading) return;
    try {
      if (kind === 'record') downloadString(serializeAnalysisRecord(accepted.record), 'mosaic-analysis.json', 'application/json');
      else if (kind === 'dataset') downloadString(serializeMosaicDataset(accepted.dataset), 'mosaic-dataset.json', 'application/json');
      else downloadString(exportMosaicTsv(accepted.record, kind), `mosaic-${kind}.tsv`, 'text/tab-separated-values');
      setExportError(null);
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); }
  }, [accepted, loading]);
  const analyzeRepository = useCallback(() => {
    if (!repository || !currentPhage) return;
    setExportError(null);
    void session.run(scope, async signal => ({ kind: 'analyze',
      dataset: await readRepositoryMosaicDataset(repository, currentPhage, signal), options: optionsRef.current }));
  }, [repository, currentPhage, scope, session]);

  const [hoverSnapshot, setHoverSnapshot] = useState<{
    analysis: MosaicRadarResult;
    info: GenomeTrackInteraction;
  } | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<{
    analysis: MosaicRadarResult;
    segment: MosaicSegment;
  } | null>(null);

  // Hotkey to toggle overlay (Alt+M to avoid conflict with StructureConstraint)
  useHotkey(
    ActionIds.OverlayMosaicRadar,
    () => toggle('mosaicRadar'),
    { modes: ['NORMAL'] }
  );

  // Keyboard controls
  useEffect(() => {
    if (!shouldCaptureHotkeys) return;
    if (typeof window === 'undefined') return;

    const manager = getKeyboardManager();

    const definitions: HotkeyDefinition[] = [
      // Window size
      {
        combo: { key: '+' },
        description: 'Mosaic radar: increase window size',
        action: () => setWindowSize((w) => Math.min(10000, Math.round(w * 1.25))),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: '=' },
        description: 'Mosaic radar: increase window size',
        action: () => setWindowSize((w) => Math.min(10000, Math.round(w * 1.25))),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: '-' },
        description: 'Mosaic radar: decrease window size',
        action: () => setWindowSize((w) => Math.max(500, Math.round(w / 1.25))),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: '_' },
        description: 'Mosaic radar: decrease window size',
        action: () => setWindowSize((w) => Math.max(500, Math.round(w / 1.25))),
        modes: ['NORMAL'],
        priority: 10,
      },
      // K-mer size
      {
        combo: { key: '[' },
        description: 'Mosaic radar: decrease k',
        action: () => setK((v) => Math.max(3, v - 1)),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: ']' },
        description: 'Mosaic radar: increase k',
        action: () => setK((v) => Math.min(16, v + 1)),
        modes: ['NORMAL'],
        priority: 10,
      },
      // Breakpoints toggle
      {
        combo: { key: 'b' },
        description: 'Mosaic radar: toggle reference switches',
        action: () => setShowBreakpoints((v) => !v),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: 'b', modifiers: { shift: true } },
        description: 'Mosaic radar: toggle reference switches',
        action: () => setShowBreakpoints((v) => !v),
        modes: ['NORMAL'],
        priority: 10,
      },
      // Similarity threshold
      {
        combo: { key: 'm' },
        description: 'Mosaic radar: decrease min similarity',
        action: () => setMinSimilarity((s) => Math.max(0.01, +(s - 0.02).toFixed(2))),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: 'm', modifiers: { shift: true } },
        description: 'Mosaic radar: increase min similarity',
        action: () => setMinSimilarity((s) => Math.min(0.95, +(s + 0.02).toFixed(2))),
        modes: ['NORMAL'],
        priority: 10,
      },
    ];

    const unregister = manager.registerMany(definitions);
    return unregister;
  }, [shouldCaptureHotkeys, setK, setWindowSize, setMinSimilarity]);

  // Fetch sequence and references when overlay opens
  useEffect(() => {
    session.setScope(scope); setExportError(null);
    if (!overlayOpen) { session.deactivate(); return; }
    session.activate();
    analyzeRepository();
    return () => session.deactivate();
  }, [overlayOpen, scope, session, analyzeRepository]);
  const hoverInfo = hoverSnapshot?.analysis === analysis ? hoverSnapshot.info : null;
  const selectedSegment = selectedSnapshot?.analysis === analysis ? selectedSnapshot.segment : null;

  // Get donor statistics
  const donorStats = useMemo(() => {
    if (!analysis) return [];
    return getDonorStats(analysis, sequence.length);
  }, [analysis, sequence.length]);

  // Build color map for donors
  const donorColorMap = useMemo(() => {
    const map = new Map<string, string>();
    donorStats.forEach((s) => map.set(s.donor, s.color));
    return map;
  }, [donorStats]);

  // Convert segments to track segments
  const mosaicSegments = useMemo((): GenomeTrackSegment[] => {
    if (!analysis) return [];
    return analysis.segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      label: `${segmentLabel(seg)} (J=${seg.meanScore.toFixed(2)})`,
      color: seg.donor ? donorColorMap.get(seg.donor) ?? colors.textMuted : colors.textMuted,
      height: 20,
      data: seg,
    }));
  }, [analysis, donorColorMap, colors.textMuted]);

  // Breakpoint markers
  const breakpointSegments = useMemo((): GenomeTrackSegment[] => {
    if (!analysis || !showBreakpoints) return [];
    return analysis.referenceSwitches.map((change) => ({
      start: change.start,
      end: change.end,
      label: `${change.from} → ${change.to}: sampled centers ${change.start.toLocaleString()}–${change.end.toLocaleString()} bp`,
      color: colors.warning,
      height: 30,
      data: change,
    }));
  }, [analysis, showBreakpoints, colors.warning]);

  // Handle track hover
  const handleHover = useCallback((info: GenomeTrackInteraction | null) => {
    if (!analysis || !info || (info.segment && !analysis.segments.some((seg) => seg === info.segment?.data))) {
      setHoverSnapshot(null);
      return;
    }
    setHoverSnapshot({ analysis, info });
  }, [analysis]);

  // Handle track click
  const handleClick = useCallback((info: GenomeTrackInteraction) => {
    if (!analysis) return;
    const segment = analysis.segments.find((seg) => seg === info.segment?.data);
    if (segment) setSelectedSnapshot({ analysis, segment });
  }, [analysis]);

  if (!isOpen('mosaicRadar')) return null;

  return (
    <Overlay
      id="mosaicRadar"
      title="MOSAIC / RECOMBINATION RADAR"
      hotkey="Alt+M"
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong style={{ color: colors.accent }}>Reference Similarity</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about mosaic phages"
                tooltip="Local k-mer similarity can highlight candidate mosaic regions. It does not identify a donor or establish a recombination event."
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'mosaic-genome')}
              />
            )}
          </div>
          <div>
            Compares strand-independent k-mer similarity against reference sequences. Colors indicate
            a uniquely closest reference. Ties and windows without evidence stay unresolved.
            Reference switches do not establish a donor, transfer direction or recombination event.
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', fontSize: '0.8rem' }}>
          <button type="button" disabled={!repository || !currentPhage} onClick={analyzeRepository}>Use selected genome and repository panel</button>
          <label>Reference FASTA / GenBank
            <input type="file" accept=".fa,.fna,.fasta,.gb,.gbk,.genbank,.txt" aria-label="Import mosaic reference sequences"
              disabled={!dataset && (!repository || !currentPhage)}
              onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) importFile('panel', file); }} />
          </label>
          <label>Exact query + reference dataset
            <input type="file" accept=".json" aria-label="Import mosaic dataset"
              onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) importFile('import', file); }} />
          </label>
          <label>Saved analysis
            <input type="file" accept=".json" aria-label="Replay mosaic analysis"
              onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) importFile('replay', file); }} />
          </label>
          {loading && <button type="button" onClick={session.cancel}>Cancel mosaic analysis</button>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', fontSize: '0.8rem' }}>
          <label>k-mer length <input aria-label="Mosaic k-mer length" type="number" min={1} max={16} value={k} disabled={!dataset}
            onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 1 && value <= 16) setK(() => value); }} /></label>
          <label>Window (bp) <input aria-label="Mosaic window size" type="number" min={200} max={10000} step={100} value={windowSize} disabled={!dataset}
            onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 200 && value <= 10000) setWindowSize(() => value); }} /></label>
          <label>Minimum similarity <input aria-label="Mosaic minimum similarity" type="number" min={0} max={1} step={0.01} value={minSimilarity} disabled={!dataset}
            onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= 0 && value <= 1) setMinSimilarity(() => value); }} /></label>
        </div>
        <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
          Private files are processed locally. Reference files retain complete supplied sequences; the catalogue panel is explicitly bounded.
          Saved analyses embed the exact query, reference panel, parameters and source ranges, and are recomputed on replay.
          Reference files use the displayed query; the selected-genome button reloads the current repository.
        </div>
        {snapshot.scope === scope && snapshot.error && <p role="alert">{snapshot.error}</p>}
        {exportError && <p role="alert">{exportError}</p>}
        {snapshot.scope === scope && snapshot.phase && !loading && <p role="status">{snapshot.phase}</p>}
        {accepted && (
          <>
            <div style={{ color: colors.textDim, fontSize: '0.8rem' }}>
              <strong>Analyzed query: {accepted.dataset.query.label}</strong>
              <div>{accepted.dataset.query.accession ?? 'No accession'} · {accepted.dataset.query.sequence.length.toLocaleString()} bases · {accepted.dataset.query.source}</div>
              <div>Panel: {accepted.dataset.name}. {accepted.dataset.references.length} supplied references; {accepted.dataset.excludedReferences.length} excluded before comparison.</div>
              <div>{accepted.result.referencePanel.omitted} supplied references omitted by the saved maximum-reference setting.</div>
              <div>Query source range: [{accepted.dataset.query.sourceStart.toLocaleString()}, {(accepted.dataset.query.sourceStart + accepted.dataset.query.sequence.length).toLocaleString()}) of {accepted.dataset.query.sourceLength.toLocaleString()} original bases.</div>
              <div>Result identity: <code style={{ overflowWrap: 'anywhere' }}>{accepted.record.resultId}</code>{snapshot.verified ? ' · Replay verified' : ''}</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              <button type="button" onClick={() => exportResult('record')}>Export replayable analysis</button>
              <button type="button" onClick={() => exportResult('dataset')}>Export exact dataset</button>
              <button type="button" onClick={() => exportResult('windows')}>Export windows TSV</button>
              <button type="button" onClick={() => exportResult('segments')}>Export segments TSV</button>
              <button type="button" onClick={() => exportResult('switches')}>Export switches TSV</button>
            </div>
            <details style={{ fontSize: '0.75rem', color: colors.textMuted }}>
              <summary>Reference provenance and partial coverage</summary>
              <ul>{accepted.dataset.references.map(reference => <li key={reference.id}>
                <strong>{reference.label}</strong>: [{reference.sourceStart.toLocaleString()}, {(reference.sourceStart + reference.sequence.length).toLocaleString()}) of {reference.sourceLength.toLocaleString()} bases
                {reference.sequence.length < reference.sourceLength ? ' — partial reference' : ' — complete supplied reference'}; {reference.source}; {reference.sourceDescription}
              </li>)}</ul>
              {accepted.dataset.excludedReferences.length > 0 && <ul>{accepted.dataset.excludedReferences.map(reference => <li key={reference.id}>
                <strong>{reference.label}</strong>: excluded — {reference.reason}
              </li>)}</ul>}
            </details>
          </>
        )}

        {loading ? (
          <OverlayLoadingState message={snapshot.phase || 'Loading sequence and references...'}>
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : !analysis || analysis.windows.length === 0 ? (
          <OverlayEmptyState
            message={
              !sequence
                ? 'No sequence loaded'
                : references.length === 0
                  ? 'No reference genomes available'
                  : 'Sequence is shorter than the selected k-mer length'
            }
            hint={
              !sequence
                ? 'Select a phage, import an exact dataset, or replay a saved mosaic analysis.'
                : references.length === 0
                  ? 'Reference comparison requires at least one other genome in the database.'
                  : 'Try adjusting analysis parameters.'
            }
          />
        ) : (
          <>
            {/* Parameter controls */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                fontSize: '0.75rem',
                color: colors.textMuted,
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
              }}
            >
              <span>k={accepted!.options.k}</span>
              <span>window={analysis.window}bp</span>
              <span>minSim={accepted!.options.minSimilarity}</span>
              <span style={{ color: colors.textDim }}>
                [+/-] window | [/] k | [b] reference switches {showBreakpoints ? 'on' : 'off'} | [m/M]
                minSim
              </span>
            </div>

            {/* Mosaic Track */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <span>Reference similarity segments (click for details)</span>
                {beginnerModeEnabled && (
                  <InfoButton
                    size="sm"
                    label="What do colors mean?"
                    tooltip="Colors represent unique closest references. Gray regions are tied, below threshold or lack comparable k-mers. Display segments partition the genome without overlapping."
                    onClick={() => showContextFor('mosaic-genome')}
                  />
                )}
              </div>
              <GenomeTrack
                genomeLength={sequence.length}
                segments={mosaicSegments}
                width={540}
                height={50}
                onHover={handleHover}
                onClick={handleClick}
                ariaLabel="Mosaic reference similarity track"
              />
            </div>

            {/* Breakpoint Track */}
            {showBreakpoints && analysis.breakpoints.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: colors.textMuted,
                    marginBottom: '0.25rem',
                  }}
                >
                  Reference switches ({analysis.breakpoints.length})
                </div>
                <GenomeTrack
                  genomeLength={sequence.length}
                  segments={breakpointSegments}
                  width={540}
                  height={30}
                  ariaLabel="Reference switch ranges"
                />
              </div>
            )}

            {/* Hover tooltip */}
            {hoverInfo && (
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                }}
              >
                Position: {Math.round(hoverInfo.position).toLocaleString()} bp
                {hoverInfo.segment && (
                  <span style={{ marginLeft: '1rem', color: colors.textMuted }}>
                    {hoverInfo.segment.label}
                  </span>
                )}
              </div>
            )}

            {/* Selected segment details */}
            {selectedSegment && (
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.backgroundAlt,
                  border: `1px solid ${
                    selectedSegment.donor
                      ? donorColorMap.get(selectedSegment.donor) ?? colors.border
                      : colors.border
                  }`,
                  borderRadius: '4px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                      {segmentLabel(selectedSegment)}
                    </div>
                    <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
                      Position: {selectedSegment.start.toLocaleString()} -{' '}
                      {selectedSegment.end.toLocaleString()} bp (0-based, end-exclusive)
                    </div>
                    <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
                      Size: {(selectedSegment.end - selectedSegment.start).toLocaleString()} bp
                    </div>
                    <div style={{ color: colors.textDim, fontSize: '0.7rem' }}>
                      Mean window Jaccard: {selectedSegment.meanScore.toFixed(3)}
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedSnapshot(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: colors.textMuted,
                      cursor: 'pointer',
                      fontSize: '1rem',
                    }}
                  >
                    x
                  </button>
                </div>
              </div>
            )}

            {/* Donor Legend */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.5rem',
                  fontWeight: 'bold',
                }}
              >
                Unique closest references:
              </div>
              {donorStats.length === 0 ? (
                <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                  No unique reference assignments at the current similarity threshold.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  {donorStats.map((stat) => (
                    <div
                      key={stat.donor}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '0.75rem',
                      }}
                    >
                      <span
                        style={{
                          width: '12px',
                          height: '12px',
                          backgroundColor: stat.color,
                          borderRadius: '2px',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ color: stat.color, fontWeight: 500 }}>{stat.donor}</span>
                      <span style={{ color: colors.textMuted }}>
                        {(stat.coverage * 100).toFixed(1)}% of display partition
                      </span>
                      <span style={{ color: colors.textDim }}>
                        J={stat.meanScore.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Breakpoint list */}
            {analysis.breakpoints.length > 0 && (
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                }}
              >
                <span style={{ color: colors.textDim }}>
                  Reference switches between sampled window centers:{' '}
                  {analysis.referenceSwitches.map((change) =>
                    `${change.from} → ${change.to}: ${change.start.toLocaleString()}–${change.end.toLocaleString()} bp`
                  ).join('; ')}
                </span>
              </div>
            )}

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
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                <strong>Interpretation:</strong>
                {beginnerModeEnabled && (
                  <InfoButton
                    size="sm"
                    label="Learn about mosaic interpretation"
                    tooltip="A change in the closest reference is an exploratory similarity signal. Establishing recombination requires additional alignment and statistical evidence."
                    onClick={() => showContextFor('mosaic-genome')}
                  />
                )}
              </span>{' '}
              Display boundaries lie midway between sampled window centers; the colored spans are
              not sequence alignments. Switch ranges show the resolution of the supporting windows,
              not a biological breakpoint or confidence interval. Similarity depends on k, window size
              and the available panel. Small k can tie many long references; use [/] to choose k from
              3 to 16. No matches do not rule out shared ancestry.
              <div style={{ marginTop: '0.5rem' }}>
                Unresolved display spans: {analysis.coverage.ambiguous.toLocaleString()} bp tied,{' '}
                {analysis.coverage['below-threshold'].toLocaleString()} bp below threshold,{' '}
                {analysis.coverage['no-evidence'].toLocaleString()} bp without comparable k-mers.
              </div>
            </div>

            {/* Reference count */}
            <div
              style={{
                fontSize: '0.7rem',
                color: colors.textMuted,
                textAlign: 'right',
              }}
            >
              {analysis.referencePanel.usable} of {analysis.referencePanel.selected} selected references
              {' contain valid k-mers. '}{accepted!.dataset.name === REPOSITORY_MOSAIC_PANEL
                ? 'Panel: at most 30 other genomes by catalogue ID, first 150,000 bp each.'
                : 'Panel: exact supplied reference sequences; inspect source ranges above.'}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default MosaicRadarOverlay;
