/**
 * Feature Tour Component
 *
 * Guided tour that highlights key UI elements with explanations.
 */

import React, { useEffect, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useOverlay } from './OverlayProvider';

interface TourStep {
  target: string; // CSS selector
  title: string;
  content: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

const TOUR_STEPS: TourStep[] = [
  {
    target: '.app-header',
    title: 'Navigation Bar',
    content: 'Access global controls, theme toggle, and view status here.',
    position: 'bottom',
  },
  {
    target: '.app-body',
    title: 'Main Workspace',
    content: 'This area displays the sequence grid, gene maps, or 3D models.',
    position: 'right',
  },
  {
    target: '.key-hint',
    title: 'Keyboard Shortcuts',
    content: 'Look for these hints to learn shortcuts. Speed is key!',
    position: 'top',
  },
  {
    target: '.footer-hints',
    title: 'Quick Reference',
    content: 'Common actions are always visible here.',
    position: 'top',
  },
];

export function FeatureTour(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const reducedMotion = useReducedMotion();
  const { isOpen, close } = useOverlay();
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Reset when closed or reopened
  useEffect(() => {
    if (isOpen('tour')) {
      setStepIndex(0);
    }
  }, [isOpen]);

  // Update target rect
  useEffect(() => {
    if (!isOpen('tour')) return;

    const step = TOUR_STEPS[stepIndex];
    const el = document.querySelector(step.target);
    
    if (el) {
      setRect(el.getBoundingClientRect());
      el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    } else {
      // Skip if target not found
      if (stepIndex < TOUR_STEPS.length - 1) {
        setStepIndex(stepIndex + 1);
      } else {
        close('tour');
      }
    }
  }, [stepIndex, isOpen, close, reducedMotion]);

  if (!isOpen('tour') || !rect) return null;

  const step = TOUR_STEPS[stepIndex];
  
  const handleNext = () => {
    if (stepIndex < TOUR_STEPS.length - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      close('tour');
    }
  };

  const handlePrev = () => {
    if (stepIndex > 0) {
      setStepIndex(stepIndex - 1);
    }
  };

  // Calculate position
  const popoverStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1000,
    width: '300px',
    backgroundColor: colors.background,
    border: `2px solid ${colors.accent}`,
    borderRadius: '8px',
    padding: '1rem',
    boxShadow: `0 0 20px ${colors.shadow}`,
  };

  if (step.position === 'bottom') {
    popoverStyle.top = rect.bottom + 16;
    popoverStyle.left = rect.left + (rect.width / 2) - 150;
  } else if (step.position === 'top') {
    popoverStyle.bottom = window.innerHeight - rect.top + 16;
    popoverStyle.left = rect.left + (rect.width / 2) - 150;
  } else if (step.position === 'right') {
    popoverStyle.top = rect.top + (rect.height / 2) - 100;
    popoverStyle.left = rect.right + 16;
  } else if (step.position === 'left') {
    popoverStyle.top = rect.top + (rect.height / 2) - 100;
    popoverStyle.right = window.innerWidth - rect.left + 16;
  }

  // Ensure onscreen
  if (Number(popoverStyle.left) < 10) popoverStyle.left = 10;
  if (Number(popoverStyle.right) < 10) popoverStyle.right = 10;

  return (
    <>
      {/* Backdrop highlight mask */}
      <div style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        zIndex: 999,
        pointerEvents: 'none',
      }}>
        <div style={{
          position: 'absolute',
          top: rect.top - 4,
          left: rect.left - 4,
          width: rect.width + 8,
          height: rect.height + 8,
          backgroundColor: 'transparent',
          boxShadow: `0 0 0 9999px rgba(0,0,0,0.7)`,
          borderRadius: '4px',
          border: `2px solid ${colors.accent}`,
          transition: 'all 0.3s ease'
        }} />
      </div>

      {/* Popover */}
      <div style={popoverStyle} className="tour-popover animate-fade-in">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <strong style={{ color: colors.primary }}>{step.title}</strong>
          <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>
            {stepIndex + 1} / {TOUR_STEPS.length}
          </span>
        </div>
        <p style={{ color: colors.text, marginBottom: '1rem', lineHeight: 1.5 }}>
          {step.content}
        </p>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <button
            onClick={() => close('tour')}
            style={{
              background: 'none',
              border: 'none',
              color: colors.textMuted,
              cursor: 'pointer',
              fontSize: '0.9rem'
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
                borderRadius: '4px',
                cursor: stepIndex === 0 ? 'not-allowed' : 'pointer',
                opacity: stepIndex === 0 ? 0.5 : 1
              }}
            >
              Prev
            </button>
            <button
              onClick={handleNext}
              style={{
                padding: '0.4rem 0.8rem',
                background: colors.primary,
                border: 'none',
                color: '#000',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              {stepIndex === TOUR_STEPS.length - 1 ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
