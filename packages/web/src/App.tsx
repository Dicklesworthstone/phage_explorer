import React, { useCallback, useMemo, useState } from 'react';
import { useTheme, getNucleotideClass, useHotkey, useKeyboardMode, usePendingSequence, useReducedMotion } from './hooks';
import { AppShell } from './components';
import { HotkeyCategories } from './keyboard/types';
import { OverlayProvider, OverlayManager, useOverlay } from './components/overlays';
import { useWebPreferences } from './store/createWebStore';
import type { ExperienceLevel } from '@phage-explorer/state';

const PhageExplorerContent: React.FC = () => {
  const { theme, nextTheme, availableThemes } = useTheme();
  const { mode, setMode } = useKeyboardMode();
  const { toggle } = useOverlay();
  const pendingSequence = usePendingSequence();
  const [lastAction, setLastAction] = useState<string>('');
  const { experienceLevel, setExperienceLevel } = useWebPreferences((s) => ({
    experienceLevel: s.experienceLevel as ExperienceLevel,
    setExperienceLevel: s.setExperienceLevel,
  }));

  const experienceLevels = useMemo<ExperienceLevel[]>(() => ['novice', 'intermediate', 'power'], []);

  // Register hotkeys
  const handleThemeCycle = useCallback(() => {
    nextTheme();
    setLastAction('Theme cycled');
  }, [nextTheme]);

  const handleHelp = useCallback(() => {
    toggle('help');
    setLastAction('Help overlay toggled');
  }, [toggle]);

  const handleSearch = useCallback(() => {
    // setMode('SEARCH'); // Search is now an overlay in web too?
    // For now, keep mode switching if search overlay isn't fully replacing it
    toggle('search'); // Assuming search is an overlay
    setLastAction('Search overlay toggled');
  }, [toggle]);

  const handleCommand = useCallback(() => {
    toggle('commandPalette');
    setLastAction('Command palette toggled');
  }, [toggle]);

  const handleEscape = useCallback(() => {
    setMode('NORMAL');
    setLastAction('Normal mode');
  }, [setMode]);

  const handleGoTop = useCallback(() => {
    setLastAction('Go to top (gg sequence)');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleGoBottom = useCallback(() => {
    setLastAction('Go to bottom (G)');
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }, []);

  const handleTranscriptionFlow = useCallback(() => {
    toggle('transcriptionFlow');
    setLastAction('Transcription flow toggled');
  }, [toggle]);

  const handleExperienceChange = useCallback((level: ExperienceLevel) => {
    setExperienceLevel(level);
    setLastAction(`Experience set to ${level}`);
  }, [setExperienceLevel]);

  const handleUp = useCallback(() => {
    setLastAction('Navigate Up');
  }, []);

  const handleDown = useCallback(() => {
    setLastAction('Navigate Down');
  }, []);

  const handleEnter = useCallback(() => {
    setLastAction('Enter / Select');
  }, []);

  const handleTab = useCallback(() => {
    setLastAction('Tab Navigation');
  }, []);

  // Theme hotkey
  useHotkey({ key: 't' }, 'Cycle theme', handleThemeCycle, {
    category: HotkeyCategories.THEMES,
    modes: ['NORMAL'],
  });

  // Navigation hotkeys (Standard)
  useHotkey({ key: 'ArrowUp' }, 'Navigate Up', handleUp, {
    category: HotkeyCategories.NAVIGATION,
    modes: ['NORMAL'],
  });

  useHotkey({ key: 'ArrowDown' }, 'Navigate Down', handleDown, {
    category: HotkeyCategories.NAVIGATION,
    modes: ['NORMAL'],
  });

  useHotkey({ key: 'Enter' }, 'Select Item', handleEnter, {
    category: HotkeyCategories.GENERAL,
    modes: ['NORMAL'],
  });

  useHotkey({ key: 'Tab' }, 'Next Focus', handleTab, {
    category: HotkeyCategories.NAVIGATION,
    modes: ['NORMAL'],
  });

  useHotkey({ key: 'Tab', modifiers: { shift: true } }, 'Previous Focus', handleTab, {
    category: HotkeyCategories.NAVIGATION,
    modes: ['NORMAL'],
  });

  // Help hotkey
  useHotkey({ key: 't' }, 'Cycle theme', handleThemeCycle, {
    category: HotkeyCategories.THEMES,
    modes: ['NORMAL'],
  });

  // Help hotkey
  useHotkey({ key: '?' }, 'Show help', handleHelp, {
    category: HotkeyCategories.GENERAL,
    modes: ['NORMAL'],
  });

  // Search hotkey
  useHotkey({ key: '/' }, 'Search', handleSearch, {
    category: HotkeyCategories.SEARCH,
    modes: ['NORMAL'],
  });

  // Command hotkey
  useHotkey({ key: ':' }, 'Command palette', handleCommand, {
    category: HotkeyCategories.GENERAL,
    modes: ['NORMAL'],
  });

  // Transcription Flow hotkey
  useHotkey({ key: 'y' }, 'Transcription Flow', handleTranscriptionFlow, {
    category: HotkeyCategories.ANALYSIS,
    modes: ['NORMAL'],
  });

  // Escape to normal mode
  useHotkey({ key: 'Escape' }, 'Return to normal mode', handleEscape, {
    category: HotkeyCategories.GENERAL,
  });

  // Vim navigation - gg for top
  useHotkey({ sequence: ['g', 'g'] }, 'Go to top', handleGoTop, {
    category: HotkeyCategories.NAVIGATION,
    modes: ['NORMAL'],
  });

  // Vim navigation - G for bottom
  useHotkey({ key: 'G', modifiers: { shift: true } }, 'Go to bottom', handleGoBottom, {
    category: HotkeyCategories.NAVIGATION,
    modes: ['NORMAL'],
  });

  return (
    <AppShell
      header={{
        subtitle: `Theme: ${theme.name} · Level: ${experienceLevel}`,
        mode,
        pendingSequence,
        children: (
          <div className="flex gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" onClick={handleThemeCycle}>
              <span className="key-hint">t</span> Theme
            </button>
            <div className="flex gap-1" style={{ alignItems: 'center' }}>
              <span className="text-dim" style={{ fontSize: '0.85rem' }}>Experience</span>
              {experienceLevels.map((level) => {
                const active = level === experienceLevel;
                return (
                  <button
                    key={level}
                    className="badge"
                    onClick={() => handleExperienceChange(level)}
                    style={{
                      border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                      background: active ? 'var(--color-accent)' : 'var(--color-badge)',
                      color: active ? '#000' : 'var(--color-badge-text)',
                      textTransform: 'capitalize',
                      cursor: 'pointer',
                    }}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
          </div>
        ),
      }}
    >
      <OverlayManager />
      
      <div className="cards-grid">
        <section className="card animate-fade-in">
          <h2>Keyboard Manager Active</h2>
          <p>
            Vim-style modal keyboard system. Current mode: <strong>{mode}</strong>.
            Press <span className="key-hint">?</span> for help.
          </p>
          {lastAction && (
            <p className="text-dim" style={{ marginTop: '0.5rem' }}>
              Last action: {lastAction}
            </p>
          )}
        </section>

        <section className="card animate-fade-in" style={{ animationDelay: '50ms' }}>
          <h2>Analysis Tools</h2>
          <p>
            Try <span className="key-hint">y</span> for Transcription Flow analysis.
          </p>
        </section>

        <section className="card animate-fade-in" style={{ animationDelay: '100ms' }}>
          <h2>Modal Modes</h2>
          <p>
            <span className="key-hint">/</span> Search mode{' '}
            <span className="key-hint">:</span> Command mode{' '}
            <span className="key-hint">Esc</span> Normal mode
          </p>
        </section>

        <section className="card animate-fade-in" style={{ animationDelay: '150ms' }}>
          <h2>Color Palette</h2>
          <div className="flex gap-2" style={{ marginTop: '0.5rem' }}>
            <span className="badge" style={{ background: theme.palette.primary, color: '#000' }}>
              Primary
            </span>
            <span className="badge" style={{ background: theme.palette.secondary, color: '#fff' }}>
              Secondary
            </span>
            <span className="badge" style={{ background: theme.palette.accent, color: '#000' }}>
              Accent
            </span>
          </div>
        </section>

        <section className="card animate-fade-in" style={{ animationDelay: '200ms' }}>
          <h2>Nucleotide Colors</h2>
          <p className="tabular-nums" style={{ letterSpacing: '0.1em' }}>
            {['A', 'T', 'G', 'C', 'A', 'T', 'G', 'C', 'N', 'A'].map((nuc, i) => (
              <span key={i} className={getNucleotideClass(nuc)}>
                {nuc}
              </span>
            ))}
          </p>
        </section>

        <section className="card animate-fade-in" style={{ animationDelay: '250ms' }}>
          <h2>All {availableThemes.length} Themes</h2>
          <div className="flex gap-2" style={{ marginTop: '0.5rem', flexWrap: 'wrap' }}>
            {availableThemes.map((t) => (
              <span
                key={t.id}
                className="badge"
                style={{
                  background: t.id === theme.id ? 'var(--color-primary)' : 'var(--color-badge)',
                  color: t.id === theme.id ? '#000' : 'var(--color-badge-text)',
                }}
              >
                {t.name}
              </span>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
};

const App: React.FC = () => {
  return (
    <OverlayProvider>
      <PhageExplorerContent />
    </OverlayProvider>
  );
};

export default App;
