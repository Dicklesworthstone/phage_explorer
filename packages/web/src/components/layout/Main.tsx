/**
 * Main Component
 *
 * Primary content container with flex layout and scrolling.
 */

import React from 'react';

export interface MainProps {
  children: React.ReactNode;
  className?: string;
}

export const Main: React.FC<MainProps> = ({ children, className = '' }) => {
  return (
    <main className={`app-body ${className}`.trim()}>
      {children}
    </main>
  );
};

export default Main;
