/**
 * DotPlotOverlay - Self-Similarity Matrix Visualization
 *
 * Visualizes genome self-similarity through dot plot matrix analysis,
 * revealing repeats, palindromes, and internal duplications.
 *
 * Features:
 * - Direct repeat detection (forward matches)
 * - Inverted repeat detection (reverse complement)
 * - Interactive hover for position details
 * - Toggle between direct and inverted views
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import {
  OverlayStack,
  OverlayDescription,
  OverlayToolbar,
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { HeatmapCanvas } from '../primitives/HeatmapCanvas';
import type { HeatmapHover, ColorScale } from '../primitives/types';
import type { DotPlotWorkerResponse } from '../../workers/types';
import { SharedSequencePool } from '../../workers/SharedSequencePool';

// Color scales for direct vs inverted
const directColorScale: ColorScale = (value: number): string => {
  if (value >= 0.95) return '#22c55e'; // Green - high identity
  if (value >= 0.8) return '#3b82f6'; // Blue
  if (value >= 0.6) return '#6366f1'; // Indigo
  if (value >= 0.4) return '#8b5cf6'; // Purple
  if (value >= 0.2) return '#4b5563'; // Gray
  return '#1e293b'; // Dark
};

const invertedColorScale: ColorScale = (value: number): string => {
  if (value >= 0.95) return '#ef4444'; // Red - high identity
  if (value >= 0.8) return '#f59e0b'; // Orange
  if (value >= 0.6) return '#eab308'; // Yellow
  if (value >= 0.4) return '#84cc16'; // Lime
  if (value >= 0.2) return '#4b5563'; // Gray
  return '#1e293b'; // Dark
};

type ViewMode = 'direct' | 'inverted' | 'combined';

interface DotPlotOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function DotPlotOverlay({
  repository,
  currentPhage,
}: DotPlotOverlayProps): React.ReactElement | null {
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('dotPlot');
  const workerRef = useRef<Worker | null>(null);
  const sequenceCache = useRef<Map<number, string>>(new Map());

  // State
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [computeLoading, setComputeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sequence, setSequence] = useState<string>('');
  const loading = sequenceLoading || computeLoading;

  // Analysis results
  const [directValues, setDirectValues] = useState<Float32Array | null>(null);
  const [invertedValues, setInvertedValues] = useState<Float32Array | null>(null);
  const [bins, setBins] = useState(0);
  const [windowSize, setWindowSize] = useState(0);

  // UI state
  const [viewMode, setViewMode] = useState<ViewMode>('combined');
  const [resolution, setResolution] = useState(80);
  const [hoverInfo, setHoverInfo] = useState<HeatmapHover | null>(null);
  const viewSelectId = 'dotplot-view';
  const resolutionSelectId = 'dotplot-resolution';

  // Hotkey to toggle overlay (Alt+O for dOt plot - Alt+D used by ProteinDomainOverlay)
  useHotkey(
    ActionIds.OverlayDotPlot,
    () => toggle('dotPlot'),
    { modes: ['NORMAL'] }
  );

  // Initialize worker
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('../../workers/dotplot.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      try {
        worker = new Worker(new URL('../../workers/dotplot.worker.ts', import.meta.url));
      } catch {
        // Both worker variants failed; leave worker null.
      }
    }
    if (worker) workerRef.current = worker;
    return () => {
      worker?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Fetch full genome when overlay opens
  useEffect(() => {
    if (!isOpen('dotPlot')) {
      setSequenceLoading(false);
      return;
    }
    if (!repository || !currentPhage) {
      setSequence('');
      setSequenceLoading(false);
      setComputeLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    // Check cache
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      setSequenceLoading(false);
      return;
    }

    let cancelled = false;
    setSequenceLoading(true);

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
        if (!cancelled) setSequenceLoading(false);
      });

    return () => {
      cancelled = true;
      setSequenceLoading(false);
    };
  }, [isOpen, repository, currentPhage]);

  // Run dot plot analysis when sequence or resolution changes
  useEffect(() => {
    if (!isOpen('dotPlot')) {
      setComputeLoading(false);
      return;
    }
    if (!sequence || sequence.length < 100) {
      setDirectValues(null);
      setInvertedValues(null);
      setComputeLoading(false);
      return;
    }

    const phageId = currentPhage?.id;
    if (phageId !== undefined && sequenceCache.current.get(phageId) !== sequence) {
      return;
    }

    const worker = workerRef.current;
    if (!worker) {
      setComputeLoading(false);
      return;
    }

    let cancelled = false;
    setDirectValues(null);
    setInvertedValues(null);
    setComputeLoading(true);
    setError(null);

    const handleMessage = (event: MessageEvent<DotPlotWorkerResponse>) => {
      const response = event.data;
      if (cancelled) return;
      setComputeLoading(false);

      if (!response.ok) {
        setDirectValues(null);
        setInvertedValues(null);
        setError(response.error ?? 'Dot plot computation failed');
        return;
      }

      if (response.directValues && response.invertedValues) {
        setDirectValues(response.directValues);
        setInvertedValues(response.invertedValues);
        setBins(response.bins ?? 0);
        setWindowSize(response.window ?? 0);
      }
    };

    worker.onmessage = handleMessage;

    if (phageId) {
      const { ref: sequenceRef, transfer } = SharedSequencePool.getInstance().getOrCreateRef(phageId, sequence);
      worker.postMessage({ sequenceRef, config: { bins: resolution } }, transfer);
    } else {
      // Compatibility fallback: unknown phage id; keep string path.
      worker.postMessage({ sequence, config: { bins: resolution } });
    }

    return () => {
      cancelled = true;
      worker.onmessage = null;
      setComputeLoading(false);
    };
  }, [isOpen, sequence, resolution, currentPhage?.id]);

  // Combined values (max of direct and inverted)
  const combinedValues = useMemo(() => {
    if (!directValues || !invertedValues) return null;
    const combined = new Float32Array(directValues.length);
    for (let i = 0; i < directValues.length; i++) {
      combined[i] = Math.max(directValues[i], invertedValues[i]);
    }
    return combined;
  }, [directValues, invertedValues]);

  // Get current display values based on view mode
  const displayValues = useMemo(() => {
    switch (viewMode) {
      case 'direct':
        return directValues;
      case 'inverted':
        return invertedValues;
      case 'combined':
        return combinedValues;
      default:
        return combinedValues;
    }
  }, [viewMode, directValues, invertedValues, combinedValues]);

  // Combined color scale
  const combinedColorScale: ColorScale = useCallback(
    (value: number): string => {
      if (!directValues || !invertedValues || !hoverInfo) {
        // Default coloring when no hover
        if (value >= 0.95) return '#22c55e';
        if (value >= 0.8) return '#3b82f6';
        if (value >= 0.6) return '#6366f1';
        if (value >= 0.4) return '#8b5cf6';
        if (value >= 0.2) return '#4b5563';
        return '#1e293b';
      }
      return directColorScale(value);
    },
    [directValues, invertedValues, hoverInfo]
  );

  // Get color scale based on view mode
  const currentColorScale = useMemo((): ColorScale => {
    switch (viewMode) {
      case 'direct':
        return directColorScale;
      case 'inverted':
        return invertedColorScale;
      case 'combined':
        return combinedColorScale;
      default:
        return combinedColorScale;
    }
  }, [viewMode, combinedColorScale]);

  // Position from bin index
  const binToPosition = useCallback(
    (binIndex: number): number => {
      if (!sequence || bins === 0) return 0;
      return Math.floor((binIndex / bins) * sequence.length);
    },
    [sequence, bins]
  );

  if (!isOpen('dotPlot')) return null;

  const hasData = displayValues && bins > 0;
  const isEmpty = !loading && !error && (!displayValues || bins === 0);

  return (
    <Overlay id="dotPlot" title="DOT PLOT ANALYSIS" hotkey="Alt+O" size="lg">
      <OverlayStack>
        {/* Description */}
        <OverlayDescription
          title="Dot Plot"
          action={beginnerModeEnabled ? (
            <InfoButton
              size="sm"
              label="Learn about dot plots"
              tooltip={overlayHelp?.summary ?? 'Dot plots are self-comparison matrices that reveal repeats and rearrangements.'}
              onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'dot-plot')}
            />
          ) : undefined}
        >
          Self-similarity matrix showing direct repeats (diagonal patterns) and inverted repeats
          (off-diagonal). The main diagonal represents self-identity. Parallel diagonals indicate
          tandem repeats, while perpendicular patterns suggest palindromes or inversions.
        </OverlayDescription>

        {/* Controls */}
        <OverlayToolbar>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label htmlFor={viewSelectId} style={{ color: 'var(--color-text-muted)' }}>
              View:
            </label>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="What are direct vs inverted repeats?"
                tooltip="Switch between direct repeats, inverted repeats, or a combined view to interpret repeat structure."
                onClick={() => showContextFor('dot-plot')}
              />
            )}
            <select
              id={viewSelectId}
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value as ViewMode)}
              style={{
                padding: '0.25rem',
                backgroundColor: 'var(--color-background-alt)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border-light)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <option value="combined">Combined</option>
              <option value="direct">Direct Repeats</option>
              <option value="inverted">Inverted Repeats</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label htmlFor={resolutionSelectId} style={{ color: 'var(--color-text-muted)' }}>
              Resolution:
            </label>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="What does resolution mean?"
                tooltip="Higher resolution uses more bins (smaller windows), showing finer structure but taking longer to compute."
                onClick={() => showContextFor('sliding-window')}
              />
            )}
            <select
              id={resolutionSelectId}
              value={resolution}
              onChange={(e) => setResolution(Number(e.target.value))}
              style={{
                padding: '0.25rem',
                backgroundColor: 'var(--color-background-alt)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border-light)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <option value={40}>Low (40x40)</option>
              <option value={80}>Medium (80x80)</option>
              <option value={120}>High (120x120)</option>
              <option value={200}>Very High (200x200)</option>
            </select>
          </div>

          {currentPhage && (
            <span style={{ color: 'var(--color-text-dim)' }}>
              {currentPhage.name} ({sequence.length.toLocaleString()} bp)
            </span>
          )}
        </OverlayToolbar>

        {/* Loading State */}
        {loading && (
          <OverlayLoadingState message="Computing dot plot...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        )}

        {/* Error State */}
        {error && !loading && (
          <OverlayErrorState message={error} />
        )}

        {/* Empty State */}
        {isEmpty && (
          <OverlayEmptyState
            message={!sequence ? 'No sequence loaded' : 'Sequence too short for analysis'}
            hint="Select a phage with sufficient sequence data."
          />
        )}

        {/* Main Content */}
        {hasData && !loading && !error && (
          <>
            {/* Dot Plot Matrix */}
            <div>
              <div
                style={{
                  display: 'flex',
                  gap: '1rem',
                  alignItems: 'flex-start',
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--color-text-muted)',
                      marginBottom: '0.25rem',
                    }}
                  >
                    {viewMode === 'direct'
                      ? 'Direct Repeats'
                      : viewMode === 'inverted'
                        ? 'Inverted Repeats'
                        : 'Combined View'}{' '}
                    ({bins}x{bins}, window: {windowSize} bp)
                  </div>
                  <HeatmapCanvas
                    width={Math.min(450, bins * 4)}
                    height={Math.min(450, bins * 4)}
                    matrix={{
                      rows: bins,
                      cols: bins,
                      values: displayValues,
                      min: 0,
                      max: 1,
                    }}
                    colorScale={currentColorScale}
                    onHover={setHoverInfo}
                    ariaLabel={`Dot plot ${viewMode} view`}
                  />
                </div>

                {/* Color Legend (vertical swatch) */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                    fontSize: '0.7rem',
                    marginTop: '1.5rem',
                  }}
                >
                  <div style={{ color: 'var(--color-text-muted)', marginBottom: '0.25rem' }}>Identity</div>
                  {viewMode === 'inverted' ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#ef4444' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>&gt;95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#f59e0b' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>80-95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#eab308' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>60-80%</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#22c55e' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>&gt;95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#3b82f6' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>80-95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#6366f1' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>60-80%</span>
                      </div>
                    </>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{ width: '12px', height: '12px', backgroundColor: '#4b5563' }} />
                    <span style={{ color: 'var(--color-text-muted)' }}>20-40%</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{ width: '12px', height: '12px', backgroundColor: '#1e293b' }} />
                    <span style={{ color: 'var(--color-text-muted)' }}>&lt;20%</span>
                  </div>
                </div>
              </div>

              {/* Hover info */}
              {hoverInfo && (
                <div
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.5rem',
                    backgroundColor: 'var(--color-background-alt)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.75rem',
                  }}
                >
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    Position X: {binToPosition(hoverInfo.col).toLocaleString()} bp | Position Y:{' '}
                    {binToPosition(hoverInfo.row).toLocaleString()} bp
                  </span>
                  <span style={{ marginLeft: '1rem', fontWeight: 'bold' }}>
                    Identity: {(hoverInfo.value * 100).toFixed(1)}%
                  </span>
                </div>
              )}
            </div>

            {/* Interpretation guide */}
            <OverlayDescription
              title="Reading the plot:"
              action={beginnerModeEnabled ? (
                <InfoButton
                  size="sm"
                  label="Dot plot interpretation tips"
                  tooltip="Use the diagonal as a reference; parallel lines indicate repeats and off-diagonals can indicate inversions."
                  onClick={() => showContextFor('dot-plot')}
                />
              ) : undefined}
              style={{ fontSize: '0.75rem' }}
            >
              <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0 }}>
                <li><strong>Main diagonal</strong>: Self-identity (always bright)</li>
                <li><strong>Parallel diagonals</strong>: Direct repeats (tandem duplications)</li>
                <li><strong>Perpendicular lines</strong>: Inverted repeats (palindromes)</li>
                <li><strong>Terminal patterns</strong>: May indicate terminal repeats for packaging</li>
              </ul>
            </OverlayDescription>
          </>
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default DotPlotOverlay;
