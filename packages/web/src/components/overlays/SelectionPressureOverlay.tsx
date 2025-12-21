import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { calculateSelectionPressure } from '@phage-explorer/core';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';

interface SelectionPressureOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function SelectionPressureOverlay({ repository, currentPhage }: SelectionPressureOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const diffEnabled = usePhageStore(s => s.diffEnabled);
  const diffReferenceSequence = usePhageStore(s => s.diffReferenceSequence);

  const [targetSequence, setTargetSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Fetch target sequence when overlay is open
  useEffect(() => {
    if (!isOpen('selectionPressure') || !repository || !currentPhage) {
      setTargetSequence('');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    repository.getFullGenomeLength(currentPhage.id)
      .then(len => repository.getSequenceWindow(currentPhage.id, 0, len))
      .then(seq => {
        if (!cancelled) setTargetSequence(seq);
      })
      .catch(err => console.error('Failed to load target sequence', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [isOpen, repository, currentPhage]);

  const analysis = useMemo(() => {
    if (!diffEnabled || !targetSequence || !diffReferenceSequence) return null;
    return calculateSelectionPressure(targetSequence, diffReferenceSequence, 150);
  }, [diffEnabled, targetSequence, diffReferenceSequence]);

  useEffect(() => {
    if (!isOpen('selectionPressure') || !canvasRef.current || !analysis) return;
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

  if (!isOpen('selectionPressure')) return null;

  return (
    <Overlay
      id="selectionPressure"
      title="SELECTION PRESSURE (dN/dS)"
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

        {loading ? (
           <AnalysisPanelSkeleton />
        ) : !analysis ? (
           <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
             {!diffEnabled ? 'Requires reference comparison (enable Diff mode).' : 'Preparing analysis...'}
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
