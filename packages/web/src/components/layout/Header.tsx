/**
 * Header Component
 *
 * Top navigation bar with branding, status indicators, and quick actions.
 */

import React from 'react';
import { SubtleBadge, WarningBadge } from '../ui/Badge';

export interface HeaderProps {
  /** Title can be a string or a custom ReactNode (e.g., tappable picker trigger) */
  title?: string | React.ReactNode;
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
    <header className="app-header" role="banner" aria-label="Application Header">
      <div className="header-left">
        <span className="app-title" role="heading" aria-level={1}>{title}</span>
        {subtitle && (
          <span className="app-subtitle" role="status" aria-live="polite">
            {subtitle}
          </span>
        )}
        {mode && (
          <SubtleBadge aria-label={`Keyboard Mode: ${mode}`}>
            {mode}
          </SubtleBadge>
        )}
        {pendingSequence && (
          <WarningBadge
            pulse
            aria-label={`Pending Key Sequence: ${pendingSequence}`}
          >
            {pendingSequence}
          </WarningBadge>
        )}
      </div>
      <div className="header-right" role="navigation" aria-label="Quick actions">
        {children}
      </div>
    </header>
  );
};

export default Header;
