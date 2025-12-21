/**
 * RibosomeVisualizer - Visualization for Ribosome Traffic Simulation
 *
 * Displays ribosome positions along mRNA and production statistics.
 */

import React, { useMemo, useRef, useEffect } from 'react';
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

  const codonRates = state.codonRates ?? [];
  const length = codonRates.length || Number(state.params.length ?? 120);
  const footprint = Number(state.params.footprint ?? 9);

  const queueStats = useMemo(() => {
    if (!state.ribosomes.length) return { longestQueue: 0, queues: 0 };
    const sorted = [...state.ribosomes].sort((a, b) => a - b);
    let longest = 1;
    let current = 1;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] <= footprint) {
        current += 1;
        longest = Math.max(longest, current);
      } else {
        current = 1;
      }
    }
    return { longestQueue: longest, queues: Math.max(1, Math.ceil(sorted.length / longest)) };
  }, [state.ribosomes, footprint]);

  const slowSites = useMemo(() => {
    if (!codonRates.length) return [];
    const annotated = codonRates.map((rate, idx) => ({ rate, idx }));
    const sortedRates = [...annotated].map(a => a.rate).sort((a, b) => a - b);
    const median = sortedRates[Math.floor(sortedRates.length / 2)] ?? 0;
    return annotated
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 3)
      .map(s => ({
        ...s,
        rate: Number(s.rate.toFixed(2)),
        slowdown: median > 0 ? Number(((median - s.rate) / median).toFixed(2)) : 0,
      }));
  }, [codonRates]);

  const spark = useMemo(() => {
    const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const toSpark = (values: number[], width = 40): string => {
      if (!values.length) return '';
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
    };

    const density = toSpark(state.densityHistory ?? [], 32);
    const codon = toSpark(codonRates, 48);
    const productionHistory = state.productionHistory ?? [];
    const deltas: number[] = [];
    for (let i = 1; i < productionHistory.length; i++) {
      deltas.push(productionHistory[i] - productionHistory[i - 1]);
    }
    const production = toSpark(deltas, 32);

    const stallHistory = state.stallHistory ?? [];
    const stallDeltas: number[] = [];
    for (let i = 1; i < stallHistory.length; i++) {
      stallDeltas.push(stallHistory[i] - stallHistory[i - 1]);
    }
    const stalls = toSpark(stallDeltas, 32);

    return { density, codon, production, stalls };
  }, [state.densityHistory, state.productionHistory, state.stallHistory, codonRates]);

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

    // Draw mRNA track
    const trackY = height * 0.4;
    const trackHeight = 8;
    const trackPadding = 20;
    const trackWidth = width - trackPadding * 2;

    const rateMin = codonRates.length > 0 ? Math.min(...codonRates) : 0;
    const rateMax = codonRates.length > 0 ? Math.max(...codonRates) : rateMin + 1;

    // Background track with codon rate heatmap
    for (let i = 0; i < length; i++) {
      const rate = codonRates[i] ?? rateMax ?? 0.5;
      const normalizedRate =
        rateMax === rateMin ? 0.5 : (rate - rateMin) / (rateMax - rateMin);
      const clampedRate = Math.max(0, Math.min(1, normalizedRate));
      const x = trackPadding + (i / length) * trackWidth;
      const w = trackWidth / length + 1;

      // Color from red (slow) to green (fast)
      const r = Math.round((1 - clampedRate) * 200);
      const g = Math.round(clampedRate * 200);
      ctx.fillStyle = `rgb(${r}, ${g}, 100)`;
      ctx.fillRect(x, trackY - trackHeight / 2, w, trackHeight);
    }

    // Draw track outline
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.strokeRect(trackPadding, trackY - trackHeight / 2, trackWidth, trackHeight);

    // Highlight slowest sites (top 3)
    slowSites.forEach(site => {
      const x = trackPadding + (site.idx / length) * trackWidth;
      ctx.strokeStyle = colors.warning;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, trackY - trackHeight - 4);
      ctx.lineTo(x, trackY + trackHeight + 4);
      ctx.stroke();
    });

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

    // Draw density sparkline (active ribosomes)
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
  }, [state, width, height, colors, length, footprint, slowSites]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {/* Stats */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-around',
          padding: '0.5rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
          fontFamily: 'monospace',
          fontSize: '0.85rem',
          rowGap: '0.25rem',
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
        <span style={{ color: colors.accent }}>
          Longest queue: {queueStats.longestQueue}
        </span>
        <span style={{ color: colors.textMuted }}>
          Queues: {queueStats.queues}
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

      {/* Trend sparklines */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
          fontFamily: 'monospace',
          fontSize: '0.75rem',
          color: colors.textMuted,
          padding: '0 0.25rem',
        }}
      >
        {spark.codon && (
          <div>
            Codon rates: <span style={{ color: colors.accent }}>{spark.codon}</span>
          </div>
        )}
        {spark.production && (
          <div>
            Proteins/step: <span style={{ color: colors.success }}>{spark.production}</span>
          </div>
        )}
        {spark.stalls && (
          <div>
            Stalls/step: <span style={{ color: colors.warning }}>{spark.stalls}</span>
          </div>
        )}
        {spark.density && (
          <div>
            Active ribosomes: <span style={{ color: colors.info }}>{spark.density}</span>
          </div>
        )}
      </div>

      {/* Slow sites */}
      {slowSites.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.1rem',
            fontFamily: 'monospace',
            fontSize: '0.75rem',
            color: colors.text,
            padding: '0 0.25rem',
          }}
        >
          <div style={{ color: colors.accent }}>Slow sites (top 3)</div>
          {slowSites.map(site => (
            <div key={site.idx} style={{ color: colors.textMuted }}>
              Codon {site.idx + 1}: rate {site.rate}{' '}
              {site.slowdown > 0 ? `(${Math.round(site.slowdown * 100)}% slower vs median)` : '(~median)'}
            </div>
          ))}
        </div>
      )}

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
