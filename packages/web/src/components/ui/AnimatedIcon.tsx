/**
 * AnimatedIcon - Animated icon wrapper with state-based animations
 *
 * Provides common icon animations for premium UI interactions:
 * - Rotation (for refresh/sync)
 * - Bounce (for success/completion)
 * - Shake (for error/warning)
 * - Pulse (for attention)
 * - Spin (for loading)
 */

import React, { useEffect, useState } from 'react';

export type IconAnimation =
  | 'none'
  | 'rotate'      // 360° rotation (refresh)
  | 'bounce'      // Vertical bounce (success)
  | 'shake'       // Horizontal shake (error)
  | 'pulse'       // Scale pulse (attention)
  | 'spin'        // Continuous spin (loading)
  | 'pop'         // Quick pop in (appear)
  | 'wobble';     // Slight rotation wobble

export interface AnimatedIconProps {
  /** The icon component to animate */
  icon: React.ComponentType<{ size?: number; className?: string }>;
  /** Icon size */
  size?: number;
  /** Current animation to play */
  animation?: IconAnimation;
  /** Duration in ms (default: 300 for one-shot, 1000 for continuous) */
  duration?: number;
  /** Trigger animation on this value change */
  trigger?: unknown;
  /** Additional className */
  className?: string;
  /** Callback when animation completes (for one-shot animations) */
  onAnimationComplete?: () => void;
}

// Continuous animations that loop
const CONTINUOUS_ANIMATIONS = new Set<IconAnimation>(['spin', 'pulse']);

export function AnimatedIcon({
  icon: Icon,
  size = 20,
  animation = 'none',
  duration,
  trigger,
  className,
  onAnimationComplete,
}: AnimatedIconProps): React.ReactElement {
  const [currentAnimation, setCurrentAnimation] = useState(animation);
  const [animationKey, setAnimationKey] = useState(0);

  // Handle animation prop changes
  useEffect(() => {
    setCurrentAnimation(animation);
    // Increment key to restart animation
    setAnimationKey(k => k + 1);
  }, [animation, trigger]);

  // Handle animation end for one-shot animations
  const handleAnimationEnd = () => {
    if (!CONTINUOUS_ANIMATIONS.has(currentAnimation)) {
      onAnimationComplete?.();
    }
  };

  const isContinuous = CONTINUOUS_ANIMATIONS.has(currentAnimation);
  const animDuration = duration ?? (isContinuous ? 1000 : 300);

  const classes = [
    'animated-icon',
    currentAnimation !== 'none' ? `animated-icon--${currentAnimation}` : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      key={animationKey}
      className={classes}
      style={{
        '--animation-duration': `${animDuration}ms`,
      } as React.CSSProperties}
      onAnimationEnd={handleAnimationEnd}
    >
      <Icon size={size} />
    </span>
  );
}

/**
 * Hook to control AnimatedIcon imperatively
 */
export function useIconAnimation() {
  const [animation, setAnimation] = useState<IconAnimation>('none');
  const [trigger, setTrigger] = useState(0);

  const play = (anim: IconAnimation) => {
    setAnimation(anim);
    setTrigger(t => t + 1);
  };

  const stop = () => {
    setAnimation('none');
  };

  return {
    animation,
    trigger,
    play,
    stop,
    // Convenience methods
    rotate: () => play('rotate'),
    bounce: () => play('bounce'),
    shake: () => play('shake'),
    pulse: () => play('pulse'),
    spin: () => play('spin'),
    pop: () => play('pop'),
    wobble: () => play('wobble'),
  };
}

export default AnimatedIcon;
