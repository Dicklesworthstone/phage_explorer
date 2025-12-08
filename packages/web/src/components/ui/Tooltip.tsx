import React, { useState, useRef, useEffect } from 'react';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  className?: string;
  isVisible?: boolean; // Control visibility externally if needed
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  position = 'top',
  delay = 300,
  className = '',
  isVisible: externalVisible,
}) => {
  const [internalVisible, setVisible] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const show = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  const visible = externalVisible ?? internalVisible;

  return (
    <div
      className={`tooltip-container ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      {children}
      {visible && (
        <div
          className={`tooltip-content tooltip-${position}`}
          role="tooltip"
          style={{
            position: 'absolute',
            zIndex: 1000,
            padding: '0.5rem',
            background: 'var(--color-background-alt, #333)',
            color: 'var(--color-text, #fff)',
            border: '1px solid var(--color-border, #555)',
            borderRadius: '4px',
            fontSize: '0.8rem',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
            ...getPositionStyle(position),
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
};

function getPositionStyle(position: 'top' | 'bottom' | 'left' | 'right'): React.CSSProperties {
  switch (position) {
    case 'top':
      return { bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: '0.5rem' };
    case 'bottom':
      return { top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: '0.5rem' };
    case 'left':
      return { right: '100%', top: '50%', transform: 'translateY(-50%)', marginRight: '0.5rem' };
    case 'right':
      return { left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: '0.5rem' };
  }
}
