/**
 * ComplexityOverlay - Sequence Complexity Analysis
 *
 * Displays Shannon entropy and linguistic complexity visualization.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { PhageFull } from '@phage-explorer/core';
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
} from './primitives';
import { ChartOverlaySkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { getOrchestrator } from '../../workers/ComputeOrchestrator';
import type { ComplexityResult } from '../../workers/types';

interface ComplexityOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function ComplexityOverlay({
  repository,
  currentPhage,
}: ComplexityOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [entropy, setEntropy] = useState<number[]>([]);
  const [linguistic, setLinguistic] = useState<number[]>([]);
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('complexity');

  // Hotkey to toggle overlay
  useHotkey(
    ActionIds.OverlayComplexity,
    () => toggle('complexity'),
    { modes: ['NORMAL'] }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('complexity')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setEntropy([]);
      setLinguistic([]);
      setSequenceLoading(false);
      setAnalysisLoading(false);
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
    };
  }, [isOpen, repository, currentPhage]);

  // Compute complexity in the analysis worker (WASM-accelerated) to avoid main-thread jank.
  useEffect(() => {
    if (!isOpen('complexity')) return;
    if (!currentPhage) return;

    if (!sequence) {
      setEntropy([]);
      setLinguistic([]);
      setAnalysisLoading(false);
      return;
    }
    if (sequenceCache.current.get(currentPhage.id) !== sequence) {
      return;
    }

    let cancelled = false;
    setAnalysisLoading(true);

    (async () => {
      try {
        const result = await getOrchestrator().runAnalysisWithSharedBuffer(
          currentPhage.id,
          sequence,
          'complexity',
          { windowSize: 100 }
        ) as ComplexityResult;

        if (cancelled) return;
        setEntropy(result.entropy);
        setLinguistic(result.linguistic);
      } catch {
        if (cancelled) return;
        setEntropy([]);
        setLinguistic([]);
      } finally {
        if (!cancelled) setAnalysisLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, currentPhage, sequence]);

  // Draw the visualization
  useEffect(() => {
    // Need at least 2 data points to draw lines and avoid division by zero
    if (!isOpen('complexity') || !canvasRef.current || entropy.length < 2) return;

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

    // Draw entropy
    ctx.beginPath();
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2;

    for (let i = 0; i < entropy.length; i++) {
      const x = (i / (entropy.length - 1)) * width;
      const y = height - entropy[i] * height;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw linguistic complexity
    ctx.beginPath();
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);

    for (let i = 0; i < linguistic.length; i++) {
      const x = (i / (linguistic.length - 1)) * width;
      const y = height - linguistic[i] * height;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Mark low complexity regions
    ctx.fillStyle = 'rgba(231, 111, 81, 0.2)';
    for (let i = 0; i < entropy.length; i++) {
      if (entropy[i] < 0.5) {
        const x = (i / (entropy.length - 1)) * width;
        const barWidth = width / entropy.length;
        ctx.fillRect(x, 0, barWidth, height);
      }
    }
  }, [isOpen, entropy, linguistic, colors]);

  if (!isOpen('complexity')) {
    return null;
  }

  const isLoading = sequenceLoading || analysisLoading;
  const hasData = entropy.length >= 2;
  const isEmpty = !isLoading && (sequence.length === 0 || entropy.length < 2);

  const avgEntropy = entropy.length > 0
    ? (entropy.reduce((a, b) => a + b, 0) / entropy.length).toFixed(3)
    : '0.000';
  const avgLinguistic = linguistic.length > 0
    ? (linguistic.reduce((a, b) => a + b, 0) / linguistic.length).toFixed(3)
    : '0.000';
  const lowComplexityCount = entropy.filter(e => e < 0.5).length;

  return (
    <Overlay
      id="complexity"
      title="SEQUENCE COMPLEXITY"
      hotkey="x"
      size="lg"
    >
      <OverlayStack>
        {/* Loading State */}
        {isLoading && (
          <OverlayLoadingState message={sequenceLoading ? "Loading sequence data..." : "Computing complexity..."}>
            <ChartOverlaySkeleton />
          </OverlayLoadingState>
        )}

        {/* Description */}
        {!isLoading && (
          <OverlayDescription
            title="Sequence Complexity"
            action={beginnerModeEnabled ? (
              <InfoButton
                size="sm"
                label="Learn about sequence complexity"
                tooltip={overlayHelp?.summary ?? 'Sequence complexity measures how repetitive or information-dense a window is.'}
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'sequence-complexity')}
              />
            ) : undefined}
          >
            Measures information content. Low complexity regions (highlighted in red) may indicate repetitive
            sequences, biased composition, or functional elements like promoters.
          </OverlayDescription>
        )}

        {/* Stats - only show when we have valid analysis data */}
        {!isLoading && hasData && (
          <OverlayStatGrid columns={3}>
            <OverlayStatCard
              label={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  Avg Shannon Entropy
                  {beginnerModeEnabled && (
                    <InfoButton
                      size="sm"
                      label="What is Shannon entropy?"
                      tooltip="Shannon entropy measures how unpredictable the base composition is within a window (higher = more diverse)."
                      onClick={() => showContextFor('shannon-entropy')}
                    />
                  )}
                </span>
              }
              value={avgEntropy}
              labelColor="var(--color-primary)"
            />
            <OverlayStatCard
              label={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  Avg Linguistic Complexity
                  {beginnerModeEnabled && (
                    <InfoButton
                      size="sm"
                      label="What is linguistic complexity?"
                      tooltip="Linguistic complexity approximates how many unique k-mers appear in the window (higher = less repetitive)."
                      onClick={() => showContextFor('k-mer')}
                    />
                  )}
                </span>
              }
              value={avgLinguistic}
              labelColor="var(--color-accent)"
            />
            <OverlayStatCard
              label={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  Low Complexity Regions
                  {beginnerModeEnabled && (
                    <InfoButton
                      size="sm"
                      label="What does low complexity mean?"
                      tooltip="Low-complexity windows are more repetitive or compositionally biased; they can coincide with repeats or regulatory motifs."
                      onClick={() => showContextFor('sequence-complexity')}
                    />
                  )}
                </span>
              }
              value={lowComplexityCount}
              labelColor="var(--color-error)"
            />
          </OverlayStatGrid>
        )}

        {/* Canvas */}
        {!isLoading && hasData && (
          <div style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}>
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="Sequence complexity graph showing Shannon entropy across genome position"
              style={{ width: '100%', height: '200px', display: 'block' }}
            />
          </div>
        )}

        {/* Legend */}
        {!isLoading && hasData && (
          <OverlayLegend>
            <OverlayLegendItem indicator="━" color={colors.primary} label="Shannon Entropy" />
            <OverlayLegendItem indicator="┄" color={colors.accent} label="Linguistic Complexity" />
            <OverlayLegendItem indicator="▌" color={colors.error} label="Low Complexity" />
          </OverlayLegend>
        )}

        {/* Empty State */}
        {isEmpty && (
          <OverlayEmptyState
            message={sequence.length === 0
              ? 'No sequence data available.'
              : 'Sequence too short for complexity analysis.'}
            hint={sequence.length === 0 ? 'Select a phage to analyze.' : undefined}
          />
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default ComplexityOverlay;
