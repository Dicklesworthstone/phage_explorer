/**
 * BottomSheet - iOS/Android-style modal with gesture physics
 *
 * Features:
 * - Slides up from bottom with spring animation
 * - Swipe down to dismiss with velocity-based snapping
 * - Multiple snap points (half, full)
 * - Drag handle for visual affordance
 * - Haptic feedback on interactions
 * - Backdrop blur effect
 * - Safe area padding for notched devices
 *
 * Uses @use-gesture/react and @react-spring/web for native-feeling physics.
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useSpringValue, animated, config } from '@react-spring/web';
import { useDrag } from '@use-gesture/react';
import { haptics } from '../../utils/haptics';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useModalScrollLock } from '../../hooks/useModalScrollLock';

// =============================================================================
// Types
// =============================================================================

export type SnapPoint = 'closed' | 'half' | 'full';

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Optional footer content (e.g., action buttons) */
  footer?: ReactNode;
  /** Whether to show the drag handle (default: true) */
  showHandle?: boolean;
  /** Whether to close on backdrop tap (default: true) */
  closeOnBackdropTap?: boolean;
  /** Disable when an overlay stack already owns Escape for this sheet. */
  closeOnEscape?: boolean;
  /** Whether to enable swipe-to-dismiss (default: true) */
  swipeToDismiss?: boolean;
  /** Initial snap point (default: 'half') */
  initialSnapPoint?: SnapPoint;
  /** Minimum height as percentage of viewport (default: 30) */
  minHeight?: number;
  /** Maximum height as percentage of viewport (default: 90) */
  maxHeight?: number;
  /** Callback when snap point changes */
  onSnapPointChange?: (snapPoint: SnapPoint) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Height percentages for each snap point */
const SNAP_HEIGHTS: Record<SnapPoint, number> = {
  closed: 0,
  half: 55,
  full: 94,
};

/** Velocity threshold to trigger snap on release (px/ms) */
const VELOCITY_THRESHOLD = 0.5;

function isLikelyTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const hasTouch =
    'ontouchstart' in window ||
    (typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0);
  const canMatchMedia = typeof window.matchMedia === 'function';
  const pointerCoarse = canMatchMedia && window.matchMedia('(pointer: coarse)').matches;
  const hoverNone = canMatchMedia && window.matchMedia('(hover: none)').matches;
  const narrowViewport = window.innerWidth <= 768;
  return hasTouch && (pointerCoarse || hoverNone || narrowViewport);
}

function shouldIgnoreDragTarget(event: Event | undefined): boolean {
  if (!event) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, a, input, textarea, select, [data-no-drag]'));
}

// =============================================================================
// Component
// =============================================================================

