/**
 * GCSkewOverlay - GC Skew Analysis Visualization
 *
 * Displays cumulative GC skew plot for origin/terminus detection.
 * Uses canvas for the sparkline visualization.
 */

import React, { useEffect, useRef, useMemo } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

interface GCSkewOverlayProps {
  sequence?: string;
}

// Calculate GC skew values
function calculateGCSkew(sequence: string, windowSize = 1000): { skew: number[]; cumulative: number[] } {
  if (!sequence || sequence.length === 0) {
    return { skew: [], cumulative: [] };
  }

  const skew: number[] = [];
  const cumulative: number[] = [];
  let cumSum = 0;

  for (let i = 0; i < sequence.length - windowSize; i += windowSize) {
    const window = sequence.slice(i, i + windowSize).toUpperCase();
    let g = 0, c = 0;

    for (const base of window) {
      if (base === 'G') g++;
      else if (base === 'C') c++;
    }

    const gcSkew = (g + c > 0) ? (g - c) / (g + c) : 0;
    skew.push(gcSkew);
    cumSum += gcSkew;
    cumulative.push(cumSum);
  }

  return { skew, cumulative };
}

// Find min/max positions
function findExtrema(values: number[]): { minIdx: number; maxIdx: number; min: number; max: number } {
  let minIdx = 0, maxIdx = 0;
  let min = Infinity, max = -Infinity;

  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) {
      min = values[i];
      minIdx = i;
    }
    if (values[i] > max) {
      max = values[i];
      maxIdx = i;
    }
  }

  return { minIdx, maxIdx, min, max };
}

export function GCSkewOverlay({ sequence = '' }: GCSkewOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Calculate GC skew data
  const { skew, cumulative } = useMemo(() => {
    return calculateGCSkew(sequence, 500);
  }, [sequence]);

  const extrema = useMemo(() => {
    return cumulative.length > 0 ? findExtrema(cumulative) : null;
  }, [cumulative]);

  // Register hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        toggle('gcSkew');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  // Draw the sparkline
  useEffect(() => {
    if (!isOpen('gcSkew') || !canvasRef.current || cumulative.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

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
    const { min, max } = extrema || { min: -1, max: 1 };
    const range = Math.max(Math.abs(min), Math.abs(max)) || 1;

    // Draw cumulative skew
    ctx.beginPath();
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2;

    for (let i = 0; i < cumulative.length; i++) {
      const x = (i / (cumulative.length - 1)) * width;
      const normalized = cumulative[i] / range;
      const y = height / 2 - normalized * (height / 2 - 10);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Mark origin (minimum) and terminus (maximum)
    if (extrema) {
      const drawMarker = (idx: number, color: string, label: string) => {
        const x = (idx / (cumulative.length - 1)) * width;
        const normalized = cumulative[idx] / range;
        const y = height / 2 - normalized * (height / 2 - 10);

        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        ctx.font = '12px monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.fillText(label, x, y - 12);
      };

      drawMarker(extrema.minIdx, colors.error, 'ori');
      drawMarker(extrema.maxIdx, colors.success, 'ter');
    }
  }, [isOpen, cumulative, extrema, colors]);

  if (!isOpen('gcSkew')) {
    return null;
  }

  const windowSize = 500;
  const genomeLength = sequence.length;

  return (
    <Overlay
      id="gcSkew"
      title="GC SKEW ANALYSIS"
      icon="📈"
      hotkey="g"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Description */}
        <div style={{
          padding: '0.75rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
          color: colors.textDim,
          fontSize: '0.9rem',
        }}>
          <strong style={{ color: colors.primary }}>Cumulative GC Skew</strong> helps identify the origin (ori) and terminus (ter) of replication.
          The minimum typically corresponds to the origin, maximum to the terminus.
        </div>

        {/* Stats */}
        {extrema && genomeLength > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '1rem',
          }}>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Genome Length</div>
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>{genomeLength.toLocaleString()} bp</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Window Size</div>
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>{windowSize} bp</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.error, fontSize: '0.75rem' }}>Origin (ori)</div>
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>~{Math.round(extrema.minIdx * windowSize).toLocaleString()} bp</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.success, fontSize: '0.75rem' }}>Terminus (ter)</div>
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>~{Math.round(extrema.maxIdx * windowSize).toLocaleString()} bp</div>
            </div>
          </div>
        )}

        {/* Canvas for sparkline */}
        <div style={{
          border: `1px solid ${colors.borderLight}`,
          borderRadius: '4px',
          overflow: 'hidden',
        }}>
          <canvas
            ref={canvasRef}
            style={{
              width: '100%',
              height: '200px',
              display: 'block',
            }}
          />
        </div>

        {/* Legend */}
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '2rem',
          color: colors.textMuted,
          fontSize: '0.85rem',
        }}>
          <span>
            <span style={{ color: colors.primary }}>━</span> Cumulative GC Skew
          </span>
          <span>
            <span style={{ color: colors.error }}>●</span> Origin (minimum)
          </span>
          <span>
            <span style={{ color: colors.success }}>●</span> Terminus (maximum)
          </span>
        </div>

        {/* No data message */}
        {sequence.length === 0 && (
          <div style={{
            textAlign: 'center',
            padding: '2rem',
            color: colors.textMuted,
          }}>
            No sequence data available. Select a phage to analyze.
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default GCSkewOverlay;
