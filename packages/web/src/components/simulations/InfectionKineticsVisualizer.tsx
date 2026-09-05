import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { InfectionKineticsState } from '../../workers/types';
import { useTheme } from '../../hooks/useTheme';
import { usePhageStore } from '../../store';
import {
  CANONICAL_GROWTH_CURVES,
  inferBurstKinetics,
  type BurstInferenceResult,
  type PhageFull,
} from '@phage-explorer/core';

interface InfectionKineticsVisualizerProps {
  state: InfectionKineticsState;
  width?: number;
  height?: number;
}

const COLORS = {
  bacteria: '#22c55e',
  infected: '#eab308',
  phage: '#6366f1',
  experimentalPoint: '#ef4444',
  fittedCurve: '#818cf8',
};

export function InfectionKineticsVisualizer({
  state,
  width = 540,
  height = 260,
}: InfectionKineticsVisualizerProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const currentPhage = usePhageStore((s) => s.currentPhage);

  // View mode tab: Forward ODE dynamics vs Experimental Latency & Burst Inference
  const [viewMode, setViewMode] = useState<'forward_ode' | 'latency_inference'>('forward_ode');
  const [demoPhageId, setDemoPhageId] = useState<number | null>(null);
  const demonstration = demoPhageId === (currentPhage?.id ?? -1);
  useEffect(() => { setDemoPhageId(null); setViewMode('forward_ode'); }, [currentPhage?.id]);

  // Curve selection for experimental fitting
  const [selectedCurveId, setSelectedCurveId] = useState<string>('t4_ecoli');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fitCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Auto-detect default curve matching phage name if available
  useEffect(() => {
    if (!currentPhage?.name) return;
    const norm = currentPhage.name.toLowerCase();
    if (norm.includes('t4')) setSelectedCurveId('t4_ecoli');
    else if (norm.includes('lambda')) setSelectedCurveId('lambda_ecoli');
    else if (norm.includes('phix174') || norm.includes('φx174')) setSelectedCurveId('phix174_ecoli');
    else if (norm.includes('pak') || norm.includes('pseudomonas')) setSelectedCurveId('pseudomonas_pak_p1');
  }, [currentPhage?.name]);

  // Run Burst Kinetics & Latency Inference on selected experimental dataset
  const inferenceResult: BurstInferenceResult | null = useMemo(() => {
    if (!demonstration || viewMode !== 'latency_inference') return null;
    const curve = CANONICAL_GROWTH_CURVES[selectedCurveId] ?? CANONICAL_GROWTH_CURVES.t4_ecoli;
    const phageToUse: PhageFull = currentPhage ?? {
      id: 999,
      slug: 'enterobacteria-phage-t4',
      name: curve.phageName,
      accession: 'NC_000866',
      family: 'Myoviridae',
      host: curve.hostName,
      genomeLength: 168903,
      gcContent: 35.3,
      morphology: 'myovirus',
      lifecycle: 'lytic',
      description: null,
      baltimoreGroup: null,
      genomeType: 'dsDNA',
      pdbIds: [],
      genes: [
        { id: 1, name: 'gp19', locusTag: 'T4_019', startPos: 500, endPos: 1200, strand: '+', product: 'endolysin lysozyme', type: 'CDS' },
        { id: 2, name: 't', locusTag: 'T4_T', startPos: 1500, endPos: 2100, strand: '+', product: 'holin lysis protein t', type: 'CDS' },
        { id: 3, name: 'rI', locusTag: 'T4_RI', startPos: 2500, endPos: 3000, strand: '+', product: 'antiholin lysis inhibitor rI', type: 'CDS' },
      ],
      codonUsage: null,
      hasModel: false,
    };

    return inferBurstKinetics(phageToUse, curve, { maxIterations: 65, demonstration: true });
  }, [selectedCurveId, currentPhage, demonstration, viewMode]);

  // Forward simulation series
  const series = useMemo(() => {
    const history = (state as any).history as Array<{ time: number; bacteria: number; infected: number; phage: number }> | undefined;
    const points = history && history.length > 0
      ? history
      : [{ time: state.time, bacteria: state.bacteria, infected: state.infected, phage: state.phage }];
    return [...points].sort((a, b) => a.time - b.time);
  }, [state]);

  const last = series.at(-1);
  const first = series[0];

  // Render Forward Simulation Canvas
  useEffect(() => {
    if (viewMode !== 'forward_ode') return;
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

    const padding = { top: 20, right: 180, bottom: 32, left: 58 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const maxVal = Math.max(
      1,
      ...series.flatMap((p) => [p.bacteria, p.infected, p.phage]).map(Math.abs),
    );
    const maxTime = Math.max(1, ...series.map((p) => p.time));

    const xScale = (t: number) => padding.left + (t / maxTime) * chartW;
    const yScale = (v: number) => padding.top + chartH - (v / maxVal) * chartH;

    // Gridlines
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    // Y ticks
    ctx.fillStyle = colors.textDim;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    const yTicks = 3;
    for (let i = 0; i <= yTicks; i++) {
      const val = (maxVal / yTicks) * i;
      const y = yScale(val);
      ctx.fillText(val >= 1e6 ? `${(val / 1e6).toFixed(1)}M` : val.toFixed(0), padding.left - 6, y + 3);
      ctx.strokeStyle = colors.borderLight;
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center';
    ctx.fillText('Time (minutes)', padding.left + chartW / 2, height - 8);

    const drawSeries = (key: 'bacteria' | 'infected' | 'phage', color: string) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      series.forEach((p, i) => {
        const x = xScale(p.time);
        const y = yScale((p as any)[key]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawSeries('bacteria', COLORS.bacteria);
    drawSeries('infected', COLORS.infected);
    drawSeries('phage', COLORS.phage);

    // Legend + metrics panel
    const legendX = width - padding.right + 10;
    const legendY = padding.top;
    ctx.font = '11px monospace';

    const rows: Array<{ label: string; color: string; value: number }> = [
      { label: 'Bacteria', color: COLORS.bacteria, value: series.at(-1)?.bacteria ?? 0 },
      { label: 'Infected', color: COLORS.infected, value: series.at(-1)?.infected ?? 0 },
      { label: 'Phage', color: COLORS.phage, value: series.at(-1)?.phage ?? 0 },
    ];
    rows.forEach((row, idx) => {
      const y = legendY + idx * 18;
      ctx.fillStyle = row.color;
      ctx.fillRect(legendX, y - 8, 10, 10);
      ctx.fillStyle = colors.text;
      ctx.fillText(row.label, legendX + 16, y);
      ctx.fillStyle = colors.textDim;
      ctx.fillText(formatCount(row.value), legendX + 110, y);
    });

    // Phase-plane inset (B vs P)
    const insetW = 110;
    const insetH = 90;
    const insetX = width - padding.right + 10;
    const insetY = legendY + 70;
    ctx.strokeStyle = colors.borderLight;
    ctx.strokeRect(insetX, insetY, insetW, insetH);
    const insetPadding = 6;
    const maxB = Math.max(...series.map((p) => p.bacteria), 1);
    const maxP = Math.max(...series.map((p) => p.phage), 1);
    const xInset = (v: number) => insetX + insetPadding + (v / maxB) * (insetW - insetPadding * 2);
    const yInset = (v: number) => insetY + insetH - insetPadding - (v / maxP) * (insetH - insetPadding * 2);

    ctx.beginPath();
    series.forEach((p, i) => {
      const x = xInset(p.bacteria);
      const y = yInset(p.phage);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = colors.textDim;
    ctx.font = '9px monospace';
    ctx.fillText('Phase plane (B vs P)', insetX + insetW / 2, insetY - 4);
  }, [series, width, height, colors, viewMode]);

  // Render the example curve and sigmoid fit without invented uncertainty.
  useEffect(() => {
    if (viewMode !== 'latency_inference' || !inferenceResult) return;
    const canvas = fitCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const fitW = width;
    const fitH = Math.max(260, height);
    canvas.width = fitW * dpr;
    canvas.height = fitH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, fitW, fitH);

    const curve = CANONICAL_GROWTH_CURVES[selectedCurveId] ?? CANONICAL_GROWTH_CURVES.t4_ecoli;
    const isOD = curve.data[0]?.type === 'OD';

    const padding = { top: 25, right: 35, bottom: 35, left: 65 };
    const chartW = fitW - padding.left - padding.right;
    const chartH = fitH - padding.top - padding.bottom;

    const maxTime = Math.max(1, ...curve.data.map((d) => d.timeMin), ...inferenceResult.fittedTrajectory.map((t) => t.timeMin));
    const maxVal = isOD
      ? Math.max(1.0, ...curve.data.map((d) => d.value), ...inferenceResult.fittedTrajectory.map((t) => t.od600)) * 1.15
      : Math.max(...curve.data.map((d) => Math.log10(Math.max(1, d.value))), ...inferenceResult.fittedTrajectory.map((t) => Math.log10(Math.max(1, t.phage)))) * 1.05;
    const minVal = isOD ? 0 : Math.min(...curve.data.map((d) => Math.log10(Math.max(1, d.value)))) * 0.95;

    const xScale = (t: number) => padding.left + (t / maxTime) * chartW;
    const yScale = (v: number) => {
      const val = isOD ? v : Math.log10(Math.max(1, v));
      return padding.top + chartH - ((val - minVal) / Math.max(0.01, maxVal - minVal)) * chartH;
    };

    // Axes
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, fitH - padding.bottom);
    ctx.lineTo(fitW - padding.right, fitH - padding.bottom);
    ctx.stroke();

    // Latent period milestone line
    const latentX = xScale(inferenceResult.fittedParameters.latentPeriod);
    ctx.strokeStyle = '#f59e0b';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(latentX, padding.top);
    ctx.lineTo(latentX, fitH - padding.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#f59e0b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`L = ${inferenceResult.fittedParameters.latentPeriod.toFixed(1)} min`, latentX, padding.top - 8);

    const traj = inferenceResult.fittedTrajectory;

    // Fitted Trajectory Curve
    ctx.strokeStyle = COLORS.fittedCurve;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    traj.forEach((pt, idx) => {
      const v = isOD ? pt.od600 : pt.phage;
      const x = xScale(pt.timeMin);
      const y = yScale(v);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Experimental Data Points
    curve.data.forEach((pt) => {
      const x = xScale(pt.timeMin);
      const y = yScale(pt.value);

      ctx.fillStyle = COLORS.experimentalPoint;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Labels and ticks
    ctx.fillStyle = colors.textDim;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Time elapsed (minutes)', padding.left + chartW / 2, fitH - 10);

    ctx.textAlign = 'right';
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const frac = i / yTicks;
      const v = minVal + frac * (maxVal - minVal);
      const y = padding.top + chartH - frac * chartH;
      const label = isOD ? v.toFixed(2) : `10^${v.toFixed(1)}`;
      ctx.fillText(label, padding.left - 8, y + 3);
    }
  }, [inferenceResult, selectedCurveId, viewMode, width, height, colors]);

  return (
    <div className="infection-viz" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Top Tab Switcher */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: `1px solid ${colors.borderLight}`, paddingBottom: '0.4rem' }}>
        <button
          type="button"
          onClick={() => setViewMode('forward_ode')}
          style={{
            padding: '0.35rem 0.75rem',
            borderRadius: '4px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.8rem',
            backgroundColor: viewMode === 'forward_ode' ? (colors.primary ?? '#3b82f6') : colors.backgroundAlt,
            color: viewMode === 'forward_ode' ? '#ffffff' : colors.textMuted,
          }}
        >
          Forward Infection Dynamics (SIR)
        </button>
        <button
          type="button"
          onClick={() => { setDemoPhageId(currentPhage?.id ?? -1); setViewMode('latency_inference'); }}
          style={{
            padding: '0.35rem 0.75rem',
            borderRadius: '4px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.8rem',
            backgroundColor: viewMode === 'latency_inference' ? (colors.primary ?? '#3b82f6') : colors.backgroundAlt,
            color: viewMode === 'latency_inference' ? '#ffffff' : colors.textMuted,
          }}
        >
          Show illustrative growth-curve fitting
        </button>
      </div>

      {viewMode === 'forward_ode' ? (
        <>
          <div className="infection-viz__metrics" aria-label="Infection kinetics summary">
            <div className="metric">
              <p className="label">Time</p>
              <p className="value mono">{last?.time?.toFixed(0) ?? '0'}</p>
            </div>
            <div className="metric">
              <p className="label">Bacteria</p>
              <p className="value" style={{ color: COLORS.bacteria }}>
                {formatCount(last?.bacteria ?? 0)}
              </p>
            </div>
            <div className="metric">
              <p className="label">Infected</p>
              <p className="value" style={{ color: COLORS.infected }}>
                {formatCount(last?.infected ?? 0)}
              </p>
            </div>
            <div className="metric">
              <p className="label">Phage</p>
              <p className="value" style={{ color: COLORS.phage }}>
                {formatCount(last?.phage ?? 0)}
              </p>
            </div>
            {first && last && (
              <div className="metric">
                <p className="label">Δ Bacteria</p>
                <p className="value mono">
                  {formatDelta(last.bacteria - first.bacteria)}
                </p>
              </div>
            )}
          </div>
          <canvas
            ref={canvasRef}
            aria-label="Infection kinetics chart"
            role="img"
            style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
          />
        </>
      ) : (
        /* Experimental Latency Inference & Lysis Cassette View */
        inferenceResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <p role="note" aria-label="Demonstration assumptions">DEMONSTRATION: {inferenceResult.assumptions}</p>
            {/* Dataset Selector Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.5rem',
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                backgroundColor: colors.backgroundAlt,
                border: `1px solid ${colors.borderLight}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.8rem', color: colors.textMuted }}>Example curve:</span>
                <select
                  value={selectedCurveId}
                  onChange={(e) => setSelectedCurveId(e.target.value)}
                  style={{
                    padding: '0.3rem 0.5rem',
                    borderRadius: '4px',
                    border: `1px solid ${colors.borderLight}`,
                    backgroundColor: colors.background,
                    color: colors.text,
                    fontSize: '0.8rem',
                    fontWeight: 600,
                  }}
                >
                  {Object.entries(CANONICAL_GROWTH_CURVES).map(([k, c]) => (
                    <option key={k} value={k}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ fontSize: '0.75rem', color: colors.textDim }}>
                Descriptive fit: <strong>R² = {inferenceResult.fitQualityR2?.toFixed(3) ?? 'Undefined'}</strong>
              </div>
            </div>

            {/* Example observations and fitted sigmoid */}
            <div style={{ position: 'relative' }}>
              <canvas
                ref={fitCanvasRef}
                aria-label="Demonstration growth curve and sigmoid fit"
                role="img"
                style={{ width: `${width}px`, height: `${Math.max(260, height)}px`, display: 'block', borderRadius: '4px' }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '12px',
                  display: 'flex',
                  gap: '12px',
                  fontSize: '0.7rem',
                  backgroundColor: `${colors.background}cc`,
                  padding: '3px 8px',
                  borderRadius: '4px',
                  border: `1px solid ${colors.borderLight}`,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLORS.experimentalPoint }} />
                  Example points
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '12px', height: '2px', backgroundColor: COLORS.fittedCurve }} />
                  Fitted sigmoid
                </span>
              </div>
            </div>

            {/* Inferred Parameters Metric Grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '0.5rem',
              }}
            >
              <div style={{ padding: '0.5rem', borderRadius: '4px', border: `1px solid ${colors.borderLight}`, backgroundColor: colors.backgroundAlt }}>
                <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>Latent Period (L)</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f59e0b' }}>
                  {inferenceResult.fittedParameters.latentPeriod.toFixed(1)} min
                </div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim }}>
                  Uncertainty not estimated
                </div>
              </div>

              <div style={{ padding: '0.5rem', borderRadius: '4px', border: `1px solid ${colors.borderLight}`, backgroundColor: colors.backgroundAlt }}>
                <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>Burst Size (b)</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: colors.success }}>
                  {Math.round(inferenceResult.fittedParameters.burstSize)} virions
                </div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim }}>
                  Uncertainty not estimated
                </div>
              </div>

              <div style={{ padding: '0.5rem', borderRadius: '4px', border: `1px solid ${colors.borderLight}`, backgroundColor: colors.backgroundAlt }}>
                <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>{inferenceResult.adsorptionRateStatus === 'unidentifiable' ? 'Assumed' : 'Unvalidated model'} Adsorption Rate (k)</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: colors.text, fontFamily: 'monospace' }}>
                  {inferenceResult.fittedParameters.adsorptionRate.toExponential(2)}
                </div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim }}>{inferenceResult.adsorptionRateStatus === 'unidentifiable' ? 'Not identifiable from these observations' : 'Depends on an unvalidated OD biomass term'}</div>
              </div>

              <div style={{ padding: '0.5rem', borderRadius: '4px', border: `1px solid ${colors.borderLight}`, backgroundColor: colors.backgroundAlt }}>
                <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>Bacterial Growth (μ)</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: colors.text }}>
                  {(inferenceResult.fittedParameters.bacterialGrowthRate * 60).toFixed(2)} hr⁻¹
                </div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim }}>
                  doubling ~{(Math.LN2 / inferenceResult.fittedParameters.bacterialGrowthRate).toFixed(0)} min
                </div>
              </div>

              <div style={{ padding: '0.5rem', borderRadius: '4px', border: `1px solid ${colors.borderLight}`, backgroundColor: colors.backgroundAlt }}>
                <div style={{ fontSize: '0.7rem', color: colors.textMuted }}>Model Concordance</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: inferenceResult.genomicCorrelation.concordance === 'high' ? colors.success : colors.warning }}>
                  {inferenceResult.genomicCorrelation.correlationScore}%
                </div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim }}>
                  Δ {inferenceResult.genomicCorrelation.observedVsPredictedDeltaMin > 0 ? '+' : ''}{inferenceResult.genomicCorrelation.observedVsPredictedDeltaMin}m from cassette
                </div>
              </div>
            </div>

            {/* Lysis Cassette Genomic Mapping & In Silico Mutation Simulation */}
            <div
              style={{
                padding: '0.75rem',
                borderRadius: '6px',
                border: `1px solid ${colors.borderLight}`,
                backgroundColor: colors.backgroundAlt,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: '0.82rem', color: colors.text }}>
                  Lysis Cassette Architecture ({inferenceResult.phageName})
                </span>
                <span style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                  Predicted timing: <strong>{inferenceResult.lysisCassette.predictedLysisTimingMin.toFixed(1)} min</strong>
                </span>
              </div>

              {/* Detected genes badges */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {inferenceResult.lysisCassette.genes.map((g) => (
                  <span
                    key={g.geneId}
                    style={{
                      fontSize: '0.7rem',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor:
                        g.role === 'holin' ? '#f59e0b25' : g.role === 'antiholin' ? '#ef444425' : g.role === 'endolysin' ? '#3b82f625' : '#8b5cf625',
                      color:
                        g.role === 'holin' ? '#f59e0b' : g.role === 'antiholin' ? '#ef4444' : g.role === 'endolysin' ? '#3b82f6' : '#8b5cf6',
                      border: `1px solid ${colors.borderLight}`,
                    }}
                    title={`${g.product}: ${g.mechanism}`}
                  >
                    [{g.role.toUpperCase()}] {g.name}
                  </span>
                ))}
                {inferenceResult.lysisCassette.genes.length === 0 && (
                  <span style={{ fontSize: '0.75rem', color: colors.textDim }}>
                    No canonical lysis cassette genes detected in current annotations.
                  </span>
                )}
              </div>

              {/* In-silico genetic engineering predictions */}
              <div style={{ marginTop: '4px', borderTop: `1px solid ${colors.borderLight}44`, paddingTop: '6px' }}>
                <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '4px' }}>
                  In-Silico Lysis Cassette Engineering Scenarios:
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.4rem' }}>
                  {inferenceResult.inSilicoScenarios.map((sc, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '0.4rem 0.6rem',
                        borderRadius: '4px',
                        backgroundColor: colors.background,
                        border: `1px solid ${colors.borderLight}`,
                        fontSize: '0.72rem',
                      }}
                    >
                      <div style={{ fontWeight: 600, color: colors.text }}>{sc.description}</div>
                      <div style={{ color: colors.textMuted, marginTop: '2px' }}>
                        Latent: <strong>{sc.predictedLatentPeriodMin.toFixed(1)}m</strong> ({sc.latentPeriodDeltaMin > 0 ? '+' : ''}{sc.latentPeriodDeltaMin}m) · Burst: <strong>{sc.predictedBurstSize}</strong> ({sc.burstSizeDelta > 0 ? '+' : ''}{sc.burstSizeDelta})
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function formatCount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}

function formatDelta(value: number): string {
  const prefix = value > 0 ? '+' : '';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${prefix}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${prefix}${(abs / 1e3).toFixed(1)}k`;
  return `${prefix}${abs.toFixed(0)}`;
}

export default InfectionKineticsVisualizer;
