import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useBeginnerMode } from '../education';

type MenuItem = {
  id: string;
  label: string;
  description: string;
  action: () => void;
};

export const LearnMenu: React.FC = () => {
  const { isEnabled, openGlossary, startTour, showContextFor } = useBeginnerMode();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const items: MenuItem[] = [
    {
      id: 'foundations',
      label: 'Foundational Modules',
      description: 'Core DNA/RNA/protein primers',
      action: () => {
        showContextFor('foundations');
        setOpen(false);
      },
    },
    {
      id: 'glossary',
      label: 'Glossary',
      description: 'Definitions for key terms',
      action: () => {
        openGlossary();
        setOpen(false);
      },
    },
    {
      id: 'welcome-tour',
      label: 'Start Welcome Tour',
      description: 'Guided walkthrough',
      action: () => {
        startTour('welcome');
        setOpen(false);
      },
    },
  ];

  const toggleMenu = useCallback(() => setOpen(v => !v), []);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [open]);

  if (!isEnabled) return null;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggleMenu}
      >
        Learn
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Learn menu"
          style={{
            position: 'absolute',
            right: 0,
            marginTop: '0.5rem',
            minWidth: '240px',
            background: 'var(--color-background-elevated)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: '10px',
            boxShadow: 'var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.3))',
            zIndex: 20,
            padding: '0.25rem',
          }}
        >
          {items.map(item => (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              onClick={item.action}
              className="btn"
              style={{
                width: '100%',
                justifyContent: 'flex-start',
                textAlign: 'left',
                margin: 0,
                marginBottom: '0.25rem',
                background: 'transparent',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontWeight: 600 }}>{item.label}</span>
                <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
                  {item.description}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default LearnMenu;
