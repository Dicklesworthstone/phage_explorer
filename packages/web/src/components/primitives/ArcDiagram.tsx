import React, { useEffect, useMemo, useRef } from 'react';
import type { ArcLink, ArcNode } from './types';

export interface ArcDiagramProps {
  width: number;
  height: number;
  nodes: ArcNode[];
  links: ArcLink[];
  padding?: number;
  stroke?: string;
  showLabels?: boolean;
  onHover?: (link: ArcLink | null) => void;
  ariaLabel?: string;
}

export function ArcDiagram({
  width,
  height,
  nodes,
  links,
  padding = 24,
  stroke = '#94a3b8',
  showLabels = false,
  onHover,
  ariaLabel = 'arc diagram',
}: ArcDiagramProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const positioned = useMemo(() => {
    const n = nodes.length || 1;
    const mapped = nodes.map((node, idx) => {
      const pos = node.position ?? idx / Math.max(1, n - 1);
      return { ...node, position: Math.min(1, Math.max(0, pos)) };
    });
    return {
      nodes: mapped,
      lookup: new Map(mapped.map(node => [node.id, node])),
    };
  }, [nodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const baselineY = height - padding;
    const availableW = width - padding * 2;

    // Draw baseline
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, baselineY);
    ctx.lineTo(width - padding, baselineY);
    ctx.stroke();

    // Draw links
    for (const link of links) {
      const source = positioned.lookup.get(link.source);
      const target = positioned.lookup.get(link.target);
      if (!source || !target) continue;
      const x1 = padding + source.position * availableW;
      const x2 = padding + target.position * availableW;
      const mid = (x1 + x2) / 2;
      const arcHeight = Math.max(12, Math.abs(x2 - x1) / 3);

      ctx.strokeStyle = link.color ?? stroke;
      ctx.lineWidth = Math.max(1, (link.weight ?? 1) * 0.5);
      ctx.beginPath();
      ctx.moveTo(x1, baselineY);
      ctx.quadraticCurveTo(mid, baselineY - arcHeight, x2, baselineY);
      ctx.stroke();
    }

    // Draw nodes
    for (const node of positioned.nodes) {
      const x = padding + node.position * availableW;
      ctx.fillStyle = node.color ?? '#0ea5e9';
      ctx.beginPath();
      ctx.arc(x, baselineY, 4, 0, Math.PI * 2);
      ctx.fill();
      if (showLabels && node.label) {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '12px Inter, sans-serif';
        ctx.fillText(node.label, x - ctx.measureText(node.label).width / 2, baselineY - 10);
      }
    }
  }, [height, links, padding, positioned, showLabels, stroke, width]);

  useEffect(() => {
    if (!onHover) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const baselineY = height - padding;
    const availableW = width - padding * 2;

    const handleMove = (evt: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const y = evt.clientY - rect.top;
      // Simple hit test: find closest link by vertical distance to arc
      let closest: ArcLink | null = null;
      let best = Infinity;
      for (const link of links) {
        const source = positioned.lookup.get(link.source);
        const target = positioned.lookup.get(link.target);
        if (!source || !target) continue;
        const x1 = padding + source.position * availableW;
        const x2 = padding + target.position * availableW;
        const arcHeight = Math.max(12, Math.abs(x2 - x1) / 3);
        const span = x2 - x1;
        const denom = span === 0 ? 1 : span;
        const t = (x - x1) / denom;
        const parabola = t * (1 - t); // 0..0.25
        const yOnArc = baselineY - arcHeight * parabola * 4;
        const dy = Math.abs(y - yOnArc);
        if (dy < best && dy < 12) {
          best = dy;
          closest = link;
        }
      }
      onHover(closest);
    };

    const handleLeave = () => onHover(null);
    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
    };
  }, [height, links, onHover, padding, positioned.lookup, width]);

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

export default ArcDiagram;

