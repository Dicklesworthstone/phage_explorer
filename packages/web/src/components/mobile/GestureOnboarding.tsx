/**
 * GestureOnboarding - First-time mobile gesture tutorial
 *
 * Shows a brief overlay explaining swipe gestures on first visit.
 * Stores dismissal in localStorage to avoid showing again.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { IconChevronLeft, IconChevronRight, IconX } from '../ui';

const STORAGE_KEY = 'phage-explorer-gesture-onboarding-dismissed';

interface GestureOnboardingProps {
  /** Override to force show for testing */
  forceShow?: boolean;
}

/**
 * Check if gesture onboarding has been dismissed
 */
function hasBeenDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Mark gesture onboarding as dismissed
 */
function markDismissed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'true');
  } catch {
    // localStorage not available - silently fail
  }
}

export function GestureOnboarding({ forceShow }: GestureOnboardingProps): React.ReactElement | null {
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);

  useEffect(() => {
    // Only show on mobile/touch devices
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouchDevice && !forceShow) return;

    // Check if already dismissed
    if (hasBeenDismissed() && !forceShow) return;

    // Small delay before showing to let the app load
    const timer = setTimeout(() => setIsVisible(true), 1000);
    return () => clearTimeout(timer);
  }, [forceShow]);

  const handleDismiss = useCallback(() => {
    setIsAnimatingOut(true);
    markDismissed();

    // Wait for animation to complete before unmounting
    setTimeout(() => {
      setIsVisible(false);
      setIsAnimatingOut(false);
    }, 300);
  }, []);

  if (!isVisible) return null;

  return (
    <div
      className={`gesture-onboarding ${isAnimatingOut ? 'gesture-onboarding--exit' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gesture-onboarding-title"
    >
      <div className="gesture-onboarding__backdrop" onClick={handleDismiss} />

      <div className="gesture-onboarding__card">
        <button
          type="button"
          className="gesture-onboarding__close"
          onClick={handleDismiss}
          aria-label="Dismiss"
        >
          <IconX size={20} />
        </button>

        <h2 id="gesture-onboarding-title" className="gesture-onboarding__title">
          Swipe to Navigate
        </h2>

        <p className="gesture-onboarding__description">
          Swipe left or right to move between phages quickly
        </p>

        <div className="gesture-onboarding__demo">
          <div className="gesture-onboarding__demo-hand">
            <div className="gesture-onboarding__demo-arrows">
              <IconChevronLeft size={24} className="gesture-onboarding__arrow gesture-onboarding__arrow--left" />
              <div className="gesture-onboarding__demo-finger" />
              <IconChevronRight size={24} className="gesture-onboarding__arrow gesture-onboarding__arrow--right" />
            </div>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary gesture-onboarding__button"
          onClick={handleDismiss}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

export default GestureOnboarding;
