/**
 * AppShell Component
 *
 * Main application layout wrapper with Header, Main, and Footer.
 */

import React from 'react';
import { Header, type HeaderProps } from './Header';
import { Footer, type FooterProps } from './Footer';
import { Main, type MainProps } from './Main';
import { SkipNavigation } from './SkipNavigation';
import { CRTOverlay } from './CRTOverlay';
import { MatrixRain } from '../MatrixRain';

export interface AppShellProps {
  header?: HeaderProps;
  footer?: FooterProps;
  children: React.ReactNode;
  matrixCharSet?: 'dna' | 'amino' | 'binary' | 'matrix' | 'hex';
  enableBackgroundEffects?: boolean;
}

export const AppShell: React.FC<AppShellProps> = ({
  header,
  footer,
  children,
  matrixCharSet = 'dna',
  enableBackgroundEffects = true,
}) => {
  return (
    <div className="app-shell">
      <SkipNavigation />
      {enableBackgroundEffects && (
        <>
          <div className="fx-layer fx-layer--matrix" aria-hidden="true">
            <MatrixRain opacity={0.08} charSet={matrixCharSet} />
          </div>
          <div className="fx-layer fx-layer--crt" aria-hidden="true">
            <CRTOverlay />
          </div>
        </>
      )}
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
