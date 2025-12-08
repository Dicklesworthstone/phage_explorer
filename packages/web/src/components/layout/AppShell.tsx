/**
 * AppShell Component
 *
 * Main application layout wrapper with Header, Main, and Footer.
 */

import React from 'react';
import { Header, type HeaderProps } from './Header';
import { Footer, type FooterProps } from './Footer';
import { SkipNavigation } from './SkipNavigation';
import { CRTOverlay } from './CRTOverlay';
import { MatrixRain } from '../MatrixRain';

interface AppShellProps {
  header?: HeaderProps;
  footer?: FooterProps;
  children: React.ReactNode;
  matrixCharSet?: 'dna' | 'amino' | 'binary' | 'matrix' | 'hex';
}

export const AppShell: React.FC<AppShellProps> = ({ header, footer, children, matrixCharSet = 'dna' }) => {
  return (
    <div className="app-shell">
      <SkipNavigation />
      <MatrixRain opacity={0.08} charSet={matrixCharSet} />
      <CRTOverlay />
      <Header {...header} />
      <main id="main-content" className="app-body" role="main">
        {children}
      </main>
      <Footer {...footer} />
    </div>
  );
};

// Re-export individual components
export { Header, Footer, Main };
export type { HeaderProps, FooterProps, MainProps };

export default AppShell;
