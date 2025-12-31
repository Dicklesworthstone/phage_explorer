/**
 * useAnimatedNumber - Smooth number animation hook
 *
 * Animates numeric values with spring-like easing for premium UI feel.
 * Similar to Stripe/Linear dashboard counters that count up smoothly.
 *
 * @example
 * ```tsx
 * const count = useAnimatedNumber(actualCount, { duration: 400 });
 * return <span>{count}</span>;
 * ```
 */

import { useEffect, useRef, useState } from 'react';

export interface AnimatedNumberOptions {
  /** Animation duration in milliseconds (default: 400) */
  duration?: number;
  /** Number of decimal places to display (default: 0) */
  decimals?: number;
  /** Easing function (default: easeOutExpo) */
  easing?: (t: number) => number;
  /** Skip animation on first render (default: true) */
  skipInitial?: boolean;
  /** Format function for the final output (default: toLocaleString) */
  format?: (value: number) => string;
}

// Easing functions
const easings = {
  // Exponential ease out - starts fast, decelerates
  easeOutExpo: (t: number): number =>
    t === 1 ? 1 : 1 - Math.pow(2, -10 * t),

  // Cubic ease out - smoother, less dramatic
  easeOutCubic: (t: number): number =>
    1 - Math.pow(1 - t, 3),

  // Linear - constant speed
  linear: (t: number): number => t,

  // Spring-like with overshoot
  easeOutBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

/**
 * Default format function using toLocaleString for nice number formatting
 */
function defaultFormat(value: number, decimals: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Hook that animates a number from its previous value to a new target.
 *
 * @param value The target number to animate to
 * @param options Animation configuration
 * @returns The current animated number (formatted as string)
 */
export function useAnimatedNumber(
  value: number,
  options: AnimatedNumberOptions = {}
): string {
  const {
    duration = 400,
    decimals = 0,
    easing = easings.easeOutExpo,
    skipInitial = true,
    format,
  } = options;

  const formatFn = format ?? ((v: number) => defaultFormat(v, decimals));

  // Track the displayed value
  const [displayValue, setDisplayValue] = useState<string>(() =>
    formatFn(value)
  );

  // Track animation state
  const startValueRef = useRef(value);
  const targetValueRef = useRef(value);
  const frameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Skip animation on first render if configured
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (skipInitial) {
        setDisplayValue(formatFn(value));
        startValueRef.current = value;
        targetValueRef.current = value;
        return;
      }
    }

    // If value hasn't changed, no animation needed
    if (value === targetValueRef.current) {
      return;
    }

    // Store animation parameters
    startValueRef.current = parseFloat(displayValue.replace(/[^0-9.-]/g, '')) || 0;
    targetValueRef.current = value;
    startTimeRef.current = null;

    // Animation frame loop
    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }

      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easing(progress);

      // Interpolate between start and target
      const currentValue =
        startValueRef.current +
        (targetValueRef.current - startValueRef.current) * easedProgress;

      setDisplayValue(formatFn(currentValue));

      // Continue animation if not complete
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      }
    };

    // Cancel any existing animation
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }

    // Start new animation
    frameRef.current = requestAnimationFrame(animate);

    // Cleanup on unmount or value change
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [value, duration, decimals, easing, skipInitial, format, displayValue, formatFn]);

  return displayValue;
}

/**
 * Hook variant that returns a raw number instead of formatted string.
 * Useful when you need to apply custom formatting.
 */
export function useAnimatedNumberRaw(
  value: number,
  options: Omit<AnimatedNumberOptions, 'format' | 'decimals'> = {}
): number {
  const {
    duration = 400,
    easing = easings.easeOutExpo,
    skipInitial = true,
  } = options;

  const [displayValue, setDisplayValue] = useState(value);

  const startValueRef = useRef(value);
  const targetValueRef = useRef(value);
  const frameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (skipInitial) {
        setDisplayValue(value);
        startValueRef.current = value;
        targetValueRef.current = value;
        return;
      }
    }

    if (value === targetValueRef.current) {
      return;
    }

    startValueRef.current = displayValue;
    targetValueRef.current = value;
    startTimeRef.current = null;

    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }

      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easing(progress);

      const currentValue =
        startValueRef.current +
        (targetValueRef.current - startValueRef.current) * easedProgress;

      setDisplayValue(currentValue);

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      }
    };

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [value, duration, easing, skipInitial, displayValue]);

  return displayValue;
}

// Export easings for custom use
export { easings };

export default useAnimatedNumber;
