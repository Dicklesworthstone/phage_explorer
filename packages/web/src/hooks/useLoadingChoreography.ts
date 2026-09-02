/**
 * useLoadingChoreography - Coordinates skeleton delay, content reveal timing
 *
 * Prevents skeleton flash on fast loads (100ms delay), adds gap between
 * skeleton fade-out and content reveal (50ms), and provides staggered
 * content-reveal animation classes.
 */

import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useReducedMotion } from './useReducedMotion';

export type ChoreographyPhase = 'idle' | 'skeleton' | 'gap' | 'content';

export interface UseLoadingChoreographyOptions {
  /** Whether the content is loading */
  isLoading: boolean;
  /** Delay before showing skeleton in ms (prevents flash on fast loads) */
  skeletonDelay?: number;
  /** Gap between skeleton hide and content show in ms */
  revealGap?: number;
}

export interface UseLoadingChoreographyResult {
  /** Current choreography phase */
  phase: ChoreographyPhase;
  /** Opacity for the skeleton overlay (0 or 1) */
  skeletonOpacity: number;
  /** Opacity for the main content (0 or 1) */
  contentOpacity: number;
  /** Whether the skeleton should be rendered at all */
  showSkeleton: boolean;
  /** Whether the content should be rendered */
  showContent: boolean;
  /** CSS class to apply on the content container for staggered entrance */
  contentClassName: string;
}

export function useLoadingChoreography(
  options: UseLoadingChoreographyOptions
): UseLoadingChoreographyResult {
  const { isLoading, skeletonDelay = 100, revealGap = 50 } = options;
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<ChoreographyPhase>(isLoading ? 'idle' : 'content');
  const phaseRef = useRef(phase);
  useLayoutEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (isLoading) {
      if (reducedMotion) {
        setPhase('skeleton');
        return;
      }
      // Delay skeleton to prevent flash on fast loads
      setPhase('idle');
      timerRef.current = setTimeout(() => {
        setPhase('skeleton');
      }, skeletonDelay);
    } else {
      // Loading finished
      if (phaseRef.current === 'idle') {
        // Load was fast enough that skeleton never showed - skip straight to content
        setPhase('content');
        return;
      }
      if (reducedMotion) {
        setPhase('content');
        return;
      }
      // Brief gap between skeleton fade-out and content reveal
      setPhase('gap');
      timerRef.current = setTimeout(() => {
        setPhase('content');
      }, revealGap);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isLoading, skeletonDelay, revealGap, reducedMotion]);

  const showSkeleton = phase === 'skeleton' || phase === 'gap';
  const showContent = phase === 'content';
  const contentClassName = showContent && !reducedMotion ? 'content-stagger' : '';

  // The interface has always documented these two, and the implementation has
  // never returned them. Nothing consumed them, so the gap survived: the web
  // package was excluded from the root tsconfig, so no typecheck ever compared
  // the return value against its declared type.
  //
  // During the 'gap' phase the skeleton is still mounted but fading, which is
  // the whole point of that phase, so it takes 0 while remaining rendered.
  const skeletonOpacity = phase === 'skeleton' ? 1 : 0;
  const contentOpacity = showContent ? 1 : 0;

  return {
    phase,
    skeletonOpacity,
    contentOpacity,
    showSkeleton,
    showContent,
    contentClassName,
  };
}
