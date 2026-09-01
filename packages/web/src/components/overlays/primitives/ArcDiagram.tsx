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
  const hoverRef = useRef(hover);
  const [canvasSize, setCanvasSize] = useState({ width, height });
  const sizeRef = useRef({ width, height });

  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);

  useEffect(() => {
    sizeRef.current = canvasSize;
  }, [canvasSize]);

  const nodePositions = useMemo(() => {
    const renderWidth = canvasSize.width || width;
    const gap = nodes.length > 1 ? renderWidth / (nodes.length - 1) : renderWidth / 2;
    return nodes.reduce<Record<string, number>>((acc, n, idx) => {
      acc[n.id] = idx * gap;
      return acc;
    }, {});
  }, [canvasSize.width, nodes, width]);

  // Re-render when the canvas CSS size changes.
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

  // Render arcs
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = canvas.clientWidth || width;
    canvas.height = canvas.clientHeight || height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const renderWidth = canvas.width;
    const renderHeight = canvas.height;
    ctx.clearRect(0, 0, renderWidth, renderHeight);
    ctx.fillStyle = theme.colors.background;
    ctx.fillRect(0, 0, renderWidth, renderHeight);
    ctx.strokeStyle = theme.colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, renderHeight - 1);
    ctx.lineTo(renderWidth, renderHeight - 1);
    ctx.stroke();

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const x1 = nodePositions[link.source] ?? 0;
      const x2 = nodePositions[link.target] ?? 0;
      const arcHeight = Math.max(10, Math.abs(x2 - x1) / 2);
      const yBase = renderHeight - 2;
      ctx.beginPath();
      const color = link.color ?? theme.colors.accent;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, thickness * ((link.weight ?? 0) > 0 ? Math.log1p(link.weight ?? 1) : 1));
      ctx.moveTo(x1, yBase);
      ctx.quadraticCurveTo((x1 + x2) / 2, yBase - arcHeight, x2, yBase);
      ctx.stroke();
    }
  }, [canvasSize, height, links, nodePositions, theme.colors.accent, theme.colors.background, theme.colors.border, thickness, width]);

  // Hover / click
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const yBase = sizeRef.current.height - 2;

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
  }, [links, nodePositions, onClick, onHover]);

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

