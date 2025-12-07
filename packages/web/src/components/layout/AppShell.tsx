/**
 * AppShell Component
 *
 * Main application layout wrapper with Header, Main, and Footer.
 */

import React from 'react';
import { Header, type HeaderProps } from './Header';
import { Main, type MainProps } from './Main';
import { Footer, type FooterProps } from './Footer';

export interface AppShellProps {
  children: React.ReactNode;
  header?: HeaderProps;
  footer?: FooterProps;
  className?: string;
}

export const AppShell: React.FC<AppShellProps> = ({
  children,
  header,
  footer,
  className = '',
}) => {
  return (
    <div className={`app-shell ${className}`.trim()}>
      <Header {...header} />
      <Main>{children}</Main>
      <Footer {...footer} />
    </div>
  );
};

// Re-export individual components
export { Header, Footer, Main };
export type { HeaderProps, FooterProps, MainProps };

export default AppShell;
