/**
 * RibosomeVisualizer - Visualization for Ribosome Traffic Simulation
 *
 * Displays ribosome positions along mRNA and production statistics.
 */

import React, { useRef, useEffect } from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { RibosomeTrafficState } from '../../workers/types';

interface RibosomeVisualizerProps {
  state: RibosomeTrafficState;
  width?: number;
  height?: number;
}

export function RibosomeVisualizer({
  state,
  width = 400,
  height = 150,
}: RibosomeVisualizerProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    const length = Number(state.params.length ?? 120);
    const footprint = Number(state.params.footprint ?? 9);

    // Draw mRNA track
    const trackY = height * 0.4;
    const trackHeight = 8;
    const trackPadding = 20;
    const trackWidth = width - trackPadding * 2;

    // Background track with codon rate heatmap
    for (let i = 0; i < length; i++) {
      const rate = state.codonRates[i] ?? 5;
      const normalizedRate = Math.min(1, rate / 10);
      const x = trackPadding + (i / length) * trackWidth;
      const w = trackWidth / length + 1;

      // Color from red (slow) to green (fast)
      const r = Math.round((1 - normalizedRate) * 200);
      const g = Math.round(normalizedRate * 200);
      ctx.fillStyle = `rgb(${r}, ${g}, 100)`;
      ctx.fillRect(x, trackY - trackHeight / 2, w, trackHeight);
    }

    // Draw track outline
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.strokeRect(trackPadding, trackY - trackHeight / 2, trackWidth, trackHeight);

    // Draw ribosomes
    const ribosomeRadius = 6;
    state.ribosomes.forEach((pos) => {
      const x = trackPadding + (pos / length) * trackWidth;
      const y = trackY;

      // Ribosome body (circle)
      ctx.beginPath();
      ctx.arc(x, y, ribosomeRadius, 0, Math.PI * 2);
      ctx.fillStyle = colors.primary;
      ctx.fill();
      ctx.strokeStyle = colors.text;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Footprint indicator (line)
      const footprintWidth = (footprint / length) * trackWidth;
      ctx.strokeStyle = `${colors.primary}80`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y + ribosomeRadius + 3);
      ctx.lineTo(x + footprintWidth, y + ribosomeRadius + 3);
      ctx.stroke();
    });

    // Draw density sparkline
    if (state.densityHistory.length > 1) {
      const sparkY = height * 0.75;
      const sparkHeight = height * 0.2;
      const maxDensity = Math.max(10, ...state.densityHistory);

      ctx.beginPath();
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.5;
      state.densityHistory.forEach((density, i) => {
        const x = trackPadding + (i / (state.densityHistory.length - 1)) * trackWidth;
        const y = sparkY + sparkHeight - (density / maxDensity) * sparkHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Label
      ctx.fillStyle = colors.textMuted;
      ctx.font = '9px monospace';
      ctx.fillText('Density', trackPadding, sparkY - 2);
    }

    // Labels
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText("5'", trackPadding - 12, trackY + 4);
    ctx.textAlign = 'right';
    ctx.fillText("3'", width - trackPadding + 12, trackY + 4);
  }, [state, width, height, colors]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {/* Stats */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-around',
          padding: '0.5rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
          fontFamily: 'monospace',
          fontSize: '0.85rem',
        }}
      >
        <span style={{ color: colors.primary }}>
          Ribosomes: {state.ribosomes.length}
        </span>
        <span style={{ color: colors.success }}>
          Proteins: {state.proteinsProduced}
        </span>
        <span style={{ color: colors.warning }}>
          Stalls: {state.stallEvents}
        </span>
      </div>

      {/* Visualization */}
      <canvas
        ref={canvasRef}
        style={{
          width: `${width}px`,
          height: `${height}px`,
          borderRadius: '4px',
          border: `1px solid ${colors.borderLight}`,
        }}
      />

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          justifyContent: 'center',
          fontSize: '0.75rem',
          color: colors.textMuted,
        }}
      >
        <span>
          <span style={{ color: 'rgb(200, 100, 100)' }}>■</span> Slow codons
        </span>
        <span>
          <span style={{ color: 'rgb(100, 200, 100)' }}>■</span> Fast codons
        </span>
        <span>
          <span style={{ color: colors.primary }}>●</span> Ribosome
        </span>
      </div>
    </div>
  );
}

export default RibosomeVisualizer;
