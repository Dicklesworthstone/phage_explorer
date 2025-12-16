import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../../hooks/useTheme';
import type { ArcInteraction, ArcLink, ArcNode } from './types';

interface ArcDiagramProps {
  nodes: ArcNode[];
  links: ArcLink[];
  width?: number;
  height?: number;
  thickness?: number;
  onHover?: (info: ArcInteraction | null) => void;
  onClick?: (info: ArcInteraction) => void;
  className?: string;
  ariaLabel?: string;
}

export const ArcDiagram: React.FC<ArcDiagramProps> = ({
  nodes,
  links,
  width = 600,
  height = 240,
  thickness = 2,
  onHover,
  onClick,
  className = '',
  ariaLabel = 'Arc diagram',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const [hover, setHover] = useState<ArcInteraction | null>(null);

  const nodePositions = useMemo(() => {
    const gap = nodes.length > 1 ? width / (nodes.length - 1) : width / 2;
    return nodes.reduce<Record<string, number>>((acc, n, idx) => {
      acc[n.id] = idx * gap;
      return acc;
    }, {});
  }, [nodes, width]);

  // Render arcs
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
    ctx.strokeStyle = theme.colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const x1 = nodePositions[link.source] ?? 0;
      const x2 = nodePositions[link.target] ?? 0;
      const arcHeight = Math.max(10, Math.abs(x2 - x1) / 2);
      const yBase = height - 2;
      ctx.beginPath();
      const color = link.color ?? theme.colors.accent;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, thickness * ((link.weight ?? 0) > 0 ? Math.log1p(link.weight ?? 1) : 1));
      ctx.moveTo(x1, yBase);
      ctx.quadraticCurveTo((x1 + x2) / 2, yBase - arcHeight, x2, yBase);
      ctx.stroke();
    }
  }, [height, links, nodePositions, theme.colors.accent, theme.colors.background, theme.colors.border, thickness, width]);

  // Hover / click
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const yBase = height - 2;

      let closest: ArcInteraction | null = null;
      let minDist = Infinity;
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const x1 = nodePositions[link.source] ?? 0;
        const x2 = nodePositions[link.target] ?? 0;
        const cx = (x1 + x2) / 2;
        const arcHeight = Math.max(10, Math.abs(x2 - x1) / 2);

        // Approximate distance to quadratic curve by checking midpoint
        const midY = yBase - arcHeight;
        const dx = mx - cx;
        const dy = my - midY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist && dist <= arcHeight + 8) {
          minDist = dist;
          closest = { link, index: i, clientX: e.clientX, clientY: e.clientY };
        }
      }
      setHover(closest);
      onHover?.(closest);
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
  }, [height, hover, links, nodePositions, onClick, onHover]);

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

export default ArcDiagram;

