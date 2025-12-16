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
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';

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

  for (let i = 0; i < seq.length - windowSize; i += windowSize / 4) {
    const window = seq.slice(i, i + windowSize);
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
    { key: 'b' },
    'DNA Bendability',
    () => toggle('bendability'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'intermediate' }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('bendability')) return;
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

    // Draw heatmap-style bars
    const barWidth = width / bendability.length;
    for (let i = 0; i < bendability.length; i++) {
      const normalized = (bendability[i] - min) / range;
      const x = i * barWidth;

      // Color gradient from blue (rigid) to red (flexible)
      const r = Math.round(normalized * 255);
      const b = Math.round((1 - normalized) * 255);
      ctx.fillStyle = `rgb(${r}, 80, ${b})`;
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Loading State */}
        {loading && (
          <AnalysisPanelSkeleton message="Loading sequence data..." rows={3} />
        )}

        {/* Description */}
        {!loading && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.9rem',
          }}>
            <strong style={{ color: colors.primary }}>DNA Bendability</strong> predicts local flexibility based on
            dinucleotide step parameters. Flexible regions (red) may be involved in protein binding,
            nucleosome positioning, or regulatory functions.
          </div>
        )}

        {/* Stats */}
        {!loading && bendability.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '1rem',
          }}>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Average</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.25rem' }}>{avg}</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.error, fontSize: '0.75rem' }}>Most Flexible</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.25rem' }}>{maxBend}</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.info, fontSize: '0.75rem' }}>Most Rigid</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.25rem' }}>{minBend}</div>
            </div>
          </div>
        )}

        {/* Canvas */}
        {!loading && bendability.length >= 2 && (
          <div style={{
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '4px',
            overflow: 'hidden',
          }}>
            <canvas
              ref={canvasRef}
              style={{ width: '100%', height: '150px', display: 'block' }}
            />
          </div>
        )}

        {/* Legend */}
        {!loading && bendability.length >= 2 && (
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.5rem',
          }}>
            <span style={{ color: colors.info }}>Rigid</span>
            <div style={{
              width: '200px',
              height: '12px',
              background: 'linear-gradient(to right, rgb(0, 80, 255), rgb(128, 80, 128), rgb(255, 80, 0))',
              borderRadius: '4px',
            }} />
            <span style={{ color: colors.error }}>Flexible</span>
          </div>
        )}

        {!loading && sequence.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem', color: colors.textMuted }}>
            No sequence data available. Select a phage to analyze.
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default BendabilityOverlay;
