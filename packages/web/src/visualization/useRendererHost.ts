import { useEffect, useRef } from 'react';
import type { Theme } from '@phage-explorer/core';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import type { RenderFrameInput } from './types';
import { RendererHost } from './rendererHost';

interface UseRendererHostOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  repo: PhageRepository | null;
  phageId: number | null;
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
    if (!canvas || !opts.repo || opts.phageId === null || !opts.theme) return;
    const host = new RendererHost({
      canvas,
      repo: opts.repo,
      phageId: opts.phageId,
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
  }, [opts.canvasRef, opts.repo, opts.phageId, opts.theme, opts.fontFamily, opts.fontSize, opts.lineHeight]);

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

