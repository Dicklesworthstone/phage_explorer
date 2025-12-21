/**
 * ScrollProvider - Premium Smooth Scroll with Lenis
 *
 * Provides app-wide smooth scrolling with native-feeling momentum physics.
 * Uses @studio-freight/lenis for buttery smooth scroll behavior.
 *
 * Features:
 * - Smooth scroll with configurable lerp/easing
 * - Native-feeling momentum on touch devices
 * - Respects prefers-reduced-motion
 * - Can be disabled for specific scroll containers
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import Lenis from '@studio-freight/lenis';
import { useReducedMotion } from '../hooks/useReducedMotion';

// =============================================================================
// Types
// =============================================================================

interface ScrollContextValue {
  /** The Lenis instance, or null if disabled */
  lenis: Lenis | null;
  /** Whether smooth scroll is currently active */
  isEnabled: boolean;
  /** Scroll to a specific position or element */
  scrollTo: (target: number | string | HTMLElement, options?: ScrollToOptions) => void;
  /** Stop the current scroll animation */
  stop: () => void;
  /** Start/resume scroll if stopped */
  start: () => void;
  /** Current scroll progress (0-1) */
  progress: number;
  /** Current scroll velocity */
  velocity: number;
  /** Whether user is actively scrolling */
  isScrolling: boolean;
}

interface ScrollToOptions {
  offset?: number;
  duration?: number;
  easing?: (t: number) => number;
  immediate?: boolean;
  lock?: boolean;
  onComplete?: () => void;
}

interface ScrollProviderProps {
  children: ReactNode;
  /** Whether to enable smooth scroll (default: true) */
  enabled?: boolean;
  /** Custom Lenis options */
  options?: Partial<LenisOptions>;
}

interface LenisOptions {
  /** Lerp (linear interpolation) factor - lower = smoother (default: 0.1) */
  lerp: number;
  /** Duration of scroll animation in seconds (default: 1.2) */
  duration: number;
  /** Easing function for scroll */
  easing: (t: number) => number;
  /** Touch scroll multiplier (default: 2) */
  touchMultiplier: number;
  /** Whether scroll is smooth (default: true) */
  smoothWheel: boolean;
  /** Orientation - 'vertical' or 'horizontal' */
  orientation: 'vertical' | 'horizontal';
  /** Gesture orientation - 'vertical', 'horizontal', or 'both' */
  gestureOrientation: 'vertical' | 'horizontal' | 'both';
  /** Infinite scroll (default: false) */
  infinite: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Default Lenis options optimized for mobile touch */
const DEFAULT_OPTIONS: LenisOptions = {
  lerp: 0.1, // Smoother interpolation
  duration: 1.2, // Longer momentum
  easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // Expo ease out
  touchMultiplier: 2, // Responsive to swipe
  smoothWheel: true,
  orientation: 'vertical',
  gestureOrientation: 'vertical',
  infinite: false,
};

/** Reduced motion options - instant scrolling */
const REDUCED_MOTION_OPTIONS: Partial<LenisOptions> = {
  lerp: 1,
  duration: 0,
};

// =============================================================================
// Context
// =============================================================================

const ScrollContext = createContext<ScrollContextValue | null>(null);

// =============================================================================
// Provider Component
// =============================================================================

export function ScrollProvider({
  children,
  enabled = true,
  options = {},
}: ScrollProviderProps): React.ReactElement {
  const lenisRef = useRef<Lenis | null>(null);
  const rafRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();

  const [progress, setProgress] = useState(0);
  const [velocity, setVelocity] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);

  // Determine if we should actually enable smooth scroll
  const shouldEnable = enabled && !reducedMotion;

  // Initialize Lenis
  useEffect(() => {
    if (!shouldEnable) {
      // Clean up any existing instance when disabled
      if (lenisRef.current) {
        lenisRef.current.destroy();
        lenisRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    // Merge options with defaults
    const mergedOptions: LenisOptions = {
      ...DEFAULT_OPTIONS,
      ...(reducedMotion ? REDUCED_MOTION_OPTIONS : {}),
      ...options,
    };

    // Create Lenis instance
    const lenis = new Lenis(mergedOptions);
    lenisRef.current = lenis;

    // Update state on scroll
    lenis.on('scroll', ({ progress: p, velocity: v, isScrolling: scrolling }: {
      progress: number;
      velocity: number;
      isScrolling: boolean;
    }) => {
      setProgress(p);
      setVelocity(v);
      setIsScrolling(scrolling);
    });

    // Animation frame loop
    const raf = (time: number) => {
      lenis.raf(time);
      rafRef.current = requestAnimationFrame(raf);
    };
    rafRef.current = requestAnimationFrame(raf);

    // Cleanup
    return () => {
      lenis.destroy();
      lenisRef.current = null;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [shouldEnable, reducedMotion, options]);

  // Handle resize/orientation changes
  useEffect(() => {
    if (!lenisRef.current) return;

    const handleResize = () => {
      lenisRef.current?.resize();
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [shouldEnable]);

  // Scroll to implementation
  const scrollTo = useCallback(
    (target: number | string | HTMLElement, scrollOptions?: ScrollToOptions) => {
      if (lenisRef.current) {
        lenisRef.current.scrollTo(target, scrollOptions);
      } else {
        // Fallback to native scroll when Lenis is disabled
        if (typeof target === 'number') {
          window.scrollTo({ top: target, behavior: reducedMotion ? 'auto' : 'smooth' });
        } else if (typeof target === 'string') {
          const element = document.querySelector(target);
          element?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
        } else if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
        }
      }
    },
    [reducedMotion]
  );

  // Stop scroll animation
  const stop = useCallback(() => {
    lenisRef.current?.stop();
  }, []);

  // Start/resume scroll
  const start = useCallback(() => {
    lenisRef.current?.start();
  }, []);

  const value: ScrollContextValue = {
    lenis: lenisRef.current,
    isEnabled: shouldEnable,
    scrollTo,
    stop,
    start,
    progress,
    velocity,
    isScrolling,
  };

  return (
    <ScrollContext.Provider value={value}>
      {children}
    </ScrollContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to access the scroll context.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { scrollTo, isScrolling, velocity } = useScroll();
 *
 *   return (
 *     <button onClick={() => scrollTo('#section-2')}>
 *       Go to Section 2
 *     </button>
 *   );
 * }
 * ```
 */
export function useScroll(): ScrollContextValue {
  const context = useContext(ScrollContext);
  if (!context) {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = prefersReducedMotion ? 'auto' : 'smooth';

    // Return safe defaults when used outside provider
    return {
      lenis: null,
      isEnabled: false,
      scrollTo: (target) => {
        if (typeof target === 'number') {
          window.scrollTo({ top: target, behavior });
        } else if (typeof target === 'string') {
          document.querySelector(target)?.scrollIntoView({ behavior });
        } else if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior });
        }
      },
      stop: () => {},
      start: () => {},
      progress: 0,
      velocity: 0,
      isScrolling: false,
    };
  }
  return context;
}

// =============================================================================
// Utility: Exclude from smooth scroll
// =============================================================================

/**
 * CSS class to add to containers that should use native scroll.
 * Lenis will not intercept scroll events for elements with this class.
 */
export const NATIVE_SCROLL_CLASS = 'lenis-prevent';

/**
 * Data attribute to mark elements for native scroll behavior.
 */
export const NATIVE_SCROLL_ATTR = 'data-lenis-prevent';

export default ScrollProvider;
