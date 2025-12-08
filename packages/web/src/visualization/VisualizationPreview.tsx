import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRendererHost } from './useRendererHost';
import type { Theme } from '@phage-explorer/core';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import type { RenderFrameInput } from './types';

interface VisualizationPreviewProps {
  repo: PhageRepository | null;
  phageId: number | null;
  theme: Theme | null;
}

/**
 * Lightweight, opt-in preview component to smoke-test the canvas renderer.
 * Not wired into the main UI yet; can be mounted in a sandbox route.
 */
export const VisualizationPreview: React.FC<VisualizationPreviewProps> = ({ repo, phageId, theme }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { render } = useRendererHost({ canvasRef, repo, phageId, theme });
  const [frame, setFrame] = useState<RenderFrameInput>({
    scrollTop: 0,
    viewportHeight: 400,
    viewportWidth: 800,
    overscanRows: 20,
  });

  // Update viewport dims from canvas client rect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      setFrame(f => ({
        ...f,
        viewportHeight: rect.height,
        viewportWidth: rect.width,
      }));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Render on frame change
  useEffect(() => {
    void render(frame);
  }, [frame, render]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    setFrame(f => ({ ...f, scrollTop: top }));
  };

  const canRender = useMemo(() => repo && phageId !== null && theme, [repo, phageId, theme]);

  return (
    <div className="viz-preview">
      <div className="viz-controls">
        <span className="badge">{canRender ? 'Ready' : 'Waiting for repo/phage/theme'}</span>
        <span className="text-dim">Scroll inside the viewport to trigger renders.</span>
      </div>
      <div className="viz-viewport" onScroll={onScroll}>
        <canvas ref={canvasRef} className="viz-canvas" />
      </div>
    </div>
  );
};

