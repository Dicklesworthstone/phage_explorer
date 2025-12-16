import { useEffect, useRef } from 'react';
import type { Theme } from '@phage-explorer/core';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import type { RenderFrameInput, SequenceSource } from './types';
import { RendererHost } from './rendererHost';

interface UseRendererHostOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  repo?: PhageRepository | null;
  phageId?: number | null;
  source?: SequenceSource | null;
  theme: Theme | null;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
}

/**
  * React hook to manage RendererHost lifecycle.
  * Caller controls RenderFrameInput (scroll/viewport) and invokes render().
  */
export function useRendererHost(opts: UseRendererHostOptions) {
  const hostRef = useRef<RendererHost | null>(null);

  useEffect(() => {
    const canvas = opts.canvasRef.current;
    const hasRepoSource = opts.repo && opts.phageId !== null && opts.phageId !== undefined;
    const hasCustomSource = !!opts.source;
    if (!canvas || (!hasRepoSource && !hasCustomSource) || !opts.theme) return;
    const host = new RendererHost({
      canvas,
      repo: hasRepoSource ? opts.repo ?? undefined : undefined,
      phageId: hasRepoSource ? opts.phageId ?? undefined : undefined,
      source: opts.source ?? undefined,
      theme: opts.theme,
      fontFamily: opts.fontFamily,
      fontSize: opts.fontSize,
      lineHeight: opts.lineHeight,
    });
    hostRef.current = host;
    void host.init();
    return () => {
      host.destroy();
      hostRef.current = null;
    };
  }, [opts.canvasRef, opts.repo, opts.phageId, opts.source, opts.theme, opts.fontFamily, opts.fontSize, opts.lineHeight]);

  const render = async (frame: RenderFrameInput) => {
    if (hostRef.current) {
      await hostRef.current.render(frame);
    }
  };

  const setPhage = (phageId: number) => {
    hostRef.current?.setPhage(phageId);
  };

  return { render, setPhage };
}

