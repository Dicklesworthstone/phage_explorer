/**
 * LysogenyVisualizer - Interactive Visualization for Lysogeny Decision Circuit
 *
 * Implements:
 * 1. 2D Phase Portrait (CI vs Cro) with vector field, nullclines, attractors, and live trajectory
 * 2. Time Series Dynamics of CI, Cro, CII, and RecA*
 * 3. Shea-Ackers Operator Occupancy model (OR1, OR2, OR3) and promoter activities (PRM, PR)
 * 4. Genomic switch architecture detection and lysogeny fate probability gauge
 */

import React, { useMemo, useRef, useEffect, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Badge } from '../ui/Badge';
import type { LysogenyCircuitState } from '../../workers/types';

interface LysogenyVisualizerProps {
  state: LysogenyCircuitState;
  width?: number;
  height?: number;
}

type VisualizerTab = 'portrait' | 'timeseries' | 'operators';

export function LysogenyVisualizer({
  state,
  width = 540,
  height = 280,
}: LysogenyVisualizerProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeTab, setActiveTab] = useState<VisualizerTab>('portrait');

  const ciColor = colors.success ?? '#10b981';
  const croColor = colors.error ?? '#ef4444';
  const cIIColor = '#f59e0b';
  const recAColor = '#a855f7';

  // CI - Cro sparkline
  const ciCroSpark = useMemo(() => {
    const history = state.history ?? [];
    if (history.length < 2) return '';
    const values = history.map((h) => h.ci - h.cro);
    const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const barWidth = 24;
    const trimmed = values.slice(-barWidth);
    const min = Math.min(...trimmed);
    const max = Math.max(...trimmed);
    if (min === max) return bars[0].repeat(trimmed.length);
    return trimmed
      .map((v) => {
        const t = (v - min) / (max - min);
        const idx = Math.min(bars.length - 1, Math.max(0, Math.round(t * (bars.length - 1))));
        return bars[idx];
      })
      .join('');
  }, [state.history]);

  // Canvas renderer for Phase Portrait & Time Series
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    const padding = { top: 24, right: 30, bottom: 36, left: 46 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    if (activeTab === 'portrait') {
      // ==========================================
      // PHASE PORTRAIT: [CI] (x) vs [Cro] (y)
      // ==========================================
      const maxScale = 3.2;

      // Coordinate transforms
      const toScreenX = (ciVal: number) => padding.left + (Math.max(0, ciVal) / maxScale) * plotWidth;
      const toScreenY = (croVal: number) => height - padding.bottom - (Math.max(0, croVal) / maxScale) * plotHeight;

      // Grid background lines
      ctx.strokeStyle = colors.borderLight ?? '#1f293d';
      ctx.lineWidth = 0.5;
      for (let g = 0.5; g <= maxScale; g += 0.5) {
        // Vertical lines (CI)
        const gx = toScreenX(g);
        ctx.beginPath();
        ctx.moveTo(gx, padding.top);
        ctx.lineTo(gx, height - padding.bottom);
        ctx.stroke();

        // Horizontal lines (Cro)
        const gy = toScreenY(g);
        ctx.beginPath();
        ctx.moveTo(padding.left, gy);
        ctx.lineTo(width - padding.right, gy);
        ctx.stroke();
      }

      // Draw Vector Field arrows from precomputed phase portrait points
      const portraitPoints = state.phasePortrait ?? [];
      if (portraitPoints.length > 0) {
        for (const pt of portraitPoints) {
          const sx = toScreenX(pt.ci);
          const sy = toScreenY(pt.cro);

          const mag = Math.max(0.001, Math.min(2.0, pt.magnitude));
          const angle = Math.atan2(-pt.dCro, pt.dCi); // Inverted Y screen coords
          const arrowLen = 5 + mag * 5;

          const ex = sx + Math.cos(angle) * arrowLen;
          const ey = sy + Math.sin(angle) * arrowLen;

          const arrowColor =
            pt.fate === 'lysogenic'
              ? `${ciColor}55`
              : pt.fate === 'lytic'
                ? `${croColor}55`
                : `${colors.textMuted ?? '#64748b'}44`;

          ctx.strokeStyle = arrowColor;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(ex, ey);
          ctx.stroke();

          // Arrow head
          const headAngle1 = angle + Math.PI * 0.85;
          const headAngle2 = angle - Math.PI * 0.85;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex + Math.cos(headAngle1) * 3, ey + Math.sin(headAngle1) * 3);
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex + Math.cos(headAngle2) * 3, ey + Math.sin(headAngle2) * 3);
          ctx.stroke();
        }
      }

      // Draw Nullclines if available
      if (state.nullclines) {
        // CI-nullcline (dCI/dt = 0)
        const ciNull = state.nullclines.ciNullcline;
        if (ciNull.length > 1) {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = `${ciColor}aa`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ciNull.forEach((pt, idx) => {
            const nx = toScreenX(pt.ci);
            const ny = toScreenY(pt.cro);
            if (idx === 0) ctx.moveTo(nx, ny);
            else ctx.lineTo(nx, ny);
          });
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Cro-nullcline (dCro/dt = 0)
        const croNull = state.nullclines.croNullcline;
        if (croNull.length > 1) {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = `${croColor}aa`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          croNull.forEach((pt, idx) => {
            const nx = toScreenX(pt.ci);
            const ny = toScreenY(pt.cro);
            if (idx === 0) ctx.moveTo(nx, ny);
            else ctx.lineTo(nx, ny);
          });
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Draw Attractors and Separatrix
      if (state.attractors) {
        for (const attr of state.attractors) {
          const ax = toScreenX(attr.ci);
          const ay = toScreenY(attr.cro);

          if (attr.type === 'lysogenic') {
            ctx.fillStyle = ciColor;
            ctx.beginPath();
            ctx.arc(ax, ay, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = '9px monospace';
            ctx.fillText('Lysogenic', ax + 6, ay - 4);
          } else if (attr.type === 'lytic') {
            ctx.fillStyle = croColor;
            ctx.beginPath();
            ctx.arc(ax, ay, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = '9px monospace';
            ctx.fillText('Lytic', ax + 6, ay + 10);
          } else if (attr.type === 'saddle') {
            ctx.strokeStyle = colors.warning ?? '#eab308';
            ctx.lineWidth = 2;
            const size = 3;
            ctx.beginPath();
            ctx.moveTo(ax - size, ay - size);
            ctx.lineTo(ax + size, ay + size);
            ctx.moveTo(ax - size, ay + size);
            ctx.lineTo(ax + size, ay - size);
            ctx.stroke();
            ctx.fillStyle = colors.warning ?? '#eab308';
            ctx.font = '8px monospace';
            ctx.fillText('Separatrix', ax + 5, ay);
          }
        }
      }

      // Draw Trajectory Path from history
      const history = state.history ?? [];
      if (history.length > 1) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = colors.accent ?? '#38bdf8';
        ctx.beginPath();
        history.forEach((pt, idx) => {
          const tx = toScreenX(pt.ci);
          const ty = toScreenY(pt.cro);
          if (idx === 0) ctx.moveTo(tx, ty);
          else ctx.lineTo(tx, ty);
        });
        ctx.stroke();
      }

      // Draw Current Operating State Dot
      const curX = toScreenX(state.ci);
      const curY = toScreenY(state.cro);

      // Pulsing halo
      ctx.fillStyle = `${state.phase === 'lysogenic' ? ciColor : state.phase === 'lytic' ? croColor : colors.warning}33`;
      ctx.beginPath();
      ctx.arc(curX, curY, 9, 0, Math.PI * 2);
      ctx.fill();

      // Inner dot
      ctx.fillStyle = state.phase === 'lysogenic' ? ciColor : state.phase === 'lytic' ? croColor : colors.warning;
      ctx.beginPath();
      ctx.arc(curX, curY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Coordinate tag
      ctx.font = '10px monospace';
      ctx.fillStyle = colors.text ?? '#f8fafc';
      ctx.textAlign = 'left';
      ctx.fillText(`● (${state.ci.toFixed(2)}, ${state.cro.toFixed(2)})`, curX + 10, curY - 6);

      // Main Axes
      ctx.strokeStyle = colors.textMuted ?? '#64748b';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(padding.left, padding.top);
      ctx.lineTo(padding.left, height - padding.bottom);
      ctx.lineTo(width - padding.right, height - padding.bottom);
      ctx.stroke();

      // Axis Ticks & Labels
      ctx.fillStyle = colors.textMuted ?? '#64748b';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      for (let v = 0; v <= maxScale; v += 1.0) {
        const yPos = toScreenY(v);
        ctx.fillText(v.toFixed(1), padding.left - 6, yPos + 3);
        const xPos = toScreenX(v);
        ctx.fillText(v.toFixed(1), xPos + 8, height - padding.bottom + 14);
      }

      ctx.textAlign = 'center';
      ctx.font = '10px monospace';
      ctx.fillStyle = colors.text ?? '#e2e8f0';
      ctx.fillText('[CI Repressor Concentration] →', width / 2, height - 8);

      // Y-axis title
      ctx.save();
      ctx.translate(14, height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText('↑ [Cro Concentration]', 0, 0);
      ctx.restore();
    } else if (activeTab === 'timeseries') {
      // ==========================================
      // TIME SERIES DYNAMICS
      // ==========================================
      const history = state.history ?? [];
      if (history.length === 0) return;

      const maxVal = Math.max(
        3.0,
        Math.max(...history.map((h) => h.ci)),
        Math.max(...history.map((h) => h.cro)),
        Math.max(...history.map((h) => h.cII ?? 0))
      );

      // Axes
      ctx.strokeStyle = colors.borderLight ?? '#1f293d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, padding.top);
      ctx.lineTo(padding.left, height - padding.bottom);
      ctx.lineTo(width - padding.right, height - padding.bottom);
      ctx.stroke();

      // Y-axis labels
      ctx.fillStyle = colors.textMuted ?? '#64748b';
      ctx.font = '10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText('0', padding.left - 6, height - padding.bottom);
      ctx.fillText(maxVal.toFixed(1), padding.left - 6, padding.top + 6);
      ctx.fillText((maxVal / 2).toFixed(1), padding.left - 6, padding.top + plotHeight / 2 + 3);

      // X-axis label
      ctx.textAlign = 'center';
      ctx.fillText(`Time (t = ${state.time.toFixed(1)} min)`, width / 2, height - 8);

      // Draw CI Trace
      ctx.beginPath();
      ctx.strokeStyle = ciColor;
      ctx.lineWidth = 2.2;
      history.forEach((pt, i) => {
        const x = padding.left + (i / Math.max(1, history.length - 1)) * plotWidth;
        const y = height - padding.bottom - (pt.ci / maxVal) * plotHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Draw Cro Trace
      ctx.beginPath();
      ctx.strokeStyle = croColor;
      ctx.lineWidth = 2.2;
      history.forEach((pt, i) => {
        const x = padding.left + (i / Math.max(1, history.length - 1)) * plotWidth;
        const y = height - padding.bottom - (pt.cro / maxVal) * plotHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Draw CII Trace if available
      const hasCII = history.some((h) => h.cII !== undefined);
      if (hasCII) {
        ctx.beginPath();
        ctx.strokeStyle = cIIColor;
        ctx.lineWidth = 1.8;
        ctx.setLineDash([3, 3]);
        history.forEach((pt, i) => {
          const x = padding.left + (i / Math.max(1, history.length - 1)) * plotWidth;
          const y = height - padding.bottom - ((pt.cII ?? 0) / maxVal) * plotHeight;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Legend
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = ciColor;
      ctx.fillText(`CI: ${state.ci.toFixed(2)}`, padding.left + 15, padding.top + 5);
      ctx.fillStyle = croColor;
      ctx.fillText(`Cro: ${state.cro.toFixed(2)}`, padding.left + 110, padding.top + 5);
      if (hasCII && state.cII !== undefined) {
        ctx.fillStyle = cIIColor;
        ctx.fillText(`CII: ${state.cII.toFixed(2)}`, padding.left + 210, padding.top + 5);
      }
      if (state.recAStar !== undefined && state.recAStar > 0.05) {
        ctx.fillStyle = recAColor;
        ctx.fillText(`RecA*: ${state.recAStar.toFixed(2)}`, padding.left + 300, padding.top + 5);
      }
    }
  }, [state, width, height, colors, ciColor, croColor, cIIColor, recAColor, activeTab]);

  const occupancy = state.occupancy;
  const circuit = state.circuitInfo;
  const prob = state.predictedProbability ?? (state.phase === 'lysogenic' ? 0.85 : state.phase === 'lytic' ? 0.15 : 0.5);
  const factors = state.predictionFactors ?? [];

  const phaseColors: Record<string, string> = {
    lysogenic: ciColor,
    lytic: croColor,
    undecided: colors.warning ?? '#eab308',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {/* Top Header: Decision Fate, P(Lysogeny), and Architecture */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          padding: '0.5rem 0.8rem',
          backgroundColor: colors.backgroundAlt ?? '#0f172a',
          borderRadius: '6px',
          border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
        }}
      >
        {/* Left: Phase indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <div
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              backgroundColor: phaseColors[state.phase],
              boxShadow: `0 0 10px ${phaseColors[state.phase]}`,
            }}
          />
          <span
            style={{
              fontFamily: 'monospace',
              fontWeight: 'bold',
              color: phaseColors[state.phase],
              fontSize: '0.9rem',
              letterSpacing: '0.05em',
            }}
          >
            FATE: {state.phase.toUpperCase()}
          </span>

          {circuit && (
            <Badge
              variant={circuit.isTemperate ? 'info' : 'warning'}
              size="small"
              title={circuit.summary}
            >
              {circuit.architecture === 'lambda-like'
                ? 'λ Classical Toggle'
                : circuit.architecture === 'temperate'
                  ? 'Temperate Switch'
                  : circuit.architecture === 'obligately-lytic'
                    ? 'Obligately Lytic'
                    : 'Atypical Circuit'}
            </Badge>
          )}
        </div>

        {/* Center: Lysogeny Probability Gauge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: '180px' }}>
          <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: colors.textMuted }}>
            P(lyso):
          </span>
          <div
            style={{
              flex: 1,
              height: '8px',
              backgroundColor: `${croColor}44`,
              borderRadius: '4px',
              overflow: 'hidden',
              display: 'flex',
            }}
            title={`Predicted Lysogeny Probability: ${(prob * 100).toFixed(1)}%`}
          >
            <div
              style={{
                width: `${Math.round(prob * 100)}%`,
                height: '100%',
                backgroundColor: ciColor,
                transition: 'width 0.2s ease',
              }}
            />
          </div>
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: '0.78rem',
              fontWeight: 'bold',
              color: prob > 0.5 ? ciColor : croColor,
            }}
          >
            {(prob * 100).toFixed(0)}%
          </span>
        </div>

        {/* Right: Key Concentrations */}
        <div style={{ display: 'flex', gap: '0.8rem', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <span style={{ color: ciColor }}>CI: {state.ci.toFixed(2)}</span>
          <span style={{ color: croColor }}>Cro: {state.cro.toFixed(2)}</span>
          {state.cII !== undefined && <span style={{ color: cIIColor }}>CII: {state.cII.toFixed(2)}</span>}
        </div>
      </div>

      {/* Tabs navigation */}
      <div style={{ display: 'flex', gap: '0.4rem', borderBottom: `1px solid ${colors.borderLight ?? '#334155'}` }}>
        <button
          type="button"
          onClick={() => setActiveTab('portrait')}
          style={{
            padding: '0.35rem 0.75rem',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
            border: 'none',
            borderBottom: activeTab === 'portrait' ? `2px solid ${colors.accent ?? '#38bdf8'}` : '2px solid transparent',
            background: 'transparent',
            color: activeTab === 'portrait' ? (colors.accent ?? '#38bdf8') : (colors.textMuted ?? '#64748b'),
            cursor: 'pointer',
            fontWeight: activeTab === 'portrait' ? 'bold' : 'normal',
          }}
        >
          Phase Portrait (Vector Field)
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('timeseries')}
          style={{
            padding: '0.35rem 0.75rem',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
            border: 'none',
            borderBottom: activeTab === 'timeseries' ? `2px solid ${colors.accent ?? '#38bdf8'}` : '2px solid transparent',
            background: 'transparent',
            color: activeTab === 'timeseries' ? (colors.accent ?? '#38bdf8') : (colors.textMuted ?? '#64748b'),
            cursor: 'pointer',
            fontWeight: activeTab === 'timeseries' ? 'bold' : 'normal',
          }}
        >
          Time Series Dynamics
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('operators')}
          style={{
            padding: '0.35rem 0.75rem',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
            border: 'none',
            borderBottom: activeTab === 'operators' ? `2px solid ${colors.accent ?? '#38bdf8'}` : '2px solid transparent',
            background: 'transparent',
            color: activeTab === 'operators' ? (colors.accent ?? '#38bdf8') : (colors.textMuted ?? '#64748b'),
            cursor: 'pointer',
            fontWeight: activeTab === 'operators' ? 'bold' : 'normal',
          }}
        >
          Shea-Ackers Operators ({occupancy ? 'Live' : 'Model'})
        </button>
      </div>

      {/* Main Display: Canvas for Phase Portrait & Time Series, or Shea-Ackers Operator Panel */}
      {activeTab !== 'operators' ? (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={
            activeTab === 'portrait'
              ? 'Phase portrait of Lysogeny/Lysis decision circuit showing CI versus Cro vector field and attractors'
              : 'Time series trajectories of CI, Cro, and CII proteins'
          }
          style={{
            width: `${width}px`,
            height: `${height}px`,
            borderRadius: '4px',
            border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
          }}
        />
      ) : (
        <div
          style={{
            height: `${height}px`,
            padding: '0.8rem',
            backgroundColor: colors.backgroundAlt ?? '#0b1120',
            borderRadius: '4px',
            border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
          }}
        >
          {/* Operator OR Region Diagram */}
          <div>
            <div style={{ color: colors.textMuted, fontSize: '0.75rem', marginBottom: '0.4rem' }}>
              THREE-SITE OPERATOR OCCUPANCY (SHEA-ACKERS PARTITION MODEL):
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.6rem' }}>
              {/* OR3 */}
              <div
                style={{
                  padding: '0.5rem',
                  borderRadius: '4px',
                  backgroundColor: colors.backgroundAlt ?? '#1e293b',
                  border: `1px solid ${(occupancy?.or3Ci ?? 0) > 0.4 ? ciColor : (occupancy?.orCro ?? 0) > 0.4 ? croColor : colors.borderLight}`,
                }}
              >
                <div style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                  <span>OR3 Site</span>
                  <span style={{ color: (occupancy?.orCro ?? 0) > 0.4 ? croColor : ciColor }}>
                    {((occupancy?.orCro ?? 0) * 100).toFixed(0)}% Cro
                  </span>
                </div>
                <div style={{ fontSize: '0.7rem', color: colors.textMuted, marginTop: '0.2rem' }}>
                  CI Kd: 3.2 · Cro Kd: 0.4
                </div>
                <div style={{ fontSize: '0.7rem', color: colors.textDim, marginTop: '0.2rem' }}>
                  {(occupancy?.or3Ci ?? 0) > 0.5 ? 'CI bound (Autorepression)' : (occupancy?.orCro ?? 0) > 0.4 ? 'Cro bound (Represses PRM)' : 'Vacant'}
                </div>
              </div>

              {/* OR2 */}
              <div
                style={{
                  padding: '0.5rem',
                  borderRadius: '4px',
                  backgroundColor: colors.backgroundAlt ?? '#1e293b',
                  border: `1px solid ${(occupancy?.or2Ci ?? 0) > 0.4 ? ciColor : colors.borderLight}`,
                }}
              >
                <div style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                  <span>OR2 Site</span>
                  <span style={{ color: ciColor }}>
                    {((occupancy?.or2Ci ?? 0) * 100).toFixed(0)}% CI
                  </span>
                </div>
                <div style={{ fontSize: '0.7rem', color: colors.textMuted, marginTop: '0.2rem' }}>
                  CI Kd: 0.5 (Cooperative tetramer)
                </div>
                <div style={{ fontSize: '0.7rem', color: (occupancy?.or2Ci ?? 0) > 0.4 ? ciColor : colors.textDim, marginTop: '0.2rem' }}>
                  {(occupancy?.or2Ci ?? 0) > 0.4 ? 'CI bound (Stimulates PRM)' : 'Vacant'}
                </div>
              </div>

              {/* OR1 */}
              <div
                style={{
                  padding: '0.5rem',
                  borderRadius: '4px',
                  backgroundColor: colors.backgroundAlt ?? '#1e293b',
                  border: `1px solid ${(occupancy?.or1Ci ?? 0) > 0.4 ? ciColor : colors.borderLight}`,
                }}
              >
                <div style={{ fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
                  <span>OR1 Site</span>
                  <span style={{ color: ciColor }}>
                    {((occupancy?.or1Ci ?? 0) * 100).toFixed(0)}% CI
                  </span>
                </div>
                <div style={{ fontSize: '0.7rem', color: colors.textMuted, marginTop: '0.2rem' }}>
                  CI Kd: 0.25 (Highest CI affinity)
                </div>
                <div style={{ fontSize: '0.7rem', color: (occupancy?.or1Ci ?? 0) > 0.4 ? ciColor : colors.textDim, marginTop: '0.2rem' }}>
                  {(occupancy?.or1Ci ?? 0) > 0.4 ? 'CI bound (Represses PR)' : 'Vacant'}
                </div>
              </div>
            </div>
          </div>

          {/* Promoters Activities */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem', marginTop: '0.6rem' }}>
            <div
              style={{
                padding: '0.5rem 0.8rem',
                borderRadius: '4px',
                backgroundColor: colors.backgroundAlt ?? '#1e293b',
                borderLeft: `4px solid ${ciColor}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 'bold' }}>PRM (CI Synthesis)</span>
                <span style={{ color: ciColor, fontWeight: 'bold' }}>
                  {((occupancy?.prmActivity ?? 0) * 100).toFixed(0)}% Activity
                </span>
              </div>
              <div style={{ fontSize: '0.72rem', color: colors.textMuted, marginTop: '0.2rem' }}>
                Directs leftward transcription of cI repressor maintenance.
              </div>
            </div>

            <div
              style={{
                padding: '0.5rem 0.8rem',
                borderRadius: '4px',
                backgroundColor: colors.backgroundAlt ?? '#1e293b',
                borderLeft: `4px solid ${croColor}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 'bold' }}>PR (Cro & Lytic Operon)</span>
                <span style={{ color: croColor, fontWeight: 'bold' }}>
                  {((occupancy?.prActivity ?? 0) * 100).toFixed(0)}% Activity
                </span>
              </div>
              <div style={{ fontSize: '0.72rem', color: colors.textMuted, marginTop: '0.2rem' }}>
                Directs rightward transcription of cro, cII, and replication/lysis proteins.
              </div>
            </div>
          </div>

          {/* Cooperativity Badge */}
          <div style={{ fontSize: '0.75rem', color: colors.textMuted, display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${colors.borderLight ?? '#334155'}`, paddingTop: '0.4rem' }}>
            <span>CI dimer-dimer cooperativity: ω = 10.0 (OR1-OR2 tetramer)</span>
            <span>Partition Function Z: {(occupancy?.partitionZ ?? 1).toFixed(1)}</span>
          </div>
        </div>
      )}

      {/* Footer info: Sparkline trend & Prediction factors */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: colors.textMuted }}>
        <div>
          {factors.length > 0 && (
            <span>
              ► {factors[0]}
            </span>
          )}
        </div>
        {ciCroSpark && (
          <div style={{ fontFamily: 'monospace' }}>
            CI−Cro trend: <span style={{ color: colors.accent ?? '#38bdf8' }}>{ciCroSpark}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default LysogenyVisualizer;
