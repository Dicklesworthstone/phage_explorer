import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../../hooks/useTheme';
import type { GenomeTrackInteraction, GenomeTrackSegment } from './types';

export interface GenomeTrackProps {
  genomeLength: number;
  segments: GenomeTrackSegment[];
  width?: number;
  height?: number;
  currentPosition?: number | null;
  onHover?: (info: GenomeTrackInteraction | null) => void;
  onClick?: (info: GenomeTrackInteraction) => void;
  className?: string;
  ariaLabel?: string;
}

export const GenomeTrack: React.FC<GenomeTrackProps> = ({
  genomeLength,
  segments,
  width = 640,
  height = 80,
  currentPosition = null,
  onHover,
  onClick,
  className = '',
  ariaLabel = 'Genome track',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const [hover, setHover] = useState<GenomeTrackInteraction | null>(null);
  const hoverRef = useRef(hover);
  const [canvasSize, setCanvasSize] = useState({ width, height });
  const sizeRef = useRef({ width, height });

  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);

  useEffect(() => {
    sizeRef.current = canvasSize;
  }, [canvasSize]);

  const clampedSegments = useMemo(
    () =>
      segments.map((s) => ({
        ...s,
        start: Math.max(0, Math.min(genomeLength, s.start)),
        end: Math.max(0, Math.min(genomeLength, s.end)),
      })),
    [genomeLength, segments]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Use the canvas's actual CSS pixel size as the backing store so mouse
    // coordinates from getBoundingClientRect() map 1:1 to intrinsic pixels.
    canvas.width = canvas.clientWidth || width;
    canvas.height = canvas.clientHeight || height;
    sizeRef.current = { width: canvas.width, height: canvas.height };

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const renderWidth = canvas.width;
    const renderHeight = canvas.height;
    ctx.clearRect(0, 0, renderWidth, renderHeight);
    ctx.fillStyle = theme.colors.background;
    ctx.fillRect(0, 0, renderWidth, renderHeight);

    const len = Math.max(1, genomeLength);
    const toXLocal = (pos: number) => (pos / len) * (renderWidth - 20) + 10;

    // Baseline
    ctx.strokeStyle = theme.colors.border;
    ctx.lineWidth = 1;
    const baseY = renderHeight / 2;
    ctx.beginPath();
    ctx.moveTo(10, baseY);
    ctx.lineTo(renderWidth - 10, baseY);
    ctx.stroke();

    // Segments
    for (const seg of clampedSegments) {
      const x1 = toXLocal(seg.start);
      const x2 = toXLocal(seg.end);
      const segHeight = seg.height ?? 14;
      ctx.fillStyle = seg.color ?? theme.colors.accent;
      ctx.fillRect(x1, baseY - segHeight / 2, Math.max(1, x2 - x1), segHeight);
    }

    // Current position marker
    if (currentPosition !== null && Number.isFinite(currentPosition)) {
      const cx = toXLocal(currentPosition);
      ctx.strokeStyle = theme.colors.warning;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, baseY - 20);
      ctx.lineTo(cx, baseY + 20);
      ctx.stroke();
    }
  }, [canvasSize, clampedSegments, currentPosition, height, theme.colors.accent, theme.colors.background, theme.colors.border, theme.colors.warning, genomeLength, width]);

  // Re-render when the canvas CSS size changes (e.g., responsive layouts).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      if (canvas.clientWidth > 0) {
        setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight });
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) {
        setHover(null);
        onHover?.(null);
        return;
      }
      const cssWidth = sizeRef.current.width || rect.width;
      const frac = (mx - 10) / (cssWidth - 20);
      const position = Math.max(0, Math.min(genomeLength, frac * genomeLength));
      let segment: GenomeTrackSegment | null = null;
      for (const seg of clampedSegments) {
        if (position >= seg.start && position <= seg.end) {
          segment = seg;
          break;
        }
      }
      const info: GenomeTrackInteraction = {
        position,
        segment,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      setHover(info);
      onHover?.(info);
    };
    const handleLeave = () => {
      setHover(null);
      onHover?.(null);
    };
    const handleClick = () => {
      const currentHover = hoverRef.current;
      if (currentHover) onClick?.(currentHover);
    };

    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    canvas.addEventListener('click', handleClick);
    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
      canvas.removeEventListener('click', handleClick);
    };
  }, [clampedSegments, genomeLength, onClick, onHover]);

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width,
        height,
        background: theme.colors.background,
        border: `1px solid ${theme.colors.border}`,
      }}
      aria-label={ariaLabel}
      role="img"
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
};

export default GenomeTrack;

