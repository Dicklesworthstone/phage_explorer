/**
 * PullToRefresh - iOS-style pull-to-refresh with gesture physics
 *
 * Features:
 * - Rubberband resistance during pull
 * - Arrow rotation based on pull distance
 * - Spinner transition at threshold
 * - Haptic feedback at ready state
 * - Spring-based animations
 *
 * Uses @use-gesture/react and @react-spring/web for native-feeling physics.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useSpring, animated, config } from '@react-spring/web';
import { useDrag } from '@use-gesture/react';
import { haptics } from '../../utils/haptics';
import { useReducedMotion } from '../../hooks/useReducedMotion';

// =============================================================================
// Types
// =============================================================================

type RefreshState = 'idle' | 'pulling' | 'ready' | 'refreshing';

interface PullToRefreshProps {
  /** Callback when refresh is triggered */
  onRefresh: () => Promise<void>;
  /** Content to wrap */
  children: ReactNode;
  /** Pull distance threshold in px (default: 80) */
  threshold?: number;
  /** Maximum pull distance in px (default: 120) */
  maxPull?: number;
  /** Whether pull-to-refresh is enabled (default: true) */
  enabled?: boolean;
  /** Custom class name */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Rubberband resistance factor (0-1, lower = more resistance) */
const RUBBERBAND_FACTOR = 0.4;

/** Spinner rotation speed in degrees per frame */
const SPINNER_ROTATION_SPEED = 12;

// =============================================================================
// Component
// =============================================================================

