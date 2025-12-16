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

  const clampedSegments = useMemo(
    () =>
      segments.map((s) => ({
        ...s,
        start: Math.max(0, Math.min(genomeLength, s.start)),
        end: Math.max(0, Math.min(genomeLength, s.end)),
      })),
    [genomeLength, segments]
  );

  const toX = useMemo(() => {
    const len = Math.max(1, genomeLength);
    return (pos: number) => (pos / len) * (width - 20) + 10;
  }, [genomeLength, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = theme.colors.background;
    ctx.fillRect(0, 0, width, height);

    // Baseline
    ctx.strokeStyle = theme.colors.border;
    ctx.lineWidth = 1;
    const baseY = height / 2;
    ctx.beginPath();
    ctx.moveTo(10, baseY);
    ctx.lineTo(width - 10, baseY);
    ctx.stroke();

    // Segments
    for (const seg of clampedSegments) {
      const x1 = toX(seg.start);
      const x2 = toX(seg.end);
      const segHeight = seg.height ?? 14;
      ctx.fillStyle = seg.color ?? theme.colors.accent;
      ctx.fillRect(x1, baseY - segHeight / 2, Math.max(1, x2 - x1), segHeight);
    }

    // Current position marker
    if (currentPosition !== null && Number.isFinite(currentPosition)) {
      const cx = toX(currentPosition);
      ctx.strokeStyle = theme.colors.warning;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, baseY - 20);
      ctx.lineTo(cx, baseY + 20);
      ctx.stroke();
    }
  }, [clampedSegments, currentPosition, height, theme.colors.accent, theme.colors.background, theme.colors.border, theme.colors.warning, toX, width]);

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
      const frac = (mx - 10) / (width - 20);
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
      if (hover) onClick?.(hover);
    };

    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    canvas.addEventListener('click', handleClick);
    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
      canvas.removeEventListener('click', handleClick);
    };
  }, [clampedSegments, genomeLength, height, hover, onClick, onHover, width]);

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

