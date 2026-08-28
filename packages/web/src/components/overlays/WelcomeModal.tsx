/**
 * WelcomeModal - First Run Experience
 *
 * Onboarding modal that introduces the user to the application.
 * Allows selecting experience level and provides a quick tour.
 *
 * Focus management and keyboard behavior (Escape, tab order) are handled
 * by the Overlay component.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useWebPreferences } from '../../store/createWebStore';
import { usePhageStore, type ExperienceLevel } from '@phage-explorer/state';
import { KeyboardPrimer } from './KeyboardPrimer';
import { IconKeyboard, IconFlask, IconLearn, IconSearch, IconZap } from '../ui/icons';

import './WelcomeModal.css';

type WelcomeStep = 'intro' | 'level' | 'primer';

const STEPS: WelcomeStep[] = ['intro', 'level', 'primer'];
const STEP_LABELS: Record<WelcomeStep, string> = {
  intro: 'Introduction',
  level: 'Experience Level',
  primer: 'Quick Start',
};
const TOUR_START_DELAY_MS = 240;

interface StepIndicatorProps {
  currentStep: WelcomeStep;
}

function StepIndicator({ currentStep }: StepIndicatorProps): React.ReactElement {
  const currentIndex = STEPS.indexOf(currentStep);
  const totalSteps = STEPS.length;

  return (
    <div
      className="welcome-step-indicator"
      role="navigation"
      aria-label={`Step ${currentIndex + 1} of ${totalSteps}: ${STEP_LABELS[currentStep]}`}
    >
      {STEPS.map((step, index) => {
        const isCurrent = index === currentIndex;
        const isCompleted = index < currentIndex;
        return (
          <div
            key={step}
            className={`welcome-step-dot ${isCurrent ? 'welcome-step-dot--current' : ''} ${isCompleted ? 'welcome-step-dot--completed' : ''}`}
            aria-hidden="true"
          />
        );
      })}
      <span className="welcome-step-label">
        Step {currentIndex + 1} of {totalSteps}
      </span>
    </div>
  );
}

interface LevelCardProps {
  title: string;
  desc: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}

function LevelCard({ title, desc, icon, selected, onSelect }: LevelCardProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="welcome-level-card"
    >
      <div className="welcome-level-card__header">
        <span aria-hidden="true" className="welcome-level-card__icon">
          {icon}
        </span>
        <h3 className="welcome-level-card__title">{title}</h3>
      </div>
      <p className="welcome-level-card__desc">{desc}</p>
    </button>
  );
}

export function WelcomeModal(): React.ReactElement | null {
  const { close, isOpen } = useOverlay();

  // Web-specific preferences (persisted)
  const hasSeenWelcome = useWebPreferences(s => s.hasSeenWelcome);
  const setHasSeenWelcome = useWebPreferences(s => s.setHasSeenWelcome);

  // Main store preferences
  const setExperienceLevel = usePhageStore(s => s.setExperienceLevel);
  const setBeginnerModeEnabled = usePhageStore(s => s.setBeginnerModeEnabled);
  const startTour = usePhageStore(s => s.startTour);
  const experienceLevel = usePhageStore(s => s.experienceLevel) as ExperienceLevel;

  const [step, setStep] = useState<WelcomeStep>('intro');

  const handleNext = useCallback(() => {
    if (step === 'intro') setStep('level');
    else if (step === 'level') setStep('primer');
    else {
      setHasSeenWelcome(true);
      close('welcome');
    }
  }, [step, setHasSeenWelcome, close]);

  const handleFinish = useCallback(() => {
    setHasSeenWelcome(true);
    close('welcome');
  }, [setHasSeenWelcome, close]);

  const handleTour = useCallback(() => {
    setHasSeenWelcome(true);
    close('welcome');
    setBeginnerModeEnabled(true);
    setTimeout(() => startTour('welcome'), TOUR_START_DELAY_MS);
  }, [setHasSeenWelcome, close, setBeginnerModeEnabled, startTour]);

  const handleBack = useCallback(() => {
    setStep(step === 'primer' ? 'level' : 'intro');
  }, [step]);

  // Handle Enter key to activate primary action (Next/Get Started)
  useEffect(() => {
    if (!isOpen('welcome')) return;

    const handleEnterKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (e.isComposing) return;
      // Don't trigger if focused on a button (let button handle it)
      const target = e.target as HTMLElement;
      if (target.tagName === 'BUTTON') return;

      e.preventDefault();
      handleNext();
    };

    document.addEventListener('keydown', handleEnterKey);
    return () => document.removeEventListener('keydown', handleEnterKey);
  }, [isOpen, handleNext]);

  // If already seen, don't render unless explicitly opened via help/menu
  if (hasSeenWelcome && !isOpen('welcome')) {
    return null;
  }

  if (!isOpen('welcome')) {
    return null;
  }

  return (
    <Overlay
      id="welcome"
      title="Welcome to Phage Explorer"
      size="lg"
      showBackdrop={true}
      onClose={handleFinish}
      footer={(
        <div className="welcome-footer">
          <button
            type="button"
            onClick={handleFinish}
            className="btn btn-ghost welcome-footer__skip"
          >
            Skip
          </button>

          <div className="welcome-footer__actions">
            {step === 'intro' && (
              <button
                type="button"
                onClick={handleTour}
                className="btn btn-tour"
                style={{ marginRight: '0.5rem' }}
              >
                Take Tour
              </button>
            )}
            {step !== 'intro' && (
              <button
                type="button"
                onClick={handleBack}
                className="btn btn-secondary"
              >
                Back
              </button>
            )}
            {step === 'primer' && (
              <button
                type="button"
                onClick={handleTour}
                className="btn btn-tour"
              >
                Take Tour
              </button>
            )}
            <button
              type="button"
              onClick={handleNext}
              className="btn btn-primary"
            >
              {step === 'primer' ? 'Get Started' : 'Next'}
            </button>
          </div>
        </div>
      )}
    >
      <div className="welcome-modal">
        {/* Step Progress Indicator */}
        <StepIndicator currentStep={step} />

        {/* Step 1: Intro */}
        {step === 'intro' && (
          <div className="animate-fade-in welcome-intro">
            <h2 className="welcome-intro__title">
              Explore the Viral Universe
            </h2>
            <p className="welcome-intro__description">
              Phage Explorer is a keyboard-first visualization tool for bacteriophage genomes.
              Navigate sequences, analyze genes, and simulate biological processes directly in your browser.
            </p>

            <div className="welcome-features">
              <div className="welcome-feature">
                <strong className="welcome-feature__header welcome-feature__header--primary">
                  <span aria-hidden="true" className="welcome-feature__icon">
                    <IconKeyboard size={16} />
                  </span>
                  Keyboard First
                </strong>
                <p className="welcome-feature__text">
                  Designed for speed. Use shortcuts for almost everything.
                </p>
              </div>
              <div className="welcome-feature">
                <strong className="welcome-feature__header welcome-feature__header--secondary">
                  <span aria-hidden="true" className="welcome-feature__icon">
                    <IconFlask size={16} />
                  </span>
                  Deep Analysis
                </strong>
                <p className="welcome-feature__text">
                  Real-time GC skew, codon bias, and structural overlays.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Experience Level */}
        {step === 'level' && (
          <div className="animate-fade-in welcome-level">
            <h3 className="welcome-level__title">
              Choose your experience level
            </h3>
            <div className="welcome-level__grid">
              <LevelCard
                title="Novice"
                desc="Core features only. Guided experience."
                icon={<IconLearn size={20} />}
                selected={experienceLevel === 'novice'}
                onSelect={() => setExperienceLevel('novice')}
              />
              <LevelCard
                title="Explorer"
                desc="Standard toolset. Balanced complexity."
                icon={<IconSearch size={20} />}
                selected={experienceLevel === 'intermediate'}
                onSelect={() => setExperienceLevel('intermediate')}
              />
              <LevelCard
                title="Power User"
                desc="Full access. All overlays & raw data."
                icon={<IconZap size={20} />}
                selected={experienceLevel === 'power'}
                onSelect={() => setExperienceLevel('power')}
              />
            </div>
            <p className="welcome-level__hint">
              You can change this later in the settings or command palette.
            </p>
          </div>
        )}

        {/* Step 3: Primer */}
        {step === 'primer' && (
          <div className="animate-fade-in welcome-primer">
            <h3 className="welcome-primer__title">
              Quick Start Guide
            </h3>
            <KeyboardPrimer />
          </div>
        )}
      </div>
    </Overlay>
  );
}
