import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../../hooks/useTheme';
import type { GelInteraction, GelLane } from './types';

interface GelCanvasProps {
  lanes: GelLane[];
  width?: number;
  height?: number;
  onHover?: (info: GelInteraction | null) => void;
  onClick?: (info: GelInteraction) => void;
  className?: string;
  ariaLabel?: string;
}

const MIN_SIZE_BP = 50;
const MAX_SIZE_BP = 20000;

function sizeToY(size: number, height: number): number {
  // Log-scale mapping: larger fragments stay near top, small near bottom
  const clamped = Math.max(MIN_SIZE_BP, Math.min(MAX_SIZE_BP, size));
  const logMin = Math.log10(MIN_SIZE_BP);
  const logMax = Math.log10(MAX_SIZE_BP);
  const t = (Math.log10(clamped) - logMin) / (logMax - logMin);
  // Top padding 20, bottom padding 20
  return 20 + t * (height - 40);
}

export const GelCanvas: React.FC<GelCanvasProps> = ({
  lanes,
  width = 600,
  height = 300,
  onHover,
  onClick,
  className = '',
  ariaLabel = 'Virtual gel electrophoresis',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const [hover, setHover] = useState<GelInteraction | null>(null);

  const laneWidth = useMemo(() => (lanes.length > 0 ? width / lanes.length : width), [lanes.length, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Background
    ctx.fillStyle = theme.colors.background;
    ctx.fillRect(0, 0, width, height);

    // Gel gradient
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a1d2e');
    grad.addColorStop(1, '#0f111a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Lane dividers
    ctx.strokeStyle = theme.colors.border;
    ctx.lineWidth = 1;
    for (let i = 0; i <= lanes.length; i++) {
      const x = i * laneWidth;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Bands
    lanes.forEach((lane, laneIndex) => {
      const laneX = laneIndex * laneWidth;
      const cx = laneX + laneWidth / 2;
      for (let b = 0; b < lane.bands.length; b++) {
        const band = lane.bands[b];
        const y = sizeToY(band.size, height);
        const intensity = Math.max(0, Math.min(1, band.intensity));
        const bandHeight = 6 + intensity * 6;
        const bandWidth = laneWidth * 0.7;
        const x1 = cx - bandWidth / 2;
        const x2 = cx + bandWidth / 2;
        const color = lane.color ?? '#a5c9ff';
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.2 + intensity * 0.8;
        ctx.fillRect(x1, y - bandHeight / 2, bandWidth, bandHeight);
        // Slight blur effect via shadow
        ctx.shadowColor = color;
        ctx.shadowBlur = 8 * intensity;
        ctx.fillRect(x1, y - bandHeight / 2, bandWidth, bandHeight);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
    });
  }, [height, laneWidth, lanes, theme.colors.background, theme.colors.border, width]);

  // Hover / click
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const laneIndex = Math.floor(mx / laneWidth);
      if (laneIndex < 0 || laneIndex >= lanes.length) {
        setHover(null);
        onHover?.(null);
        return;
      }
      const lane = lanes[laneIndex];
      const cx = laneIndex * laneWidth + laneWidth / 2;
      let best: GelInteraction | null = null;
      let minDist = Infinity;
      for (let b = 0; b < lane.bands.length; b++) {
        const band = lane.bands[b];
        const y = sizeToY(band.size, height);
        const bandHeight = 6 + Math.max(0, Math.min(1, band.intensity)) * 6;
        const bandWidth = laneWidth * 0.7;
        const x1 = cx - bandWidth / 2;
        const x2 = cx + bandWidth / 2;
        if (mx >= x1 && mx <= x2 && my >= y - bandHeight && my <= y + bandHeight) {
          const dy = Math.abs(my - y);
          if (dy < minDist) {
            minDist = dy;
            best = { laneIndex, bandIndex: b, band, clientX: e.clientX, clientY: e.clientY };
          }
        }
      }
      setHover(best);
      onHover?.(best);
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
  }, [height, hover, laneWidth, lanes, onClick, onHover]);

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width,
        height,
        background: '#0f111a',
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

export default GelCanvas;

