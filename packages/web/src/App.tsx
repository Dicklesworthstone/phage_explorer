import React, { useCallback, useState } from 'react';
import { useTheme, getNucleotideClass, useHotkey, useKeyboardMode, usePendingSequence } from './hooks';
import { AppShell } from './components';
import { HotkeyCategories } from './keyboard/types';

const App: React.FC = () => {
  const { theme, nextTheme, availableThemes } = useTheme();
  const { mode, setMode } = useKeyboardMode();
  const pendingSequence = usePendingSequence();
  const [lastAction, setLastAction] = useState<string>('');

  // Register hotkeys
  const handleThemeCycle = useCallback(() => {
    nextTheme();
    setLastAction('Theme cycled');
  }, [nextTheme]);

  const handleHelp = useCallback(() => {
    setLastAction('Help overlay (not yet implemented)');
  }, []);

  const handleSearch = useCallback(() => {
    setMode('SEARCH');
    setLastAction('Search mode activated');
  }, [setMode]);

  const handleCommand = useCallback(() => {
    setMode('COMMAND');
    setLastAction('Command mode activated');
  }, [setMode]);

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

  // Theme hotkey
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
        subtitle: `Theme: ${theme.name}`,
        mode,
        pendingSequence,
        children: (
          <button className="btn" onClick={handleThemeCycle}>
            <span className="key-hint">t</span> Theme
          </button>
        ),
      }}
    >
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
          <h2>Key Sequences</h2>
          <p>
            Try <span className="key-hint">g</span><span className="key-hint">g</span> to go to top,
            or <span className="key-hint">G</span> for bottom.
            Sequences timeout after 1 second.
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

export default App;
