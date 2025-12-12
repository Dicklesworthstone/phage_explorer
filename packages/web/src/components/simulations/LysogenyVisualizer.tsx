/**
 * LysogenyVisualizer - Visualization for Lysogeny Circuit Simulation
 *
 * Displays CI/Cro concentrations and phase diagram.
 */

import React, { useMemo, useRef, useEffect } from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { LysogenyCircuitState } from '../../workers/types';

interface LysogenyVisualizerProps {
  state: LysogenyCircuitState;
  width?: number;
  height?: number;
}

export function LysogenyVisualizer({
  state,
  width = 400,
  height = 200,
}: LysogenyVisualizerProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const ciColor = colors.success;
  const croColor = colors.error;

  const ciCroSpark = useMemo(() => {
    const history = state.history ?? [];
    if (history.length < 2) return '';
    const values = history.map(h => h.ci - h.cro);
    const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const width = 24;
    const trimmed = values.slice(-width);
    const min = Math.min(...trimmed);
    const max = Math.max(...trimmed);
    if (min === max) return bars[0].repeat(trimmed.length);
    return trimmed
      .map(v => {
        const t = (v - min) / (max - min);
        const idx = Math.min(bars.length - 1, Math.max(0, Math.round(t * (bars.length - 1))));
        return bars[idx];
      })
      .join('');
  }, [state.history]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const history = state.history;
    if (history.length === 0) return;

    const padding = { top: 20, right: 20, bottom: 30, left: 40 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Find max values for scaling
    const maxVal = Math.max(
      3,
      Math.max(...history.map(h => h.ci)),
      Math.max(...history.map(h => h.cro))
    );

    // Draw axes
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('0', padding.left - 5, height - padding.bottom);
    ctx.fillText(maxVal.toFixed(1), padding.left - 5, padding.top + 5);

    // X-axis label
    ctx.textAlign = 'center';
    ctx.fillText('Time', width / 2, height - 5);

    // Draw CI line
    ctx.beginPath();
    ctx.strokeStyle = ciColor;
    ctx.lineWidth = 2;
    history.forEach((point, i) => {
      const x = padding.left + (i / (history.length - 1 || 1)) * chartWidth;
      const y = height - padding.bottom - (point.ci / maxVal) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw Cro line
    ctx.beginPath();
    ctx.strokeStyle = croColor;
    ctx.lineWidth = 2;
    history.forEach((point, i) => {
      const x = padding.left + (i / (history.length - 1 || 1)) * chartWidth;
      const y = height - padding.bottom - (point.cro / maxVal) * chartHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Legend
    ctx.font = '11px monospace';
    ctx.fillStyle = ciColor;
    ctx.textAlign = 'left';
    ctx.fillText('CI', padding.left + 10, padding.top + 5);
    ctx.fillStyle = croColor;
    ctx.fillText('Cro', padding.left + 40, padding.top + 5);
  }, [state, width, height, colors, ciColor, croColor]);

  // Phase indicator
  const phaseColors = {
    lysogenic: ciColor,
    lytic: croColor,
    undecided: colors.warning,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {/* Phase indicator */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '0.5rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              backgroundColor: phaseColors[state.phase],
              boxShadow: `0 0 8px ${phaseColors[state.phase]}`,
            }}
          />
          <span
            style={{
              fontFamily: 'monospace',
              fontWeight: 'bold',
              color: phaseColors[state.phase],
              textTransform: 'uppercase',
            }}
          >
            {state.phase}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '1rem', fontFamily: 'monospace', fontSize: '0.85rem' }}>
          <span style={{ color: ciColor }}>CI: {state.ci.toFixed(2)}</span>
          <span style={{ color: croColor }}>Cro: {state.cro.toFixed(2)}</span>
        </div>
      </div>

      {/* Chart */}
      <canvas
        ref={canvasRef}
        style={{
          width: `${width}px`,
          height: `${height}px`,
          borderRadius: '4px',
          border: `1px solid ${colors.borderLight}`,
        }}
      />

      {ciCroSpark && (
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: '0.75rem',
            color: colors.textMuted,
            textAlign: 'center',
          }}
        >
          CI−Cro trend: <span style={{ color: colors.accent }}>{ciCroSpark}</span>
        </div>
      )}
    </div>
  );
}

export default LysogenyVisualizer;
