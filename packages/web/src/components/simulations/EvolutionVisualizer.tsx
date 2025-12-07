/**
 * EvolutionVisualizer - Visualization for Evolution Replay Simulation
 *
 * Displays fitness trajectory and mutation accumulation.
 */

import React, { useRef, useEffect } from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { EvolutionReplayState } from '../../workers/types';

interface EvolutionVisualizerProps {
  state: EvolutionReplayState;
  width?: number;
  height?: number;
}

export function EvolutionVisualizer({
  state,
  width = 400,
  height = 200,
}: EvolutionVisualizerProps): React.ReactElement {
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
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Draw axes
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    // Draw fitness line
    const fitnessHistory = state.fitnessHistory;
    if (fitnessHistory.length > 1) {
      const minFit = Math.min(0.6, ...fitnessHistory);
      const maxFit = Math.max(1.5, ...fitnessHistory);
      const range = maxFit - minFit || 1;

      // Y-axis labels
      ctx.fillStyle = colors.textMuted;
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(minFit.toFixed(2), padding.left - 5, height - padding.bottom);
      ctx.fillText(maxFit.toFixed(2), padding.left - 5, padding.top + 5);
      ctx.fillText('Fitness', padding.left - 5, height / 2);

      // Fitness line
      ctx.beginPath();
      ctx.strokeStyle = colors.success;
      ctx.lineWidth = 2;
      fitnessHistory.forEach((fitness, i) => {
        const x = padding.left + (i / (fitnessHistory.length - 1 || 1)) * chartWidth;
        const y = height - padding.bottom - ((fitness - minFit) / range) * chartHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Reference line at fitness = 1
      const refY = height - padding.bottom - ((1 - minFit) / range) * chartHeight;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = colors.textMuted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, refY);
      ctx.lineTo(width - padding.right, refY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Ne sparkline (secondary y-axis visualization)
    const neHistory = state.neHistory;
    if (neHistory.length > 1) {
      const minNe = Math.min(...neHistory);
      const maxNe = Math.max(...neHistory);
      const range = maxNe - minNe || 1;

      ctx.beginPath();
      ctx.strokeStyle = colors.info;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 2]);
      neHistory.forEach((ne, i) => {
        const x = padding.left + (i / (neHistory.length - 1 || 1)) * chartWidth;
        const y = height - padding.bottom - ((ne - minNe) / range) * chartHeight * 0.3 - chartHeight * 0.05;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // X-axis label
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Generation', width / 2, height - 5);
  }, [state, width, height, colors]);

  // Recent mutations
  const recentMuts = state.mutations.slice(-10);
  const beneficialCount = state.mutations.filter(m => (m.s ?? 0) > 0).length;
  const deleteriousCount = state.mutations.filter(m => (m.s ?? 0) < 0).length;

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
          Gen: {state.generation}
        </span>
        <span style={{ color: colors.success }}>
          Fitness: {(state.fitnessHistory.at(-1) ?? 1).toFixed(3)}
        </span>
        <span style={{ color: colors.text }}>
          Mutations: {state.mutations.length}
        </span>
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

      {/* Mutation breakdown */}
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          justifyContent: 'center',
          fontSize: '0.75rem',
        }}
      >
        <span style={{ color: colors.success }}>
          Beneficial: {beneficialCount}
        </span>
        <span style={{ color: colors.textMuted }}>
          Neutral: {state.mutations.length - beneficialCount - deleteriousCount}
        </span>
        <span style={{ color: colors.error }}>
          Deleterious: {deleteriousCount}
        </span>
      </div>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          justifyContent: 'center',
          fontSize: '0.7rem',
          color: colors.textMuted,
        }}
      >
        <span>
          <span style={{ color: colors.success }}>━</span> Fitness
        </span>
        <span>
          <span style={{ color: colors.info }}>┈</span> Ne (scaled)
        </span>
        <span>
          <span style={{ color: colors.textMuted }}>┄</span> Reference (1.0)
        </span>
      </div>
    </div>
  );
}

export default EvolutionVisualizer;
