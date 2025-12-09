import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { calculateSelectionPressure } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state'; // We need access to repository/data

// Mock repository access or use store if data available
// For Web, we might need to fetch data.
// Assuming we can get sequences via props or store.

interface Props {
  targetSequence?: string;
  referenceSequence?: string;
}

export function SelectionPressureOverlay({ targetSequence, referenceSequence }: Props): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const analysis = useMemo(() => {
    if (!targetSequence || !referenceSequence) return null;
    return calculateSelectionPressure(targetSequence, referenceSequence, 300);
  }, [targetSequence, referenceSequence]);

  useEffect(() => {
    if (!isOpen('pressure') || !canvasRef.current || !analysis) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      // Resize and reset transform
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Clear
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);

      const { windows } = analysis;
      if (!windows.length) return;
      const barWidth = Math.max(1, width / windows.length);

      windows.forEach((w, i) => {
        let color = colors.textDim; // Neutral
        if (w.classification === 'purifying') color = colors.primary; // Blue
        if (w.classification === 'positive') color = colors.error; // Red

        const x = i * barWidth;
        const h = Math.min(height, Math.max(2, w.omega * 20)); // Scale height by omega
        const y = height - h;

        ctx.fillStyle = color;
        ctx.fillRect(x, y, barWidth, h);
      });
    };

    draw();

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isOpen, analysis, colors]);

  if (!isOpen('pressure')) return null;

  return (
    <Overlay
      id="pressure"
      title="SELECTION PRESSURE (dN/dS)"
      icon="⚡"
      hotkey="v" // Using 'v' as mapped in TUI/Menu
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{
          padding: '0.75rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
          color: colors.textDim,
          fontSize: '0.9rem',
        }}>
          <strong style={{ color: colors.accent }}>Evolutionary Pressure</strong>: Blue = Purifying (Conserved), Red = Positive (Adaptive/Arms Race).
        </div>

        {!analysis ? (
           <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
             Requires reference comparison (Diff mode).
           </div>
        ) : (
           <>
             <div style={{
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
                overflow: 'hidden',
                height: '150px',
             }}>
                <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
             </div>
             <div>
                 Global ω: <span style={{ fontWeight: 'bold', color: analysis.globalOmega > 1 ? colors.error : colors.success }}>
                     {analysis.globalOmega.toFixed(3)}
                 </span>
             </div>
           </>
        )}
      </div>
    </Overlay>
  );
}