export function BottomSheet({
  isOpen,
  onClose,
  title,
  children,
  footer,
  showHandle = true,
  closeOnBackdropTap = true,
  closeOnEscape = true,
  swipeToDismiss = true,
  initialSnapPoint = 'half',
  minHeight = 30,
  maxHeight = 90,
  onSnapPointChange,
}: BottomSheetProps): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const snapPointRef = useRef<SnapPoint>(initialSnapPoint);
  const reducedMotion = useReducedMotion();
  const reactId = useId();
  const titleId = `bottom-sheet-title-${reactId}`;
  const isOpenRef = useRef(isOpen);
  const closeRequestSeqRef = useRef(0);
  const closeRequestTimeoutRef = useRef<number | null>(null);
  const unmountTimeoutRef = useRef<number | null>(null);
  const [shouldRender, setShouldRender] = useState(isOpen);

  // Current snap point state
  const [snapPoint, setSnapPoint] = useState<SnapPoint>(initialSnapPoint);
  const [isDragging, setIsDragging] = useState(false);

  // Calculate actual heights
  const getSnapHeight = useCallback(
    (point: SnapPoint): number => {
      if (point === 'closed') return 0;
      const baseHeight = SNAP_HEIGHTS[point];
      return Math.min(Math.max(baseHeight, minHeight), maxHeight);
    },
    [minHeight, maxHeight]
  );

  const getTranslatePercentForSnapPoint = useCallback(
    (point: SnapPoint): number => {
      if (point === 'closed') return 100;

      // The sheet's translateY uses percentages of the sheet itself.
      // We want snap points to represent visible height as a % of the viewport, so we
      // convert viewport-% heights into sheet-% translate values using maxHeight.
      const visibleViewportPercent = getSnapHeight(point);
      const hiddenViewportPercent = Math.max(0, maxHeight - visibleViewportPercent);
      const translatePercent = (hiddenViewportPercent / Math.max(1, maxHeight)) * 100;
      return Math.max(0, Math.min(100, translatePercent));
    },
    [getSnapHeight, maxHeight]
  );

  const initialTranslateY = isOpen
    ? getTranslatePercentForSnapPoint(initialSnapPoint)
    : getTranslatePercentForSnapPoint('closed');

  const initialBackdropOpacity = isOpen ? 0.5 : 0;

  // Spring values (SpringValue) for the sheet + backdrop.
  // IMPORTANT: avoid `useSpring` here. With React 19 + react-spring v10, the
  // hook-level controller can re-apply the initial update on re-render (even when
  // we drive it imperatively), which fights open/close animations. SpringValue
  // gives us fully imperative control without render-time auto-start.
  const y = useSpringValue(initialTranslateY, {
    config: reducedMotion ? { duration: 0 } : { ...config.stiff, clamp: false },
  });
  const backdropOpacity = useSpringValue(initialBackdropOpacity, {
    config: reducedMotion ? { duration: 0 } : { tension: 300, friction: 30 },
  });

  // Animate sheet position based on snap point
  const animateToSnapPoint = useCallback(
    (point: SnapPoint, immediate = false, notifyOnClose = true) => {
      const targetY = getTranslatePercentForSnapPoint(point);
      const requestSeq = ++closeRequestSeqRef.current;
      const shouldNotifyClose = point === 'closed' && notifyOnClose;

      if (closeRequestTimeoutRef.current) {
        window.clearTimeout(closeRequestTimeoutRef.current);
        closeRequestTimeoutRef.current = null;
      }

      if (immediate || reducedMotion) {
        y.set(targetY);
        backdropOpacity.set(point === 'closed' ? 0 : 0.5);
      } else {
        y.start({ to: targetY, config: { tension: 400, friction: 35 } });
        backdropOpacity.start({ to: point === 'closed' ? 0 : 0.5 });
      }

      snapPointRef.current = point;
      setSnapPoint(point);
      onSnapPointChange?.(point);

      if (shouldNotifyClose) {
        // Delay calling onClose so parents that unmount can let the animation finish.
        // Keep this as a timeout because react-spring's controller does not provide a reliable promise in all modes.
        closeRequestTimeoutRef.current = window.setTimeout(() => {
          closeRequestTimeoutRef.current = null;
          if (closeRequestSeqRef.current !== requestSeq) return;
          if (isOpenRef.current) onClose();
        }, immediate || reducedMotion ? 0 : 220);
      }
    },
    [backdropOpacity, getTranslatePercentForSnapPoint, onClose, onSnapPointChange, reducedMotion, y]
  );

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    snapPointRef.current = snapPoint;
  }, [snapPoint]);

  useEffect(() => {
    return () => {
      if (closeRequestTimeoutRef.current) {
        window.clearTimeout(closeRequestTimeoutRef.current);
        closeRequestTimeoutRef.current = null;
      }
      if (unmountTimeoutRef.current) {
        window.clearTimeout(unmountTimeoutRef.current);
        unmountTimeoutRef.current = null;
      }
    };
  }, []);

  // Find nearest snap point based on current position and velocity
  const findNearestSnapPoint = useCallback(
    (currentY: number, velocityY: number): SnapPoint => {
      // If velocity is high enough, snap based on direction
      if (Math.abs(velocityY) > VELOCITY_THRESHOLD) {
        if (velocityY > 0) {
          // Moving down - close or go to half
          return snapPoint === 'full' ? 'half' : 'closed';
        } else {
          // Moving up - expand to full
          return snapPoint === 'half' ? 'full' : 'half';
        }
      }

      // Progressive dismiss: require 65% travel toward closed to dismiss,
      // making it harder to accidentally dismiss while allowing intentional swipes.
      const currentPercent = currentY;
      const halfY = getTranslatePercentForSnapPoint('half');
      const fullY = getTranslatePercentForSnapPoint('full');
      const closedY = 100;

      // Range from current snap to closed
      const fromY = snapPoint === 'full' ? fullY : halfY;
      const range = closedY - fromY;
      const progress = range > 0 ? (currentPercent - fromY) / range : 0;

      // Need 65% progress toward closed to actually dismiss
      if (progress >= 0.65) {
        return 'closed';
      }

      // Otherwise snap to nearest non-closed point
      const distToHalf = Math.abs(currentPercent - halfY);
      const distToFull = Math.abs(currentPercent - fullY);
      if (distToFull <= distToHalf) {
        return 'full';
      }
      return 'half';
    },
    [getTranslatePercentForSnapPoint, snapPoint]
  );

  // Drag gesture handler
  const bindDrag = useDrag(
    ({
      event,
      movement: [, my],
      velocity: [, vy],
      direction: [, dy],
      active,
      first,
      last,
      memo,
    }) => {
      if (shouldIgnoreDragTarget(event)) {
        return memo ?? y.get();
      }
      if (!swipeToDismiss && dy > 0) {
        // If swipe to dismiss is disabled, don't allow downward drag
        return;
      }

      // On first touch, store initial y position
      if (first) {
        setIsDragging(true);
        return y.get();
      }

      const initialY = memo ?? y.get();
      const vvHeight = window.visualViewport?.height;
      // iOS Safari can transiently report `visualViewport.height === 0` during load/rotation.
      // Never allow that to poison drag math (would yield Infinity/NaN and break snapping).
      const windowHeight =
        typeof vvHeight === 'number' && Number.isFinite(vvHeight) && vvHeight > 0
          ? vvHeight
          : window.innerHeight;

      // Calculate new Y position (as percentage)
      // `y` is a percentage of the sheet height (translateY(%)).
      // Convert viewport drag distance into sheet-% using maxHeight (viewport-% of sheet).
      const deltaPercent = ((my / windowHeight) * 100 * 100) / Math.max(1, maxHeight);
      let newY = initialY + deltaPercent;

      // Apply bounds with rubberband effect
      const minY = getTranslatePercentForSnapPoint('full');
      const maxY = 100;

      if (newY < minY) {
        // Tighter rubberband at top for premium feel
        const overshoot = minY - newY;
        newY = minY - overshoot * 0.12;
      } else if (newY > maxY) {
        // Rubberband at bottom
        const overshoot = newY - maxY;
        newY = maxY + overshoot * 0.12;
      }

      if (active) {
        // During drag, update position immediately
        y.set(newY);

        // Update backdrop opacity based on position
        const visibleViewportPercent = (maxHeight * (100 - newY)) / 100;
        const progress = Math.max(0, Math.min(1, visibleViewportPercent / getSnapHeight('half')));
        backdropOpacity.set(progress * 0.5);

        // Haptic feedback when crossing snap thresholds
        const halfThreshold = getTranslatePercentForSnapPoint('half');
        const wasAboveHalf = (memo ?? initialY) < halfThreshold;
        const isAboveHalf = newY < halfThreshold;
        if (wasAboveHalf !== isAboveHalf) {
          haptics.selection();
        }

        // Additional haptic ticks at 25% and 75% drag progress
        const fullY = getTranslatePercentForSnapPoint('full');
        const range = 100 - fullY;
        if (range > 0) {
          const progress = (newY - fullY) / range;
          const prevProgress = ((memo ?? initialY) - fullY) / range;
          const crossed25 = (prevProgress < 0.25) !== (progress < 0.25);
          const crossed75 = (prevProgress < 0.75) !== (progress < 0.75);
          if (crossed25 || crossed75) {
            haptics.light();
          }
        }
      }

      if (last) {
        setIsDragging(false);
        // On release, snap to nearest point
        const targetPoint = findNearestSnapPoint(newY, vy * dy);
        animateToSnapPoint(targetPoint);

        if (targetPoint !== 'closed') {
          haptics.light();
        } else {
          haptics.medium();
        }
      }

      return memo;
    },
    {
      from: () => [0, 0],
      filterTaps: true,
      rubberband: 0.15,
    }
  );

  // Open/close animation
  useEffect(() => {
    if (isOpen) {
      haptics.medium();
      if (unmountTimeoutRef.current) {
        window.clearTimeout(unmountTimeoutRef.current);
        unmountTimeoutRef.current = null;
      }
      setShouldRender(true);
      return;
    }

    if (unmountTimeoutRef.current) {
      window.clearTimeout(unmountTimeoutRef.current);
      unmountTimeoutRef.current = null;
    }
    // Parent-driven close: animate out, but do not call onClose again.
    animateToSnapPoint('closed', false, false);
    unmountTimeoutRef.current = window.setTimeout(() => {
      unmountTimeoutRef.current = null;
      setShouldRender(false);
    }, reducedMotion ? 0 : 200);
  }, [animateToSnapPoint, isOpen, reducedMotion]);

  // Important: react-spring may not animate reliably if we start a spring while the
  // animated elements are not mounted (e.g., long-lived sheets rendered `null` while closed).
  // Trigger the open animation only after the portal content is actually rendered.
  useEffect(() => {
    if (!shouldRender) return;
    if (!isOpen) return;

    animateToSnapPoint(initialSnapPoint);
  }, [animateToSnapPoint, initialSnapPoint, isOpen, shouldRender]);

  // Keep snap position aligned with visual viewport changes (mobile address bar, keyboard)
  useEffect(() => {
    if (!shouldRender) return;

    let isMounted = true;
    let rafId = 0;
    const handleViewportChange = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        // Guard against RAF firing after unmount (race condition where RAF
        // fires and sets rafId=0 before cleanup runs)
        if (!isMounted) return;
        animateToSnapPoint(snapPointRef.current, true, false);
      });
    };

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', handleViewportChange);
      vv.addEventListener('scroll', handleViewportChange);
    } else {
      window.addEventListener('resize', handleViewportChange);
    }

    return () => {
      isMounted = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (vv) {
        vv.removeEventListener('resize', handleViewportChange);
        vv.removeEventListener('scroll', handleViewportChange);
      } else {
        window.removeEventListener('resize', handleViewportChange);
      }
    };
  }, [animateToSnapPoint, shouldRender]);

  useModalScrollLock(shouldRender, isLikelyTouchDevice());

  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      // Standalone sheets share a stacking level. Only the last painted portal
      // handles Escape, after focused controls have had a chance to consume it.
      const sheets = document.querySelectorAll('.bottom-sheet.is-open');
      if (!sheets[sheets.length - 1]?.contains(containerRef.current)) return;
      event.preventDefault();
      haptics.light();
      animateToSnapPoint('closed');
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeOnEscape, animateToSnapPoint]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (closeOnBackdropTap && e.target === e.currentTarget) {
        haptics.light();
        animateToSnapPoint('closed');
      }
    },
    [closeOnBackdropTap, animateToSnapPoint]
  );

  // Close button handler
  const handleClose = useCallback(() => {
    haptics.light();
    animateToSnapPoint('closed');
  }, [animateToSnapPoint]);

  // Expand/collapse handlers
  const handleExpand = useCallback(() => {
    haptics.selection();
    animateToSnapPoint(snapPoint === 'full' ? 'half' : 'full');
  }, [snapPoint, animateToSnapPoint]);

  if (!shouldRender) return null;

  // Guard against SSR or early render before document.body exists
  if (typeof document === 'undefined' || !document.body) return null;

  const dragBind = bindDrag();

  return createPortal(
    <div
      className={`bottom-sheet ${shouldRender ? 'is-open' : ''} ${isDragging ? 'bottom-sheet--dragging' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      {/* Animated Backdrop */}
      <animated.div
        className="bottom-sheet__backdrop"
        onClick={handleBackdropClick}
        aria-hidden="true"
        style={{ opacity: backdropOpacity }}
      />

      {/* Animated Sheet container */}
      <animated.div
        ref={containerRef}
        className="bottom-sheet__container"
        style={
          {
            transform: y.to((v) => `translateY(${v}%)`),
            // Drive sizing via CSS vars so we can prefer `dvh` but fall back to `vh`.
            ['--bottom-sheet-min-height-vh' as string]: `${minHeight}vh`,
            ['--bottom-sheet-min-height-dvh' as string]: `${minHeight}dvh`,
            ['--bottom-sheet-max-height-vh' as string]: `${maxHeight}vh`,
            ['--bottom-sheet-max-height-dvh' as string]: `${maxHeight}dvh`,
          } as unknown as React.CSSProperties
        }
      >
        {/* Drag handle */}
        {showHandle && (
          <div
            className="bottom-sheet__handle"
            aria-hidden="true"
            onDoubleClick={handleExpand}
            {...dragBind}
          />
        )}

        {/* Header */}
        {title && (
          <header className="bottom-sheet__header" {...dragBind}>
            <h2 id={titleId} className="bottom-sheet__title">
              {title}
            </h2>
            <button
              type="button"
              className="bottom-sheet__close"
              onClick={handleClose}
              aria-label="Close"
              data-no-drag
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </header>
        )}

        {/* Content */}
        <div
          ref={contentRef}
          className="bottom-sheet__content"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <footer className="bottom-sheet__footer" onPointerDown={(e) => e.stopPropagation()}>
            {footer}
          </footer>
        )}

        {/* Snap point indicator (visual only) */}
        <div
          className={`bottom-sheet__snap-indicator bottom-sheet__snap-indicator--${snapPoint}`}
          aria-hidden="true"
        />
      </animated.div>
    </div>,
    document.body
  );
}

export default BottomSheet;
