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
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { HeatmapCanvas } from '../primitives/HeatmapCanvas';
import type { HeatmapHover, ColorScale } from '../primitives/types';

interface DotPlotWorkerResponse {
  ok: boolean;
  directValues?: Float32Array;
  invertedValues?: Float32Array;
  bins?: number;
  window?: number;
  error?: string;
}

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
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const workerRef = useRef<Worker | null>(null);
  const sequenceCache = useRef<Map<number, string>>(new Map());

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sequence, setSequence] = useState<string>('');

  // Analysis results
  const [directValues, setDirectValues] = useState<Float32Array | null>(null);
  const [invertedValues, setInvertedValues] = useState<Float32Array | null>(null);
  const [bins, setBins] = useState(0);
  const [windowSize, setWindowSize] = useState(0);

  // UI state
  const [viewMode, setViewMode] = useState<ViewMode>('combined');
  const [resolution, setResolution] = useState(80);
  const [hoverInfo, setHoverInfo] = useState<HeatmapHover | null>(null);

  // Hotkey to toggle overlay (Alt+D)
  useHotkey(
    { key: 'd', modifiers: { alt: true } },
    'Dot Plot Analysis',
    () => toggle('dotPlot'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Initialize worker
  useEffect(() => {
    const worker = new Worker(
      new URL('../../workers/dotplot.worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Fetch full genome when overlay opens
  useEffect(() => {
    if (!isOpen('dotPlot')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      return;
    }

    const phageId = currentPhage.id;

    // Check cache
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
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

  // Run dot plot analysis when sequence or resolution changes
  useEffect(() => {
    if (!isOpen('dotPlot')) return;
    if (!sequence || sequence.length < 100) {
      setDirectValues(null);
      setInvertedValues(null);
      return;
    }

    const worker = workerRef.current;
    if (!worker) return;

    setLoading(true);
    setError(null);

    const handleMessage = (event: MessageEvent<DotPlotWorkerResponse>) => {
      const response = event.data;
      setLoading(false);

      if (!response.ok) {
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
    worker.postMessage({
      sequence,
      config: { bins: resolution },
    });

    return () => {
      worker.onmessage = null;
    };
  }, [isOpen, sequence, resolution]);

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

  return (
    <Overlay id="dotPlot" title="DOT PLOT ANALYSIS" icon="D" hotkey="Alt+D" size="lg">
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
          <strong style={{ color: colors.accent }}>Dot Plot</strong>: Self-similarity matrix
          showing direct repeats (diagonal patterns) and inverted repeats (off-diagonal). The
          main diagonal represents self-identity. Parallel diagonals indicate tandem repeats,
          while perpendicular patterns suggest palindromes or inversions.
        </div>

        {/* Controls */}
        <div
          style={{
            display: 'flex',
            gap: '1rem',
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: '0.85rem',
          }}
        >
          <label style={{ color: colors.textMuted }}>
            View:
            <select
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value as ViewMode)}
              style={{
                marginLeft: '0.5rem',
                padding: '0.25rem',
                backgroundColor: colors.backgroundAlt,
                color: colors.text,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '3px',
              }}
            >
              <option value="combined">Combined</option>
              <option value="direct">Direct Repeats</option>
              <option value="inverted">Inverted Repeats</option>
            </select>
          </label>

          <label style={{ color: colors.textMuted }}>
            Resolution:
            <select
              value={resolution}
              onChange={(e) => setResolution(Number(e.target.value))}
              style={{
                marginLeft: '0.5rem',
                padding: '0.25rem',
                backgroundColor: colors.backgroundAlt,
                color: colors.text,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '3px',
              }}
            >
              <option value={40}>Low (40x40)</option>
              <option value={80}>Medium (80x80)</option>
              <option value={120}>High (120x120)</option>
              <option value={200}>Very High (200x200)</option>
            </select>
          </label>

          {currentPhage && (
            <span style={{ color: colors.textDim }}>
              {currentPhage.name} ({sequence.length.toLocaleString()} bp)
            </span>
          )}
        </div>

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            Computing dot plot...
          </div>
        ) : error ? (
          <div
            style={{
              padding: '1rem',
              color: '#ef4444',
              backgroundColor: colors.backgroundAlt,
              borderRadius: '4px',
            }}
          >
            {error}
          </div>
        ) : !displayValues || bins === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            {!sequence ? 'No sequence loaded' : 'Sequence too short for analysis'}
          </div>
        ) : (
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
                      color: colors.textMuted,
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

                {/* Legend */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                    fontSize: '0.7rem',
                    marginTop: '1.5rem',
                  }}
                >
                  <div style={{ color: colors.textMuted, marginBottom: '0.25rem' }}>Identity</div>
                  {viewMode === 'inverted' ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span
                          style={{ width: '12px', height: '12px', backgroundColor: '#ef4444' }}
                        />
                        <span style={{ color: colors.textMuted }}>&gt;95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span
                          style={{ width: '12px', height: '12px', backgroundColor: '#f59e0b' }}
                        />
                        <span style={{ color: colors.textMuted }}>80-95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span
                          style={{ width: '12px', height: '12px', backgroundColor: '#eab308' }}
                        />
                        <span style={{ color: colors.textMuted }}>60-80%</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span
                          style={{ width: '12px', height: '12px', backgroundColor: '#22c55e' }}
                        />
                        <span style={{ color: colors.textMuted }}>&gt;95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span
                          style={{ width: '12px', height: '12px', backgroundColor: '#3b82f6' }}
                        />
                        <span style={{ color: colors.textMuted }}>80-95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span
                          style={{ width: '12px', height: '12px', backgroundColor: '#6366f1' }}
                        />
                        <span style={{ color: colors.textMuted }}>60-80%</span>
                      </div>
                    </>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{ width: '12px', height: '12px', backgroundColor: '#4b5563' }} />
                    <span style={{ color: colors.textMuted }}>20-40%</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{ width: '12px', height: '12px', backgroundColor: '#1e293b' }} />
                    <span style={{ color: colors.textMuted }}>&lt;20%</span>
                  </div>
                </div>
              </div>

              {/* Hover info */}
              {hoverInfo && (
                <div
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                  }}
                >
                  <span style={{ color: colors.textMuted }}>
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
            <div
              style={{
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
                fontSize: '0.75rem',
                color: colors.textDim,
              }}
            >
              <strong>Reading the plot:</strong>
              <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0 }}>
                <li>
                  <strong>Main diagonal</strong>: Self-identity (always bright)
                </li>
                <li>
                  <strong>Parallel diagonals</strong>: Direct repeats (tandem duplications)
                </li>
                <li>
                  <strong>Perpendicular lines</strong>: Inverted repeats (palindromes)
                </li>
                <li>
                  <strong>Terminal patterns</strong>: May indicate terminal repeats for
                  packaging
                </li>
              </ul>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default DotPlotOverlay;
