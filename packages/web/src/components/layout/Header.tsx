/**
 * Header Component
 *
 * Top navigation bar with branding, status indicators, and quick actions.
 */

import React from 'react';

export interface HeaderProps {
  title?: string;
  mode?: string;
  pendingSequence?: string | null;
  children?: React.ReactNode;
}

export const Header: React.FC<HeaderProps> = ({
  title = 'Phage Explorer',
  mode,
  pendingSequence,
  children,
}) => {
  return (
    <header className="app-header" role="banner" aria-label="Application Header">
      <div className="header-left">
        <span className="app-title chromatic-aberration" role="heading" aria-level={1}>{title}</span>
        <span className="badge" aria-label="Platform: Web">WEB</span>
        {mode && (
          <span 
            className="badge" 
            style={{ background: 'var(--color-secondary)' }}
            role="status"
            aria-live="polite"
            aria-label={`Keyboard Mode: ${mode}`}
          >
            {mode}
          </span>
        )}
        {pendingSequence && (
          <span
            className="badge animate-pulse"
            style={{ background: 'var(--color-warning)', color: '#000' }}
            role="status"
            aria-live="assertive"
            aria-label={`Pending Key Sequence: ${pendingSequence}`}
          >
            {pendingSequence}
          </span>
        )}
      </div>
      <div className="header-right" role="navigation" aria-label="Quick actions">
        {children}
      </div>
    </header>
  );
};

export default Header;
