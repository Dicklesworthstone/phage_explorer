/**
 * TourEngine
 *
 * Reusable guided tour overlay for Beginner Mode.
 * Renders whenever `activeTourId` is set in global state.
 *
 * Part of: phage_explorer-bbf4
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { useBeginnerMode } from '../hooks/useBeginnerMode';
import type { Tour, TourId, TourStep } from '../types';

// JSON tour definitions (easy authoring)
import welcomeTourJson from '../tours/welcome.json';
import analysisTourJson from '../tours/analysis.json';
import geneExplorerTourJson from '../tours/gene-explorer.json';

const BUILTIN_TOURS: Partial<Record<TourId, Tour>> = {
  welcome: {
    id: 'welcome',
    title: 'Welcome Tour',
    description: 'A quick walkthrough of the Phage Explorer web UI.',
    estimatedMinutes: 1,
    steps: [
      {
        id: 'nav',
        title: 'Navigation Bar',
        content: 'Access global controls, theme, contrast, and beginner tools here.',
        target: '.app-header',
        position: 'bottom',
      },
      {
        id: 'workspace',
        title: 'Main Workspace',
        content: 'This area shows the sequence grid, gene maps, and analysis views.',
        target: '.app-body, .panel.two-column',
        position: 'right',
      },
      {
        id: 'hints',
        title: 'Keyboard Hints',
        content: 'Look for key hints in the footer and overlays for speed.',
        target: '.footer-hints',
        position: 'top',
      },
      {
        id: 'learn',
        title: 'Learn Menu',
        content: 'Beginner Mode adds a Learn menu with glossary, tours, and modules.',
        target: 'button[aria-haspopup="true"]',
        position: 'bottom',
      },
    ],
  },
};

const JSON_TOURS: Partial<Record<TourId, Tour>> = {
  welcome: welcomeTourJson as Tour,
  overlays: analysisTourJson as Tour,
  'gene-explorer': geneExplorerTourJson as Tour,
};

function getTour(tourId: TourId): Tour | null {
  return JSON_TOURS[tourId] ?? BUILTIN_TOURS[tourId] ?? null;
}

function resolveTargetRect(step: TourStep): DOMRect | null {
  if (!step.target) return null;
  const el = document.querySelector(step.target);
  if (!el) return null;
  // Scroll first so the measured rect reflects the on-screen position.
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return el.getBoundingClientRect();
}

export function TourEngine(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { activeTourId, cancelTour, completeTour, isEnabled } = useBeginnerMode();

  const tourId = (activeTourId as TourId | null) ?? null;
  const tour = useMemo(() => (tourId ? getTour(tourId) : null), [tourId]);

  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // If a caller sets an unknown tour id, clear it to avoid stuck state.
  useEffect(() => {
    if (tourId && !tour) {
      cancelTour();
    }
  }, [tourId, tour, cancelTour]);

  // Reset when starting a new tour
  useEffect(() => {
    setStepIndex(0);
    setRect(null);
  }, [tourId]);

  // Update target rect when step changes
  useEffect(() => {
    if (!tour || !isEnabled) return;
    if (tour.steps.length === 0) {
      cancelTour();
      return;
    }

    const safeIndex = Math.min(stepIndex, tour.steps.length - 1);
    if (safeIndex !== stepIndex) {
      setStepIndex(safeIndex);
      return;
    }

    const step = tour.steps[stepIndex];
    const targetRect = resolveTargetRect(step);
    if (targetRect) {
      setRect(targetRect);
      return;
    }
    // Skip forward if target missing
    if (stepIndex < tour.steps.length - 1) {
      setStepIndex((i) => i + 1);
    } else {
      cancelTour();
    }
  }, [tour, stepIndex, isEnabled, cancelTour]);

  const handleSkip = useCallback(() => {
    cancelTour();
  }, [cancelTour]);

  const handleFinish = useCallback(() => {
    if (tour) {
      completeTour(tour.id);
    } else {
      cancelTour();
    }
  }, [tour, completeTour, cancelTour]);

  const handleNext = useCallback(() => {
    if (!tour) return;
    if (stepIndex < tour.steps.length - 1) {
      setStepIndex((i) => i + 1);
    } else {
      handleFinish();
    }
  }, [tour, stepIndex, handleFinish]);

  const handlePrev = useCallback(() => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
    }
  }, [stepIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!tour) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleSkip();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tour, handleSkip, handleNext, handlePrev]);

  if (!tour || !rect || !isEnabled) return null;

  const step = tour.steps[stepIndex];

  // Calculate popover position
  const popoverStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1000,
    width: '320px',
    maxWidth: '90vw',
    backgroundColor: colors.background,
    border: `2px solid ${colors.accent}`,
    borderRadius: '10px',
    padding: '1rem',
    boxShadow: `0 0 20px ${colors.shadow}`,
  };

  const position = step.position ?? 'bottom';
  if (position === 'bottom') {
    popoverStyle.top = rect.bottom + 16;
    popoverStyle.left = rect.left + rect.width / 2 - 160;
  } else if (position === 'top') {
    popoverStyle.bottom = window.innerHeight - rect.top + 16;
    popoverStyle.left = rect.left + rect.width / 2 - 160;
  } else if (position === 'right') {
    popoverStyle.top = rect.top + rect.height / 2 - 120;
    popoverStyle.left = rect.right + 16;
  } else if (position === 'left') {
    popoverStyle.top = rect.top + rect.height / 2 - 120;
    popoverStyle.right = window.innerWidth - rect.left + 16;
  } else {
    popoverStyle.top = rect.bottom + 16;
    popoverStyle.left = rect.left + rect.width / 2 - 160;
  }

  // Clamp to viewport
  if (popoverStyle.left != null && Number(popoverStyle.left) < 10) popoverStyle.left = 10;
  if (popoverStyle.right != null && Number(popoverStyle.right) < 10) popoverStyle.right = 10;
  if (popoverStyle.top != null && Number(popoverStyle.top) < 10) popoverStyle.top = 10;
  if (popoverStyle.bottom != null && Number(popoverStyle.bottom) < 10) popoverStyle.bottom = 10;

  return (
    <>
      {/* Backdrop highlight mask */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.55)',
          zIndex: 999,
          pointerEvents: 'auto',
        }}
        onClick={handleSkip}
        aria-hidden="true"
      >
        <div
          style={{
            position: 'absolute',
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            backgroundColor: 'transparent',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.75)',
            borderRadius: '6px',
            border: `2px solid ${colors.accent}`,
            transition: 'all 0.3s ease',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Popover */}
      <div style={popoverStyle} className="tour-popover animate-fade-in" role="dialog" aria-modal="true">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <strong style={{ color: colors.primary }}>{step.title}</strong>
          <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>
            {stepIndex + 1} / {tour.steps.length}
          </span>
        </div>
        <p style={{ color: colors.text, marginBottom: '1rem', lineHeight: 1.5 }}>
          {step.content}
        </p>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <button
            onClick={handleSkip}
            style={{
              background: 'none',
              border: 'none',
              color: colors.textMuted,
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >
            Skip
          </button>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handlePrev}
              disabled={stepIndex === 0}
              style={{
                padding: '0.4rem 0.8rem',
                background: 'transparent',
                border: `1px solid ${colors.border}`,
                color: colors.text,
                borderRadius: '6px',
                cursor: stepIndex === 0 ? 'not-allowed' : 'pointer',
                opacity: stepIndex === 0 ? 0.5 : 1,
              }}
            >
              Prev
            </button>
            <button
              onClick={handleNext}
              style={{
                padding: '0.4rem 0.9rem',
                background: colors.primary,
                border: 'none',
                color: '#000',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              {stepIndex === tour.steps.length - 1 ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export default TourEngine;
