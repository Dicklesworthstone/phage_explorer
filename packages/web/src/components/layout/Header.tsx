/**
 * Header Component
 *
 * Top navigation bar with branding, status indicators, and quick actions.
 */

import React from 'react';

export interface HeaderProps {
  title?: string;
  subtitle?: string;
  mode?: string;
  pendingSequence?: string | null;
  children?: React.ReactNode;
}

export const Header: React.FC<HeaderProps> = ({
  title = 'Phage Explorer',
  subtitle,
  mode,
  pendingSequence,
  children,
}) => {
  return (
    <header className="app-header">
      <div className="header-left">
        <span className="app-title chromatic-aberration">{title}</span>
        <span className="badge">WEB</span>
        {mode && (
          <span className="badge" style={{ background: 'var(--color-secondary)' }}>
            {mode}
          </span>
        )}
        {pendingSequence && (
          <span
            className="badge animate-pulse"
            style={{ background: 'var(--color-warning)', color: '#000' }}
          >
            {pendingSequence}
          </span>
        )}
      </div>
      <div className="header-right">
        {subtitle && <span className="app-subtitle">{subtitle}</span>}
        {children}
      </div>
    </header>
  );
};

export default Header;
