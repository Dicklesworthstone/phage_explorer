import React, { useEffect, useMemo, useRef } from 'react';
import type { GenomeTrack as Track, GenomeTrackDatum, GenomeTrackHover } from './types';

export interface GenomeTrackProps {
  width: number;
  height: number;
  genomeLength: number;
  tracks: Track[];
  padding?: number;
  backgroundColor?: string;
  cursor?: number | null;
  showScale?: boolean;
  onHover?: (hover: GenomeTrackHover | null) => void;
  onClick?: (hover: GenomeTrackHover | null) => void;
  ariaLabel?: string;
}

function drawDatum(
  ctx: CanvasRenderingContext2D,
  datum: GenomeTrackDatum,
  y: number,
  height: number,
  scale: (pos: number) => number,
  color: string
) {
  const x1 = scale(datum.start);
  const x2 = scale(datum.end);
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, Math.min(height, 10));
  const yTop = y - h / 2;
  ctx.fillStyle = datum.color ?? color;
  switch (datum.type) {
    case 'line':
      ctx.strokeStyle = datum.color ?? color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      break;
    case 'region':
    case 'bar':
    default:
      ctx.fillRect(x1, yTop, w, h);
  }
}

export function GenomeTrack({
  width,
  height,
  genomeLength,
  tracks,
  padding = 16,
  backgroundColor = '#0b1220',
  cursor = null,
  showScale = true,
  onHover,
  onClick,
  ariaLabel = 'genome track',
}: GenomeTrackProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const scale = useMemo(() => {
    const innerW = width - padding * 2;
    const denom = genomeLength || 1;
    return (pos: number) => padding + (pos / denom) * innerW;
  }, [genomeLength, padding, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);
    const laneHeight = Math.max(12, (height - padding * 2) / Math.max(1, tracks.length));

    tracks.forEach((track, idx) => {
      const y = padding + laneHeight * idx + laneHeight / 2;
      ctx.fillStyle = '#334155';
      ctx.fillRect(padding, y, width - padding * 2, 1);
      const color = track.color ?? '#22c55e';
      for (const datum of track.data) {
        drawDatum(ctx, datum, y, laneHeight, scale, color);
      }
      if (track.label) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px Inter, sans-serif';
        ctx.fillText(track.label, padding, y - laneHeight / 2 + 10);
      }
    });

    if (typeof cursor === 'number' && !Number.isNaN(cursor)) {
      const x = scale(Math.max(0, Math.min(genomeLength, cursor)));
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, padding);
      ctx.lineTo(x, height - padding);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (showScale) {
      const ticks = 4;
      ctx.strokeStyle = '#475569';
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px Inter, sans-serif';
      for (let i = 0; i <= ticks; i++) {
        const frac = i / ticks;
        const x = padding + frac * (width - padding * 2);
        ctx.beginPath();
        ctx.moveTo(x, height - padding + 2);
        ctx.lineTo(x, height - padding + 8);
        ctx.stroke();
        const label = Math.round(frac * genomeLength).toLocaleString();
        ctx.fillText(label, x - ctx.measureText(label).width / 2, height - padding + 20);
      }
    }
  }, [backgroundColor, cursor, genomeLength, height, padding, scale, showScale, tracks, width]);

  useEffect(() => {
    if (!onHover && !onClick) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const laneHeight = Math.max(12, (height - padding * 2) / Math.max(1, tracks.length));
    const innerW = width - padding * 2;

    const pick = (evt: MouseEvent): GenomeTrackHover | null => {
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const y = evt.clientY - rect.top;
      if (x < padding || x > width - padding || y < padding || y > height - padding) {
        return null;
      }
      const trackIdx = Math.floor((y - padding) / laneHeight);
      const track = tracks[trackIdx];
      if (!track) return null;
      const frac = (x - padding) / innerW;
      const genomePosition = Math.max(0, Math.min(genomeLength, frac * genomeLength));
      const datum = track.data.find(d => genomePosition >= d.start && genomePosition <= d.end) ?? null;
      return {
        track,
        datum,
        genomePosition,
        canvasX: x,
        canvasY: y,
      };
    };

    const handleMove = (evt: MouseEvent) => {
      if (!onHover) return;
      onHover(pick(evt));
    };
    const handleLeave = () => {
      if (onHover) onHover(null);
    };
    const handleClick = (evt: MouseEvent) => {
      if (!onClick) return;
      onClick(pick(evt));
    };

    if (onHover) {
      canvas.addEventListener('mousemove', handleMove);
      canvas.addEventListener('mouseleave', handleLeave);
    }
    if (onClick) {
      canvas.addEventListener('click', handleClick);
    }

    return () => {
      if (onHover) {
        canvas.removeEventListener('mousemove', handleMove);
        canvas.removeEventListener('mouseleave', handleLeave);
      }
      if (onClick) {
        canvas.removeEventListener('click', handleClick);
      }
    };
  }, [genomeLength, height, onClick, onHover, padding, tracks, width]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      aria-label={ariaLabel}
      role="img"
      style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
    />
  );
}

export default GenomeTrack;