export function PullToRefresh({
  onRefresh,
  children,
  threshold = 80,
  maxPull = 120,
  enabled = true,
  className = '',
}: PullToRefreshProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState<RefreshState>('idle');
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Track if we've triggered the ready haptic
  const hasTriggeredReadyHaptic = useRef(false);

  // Track spinner interval for cleanup on unmount
  const spinnerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Spring for pull distance and indicator
  const [spring, api] = useSpring(() => ({
    pullDistance: 0,
    arrowRotation: 0,
    spinnerRotation: 0,
    opacity: 0,
    config: reducedMotion
      ? { duration: 0 }
      : { ...config.wobbly, tension: 400, friction: 30 },
  }));

  // Cleanup spinner interval on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (spinnerIntervalRef.current !== null) {
        clearInterval(spinnerIntervalRef.current);
        spinnerIntervalRef.current = null;
      }
    };
  }, []);

  // Apply rubberband effect
  const applyRubberband = useCallback(
    (distance: number): number => {
      if (distance <= threshold) {
        return distance * RUBBERBAND_FACTOR;
      }
      // Past threshold, increase resistance
      const overThreshold = distance - threshold;
      const rubberbandedOver = overThreshold * (RUBBERBAND_FACTOR * 0.5);
      return threshold * RUBBERBAND_FACTOR + rubberbandedOver;
    },
    [threshold]
  );

  // Reset to idle state
  const resetToIdle = useCallback(() => {
    setState('idle');
    hasTriggeredReadyHaptic.current = false;
    api.start({
      pullDistance: 0,
      arrowRotation: 0,
      opacity: 0,
      config: { tension: 400, friction: 30 },
    });
  }, [api]);

  // Handle refresh completion
  const completeRefresh = useCallback(async () => {
    try {
      await onRefresh();
    } finally {
      haptics.success();
      resetToIdle();
    }
  }, [onRefresh, resetToIdle]);

  // Drag gesture handler
  const bindDrag = useDrag(
    ({ movement: [, my], active, first, cancel }) => {
      if (!enabled) return;

      // Only allow pull when at top of scroll
      if (first) {
        const scrollTop = containerRef.current?.scrollTop ?? 0;
        if (scrollTop > 0) {
          cancel();
          return;
        }
      }

      // Ignore upward drags
      if (my < 0) {
        if (stateRef.current === 'idle') return;
        resetToIdle();
        return;
      }

      // Don't process during refresh
      if (stateRef.current === 'refreshing') return;

      const rubberbandedDistance = applyRubberband(my);
      const clampedDistance = Math.min(rubberbandedDistance, maxPull * RUBBERBAND_FACTOR);
      const progress = Math.min(my / threshold, 1);

      if (active) {
        // During drag
        const isReady = my >= threshold;

        if (isReady && stateRef.current !== 'ready') {
          setState('ready');
          if (!hasTriggeredReadyHaptic.current) {
            haptics.medium();
            hasTriggeredReadyHaptic.current = true;
          }
        } else if (!isReady && stateRef.current === 'ready') {
          setState('pulling');
        } else if (stateRef.current === 'idle' && my > 5) {
          setState('pulling');
        }

        // Arrow rotates from 0 to 180 degrees as pull progresses
        const arrowRotation = Math.min(progress * 180, 180);

        api.start({
          pullDistance: clampedDistance,
          arrowRotation,
          opacity: Math.min(progress * 1.5, 1),
          immediate: true,
        });
      } else {
        // On release
        hasTriggeredReadyHaptic.current = false;

        if (stateRef.current === 'ready') {
          // Trigger refresh
          setState('refreshing');
          haptics.impact();

          // Animate to refreshing position
          api.start({
            pullDistance: threshold * RUBBERBAND_FACTOR * 0.8,
            arrowRotation: 0,
            opacity: 1,
          });

          // Start spinner animation (use ref for cleanup on unmount)
          if (spinnerIntervalRef.current !== null) {
            clearInterval(spinnerIntervalRef.current);
          }
          spinnerIntervalRef.current = setInterval(() => {
            api.set({
              spinnerRotation: (spring.spinnerRotation.get() + SPINNER_ROTATION_SPEED) % 360,
            });
          }, 16);

          // Execute refresh
          completeRefresh().finally(() => {
            if (spinnerIntervalRef.current !== null) {
              clearInterval(spinnerIntervalRef.current);
              spinnerIntervalRef.current = null;
            }
          });
        } else {
          // Not ready, spring back
          resetToIdle();
        }
      }
    },
    {
      from: () => [0, 0],
      axis: 'y',
      filterTaps: true,
      pointer: { touch: true },
      eventOptions: { passive: false },
    }
  );

  const dragBind = bindDrag();

  return (
    <div
      ref={containerRef}
      className={`pull-to-refresh ${className}`}
      style={{
        position: 'relative',
        touchAction: state === 'idle' ? 'pan-y' : 'none',
        overscrollBehavior: 'contain',
      }}
    >
      {/* Pull indicator */}
      <animated.div
        className="pull-to-refresh__indicator"
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: spring.pullDistance.to(
            (d) => `translateX(-50%) translateY(${d - 40}px)`
          ),
          opacity: spring.opacity,
          zIndex: 10,
          pointerEvents: 'none',
        }}
      >
        <animated.div
          className="pull-to-refresh__icon"
          style={{
            width: 32,
            height: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--color-background-elevated, #16161f)',
            borderRadius: '50%',
            boxShadow: 'var(--shadow-md, 0 4px 6px rgba(0,0,0,0.3))',
            transform:
              state === 'refreshing'
                ? spring.spinnerRotation.to((r) => `rotate(${r}deg)`)
                : spring.arrowRotation.to((r) => `rotate(${r}deg)`),
          }}
        >
          {state === 'refreshing' ? (
            // Spinner icon
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-primary, #22d3ee)"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M21 12a9 9 0 11-6.219-8.56" />
            </svg>
          ) : (
            // Arrow icon
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke={
                state === 'ready'
                  ? 'var(--color-primary, #22d3ee)'
                  : 'var(--color-text-muted, #6b7280)'
              }
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transition: 'stroke 150ms ease-out',
              }}
            >
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          )}
        </animated.div>

        {/* Status text */}
        <div
          className="pull-to-refresh__text"
          style={{
            marginTop: 8,
            fontSize: 12,
            fontWeight: 500,
            color:
              state === 'ready' || state === 'refreshing'
                ? 'var(--color-primary, #22d3ee)'
                : 'var(--color-text-muted, #6b7280)',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            transition: 'color 150ms ease-out',
          }}
        >
          {state === 'refreshing'
            ? 'Refreshing...'
            : state === 'ready'
            ? 'Release to refresh'
            : 'Pull to refresh'}
        </div>
      </animated.div>

      {/* Content wrapper */}
      <animated.div
        className="pull-to-refresh__content"
        style={{
          transform: spring.pullDistance.to((d) => `translateY(${d}px)`),
        }}
        {...dragBind}
      >
        {children}
      </animated.div>
    </div>
  );
}

export default PullToRefresh;
