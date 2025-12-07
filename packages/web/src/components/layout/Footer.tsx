/**
 * Footer Component
 *
 * Bottom bar with version info and keyboard hints.
 */

import React from 'react';

export interface KeyHint {
  key: string;
  label: string;
}

export interface FooterProps {
  version?: string;
  hints?: KeyHint[];
  children?: React.ReactNode;
}

const defaultHints: KeyHint[] = [
  { key: '?', label: 'help' },
  { key: 't', label: 'theme' },
  { key: '/', label: 'search' },
  { key: ':', label: 'command' },
];

export const Footer: React.FC<FooterProps> = ({
  version = '0.0.0',
  hints = defaultHints,
  children,
}) => {
  return (
    <footer className="app-footer">
      <span className="footer-version">Phage Explorer v{version}</span>
      <div className="footer-hints">
        {hints.map((hint, i) => (
          <React.Fragment key={hint.key}>
            {i > 0 && <span className="hint-separator">·</span>}
            <span className="hint-item">
              <span className="key-hint">{hint.key}</span>
              <span className="hint-label">{hint.label}</span>
            </span>
          </React.Fragment>
        ))}
        {children}
      </div>
    </footer>
  );
};

export default Footer;
