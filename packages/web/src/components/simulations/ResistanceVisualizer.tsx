import React, { useEffect, useRef } from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { ResistanceCocktailState } from '../../workers/types';

interface ResistanceVisualizerProps {
  state: ResistanceCocktailState;
  width?: number;
  height?: number;
}

function formatExp(n: number): string {
  if (n < 1000) return n.toFixed(0);
  return n.toExponential(1);
}

function progressBar(
  fraction: number,
  color: string,
  label?: string
): React.ReactElement {
  const safeFraction = Number.isFinite(fraction) ? fraction : 0;
  const pct = Math.max(0, Math.min(100, safeFraction * 100));
  return (
    <div style={{ marginBottom: '0.25rem' }}>
      {label && (
        <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)', marginBottom: '2px' }}>
          {label}
        </div>
      )}
      <div
        style={{
          width: '100%',
          height: '8px',
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderRadius: '4px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            transition: 'width 50ms linear',
          }}
        />
      </div>
    </div>
  );
}

export function ResistanceVisualizer({
  state,
  width = 400,
  height = 200,
}: ResistanceVisualizerProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Draw population history chart
  useEffect(() => {
    if (!canvasRef.current || !state) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = width;
    const canvasHeight = height;

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const history = state.history;
    if (history.length < 2) return;

    const padding = { left: 50, right: 20, top: 20, bottom: 30 };
    const plotW = canvasWidth - padding.left - padding.right;
    const plotH = canvasHeight - padding.top - padding.bottom;

    // Find max values for scaling
    const maxPop = Math.max(
      ...history.map((h) => Math.max(h.sensitive, h.partialResistant, h.fullyResistant, h.infected, 1))
    );
    const maxPhage = Math.max(...history.map((h) => h.totalPhage), 1);
    const maxT = Math.max(...history.map((h) => h.t), 1);

    const scaleX = (t: number) => padding.left + (t / maxT) * plotW;
    const scaleY = (v: number, max: number) => padding.top + plotH - (Math.log10(v + 1) / Math.log10(max + 1)) * plotH;

    // Axes
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, canvasHeight - padding.bottom);
    ctx.lineTo(canvasWidth - padding.right, canvasHeight - padding.bottom);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('10^' + Math.log10(maxPop + 1).toFixed(0), padding.left - 5, padding.top + 4);
    ctx.fillText('1', padding.left - 5, canvasHeight - padding.bottom);

    // X-axis label
    ctx.textAlign = 'center';
    ctx.fillText(`Time (${maxT.toFixed(1)}h)`, canvasWidth / 2, canvasHeight - 5);

    // Plot lines
    const drawLine = (
      data: { t: number; v: number }[],
      color: string,
      max: number
    ) => {
      if (data.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(scaleX(data[0].t), scaleY(data[0].v, max));
      for (let i = 1; i < data.length; i++) {
        ctx.lineTo(scaleX(data[i].t), scaleY(data[i].v, max));
      }
      ctx.stroke();
    };

    // Sensitive bacteria (green)
    drawLine(
      history.map((h) => ({ t: h.t, v: h.sensitive })),
      colors.success,
      maxPop
    );

    // Partial resistant (yellow)
    drawLine(
      history.map((h) => ({ t: h.t, v: h.partialResistant })),
      colors.warning,
      maxPop
    );

    // Fully resistant (red)
    drawLine(
      history.map((h) => ({ t: h.t, v: h.fullyResistant })),
      colors.error,
      maxPop
    );

    // Infected cells remain occupied until their lysis transition.
    drawLine(history.map(h => ({ t: h.t, v: h.infected })), colors.primary, maxPop);

    // Phage (blue, dashed)
    ctx.setLineDash([4, 4]);
    drawLine(
      history.map((h) => ({ t: h.t, v: h.totalPhage })),
      colors.info,
      maxPhage
    );
    ctx.setLineDash([]);

    // Resistance emergence marker
    if (state.resistanceTime !== null) {
      const markerX = scaleX(state.resistanceTime);
      ctx.strokeStyle = colors.error;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(markerX, padding.top);
      ctx.lineTo(markerX, canvasHeight - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colors.error;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('RESIST', markerX, padding.top - 5);
    }
  }, [state, width, height, colors]);

  const partialResistantTotal = state.partialResistant.reduce((a, b) => a + b, 0);
  const totalResistant = partialResistantTotal + state.fullyResistant;
  const rawCarryingCap = Number(state.params.carryingCap ?? 1e9);
  const carryingCap = Number.isFinite(rawCarryingCap) && rawCarryingCap > 0 ? rawCarryingCap : 1;
  const resistFraction = totalResistant / carryingCap;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', height: '100%' }}>
      {/* Stats Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: '0.5rem',
        }}
      >
        <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
          <div style={{ color: colors.success, fontSize: '0.7rem' }}>Sensitive</div>
          <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '0.9rem' }}>
            {formatExp(state.sensitiveBacteria)}
          </div>
        </div>
        <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
          <div style={{ color: colors.warning, fontSize: '0.7rem' }}>Partial Res</div>
          <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '0.9rem' }}>
            {formatExp(partialResistantTotal)}
          </div>
        </div>
        <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
          <div style={{ color: colors.error, fontSize: '0.7rem' }}>Full Res</div>
          <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '0.9rem' }}>
            {formatExp(state.fullyResistant)}
          </div>
        </div>
        <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
          <div style={{ color: colors.info, fontSize: '0.7rem' }}>Phage</div>
          <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '0.9rem' }}>
            {formatExp(state.phageCounts.reduce((a, b) => a + b, 0))}
          </div>
        </div>
        <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
          <div style={{ color: colors.primary, fontSize: '0.7rem' }}>Infected</div>
          <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '0.9rem' }}>
            {formatExp(state.infectedByPhage.reduce((a, b) => a + b, 0))}
          </div>
        </div>
      </div>

      <div style={{ color: colors.textDim, fontSize: '0.75rem' }}>
        Illustrative Poisson tau-leap model. Mean lysis time is not a fixed delay; infected cells remain occupied until lysis.
      </div>

      {/* Resistant population fraction */}
      <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
        {progressBar(
          resistFraction,
          resistFraction > 0.1 ? colors.error : resistFraction > 0.01 ? colors.warning : colors.success,
          'Resistant cells / carrying capacity'
        )}
      </div>

      {/* Chart */}
      <div
        style={{
          border: `1px solid ${colors.borderLight}`,
          borderRadius: '4px',
          overflow: 'hidden',
          flex: 1,
          minHeight: 0
        }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Resistance evolution simulation showing bacterial and phage population dynamics"
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
      </div>
    </div>
  );
}
