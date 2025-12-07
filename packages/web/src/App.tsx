import React from 'react';
import { useTheme, getNucleotideClass } from './hooks';

const App: React.FC = () => {
  const { theme, nextTheme, availableThemes } = useTheme();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="flex items-center gap-3">
          <span className="app-title chromatic-aberration">Phage Explorer</span>
          <span className="badge">WEB</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="app-subtitle">Theme: {theme.name}</span>
          <button
            className="btn"
            onClick={nextTheme}
            title="Press 't' to cycle themes"
          >
            <span className="key-hint">t</span> Next Theme
          </button>
        </div>
      </header>

      <main className="app-body">
        <div className="cards-grid">
          <section className="card animate-fade-in">
            <h2>Theme System Active</h2>
            <p>
              All {availableThemes.length} themes ported from @phage-explorer/core.
              CSS custom properties update dynamically. Theme persists in localStorage.
            </p>
          </section>

          <section className="card animate-fade-in" style={{ animationDelay: '50ms' }}>
            <h2>Color Palette</h2>
            <div className="flex gap-2" style={{ marginTop: '0.5rem' }}>
              <span
                className="badge"
                style={{ background: theme.palette.primary, color: '#000' }}
              >
                Primary
              </span>
              <span
                className="badge"
                style={{ background: theme.palette.secondary, color: '#fff' }}
              >
                Secondary
              </span>
              <span
                className="badge"
                style={{ background: theme.palette.accent, color: '#000' }}
              >
                Accent
              </span>
            </div>
          </section>

          <section className="card animate-fade-in" style={{ animationDelay: '100ms' }}>
            <h2>Keyboard Hints</h2>
            <p>
              <span className="key-hint">?</span> Help{' '}
              <span className="key-hint">:</span> Command{' '}
              <span className="key-hint">/</span> Search{' '}
              <span className="key-hint">t</span> Theme
            </p>
          </section>

          <section className="card animate-fade-in" style={{ animationDelay: '150ms' }}>
            <h2>Nucleotide Colors</h2>
            <p className="tabular-nums" style={{ letterSpacing: '0.1em' }}>
              {['A', 'T', 'G', 'C', 'A', 'T', 'G', 'C', 'N', 'A'].map((nuc, i) => (
                <span key={i} className={getNucleotideClass(nuc)}>
                  {nuc}
                </span>
              ))}
            </p>
          </section>

          <section className="card animate-fade-in" style={{ animationDelay: '200ms' }}>
            <h2>Status Colors</h2>
            <div className="flex gap-2" style={{ marginTop: '0.5rem' }}>
              <span className="badge badge-success">Success</span>
              <span className="badge badge-warning">Warning</span>
              <span className="badge badge-error">Error</span>
            </div>
          </section>

          <section className="card animate-fade-in" style={{ animationDelay: '250ms' }}>
            <h2>Next Steps</h2>
            <p>
              Build keyboard manager with vim modal states. Create layout shell
              components. Wire up state management with Zustand.
            </p>
          </section>
        </div>
      </main>

      <footer className="app-footer">
        <span>Phage Explorer v0.0.0</span>
        <span className="text-muted">
          Press <span className="key-hint">?</span> for help ·{' '}
          <span className="key-hint">t</span> to change theme
        </span>
      </footer>
    </div>
  );
};

export default App;
