/**
 * BendabilityOverlay - DNA Bendability Analysis
 *
 * Displays DNA curvature and flexibility predictions.
 */

import React, { useEffect, useRef, useMemo, useState } from 'react';
import type { PhageFull } from '@phage-explorer/core';
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
  OverlayDescription,
  OverlaySection,
  OverlayStack,
  OverlayStatCard,
  OverlayStatGrid,
} from './primitives';

interface BendabilityOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Dinucleotide bendability values (simplified model)
const BENDABILITY: Record<string, number> = {
  'AA': 0.35, 'AT': 0.31, 'AC': 0.32, 'AG': 0.29,
  'TA': 0.36, 'TT': 0.35, 'TC': 0.30, 'TG': 0.27,
  'CA': 0.27, 'CT': 0.29, 'CC': 0.25, 'CG': 0.20,
  'GA': 0.30, 'GT': 0.32, 'GC': 0.24, 'GG': 0.25,
};

// Calculate bendability profile
function calculateBendability(sequence: string, windowSize = 50): number[] {
  const values: number[] = [];
  const seq = sequence.toUpperCase();
  const windowSizeInt = Math.max(1, Math.floor(windowSize));
  const stepSize = Math.max(1, Math.floor(windowSizeInt / 4));

  for (let i = 0; i <= seq.length - windowSizeInt; i += stepSize) {
    const window = seq.slice(i, i + windowSizeInt);
    let sum = 0;
    let count = 0;

    for (let j = 0; j < window.length - 1; j++) {
      const di = window[j] + window[j + 1];
      if (BENDABILITY[di] !== undefined) {
        sum += BENDABILITY[di];
        count++;
      }
    }

    values.push(count > 0 ? sum / count : 0.3);
  }

  return values;
}

type Rgb = { r: number; g: number; b: number };

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseCssColorToRgb(color: string): Rgb | null {
  const trimmed = color.trim();

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
      return { r, g, b };
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
      return { r, g, b };
    }
    return null;
  }

  const rgbMatch = trimmed.match(
    /^rgba?\(\s*(?<r>\d{1,3})\s*,\s*(?<g>\d{1,3})\s*,\s*(?<b>\d{1,3})(?:\s*,\s*(?<a>[\d.]+))?\s*\)$/i
  );
  if (!rgbMatch?.groups) return null;

  const r = Number(rgbMatch.groups.r);
  const g = Number(rgbMatch.groups.g);
  const b = Number(rgbMatch.groups.b);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r: clampChannel(r), g: clampChannel(g), b: clampChannel(b) };
}

function lerpColor(a: Rgb, b: Rgb, t: number): string {
  const clampedT = Math.max(0, Math.min(1, t));
  const r = clampChannel(a.r + (b.r - a.r) * clampedT);
  const g = clampChannel(a.g + (b.g - a.g) * clampedT);
  const bChannel = clampChannel(a.b + (b.b - a.b) * clampedT);
  return `rgb(${r}, ${g}, ${bChannel})`;
}

export function BendabilityOverlay({
  repository,
  currentPhage,
}: BendabilityOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Hotkey to toggle overlay
  useHotkey(
    ActionIds.OverlayBendability,
    () => toggle('bendability'),
    { modes: ['NORMAL'] }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('bendability')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    // Check cache
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

  const bendability = useMemo(() => calculateBendability(sequence), [sequence]);

  // Draw visualization
  useEffect(() => {
    // Need at least 2 data points to draw lines and avoid division by zero
    if (!isOpen('bendability') || !canvasRef.current || bendability.length < 2) return;

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

    // Find range
    const min = Math.min(...bendability);
    const max = Math.max(...bendability);
    const range = max - min || 1;

    const rigidRgb = parseCssColorToRgb(colors.info) ?? { r: 0, g: 80, b: 255 };
    const flexibleRgb = parseCssColorToRgb(colors.error) ?? { r: 255, g: 80, b: 0 };

    // Draw heatmap-style bars
    const barWidth = width / bendability.length;
    for (let i = 0; i < bendability.length; i++) {
      const normalized = (bendability[i] - min) / range;
      const x = i * barWidth;

      // Color gradient from rigid (low) to flexible (high)
      ctx.fillStyle = lerpColor(rigidRgb, flexibleRgb, normalized);
      ctx.fillRect(x, 0, barWidth + 1, height);
    }

    // Overlay line graph
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 2;

    for (let i = 0; i < bendability.length; i++) {
      const x = (i / (bendability.length - 1)) * width;
      const normalized = (bendability[i] - min) / range;
      const y = height - normalized * height;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [isOpen, bendability, colors]);

  if (!isOpen('bendability')) {
    return null;
  }

  const avg = bendability.length > 0
    ? (bendability.reduce((a, b) => a + b, 0) / bendability.length).toFixed(3)
    : '0.000';
  const maxBend = bendability.length > 0 ? Math.max(...bendability).toFixed(3) : '0.000';
  const minBend = bendability.length > 0 ? Math.min(...bendability).toFixed(3) : '0.000';

  return (
    <Overlay
      id="bendability"
      title="DNA BENDABILITY"
      hotkey="b"
      size="lg"
    >
      <OverlayStack>
        {/* Loading State */}
        {loading && (
          <OverlayLoadingState message="Loading sequence data...">
            <AnalysisPanelSkeleton rows={3} />
          </OverlayLoadingState>
        )}

        {/* Description */}
        {!loading && (
          <OverlayDescription title="DNA Bendability">
            Predicts local flexibility based on dinucleotide step parameters. Flexible regions (red) may be involved
            in protein binding, nucleosome positioning, or regulatory functions.
          </OverlayDescription>
        )}

        {/* Stats */}
        {!loading && bendability.length > 0 && (
          <OverlayStatGrid>
            <OverlayStatCard label="Average" value={avg} />
            <OverlayStatCard label="Most Flexible" value={maxBend} labelColor="var(--color-error)" />
            <OverlayStatCard label="Most Rigid" value={minBend} labelColor="var(--color-info)" />
          </OverlayStatGrid>
        )}

        {/* Canvas */}
        {!loading && bendability.length >= 2 && (
          <OverlaySection>
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="DNA bendability graph showing flexibility profile across genome position"
              style={{ width: '100%', height: '150px', display: 'block' }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 'var(--chrome-gap)',
                padding: 'var(--chrome-padding-compact-y) var(--chrome-padding-x)',
              }}
            >
              <span style={{ color: 'var(--color-info)' }}>Rigid</span>
              <div
                style={{
                  width: '200px',
                  height: '12px',
                  background: 'linear-gradient(to right, var(--color-info), var(--color-error))',
                  borderRadius: 'var(--radius-sm)',
                }}
              />
              <span style={{ color: 'var(--color-error)' }}>Flexible</span>
            </div>
          </OverlaySection>
        )}

        {!loading && sequence.length === 0 && (
          <OverlayEmptyState
            message="No sequence data available."
            hint="Select a phage to analyze."
          />
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default BendabilityOverlay;
