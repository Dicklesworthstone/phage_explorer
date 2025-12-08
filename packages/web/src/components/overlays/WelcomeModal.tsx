/**
 * WelcomeModal - First Run Experience
 *
 * Onboarding modal that introduces the user to the application.
 * Allows selecting experience level and provides a quick tour.
 */

import React, { useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useWebPreferences } from '../../store/createWebStore';
import { usePhageStore, type ExperienceLevel } from '@phage-explorer/state';
import { KeyboardPrimer } from './KeyboardPrimer';

export function WelcomeModal(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { close, isOpen, open } = useOverlay();

  // Web-specific preferences (persisted)
  const hasSeenWelcome = useWebPreferences(s => s.hasSeenWelcome);
  const setHasSeenWelcome = useWebPreferences(s => s.setHasSeenWelcome);

  // Main store preferences
  const setExperienceLevel = usePhageStore(s => s.setExperienceLevel);
  const experienceLevel = usePhageStore(s => s.experienceLevel) as ExperienceLevel;

  const [step, setStep] = useState<'intro' | 'level' | 'primer'>('intro');

  // If already seen, don't render unless explicitly opened via help/menu
  if (hasSeenWelcome && !isOpen('welcome')) {
    return null;
  }

  // If not seen and not open, we should probably trigger it via an effect in a parent manager,
  // but for now let's assume the manager opens it if hasSeenWelcome is false.
  // Actually, let's make this component self-opening if mounted and not seen.
  // But React strict mode might trigger this double. Better to have a manager handle opening.
  // For this implementation, we assume it's opened by OverlayManager.

  if (!isOpen('welcome')) {
    return null;
  }

  const handleNext = () => {
    if (step === 'intro') setStep('level');
    else if (step === 'level') setStep('primer');
    else handleFinish();
  };

  const handleFinish = () => {
    setHasSeenWelcome(true);
    close('welcome');
  };

  const handleTour = () => {
    setHasSeenWelcome(true);
    close('welcome');
    setTimeout(() => open('tour'), 100);
  };

  const LevelCard = ({ level, title, desc, icon }: { level: ExperienceLevel, title: string, desc: string, icon: string }) => (
    <div
      onClick={() => setExperienceLevel(level)}
      style={{
        border: `2px solid ${experienceLevel === level ? colors.accent : colors.border}`,
        borderRadius: '6px',
        padding: '1rem',
        cursor: 'pointer',
        backgroundColor: experienceLevel === level ? `${colors.accent}10` : 'transparent',
        transition: 'all 0.2s ease'
      }}
    >
      <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{icon}</div>
      <h3 style={{ color: experienceLevel === level ? colors.accent : colors.primary, margin: '0 0 0.25rem 0' }}>{title}</h3>
      <p style={{ margin: 0, fontSize: '0.85rem', color: colors.textDim }}>{desc}</p>
    </div>
  );

  return (
    <Overlay
      id="welcome"
      title="WELCOME TO PHAGE EXPLORER"
      icon="🧬"
      size="lg"
      showBackdrop={true}
      onClose={handleFinish} // Allow closing at any time
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minHeight: '300px' }}>
        
        {/* Step 1: Intro */}
        {step === 'intro' && (
          <div className="animate-fade-in">
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              <h2 style={{ color: colors.text, marginBottom: '1rem' }}>
                Explore the Viral Universe
              </h2>
              <p style={{ color: colors.textDim, lineHeight: 1.6, maxWidth: '500px', margin: '0 auto' }}>
                Phage Explorer is a keyboard-first visualization tool for bacteriophage genomes.
                Navigate sequences, analyze genes, and simulate biological processes directly in your browser.
              </p>
            </div>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: '1fr 1fr', 
              gap: '1rem',
              marginTop: '1rem'
            }}>
              <div style={{ backgroundColor: colors.backgroundAlt, padding: '1rem', borderRadius: '4px' }}>
                <strong style={{ color: colors.primary }}>⌨️ Keyboard First</strong>
                <p style={{ fontSize: '0.85rem', color: colors.textMuted }}>Designed for speed. Use shortcuts for almost everything.</p>
              </div>
              <div style={{ backgroundColor: colors.backgroundAlt, padding: '1rem', borderRadius: '4px' }}>
                <strong style={{ color: colors.secondary }}>🔬 Deep Analysis</strong>
                <p style={{ fontSize: '0.85rem', color: colors.textMuted }}>Real-time GC skew, codon bias, and structural overlays.</p>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Experience Level */}
        {step === 'level' && (
          <div className="animate-fade-in">
            <h3 style={{ textAlign: 'center', color: colors.text, marginBottom: '1.5rem' }}>
              Choose your experience level
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
              <LevelCard 
                level="novice" 
                title="Novice" 
                desc="Core features only. Guided experience." 
                icon="🌱" 
              />
              <LevelCard 
                level="intermediate" 
                title="Explorer" 
                desc="Standard toolset. Balanced complexity." 
                icon="🔭" 
              />
              <LevelCard 
                level="power" 
                title="Power User" 
                desc="Full access. All overlays & raw data." 
                icon="⚡" 
              />
            </div>
            <p style={{ textAlign: 'center', fontSize: '0.8rem', color: colors.textMuted, marginTop: '1rem' }}>
              You can change this later in the settings or command palette.
            </p>
          </div>
        )}

        {/* Step 3: Primer */}
        {step === 'primer' && (
          <div className="animate-fade-in">
            <h3 style={{ textAlign: 'center', color: colors.text, marginBottom: '0.5rem' }}>
              Quick Start Guide
            </h3>
            <KeyboardPrimer />
          </div>
        )}

        {/* Footer Controls */}
        <div style={{ 
          marginTop: 'auto', 
          display: 'flex', 
          justifyContent: 'space-between', 
          paddingTop: '1rem',
          borderTop: `1px solid ${colors.borderLight}`
        }}>
          <button 
            onClick={handleFinish}
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
            {step !== 'intro' && (
              <button
                onClick={() => setStep(step === 'primer' ? 'level' : 'intro')}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: '4px',
                  border: `1px solid ${colors.border}`,
                  background: 'transparent',
                  color: colors.text,
                  cursor: 'pointer'
                }}
              >
                Back
              </button>
            )}
            {step === 'primer' && (
              <button
                onClick={handleTour}
                style={{
                  padding: '0.5rem 1.5rem',
                  borderRadius: '4px',
                  border: `1px solid ${colors.accent}`,
                  background: 'transparent',
                  color: colors.accent,
                  cursor: 'pointer',
                  fontWeight: 'bold'
                }}
              >
                Take Tour
              </button>
            )}
            <button
              onClick={handleNext}
              style={{
                padding: '0.5rem 1.5rem',
                borderRadius: '4px',
                border: 'none',
                background: colors.primary,
                color: '#000',
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              {step === 'primer' ? 'Get Started' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
