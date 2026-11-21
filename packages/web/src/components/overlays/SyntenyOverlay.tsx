/**
 * SyntenyOverlay - Gene Order Conservation Analysis
 *
 * Visualizes synteny (conserved gene order) between the current phage
 * and a reference genome using:
 * - Gene similarity heatmap matrix
 * - Synteny block detection and visualization
 * - DTW-based alignment scoring
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { GenomeTrack } from './primitives/GenomeTrack';
import {
  OverlayLoadingState,
  OverlayErrorState,
} from './primitives';
import { HeatmapCanvas } from '../primitives/HeatmapCanvas';
import type { GenomeTrackSegment, GenomeTrackInteraction, HeatmapHover, ColorScale } from '../primitives/types';
import type { SyntenyJob, SyntenyHeatmap, SyntenyBlockBp, SyntenyStats, WorkerResponse } from '../../workers/synteny-worker';

interface SyntenyPayload { heatmap: SyntenyHeatmap; blocksBp: SyntenyBlockBp[]; stats: SyntenyStats }

/** An analysis owns its worker, so abandoned computations cannot delay or replace the next pair. */
export function runWebSynteny(
  job: SyntenyJob & { jobId: string },
  signal?: AbortSignal,
  timeoutMs = 300000,
  createWorker: () => Worker = () => new Worker(new URL('../../workers/synteny-worker.ts', import.meta.url), { type: 'module' }),
): Promise<SyntenyPayload> {
  return new Promise((resolve, reject) => {
    const cancelled = () => new DOMException('Synteny analysis cancelled.', 'AbortError');
    if (signal?.aborted) { reject(cancelled()); return; }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      reject(new Error('Synteny timeout must be a positive integer.')); return;
    }
    let worker: Worker;
    try { worker = createWorker(); } catch (error) { reject(error); return; }
    let settled = false;
    const finish = (error?: Error, payload?: SyntenyPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Preserve the original outcome if cleanup fails. */ }
      if (error) reject(error); else resolve(payload!);
    };
    const onAbort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Synteny worker timed out. Retry the analysis.')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (settled) return;
      const response = event.data;
      if (!response || response.jobId !== job.jobId) {
        finish(new Error('Synteny worker returned a result for a different request.')); return;
      }
      if (response.ok !== true || !response.heatmap || !response.stats || !Array.isArray(response.blocksBp)) {
        finish(new Error(response.error ?? 'Synteny worker returned no complete response.')); return;
      }
      const { heatmap, stats, blocksBp } = response;
      if (heatmap.rows !== job.genesQuery.length || heatmap.cols !== job.genesReference.length
        || !(heatmap.values instanceof Float32Array) || heatmap.values.length !== heatmap.rows * heatmap.cols
        || stats.blockCount !== blocksBp.length) {
        finish(new Error('Synteny worker returned a result for different gene inputs.')); return;
      }
      finish(undefined, { heatmap, stats, blocksBp });
    };
    worker.onerror = event => {
      event.preventDefault();
      finish(new Error('The synteny worker failed. Retry the analysis.'));
    };
    worker.onmessageerror = () => finish(new Error('The synteny worker returned unreadable data. Retry the analysis.'));
    try { if (signal?.aborted) onAbort(); else worker.postMessage(job); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

interface OwnedSynteny {
  repository: PhageRepository;
  selectedQuery: PhageFull;
  referenceId: number;
  revision: number;
  query: PhageFull | null;
  reference: PhageFull | null;
  payload: SyntenyPayload | null;
  loading: boolean;
  error: string | null;
}
let nextSyntenyJob = 0;
const NO_BLOCKS: SyntenyBlockBp[] = [];

// Block score color scale
function blockScoreColor(score: number): string {
  if (score >= 0.8) return '#22c55e'; // Green - high conservation
  if (score >= 0.5) return '#eab308'; // Yellow - moderate
  return '#ef4444'; // Red - weak
}

// Orientation color
function orientationColor(orientation: 'forward' | 'reverse'): string {
  return orientation === 'forward' ? '#3b82f6' : '#ef4444';
}

// Heatmap color scale (gene similarity)
const similarityColorScale: ColorScale = (value: number): string => {
  // value is 0-1 normalized
  if (value >= 0.8) return '#22c55e';
  if (value >= 0.5) return '#eab308';
  if (value >= 0.2) return '#f59e0b';
  if (value > 0) return '#6b7280';
  return '#1e293b';
};

interface SyntenyOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function SyntenyOverlay({
  repository,
  currentPhage,
}: SyntenyOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('synteny');
  const referenceSelectId = 'synteny-reference-phage';
  const open = isOpen('synteny');

  const [catalog, setCatalog] = useState<{
    repository: PhageRepository; revision: number; phages: Array<{ id: number; name: string }>; error: string | null;
  } | null>(null);
  const [referencePhageId, setReferencePhageId] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<OwnedSynteny | null>(null);
  const [revision, setRevision] = useState(0);
  const source = useRef({ repository, currentPhage, referencePhageId, revision, open });
  source.current = { repository, currentPhage, referencePhageId, revision, open };
  const owned = open && analysis?.repository === repository && analysis.selectedQuery === currentPhage
    && analysis.referenceId === referencePhageId && analysis.revision === revision ? analysis : null;
  const queryPhage = owned?.query ?? null;
  const referencePhage = owned?.reference ?? null;
  const heatmap = owned?.payload?.heatmap ?? null;
  const blocks = owned?.payload?.blocksBp ?? NO_BLOCKS;
  const stats = owned?.payload?.stats ?? null;
  const currentCatalog = catalog?.repository === repository && catalog.revision === revision ? catalog : null;
  const phages = currentCatalog?.phages ?? [];
  const error = currentCatalog?.error ?? owned?.error ?? null;
  const loading = Boolean(open && repository && currentPhage && referencePhageId !== null && (!owned || owned.loading));

  // Hover states
  const [heatmapHover, setHeatmapHover] = useState<HeatmapHover | null>(null);
  const [trackHover, setTrackHover] = useState<GenomeTrackInteraction | null>(null);
  const [selectedBlockState, setSelectedBlock] = useState<SyntenyBlockBp | null>(null);
  const selectedBlock = selectedBlockState && blocks.includes(selectedBlockState) ? selectedBlockState : null;

  // Hotkey to toggle overlay (Alt+S)
  useHotkey(
    ActionIds.OverlaySynteny,
    () => toggle('synteny'),
    { modes: ['NORMAL'] }
  );

  // A list from a previous repository must not select an unrelated reused ID.
  useEffect(() => {
    setCatalog(null);
    if (!open || !repository) return;
    let cancelled = false;
    repository.listPhages()
      .then((list) => {
        if (cancelled) return;
        setCatalog({ repository, revision, phages: list.map(p => ({ id: p.id, name: p.name })), error: null });
        setReferencePhageId(previous => previous !== null && list.some(p => p.id === previous) ? previous : null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalog({ repository, revision, phages: [], error: err instanceof Error ? err.message : 'Failed to list phages' });
      });
    return () => {
      cancelled = true;
    };
  }, [open, repository, revision]);

  // Metadata reads, worker computation and all displayed details share one owner.
  // In particular, never compute a new query against a reference retained while
  // its replacement is still loading from a different repository.
  useEffect(() => {
    setHeatmapHover(null); setTrackHover(null); setSelectedBlock(null);
    if (!open || !repository || !currentPhage || referencePhageId === null
      || catalog?.repository !== repository || catalog.revision !== revision || catalog.error
      || !catalog.phages.some(phage => phage.id === referencePhageId)) {
      setAnalysis(null);
      return;
    }
    const controller = new AbortController();
    const owner = { repository, selectedQuery: currentPhage, referenceId: referencePhageId, revision };
    const current = () => !controller.signal.aborted && source.current.open
      && source.current.repository === repository && source.current.currentPhage === currentPhage
      && source.current.referencePhageId === referencePhageId && source.current.revision === revision;
    setAnalysis({ ...owner, query: null, reference: null, payload: null, loading: true, error: null });
    void (async () => {
      try {
        if (referencePhageId === currentPhage.id) throw new Error('Select a reference different from the current query.');
        const [query, reference] = await Promise.all([
          repository.getPhageById(currentPhage.id), repository.getPhageById(referencePhageId),
        ]);
        if (!current()) return;
        if (!query || !reference) throw new Error('A selected genome is no longer available. Select the genomes again.');
        if (query.id !== currentPhage.id || query.accession !== currentPhage.accession || reference.id !== referencePhageId) {
          throw new Error('The loaded genomes do not match the selected sources.');
        }
        if (!query.genes?.length || !reference.genes?.length) {
          throw new Error('Both phages need gene annotations for synteny analysis');
        }
        const payload = await runWebSynteny({
          jobId: `synteny-${++nextSyntenyJob}`,
          query: { id: query.id, name: query.name, length: query.genomeLength },
          reference: { id: reference.id, name: reference.name, length: reference.genomeLength },
          genesQuery: query.genes, genesReference: reference.genes,
        }, controller.signal);
        if (current()) setAnalysis({ ...owner, query, reference, payload, loading: false, error: null });
      } catch (cause) {
        if (current()) setAnalysis({ ...owner, query: null, reference: null, payload: null, loading: false,
          error: cause instanceof Error ? cause.message : 'Synteny analysis failed' });
      }
    })();
    return () => { controller.abort(); };
  }, [open, repository, currentPhage, referencePhageId, revision, catalog]);

  // Convert blocks to track segments for query genome
  const queryBlockSegments = useMemo((): GenomeTrackSegment[] => {
    return blocks.map((block, idx) => ({
      start: block.startBpQuery,
      end: block.endBpQuery,
      label: `Block ${idx + 1} (${block.orientation})`,
      color: orientationColor(block.orientation),
      height: Math.max(10, Math.min(24, block.score * 24)),
      data: block,
    }));
  }, [blocks]);

  // Convert blocks to track segments for reference genome
  const referenceBlockSegments = useMemo((): GenomeTrackSegment[] => {
    return blocks.map((block, idx) => ({
      start: block.startBpReference,
      end: block.endBpReference,
      label: `Block ${idx + 1} (${block.orientation})`,
      color: orientationColor(block.orientation),
      height: Math.max(10, Math.min(24, block.score * 24)),
      data: block,
    }));
  }, [blocks]);

  // Handle track click
  const handleTrackClick = useCallback((info: GenomeTrackInteraction) => {
    if (info.segment?.data) {
      setSelectedBlock(info.segment.data as SyntenyBlockBp);
    }
  }, []);

  // Handle heatmap click
  const handleHeatmapClick = useCallback(
    (hover: HeatmapHover) => {
      // Find block containing this gene pair
      const block = blocks.find(
        (b) =>
          hover.row >= b.startIdxQuery &&
          hover.row <= b.endIdxQuery &&
          hover.col >= b.startIdxReference &&
          hover.col <= b.endIdxReference
      );
      if (block) {
        setSelectedBlock(block);
      }
    },
    [blocks]
  );

  // Get gene label for hover info
  const getGeneLabel = useCallback(
    (genes: GeneInfo[], index: number): string => {
      const gene = genes[index];
      if (!gene) return `Gene ${index + 1}`;
      return gene.name || gene.locusTag || gene.product || `Gene ${index + 1}`;
    },
    []
  );

  if (!open) return null;

  const queryGenes = (queryPhage ?? currentPhage)?.genes ?? [];
  const referenceGenes = referencePhage?.genes ?? [];

  return (
    <Overlay id="synteny" title="SYNTENY ANALYSIS" hotkey="Alt+S" size="lg">
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
            <strong style={{ color: colors.accent }}>Synteny Analysis</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about synteny"
                tooltip={overlayHelp?.summary ?? 'Synteny describes conservation of gene order between genomes.'}
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'synteny')}
              />
            )}
          </div>
          <div>
            Compares gene order conservation between two phage genomes. Syntenic blocks indicate
            conserved functional modules and evolutionary relationships. Blue = forward orientation,
            Red = inverted.
          </div>
        </div>

        {/* Reference phage selector */}
        <div
          style={{
            display: 'flex',
            gap: '1rem',
            alignItems: 'center',
            fontSize: '0.85rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label htmlFor={referenceSelectId} style={{ color: colors.textMuted }}>
              Reference Phage:
            </label>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Why choose a reference?"
                tooltip="Synteny compares your current phage to a reference to highlight conserved gene order and rearrangements."
                onClick={() => showContextFor('synteny')}
              />
            )}
            <select
              id={referenceSelectId}
              value={referencePhageId ?? ''}
              onChange={(e) => setReferencePhageId(e.target.value ? Number(e.target.value) : null)}
              style={{
                padding: '0.25rem',
                backgroundColor: colors.backgroundAlt,
                color: colors.text,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '3px',
                minWidth: '200px',
              }}
            >
              <option value="">Select a phage...</option>
              {phages
                .filter((p) => p.id !== currentPhage?.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>

          {currentPhage && (
            <span style={{ color: colors.textDim }}>
              Query: {(queryPhage ?? currentPhage).name} ({queryGenes.length} genes)
            </span>
          )}
        </div>

        {!repository || !currentPhage ? (
          <p role="status">{!repository ? 'Database is still loading.' : 'Select a query phage to compare.'}</p>
        ) : error ? (
          <>
            <OverlayErrorState message="Analysis failed" details={error} />
            <button type="button" onClick={() => setRevision(value => value + 1)}>Retry synteny analysis</button>
          </>
        ) : loading ? (
          <OverlayLoadingState message="Computing gene similarity matrix...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : !referencePhage ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            Select a reference phage to compare
          </div>
        ) : (
          <>
            {/* Statistics */}
            {stats && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                  gap: '0.75rem',
                  fontSize: '0.8rem',
                }}
              >
                <div
                  style={{
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: colors.textMuted }}>Synteny Blocks</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: colors.accent }}>
                    {stats.blockCount}
                  </div>
                </div>
                <div
                  style={{
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: colors.textMuted }}>Global Score</div>
                  <div
                    style={{
                      fontSize: '1.2rem',
                      fontWeight: 'bold',
                      color: blockScoreColor(stats.globalScore),
                    }}
                  >
                    {(stats.globalScore * 100).toFixed(1)}%
                  </div>
                </div>
                <div
                  style={{
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: colors.textMuted }}>Query Coverage</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: colors.text }}>
                    {((stats.coverageQuery / (queryPhage?.genomeLength || 1)) * 100).toFixed(1)}%
                  </div>
                </div>
                <div
                  style={{
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: colors.textMuted }}>DTW Distance</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: colors.text }}>
                    {stats.dtwDistance.toFixed(2)}
                  </div>
                </div>
                <div
                  style={{
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ color: colors.textMuted }}>Continuity (SCS)</div>
                  <div
                    style={{
                      fontSize: '1.2rem',
                      fontWeight: 'bold',
                      color: blockScoreColor(stats.scsScore ?? stats.globalScore),
                    }}
                    title="Synteny Continuity Score (SCS): measures modular order preservation penalized by block fragmentation"
                  >
                    {((stats.scsScore ?? stats.globalScore) * 100).toFixed(1)}%
                  </div>
                </div>
              </div>
            )}

            {/* Rearrangement breakpoint summary banner */}
            {stats && (Boolean(stats.inversionCount) || Boolean(stats.translocationCount)) && (
              <div
                style={{
                  display: 'flex',
                  gap: '0.75rem',
                  fontSize: '0.75rem',
                  padding: '0.4rem 0.6rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  border: `1px solid ${colors.borderLight}`,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontWeight: 600, color: colors.textDim }}>Rearrangements:</span>
                {Boolean(stats.inversionCount) && (
                  <span style={{ color: '#ef4444', fontWeight: 600 }}>
                    ↺ {stats.inversionCount} Inversion{stats.inversionCount! > 1 ? 's' : ''}
                  </span>
                )}
                {Boolean(stats.translocationCount) && (
                  <span style={{ color: '#f59e0b', fontWeight: 600 }}>
                    ⇄ {stats.translocationCount} Translocation{stats.translocationCount! > 1 ? 's' : ''}
                  </span>
                )}
                {Boolean(stats.indelCount) && (
                  <span style={{ color: colors.textMuted }}>
                    ⇥ {stats.indelCount} Indel Gap{stats.indelCount! > 1 ? 's' : ''}
                  </span>
                )}
              </div>
            )}

            {/* Gene Similarity Heatmap */}
            {heatmap && heatmap.rows > 0 && heatmap.cols > 0 && (
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
                  <span>Gene Similarity Matrix ({queryGenes.length} × {referenceGenes.length})</span>
                  {beginnerModeEnabled && (
                    <InfoButton
                      size="sm"
                      label="What is this matrix?"
                      tooltip="Each cell reflects similarity between a query gene and a reference gene; blocks of high similarity suggest conserved modules."
                      onClick={() => showContextFor('synteny')}
                    />
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <HeatmapCanvas
                    width={Math.min(400, Math.max(200, heatmap.cols * 4))}
                    height={Math.min(300, Math.max(150, heatmap.rows * 4))}
                    matrix={{
                      rows: heatmap.rows,
                      cols: heatmap.cols,
                      values: heatmap.values,
                      min: heatmap.min,
                      max: heatmap.max,
                    }}
                    colorScale={similarityColorScale}
                    onHover={setHeatmapHover}
                    onClick={handleHeatmapClick}
                    ariaLabel="Gene similarity heatmap"
                  />
                  {/* Color legend */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.7rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ width: '12px', height: '12px', backgroundColor: '#22c55e' }} />
                      <span style={{ color: colors.textMuted }}>High (&gt;80%)</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ width: '12px', height: '12px', backgroundColor: '#eab308' }} />
                      <span style={{ color: colors.textMuted }}>Medium (50-80%)</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ width: '12px', height: '12px', backgroundColor: '#f59e0b' }} />
                      <span style={{ color: colors.textMuted }}>Low (20-50%)</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ width: '12px', height: '12px', backgroundColor: '#1e293b' }} />
                      <span style={{ color: colors.textMuted }}>None</span>
                    </div>
                  </div>
                </div>
                {/* Heatmap hover info */}
                {heatmapHover && (
                  <div
                    style={{
                      marginTop: '0.5rem',
                      padding: '0.5rem',
                      backgroundColor: colors.backgroundAlt,
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                    }}
                  >
                    Query: {getGeneLabel(queryGenes, heatmapHover.row)} | Reference:{' '}
                    {getGeneLabel(referenceGenes, heatmapHover.col)} | Similarity:{' '}
                    {(heatmapHover.value * 100).toFixed(1)}%
                  </div>
                )}
              </div>
            )}

            {/* Query genome track */}
            {queryPhage && (
              <div>
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: colors.textMuted,
                    marginBottom: '0.25rem',
                  }}
                >
                  Query: {queryPhage.name} - Synteny Blocks
                </div>
                <GenomeTrack
                  genomeLength={queryPhage.genomeLength || 1}
                  segments={queryBlockSegments}
                  width={540}
                  height={50}
                  onHover={setTrackHover}
                  onClick={handleTrackClick}
                  ariaLabel="Query genome synteny blocks"
                />
              </div>
            )}

            {/* Reference genome track */}
            {referencePhage && (
              <div>
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: colors.textMuted,
                    marginBottom: '0.25rem',
                  }}
                >
                  Reference: {referencePhage.name} - Synteny Blocks
                </div>
                <GenomeTrack
                  genomeLength={referencePhage.genomeLength ?? 1}
                  segments={referenceBlockSegments}
                  width={540}
                  height={50}
                  onHover={setTrackHover}
                  onClick={handleTrackClick}
                  ariaLabel="Reference genome synteny blocks"
                />
              </div>
            )}

            {/* Track hover info */}
            {trackHover && (
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                }}
              >
                Position: {Math.round(trackHover.position).toLocaleString()} bp
                {trackHover.segment && (
                  <span style={{ marginLeft: '1rem', color: colors.textMuted }}>
                    {trackHover.segment.label}
                  </span>
                )}
              </div>
            )}

            {/* Selected block details */}
            {selectedBlock && (
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.backgroundAlt,
                  border: `1px solid ${orientationColor(selectedBlock.orientation)}`,
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
                      Synteny Block Details
                    </div>
                    <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                      Query: {selectedBlock.startBpQuery.toLocaleString()} -{' '}
                      {selectedBlock.endBpQuery.toLocaleString()} bp (genes{' '}
                      {selectedBlock.startIdxQuery + 1}-{selectedBlock.endIdxQuery + 1})
                    </div>
                    <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                      Reference: {selectedBlock.startBpReference.toLocaleString()} -{' '}
                      {selectedBlock.endBpReference.toLocaleString()} bp (genes{' '}
                      {selectedBlock.startIdxReference + 1}-{selectedBlock.endIdxReference + 1})
                    </div>
                    <div style={{ marginTop: '0.25rem' }}>
                      <span
                        style={{
                          color: orientationColor(selectedBlock.orientation),
                          fontWeight: 'bold',
                        }}
                      >
                        {selectedBlock.orientation === 'forward' ? 'Forward' : 'Inverted'}
                      </span>
                      <span style={{ color: colors.textDim, marginLeft: '1rem' }}>
                        Score: {(selectedBlock.score * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedBlock(null)}
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

            {/* Legend */}
            <div
              style={{
                display: 'flex',
                gap: '1.5rem',
                fontSize: '0.75rem',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: '#3b82f6',
                    borderRadius: '2px',
                  }}
                />
                <span style={{ color: colors.textMuted, display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  Forward orientation
                  {beginnerModeEnabled && (
                    <InfoButton
                      size="sm"
                      label="What does orientation mean?"
                      tooltip="Forward blocks keep the same gene order; inverted blocks are reversed relative to the reference."
                      onClick={() => showContextFor('synteny')}
                    />
                  )}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: '#ef4444',
                    borderRadius: '2px',
                  }}
                />
                <span style={{ color: colors.textMuted }}>Inverted orientation</span>
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
              <strong>Interpretation:</strong> Syntenic blocks represent conserved gene order
              between phages. Forward blocks (blue) indicate genes in the same relative order.
              Inverted blocks (red) suggest genome rearrangements. High global scores indicate
              close evolutionary relationships and conserved functional modules.
              {' '}
              <span style={{ opacity: 0.85 }}>
                Blocks are matched on gene product names, and roughly two thirds of genes in
                this catalogue are annotated only as &ldquo;hypothetical protein&rdquo;. An
                inversion is therefore only detectable where several consecutive genes on both
                sides carry informative names, which is uncommon here. Absence of red blocks is
                not evidence that no rearrangement exists.
              </span>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default SyntenyOverlay;
