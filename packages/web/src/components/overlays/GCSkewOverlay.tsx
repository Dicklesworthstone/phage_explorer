/**
 * GCSkewOverlay - GC Skew Analysis Visualization
 *
 * Displays cumulative GC skew plot for origin/terminus detection.
 * Uses canvas for the sparkline visualization.
 * Demonstrates the overlay chrome primitives pattern.
 */

import React, { useEffect, useRef, useState } from 'react';
import { serializeAnalysisRecord, type PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import {
  OverlayStack,
  OverlayDescription,
  OverlayStatGrid,
  OverlayStatCard,
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayLegend,
  OverlayLegendItem,
  HowDoIKnowThis,
} from './primitives';
import { ChartOverlaySkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { getOrchestrator } from '../../workers/ComputeOrchestrator';
import type { AnalysisResult } from '../../workers/types';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { downloadString } from '../../utils/export';

interface GCSkewOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function GCSkewOverlay({
  repository,
  currentPhage,
}: GCSkewOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sequenceCache = useRef<Map<number, { phage: PhageFull; repository: PhageRepository; sequence: string }>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [resultSnapshot, setResultSnapshot] = useState<{ phage: PhageFull; sequence: string; repository: PhageRepository | null; data: Extract<AnalysisResult, { type: 'gc-skew' }> } | null>(null);
  const result = resultSnapshot?.phage === currentPhage && resultSnapshot?.sequence === sequence && resultSnapshot?.repository === repository ? resultSnapshot.data : null;
  const [exportError, setExportError] = useState<string | null>(null);
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('gcSkew');

  // Hotkey to toggle overlay
  useHotkey(
    ActionIds.OverlayGCSkew,
    () => toggle('gcSkew'),
    { modes: ['NORMAL'] }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('gcSkew')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setResultSnapshot(null);
      setSequenceLoading(false);
      setAnalysisLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    // Check cache
    const cached = sequenceCache.current.get(currentPhage.id);
    if (cached?.phage === currentPhage && cached.repository === repository) {
      setSequence(cached.sequence);
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
        sequenceCache.current.set(currentPhage.id, { phage: currentPhage, repository, sequence: seq });
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
    };
  }, [isOpen, repository, currentPhage]);

  // Compute GC skew in worker
  useEffect(() => {
    if (!isOpen('gcSkew')) return;
    if (!currentPhage) return;

    if (!sequence) {
      setResultSnapshot(null);
      setAnalysisLoading(false);
      return;
    }
    const cached = sequenceCache.current.get(currentPhage.id);
    if (cached?.phage !== currentPhage || cached.repository !== repository || cached.sequence !== sequence) {
      return;
    }

    let cancelled = false;
    setAnalysisLoading(true);

    (async () => {
      try {
        const data = await getOrchestrator().runAnalysisWithSharedBuffer(
          currentPhage.id,
          sequence,
          'gc-skew',
          { windowSize: 500 },
          { accession: currentPhage.accession, source: currentPhage.localGenome ? 'local' : 'catalog' }
        );

        if (cancelled) return;
        if (data.type !== 'gc-skew') throw new Error('Unexpected analysis result.');
        setResultSnapshot({ phage: currentPhage, sequence, repository, data });
      } catch {
        if (cancelled) return;
        setResultSnapshot(null);
      } finally {
        if (!cancelled) setAnalysisLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, currentPhage, repository, sequence]);

  // Draw the sparkline
  useEffect(() => {
    // Need at least 2 data points to draw a line and avoid division by zero
    if (!isOpen('gcSkew') || !canvasRef.current || !result || result.cumulative.length < 2) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;

    // Horizontal center line
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Find range for normalization
    const vals = result.cumulative;
    let min = Infinity;
    let max = -Infinity;
    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = Math.max(Math.abs(min), Math.abs(max)) || 1;

    // Draw cumulative skew
    ctx.beginPath();
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2;

    for (let i = 0; i < vals.length; i++) {
      const x = ((i * 125) / sequence.length) * width;
      const normalized = vals[i] / range;
      const y = height / 2 - normalized * (height / 2 - 10);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Mark origin (minimum) and terminus (maximum)
    // Worker returns originPosition/terminusPosition in base pairs
    // We map BP to X coordinate: (bp / genomeLength) * width
    const len = sequence.length || 1;
    
    if (result.originPosition !== undefined) {
      const oriBp = result.originPosition;
      const x = (oriBp / len) * width;
      const idx = Math.round(oriBp / 125);
      const val = vals[idx] ?? 0;
      const normalized = val / range;
      const y = height / 2 - normalized * (height / 2 - 10);

      drawMarker(ctx, x, y, colors.error, 'ori');
    }

    if (result.terminusPosition !== undefined) {
      const terBp = result.terminusPosition;
      const x = (terBp / len) * width;
      const idx = Math.round(terBp / 125);
      const val = vals[idx] ?? 0;
      const normalized = val / range;
      const y = height / 2 - normalized * (height / 2 - 10);

      drawMarker(ctx, x, y, colors.success, 'ter');
    }

  }, [isOpen, result, sequence.length, colors]);

  function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string) {
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.font = '12px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y - 12);
  }

  if (!isOpen('gcSkew')) {
    return null;
  }

  const windowSize = 500;
  const genomeLength = sequence.length;

  const isLoading = sequenceLoading || analysisLoading;
  const hasGc = /[GC]/i.test(sequence);
  const hasData = result && result.cumulative.length >= 2 && hasGc;
  const isEmpty = !isLoading && (sequence.length === 0 || !result || result.cumulative.length < 2 || !hasGc);

  return (
    <Overlay
      id="gcSkew"
      title="GC SKEW ANALYSIS"
      hotkey="g"
      size="lg"
    >
      <OverlayStack>
        {result?.evidenceRecord && <>
          <button type="button" onClick={() => {
            try {
              downloadString(serializeAnalysisRecord(result.evidenceRecord!), 'gc-skew-analysis.json', 'application/json');
              setExportError(null);
            } catch (error) { setExportError(error instanceof Error ? error.message : 'Could not export analysis.'); }
          }}>Export GC skew experiment</button>
          <AnalysisRecordDetails record={result.evidenceRecord} />
        </>}
        {(result?.evidenceError || exportError) && <p role="alert">{result?.evidenceError ?? exportError}</p>}
        {/* Loading State */}
        {isLoading && (
          <OverlayLoadingState message={sequenceLoading ? "Loading sequence data..." : "Computing GC skew..."}>
            <ChartOverlaySkeleton />
          </OverlayLoadingState>
        )}

        {/* Description */}
        {!isLoading && (
          <OverlayDescription
            title="Cumulative GC Skew"
            action={
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {hasData && currentPhage && (
                  <HowDoIKnowThis
                    title="GC Skew & Cumulative Minimum"
                    computation="Sliding-window nucleotide asymmetry (G - C) / (G + C) across the complete genome, tracking cumulative skew minima and maxima to determine putative replication origin and terminus inflection points."
                    inputs={[
                      { label: 'Genome', value: `${currentPhage.name} (${currentPhage.accession ?? currentPhage.id})` },
                      { label: 'Length', value: `${genomeLength.toLocaleString()} bp` },
                      { label: 'Window Size', value: `${windowSize} bp` },
                      { label: 'Step Size', value: '125 bp' },
                    ]}
                    implementation={{
                      engine:
                        result?.engine === 'wasm-simd'
                          ? 'WASM (SIMD)'
                          : result?.engine === 'wasm-baseline'
                          ? 'WASM (Baseline)'
                          : 'JavaScript',
                      details: result?.engine?.startsWith('wasm')
                        ? 'Compiled Rust WebAssembly kernel compute_gc_skew'
                        : 'TypeScript sliding-window fallback calculateGCSkewJS',
                    }}
                    citation={`GC skew was calculated across the ${currentPhage.name} genome using a 500 bp sliding window (125 bp step) with cumulative asymmetry tracking to determine putative replication origin and terminus inflection points in Phage Explorer.`}
                  />
                )}
                {beginnerModeEnabled ? (
                  <InfoButton
                    size="sm"
                    label="Learn about GC skew"
                    tooltip={overlayHelp?.summary ?? 'GC skew compares the abundance of G vs C bases along the genome.'}
                    onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'gc-skew')}
                  />
                ) : null}
              </div>
            }
          >
            Helps identify the origin (ori) and terminus (ter) of replication. The minimum typically
            corresponds to the origin, maximum to the terminus.
          </OverlayDescription>
        )}

        {/* Stats - only show when we have valid analysis data */}
        {!isLoading && hasData && genomeLength > 0 && (
          <OverlayStatGrid columns={4}>
            <OverlayStatCard label="Genome Length" value={`${genomeLength.toLocaleString()} bp`} />
            <OverlayStatCard label="Window Size" value={`${windowSize} bp`} />
            <OverlayStatCard label="Origin (ori)" value={`~${Math.round(result.originPosition ?? 0).toLocaleString()} bp`} labelColor="var(--color-error)" />
            <OverlayStatCard label="Terminus (ter)" value={`~${Math.round(result.terminusPosition ?? 0).toLocaleString()} bp`} labelColor="var(--color-success)" />
          </OverlayStatGrid>
        )}

        {/* Canvas for sparkline */}
        {!isLoading && hasData && (
          <div style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}>
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="GC skew graph showing cumulative nucleotide bias across genome position"
              style={{
                width: '100%',
                height: '200px',
                display: 'block',
              }}
            />
          </div>
        )}

        {/* Legend */}
        {!isLoading && hasData && (
          <OverlayLegend>
            <OverlayLegendItem
              indicator="━"
              color={colors.primary}
              label="Cumulative GC Skew"
              action={beginnerModeEnabled ? (
                <InfoButton
                  size="sm"
                  label="What is GC skew?"
                  tooltip="GC skew highlights replication patterns by tracking G vs C imbalance along the genome."
                  onClick={() => showContextFor('gc-skew')}
                />
              ) : undefined}
            />
            <OverlayLegendItem
              indicator="●"
              color={colors.error}
              label="Origin (minimum)"
              action={beginnerModeEnabled ? (
                <InfoButton
                  size="sm"
                  label="What is the replication origin?"
                  tooltip="The origin is where DNA replication typically starts; in cumulative skew it often aligns with the minimum."
                  onClick={() => showContextFor('replication-origin')}
                />
              ) : undefined}
            />
            <OverlayLegendItem
              indicator="●"
              color={colors.success}
              label="Terminus (maximum)"
            />
          </OverlayLegend>
        )}

        {/* Empty State */}
        {isEmpty && (
          <OverlayEmptyState
            message={sequence.length === 0
              ? 'No sequence data available.'
              : !hasGc ? 'GC skew is undefined: this sequence has no G or C bases.'
              : 'Two complete 500 bp windows at 125 bp spacing require at least 625 bp.'}
            hint={sequence.length === 0 ? 'Select a phage to analyze.' : undefined}
          />
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default GCSkewOverlay;
