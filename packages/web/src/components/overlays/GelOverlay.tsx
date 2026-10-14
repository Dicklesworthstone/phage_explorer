/**
 * GelOverlay - Virtual Gel Electrophoresis Simulation
 *
 * Simulates restriction enzyme digestion and gel electrophoresis
 * for experimental planning and genome verification.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { digestGenome, findRestrictionCutSites, RESTRICTION_ENZYMES, serializeAnalysisRecord, type AnalysisRecord, type PhageFull } from '@phage-explorer/core';
import { RESTRICTION_DIGEST_METHOD, resolveRestrictionDigestOptions, exportRestrictionDigestTsv } from '../../../../core/src/analysis/restriction-digest';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { GelCanvas } from './primitives/GelCanvas';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import type { GelLane, GelBand, GelInteraction } from './primitives/types';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { downloadString } from '../../utils/export';

const ENZYME_COLORS: Record<string, string> = {
  EcoRI: '#ef4444', HindIII: '#f59e0b', BamHI: '#22c55e', PstI: '#3b82f6',
  SalI: '#8b5cf6', XbaI: '#ec4899', SmaI: '#14b8a6', KpnI: '#f97316',
  NcoI: '#06b6d4', NdeI: '#a855f7', NotI: '#6366f1', XhoI: '#84cc16',
};

// DNA size ladders
const LADDERS = {
  '1kb': {
    name: '1 kb Ladder',
    sizes: [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500],
  },
  '100bp': {
    name: '100 bp Ladder',
    sizes: [1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100],
  },
  'lambda_hindiii': {
    name: 'Lambda/HindIII',
    sizes: [23130, 9416, 6557, 4361, 2322, 2027, 564],
  },
};

// Calculate band intensity based on fragment size
function calculateIntensity(size: number, maxSize: number): number {
  // Larger fragments appear brighter (more DNA)
  const sizeRatio = size / maxSize;
  // Apply sigmoid-like curve for realistic appearance
  return Math.min(1, 0.3 + sizeRatio * 0.7);
}

// Convert fragments to gel bands
function fragmentsToGelBands(fragments: number[], maxSize: number): GelBand[] {
  return fragments.map((size) => ({
    size,
    intensity: calculateIntensity(size, maxSize),
    label: formatSize(size),
  }));
}

// Format size for display
function formatSize(bp: number): string {
  if (bp >= 1000) {
    return `${(bp / 1000).toFixed(1)} kb`;
  }
  return `${bp} bp`;
}

interface GelOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Tooltip component for band details
function BandTooltip({
  band,
  colors,
}: {
  band: GelBand;
  colors: { textMuted: string };
}): React.ReactElement {
  return (
    <>
      <div style={{ fontWeight: 'bold' }}>{band.label ?? formatSize(band.size)}</div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        {band.size.toLocaleString()} bp
      </div>
    </>
  );
}

export function GelOverlay({
  repository,
  currentPhage,
}: GelOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const [loaded, setLoaded] = useState<{
    repository: PhageRepository; phage: PhageFull; sequence: string;
  } | null>(null);
  const sequence = loaded?.repository === repository && loaded?.phage === currentPhage
    ? loaded.sequence : '';
  const [sequenceError, setSequenceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Selected enzymes for digest
  const [selectedEnzymes, setSelectedEnzymes] = useState<string[]>(['EcoRI']);
  const [ladderType, setLadderType] = useState<keyof typeof LADDERS>('1kb');
  const [topologyChoice, setTopologyChoice] = useState<{
    repository: PhageRepository | null; phage: PhageFull; value: 'linear' | 'circular';
  } | null>(null);
  const topology = topologyChoice && topologyChoice.phage === currentPhage && topologyChoice.repository === repository
    ? topologyChoice.value
    : currentPhage?.localGenome?.topology === 'circular' ? 'circular' : 'linear';
  const isCircular = topology === 'circular';
  const cutCounts = useMemo(() => new Map(RESTRICTION_ENZYMES.map(enzyme => [
    enzyme.name, findRestrictionCutSites(sequence, enzyme, isCircular).length,
  ])), [sequence, isCircular]);

  const open = isOpen('gel');
  const settingsKey = JSON.stringify(resolveRestrictionDigestOptions({ enzymes: selectedEnzymes, topology }));
  const source: 'local' | 'catalog' = currentPhage?.localGenome ? 'local' : 'catalog';
  const [experiment, setExperiment] = useState<{
    repository: PhageRepository; phage: PhageFull; sequence: string; settingsKey: string;
    record: AnalysisRecord; replayed: boolean;
  } | null>(null);
  const [experimentBusy, setExperimentBusy] = useState(false);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const experimentController = useRef<AbortController | null>(null), experimentGeneration = useRef(0);
  // Also guard the render-to-effect gap: a late file read must not restore
  // enzyme settings into a different selection before effect cleanup runs.
  const latestSelection = useRef({ repository, currentPhage, sequence, settingsKey, open });
  latestSelection.current = { repository, currentPhage, sequence, settingsKey, open };
  const currentExperiment = open && experiment?.repository === repository && experiment.phage === currentPhage
    && experiment.sequence === sequence && experiment.settingsKey === settingsKey
    && experiment.record.inputs[0].accession === currentPhage?.accession && experiment.record.inputs[0].source === source ? experiment : null;

  useEffect(() => {
    setExperimentBusy(false); setExperimentError(null);
    return () => { experimentGeneration.current++; experimentController.current?.abort(); };
  }, [repository, currentPhage, sequence, settingsKey, open]);

  const runExperiment = async (file?: File) => {
    if (!repository || !currentPhage || !sequence || !open) return;
    experimentController.current?.abort();
    const controller = new AbortController(); experimentController.current = controller;
    const generation = ++experimentGeneration.current;
    const selection = latestSelection.current;
    const active = () => !controller.signal.aborted && generation === experimentGeneration.current
      && latestSelection.current.repository === selection.repository && latestSelection.current.currentPhage === selection.currentPhage
      && latestSelection.current.sequence === selection.sequence && latestSelection.current.settingsKey === selection.settingsKey
      && latestSelection.current.open;
    setExperimentBusy(true); setExperimentError(null);
    try {
      let content: string | null = null;
      if (file) {
        if (file.size > 10 * 1024 * 1024) throw new Error('Restriction experiment exceeds 10 MiB.');
        content = await file.text();
        if (!active()) return;
      }
      const { runResearchWorker } = await import('./ResearchWorkflowPanel');
      if (!active()) return;
      const response = await runResearchWorker(content === null ? {
        type: 'restriction-digest', sequence, options: resolveRestrictionDigestOptions({ enzymes: selectedEnzymes, topology }),
        context: { accession: currentPhage.accession, source },
      } : { type: 'restriction-digest-replay', content }, controller.signal);
      if (!active()) return;
      if (response.type !== 'analysis') throw new Error('Expected a recomputed restriction experiment.');
      const record = response.record;
      if (record.method.id !== RESTRICTION_DIGEST_METHOD.id || record.method.version !== RESTRICTION_DIGEST_METHOD.version
        || record.inputs[0]?.id !== 'sequence' || record.inputs[0].data !== sequence
        || record.inputs[0].accession !== currentPhage.accession || record.inputs[0].source !== source) {
        throw new Error('Experiment source does not match this selected genome. Load its exact original genome before restoring.');
      }
      const options = resolveRestrictionDigestOptions(record.parameters), acceptedKey = JSON.stringify(options);
      if (content === null && acceptedKey !== settingsKey) throw new Error('Digest evidence does not match the selected enzyme settings.');
      // A failed import never changes either the accepted experiment or controls.
      if (content !== null) {
        setSelectedEnzymes([...options.enzymes]);
        setTopologyChoice({ repository, phage: currentPhage, value: options.topology });
        setHoverInfo(null);
      }
      setExperiment({ repository, phage: currentPhage, sequence, settingsKey: acceptedKey, record, replayed: content !== null });
    } catch (cause) {
      if (active()) setExperimentError(cause instanceof Error ? cause.message : 'Restriction experiment failed.');
    } finally {
      if (active()) setExperimentBusy(false);
      if (experimentController.current === controller) experimentController.current = null;
    }
  };
  const exportExperiment = (format: 'json' | 'tsv') => {
    if (!currentExperiment) return;
    try {
      const record = currentExperiment.record;
      downloadString(format === 'json' ? serializeAnalysisRecord(record) : exportRestrictionDigestTsv(record),
        `restriction-digest-${record.resultId.slice(0, 12)}.${format}`, format === 'json' ? 'application/json' : 'text/tab-separated-values');
      setExperimentError(null);
    } catch (cause) { setExperimentError(cause instanceof Error ? cause.message : 'Could not export restriction experiment.'); }
  };

  // Hover state
  const [hoverInfo, setHoverInfo] = useState<GelInteraction | null>(null);

  // Hotkey to toggle overlay (Alt+G)
  useHotkey(
    ActionIds.OverlayGel,
    () => toggle('gel'),
    { modes: ['NORMAL'] }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('gel')) return;
    setSequenceError(null);
    setLoaded(null);
    setTopologyChoice(null);
    setHoverInfo(null);
    if (!repository || !currentPhage) {
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    let cancelled = false;
    setLoading(true);
    setSequenceError(null);
    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => cancelled ? '' : repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        if (cancelled) return;
        setLoaded({ repository, phage: currentPhage, sequence: seq });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A failed database read used to render as "No sequence loaded", which
        // tells the user this phage has no data rather than that something
        // broke. Surface the real cause.
        setLoaded(null);
        setSequenceError(
          `Could not load sequence: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Toggle enzyme selection
  const toggleEnzyme = useCallback((name: string) => {
    setSelectedEnzymes((prev) =>
      prev.includes(name) ? prev.filter((e) => e !== name) : [...prev, name]
    );
  }, []);

  // Compute digest
  const digestResult = useMemo(() => {
    if (!sequence) return null;

    const enzymes = RESTRICTION_ENZYMES.filter((e) => selectedEnzymes.includes(e.name));
    const { fragments, cutSites } = digestGenome(sequence, enzymes, isCircular);

    return {
      fragments: fragments.map(fragment => fragment.length),
      cutSites,
      numCuts: cutSites.length,
      enzymes,
    };
  }, [sequence, selectedEnzymes, isCircular]);

  // Build gel lanes
  const gelLanes = useMemo((): GelLane[] => {
    const lanes: GelLane[] = [];
    const ladder = LADDERS[ladderType];
    const maxSize = Math.max(
      sequence?.length ?? 10000,
      ...ladder.sizes
    );

    // Ladder lane
    lanes.push({
      id: 'ladder',
      label: ladder.name,
      bands: ladder.sizes.map((size) => ({
        size,
        intensity: 0.6,
        label: formatSize(size),
      })),
      color: '#888',
    });

    // Uncut lane
    if (sequence) {
      lanes.push({
        id: 'uncut',
        label: 'Uncut',
        bands: [
          {
            size: sequence.length,
            intensity: 1,
            label: formatSize(sequence.length),
          },
        ],
        color: '#a5c9ff',
      });
    }

    // Digest lane
    if (digestResult && digestResult.fragments.length > 0) {
      const enzymeLabel =
        digestResult.enzymes.length > 0
          ? digestResult.enzymes.map((e) => e.name).join('+')
          : 'No enzyme';

      lanes.push({
        id: 'digest',
        label: enzymeLabel,
        bands: fragmentsToGelBands(digestResult.fragments, maxSize),
        color: ENZYME_COLORS[digestResult.enzymes[0]?.name] ?? '#a5c9ff',
      });
    }

    return lanes;
  }, [sequence, digestResult, ladderType]);

  // Handle hover
  const handleHover = useCallback((info: GelInteraction | null) => {
    setHoverInfo(info);
  }, []);

  if (!isOpen('gel')) return null;

  return (
    <Overlay id="gel" title="VIRTUAL GEL ELECTROPHORESIS" hotkey="Alt+G" size="lg">
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
          <strong style={{ color: colors.accent }}>Virtual Gel</strong>: Simulate restriction
          enzyme digestion and visualize predicted fragment sizes. Choose the molecule's
          topology; records without topology metadata initially use a linear model.
        </div>

        {loading ? (
          <OverlayLoadingState message="Loading sequence data...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : sequenceError ? (
          <OverlayErrorState message="Could not load sequence" details={sequenceError} />
        ) : !sequence ? (
          <OverlayEmptyState
            message="No sequence loaded"
            hint="Select a phage to simulate gel electrophoresis."
          />
        ) : (
          <>
            {/* Enzyme selector */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.5rem',
                }}
              >
                Select Restriction Enzymes:
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}
              >
                {RESTRICTION_ENZYMES.map((enzyme) => {
                  const isSelected = selectedEnzymes.includes(enzyme.name);
                  const count = cutCounts.get(enzyme.name) ?? 0;
                  const color = ENZYME_COLORS[enzyme.name] ?? colors.accent;
                  return (
                    <button
                      key={enzyme.name}
                      onClick={() => toggleEnzyme(enzyme.name)}
                      aria-pressed={isSelected}
                      style={{
                        padding: '0.25rem 0.5rem',
                        fontSize: '0.75rem',
                        backgroundColor: isSelected ? color : colors.backgroundAlt,
                        color: isSelected ? '#fff' : colors.text,
                        border: `1px solid ${isSelected ? color : colors.borderLight}`,
                        borderRadius: '4px',
                        cursor: 'pointer',
                        opacity: count === 0 ? 0.5 : 1,
                      }}
                      title={`${enzyme.name}: ${enzyme.site} (${count} cuts)`}
                    >
                      {enzyme.name} ({count})
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Ladder selector */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                fontSize: '0.8rem',
              }}
            >
              <label style={{ color: colors.textMuted }}>
                Molecule topology:
                <select value={topology} onChange={event => {
                  if (currentPhage) setTopologyChoice({ repository, phage: currentPhage, value: event.target.value as 'linear' | 'circular' });
                }}>
                  <option value="linear">Linear</option>
                  <option value="circular">Circular</option>
                </select>
              </label>
              <label style={{ color: colors.textMuted }}>
                Ladder:
                <select
                  value={ladderType}
                  onChange={(e) => setLadderType(e.target.value as keyof typeof LADDERS)}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  {Object.entries(LADDERS).map(([key, ladder]) => (
                    <option key={key} value={key}>
                      {ladder.name}
                    </option>
                  ))}
                </select>
              </label>

              {digestResult && (
                <span style={{ color: colors.textMuted }}>
                  {digestResult.numCuts} cut{digestResult.numCuts !== 1 ? 's' : ''} →{' '}
                  {digestResult.fragments.length} fragment
                  {digestResult.fragments.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Gel canvas */}
            <div
              style={{
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <GelCanvas
                lanes={gelLanes}
                width={520}
                height={280}
                onHover={handleHover}
                ariaLabel="Virtual gel electrophoresis visualization"
              />

              {/* Lane labels */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-around',
                  padding: '0.25rem',
                  backgroundColor: colors.backgroundAlt,
                  fontSize: '0.7rem',
                  color: colors.textMuted,
                }}
              >
                {gelLanes.map((lane) => (
                  <span key={lane.id}>{lane.label}</span>
                ))}
              </div>

              {/* Hover tooltip */}
              {hoverInfo && (
                <div
                  style={{
                    position: 'absolute',
                    left: Math.min(hoverInfo.clientX - 50, 400),
                    top: 10,
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
                  <BandTooltip band={hoverInfo.band} colors={colors} />
                </div>
              )}
            </div>

            {/* Fragment table */}
            {digestResult && (
              <div role="region" aria-label="Digest fragment sizes">
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: colors.textMuted,
                    marginBottom: '0.25rem',
                  }}
                >
                  Fragments ({digestResult.fragments.length}):
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.25rem',
                    maxHeight: '60px',
                    overflowY: 'auto',
                    fontSize: '0.7rem',
                  }}
                >
                  {digestResult.fragments.map((size, idx) => (
                    <span
                      key={idx}
                      style={{
                        padding: '0.125rem 0.375rem',
                        backgroundColor: colors.backgroundAlt,
                        borderRadius: '3px',
                        color: colors.text,
                        fontFamily: 'monospace',
                      }}
                    >
                      {size.toLocaleString()} bp
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Portable experiment controls share the core digest producer. */}
            <section aria-label="Reproducible restriction experiment" style={{ fontSize: '0.8rem' }}>
              <p>Save exact cuts and fragment coordinates, or restore an experiment by recomputing it.
                JSON includes the full genome; share it only when intended. Processing stays on this device.</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                <button type="button" disabled={experimentBusy} onClick={() => { void runExperiment(); }}>
                  {experimentBusy ? 'Computing experiment…' : 'Prepare digest export'}
                </button>
                <label>Restore digest JSON
                  <input type="file" accept=".json,application/json" disabled={experimentBusy} onChange={event => {
                    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
                    if (file) void runExperiment(file);
                  }} />
                </label>
                {experimentBusy && <button type="button" onClick={() => {
                  experimentGeneration.current++; experimentController.current?.abort(); setExperimentBusy(false);
                }}>Cancel experiment</button>}
                <button type="button" disabled={!currentExperiment || experimentBusy} onClick={() => exportExperiment('json')}>Download digest JSON</button>
                <button type="button" disabled={!currentExperiment || experimentBusy} onClick={() => exportExperiment('tsv')}>Download fragments TSV</button>
              </div>
              {experimentError && <p role="alert">{experimentError}</p>}
              {currentExperiment && <>
                <p role="status">{currentExperiment.replayed ? 'Saved cuts and fragments match a fresh computation.' : 'Digest experiment ready for the current sequence and settings.'}</p>
                <AnalysisRecordDetails record={currentExperiment.record} />
              </>}
            </section>

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
              <strong>Model:</strong> Ideal complete digestion at definite recognition sites.
              Unresolved sequence bases do not imply a cut. Methylation, partial digestion
              and the different mobility of uncut circular DNA are not modeled; band positions
              illustrate fragment size rather than predict an experimental gel.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default GelOverlay;
