import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRendererHost } from './useRendererHost';
import type { Theme } from '@phage-explorer/core';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import type { RenderFrameInput, SequenceSource } from './types';
import { getMockSequence, hasMockSequence } from './mockSequenceSource';

interface VisualizationPreviewProps {
  repo: PhageRepository | null;
  phageId: number | null;
  theme: Theme | null;
  source?: SequenceSource | null;
}

/**
 * Lightweight, opt-in preview component to smoke-test the canvas renderer.
 * Not wired into the main UI yet; can be mounted in a sandbox route.
 */
const buildMockSource = (): SequenceSource => {
  const seq = getMockSequence();
  const rowWidth = 200;
  return {
    async getWindow(request: { start: number; end: number }) {
      const start = Math.max(0, request.start);
      const end = Math.min(seq.length, request.end);
      const chunk = seq.slice(start, end);
      const rows: string[] = [];
      for (let i = 0; i < chunk.length; i += rowWidth) {
        rows.push(chunk.slice(i, i + rowWidth));
      }
      return { start, end, rows };
    },
    async totalLength() {
      return seq.length;
    },
  };
};

export const VisualizationPreview: React.FC<VisualizationPreviewProps> = ({ repo, phageId, theme, source }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackSource = !repo && hasMockSequence() ? buildMockSource() : undefined;
  const { render } = useRendererHost({
    canvasRef,
    repo,
    phageId,
    theme,
    source: source ?? fallbackSource,
  });
  const [frame, setFrame] = useState<RenderFrameInput>({
    scrollTop: 0,
    viewportHeight: 400,
    viewportWidth: 800,
    overscanRows: 20,
    viewMode: 'dna',
    readingFrame: 0,
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

  const canRender = useMemo(
    () => (!!repo && phageId !== null && !!theme) || (!!theme && !!(source ?? fallbackSource)),
    [repo, phageId, theme, source, fallbackSource]
  );

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

