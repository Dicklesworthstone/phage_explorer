import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBeginnerMode } from '../education';
import { IconBookmark, IconChevronDown, IconLearn, IconTarget } from './ui';

type MenuItem = {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  action: () => void;
};

export const LearnMenu: React.FC = () => {
  const { isEnabled, openGlossary, startTour, showContextFor, hasCompletedTour } = useBeginnerMode();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const ids = useMemo(() => ({ trigger: 'learn-menu-trigger', menu: 'learn-menu' }), []);

  const closeMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    setOpen(false);
    if (opts?.restoreFocus) {
      window.requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
    }
  }, []);

  const sections = useMemo(() => {
    const welcomeCompleted = hasCompletedTour('welcome');

    return [
      {
        id: 'modules',
        label: 'Modules',
        items: [
          {
            id: 'module-phage-basics',
            label: 'Phage basics',
            description: 'Start here: the phage genome and key parts.',
            icon: <IconLearn size={18} />,
            action: () => {
              showContextFor('phage-genome');
              closeMenu();
            },
          },
          {
            id: 'module-sequence-basics',
            label: 'DNA & genes',
            description: 'How to read A/T/G/C and find genes.',
            icon: <IconLearn size={18} />,
            action: () => {
              showContextFor('dna-sequence');
              closeMenu();
            },
          },
        ] satisfies MenuItem[],
      },
      {
        id: 'glossary',
        label: 'Glossary',
        items: [
          {
            id: 'glossary',
            label: 'Browse glossary',
            description: 'Look up terms and follow links as you explore.',
            icon: <IconBookmark size={18} />,
            action: () => {
              openGlossary();
              closeMenu();
            },
          },
        ] satisfies MenuItem[],
      },
      {
        id: 'tours',
        label: 'Tours',
        items: [
          {
            id: 'welcome-tour',
            label: welcomeCompleted ? 'Replay welcome tour' : 'Start welcome tour',
            description: 'A quick guided walkthrough of the interface.',
            icon: <IconTarget size={18} />,
            action: () => {
              startTour('welcome');
              closeMenu();
            },
          },
        ] satisfies MenuItem[],
      },
    ] satisfies Array<{ id: string; label: string; items: MenuItem[] }>;
  }, [closeMenu, hasCompletedTour, openGlossary, showContextFor, startTour]);

  const items = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  const sectionStartIndices = useMemo(() => {
    let offset = 0;
    return sections.map((section) => {
      const start = offset;
      offset += section.items.length;
      return start;
    });
  }, [sections]);

  const toggleMenu = useCallback(() => setOpen(v => !v), []);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    if (items.length === 0) return;
    const raf = window.requestAnimationFrame(() => {
      itemRefs.current[0]?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [items.length, open]);

  if (!isEnabled) return null;

  return (
    <div
      ref={containerRef}
      className="learn-menu"
      onBlurCapture={(event) => {
        if (!open) return;
        const next = event.relatedTarget as Node | null;
        if (!next || !containerRef.current?.contains(next)) {
          closeMenu();
        }
      }}
    >
      <button
        type="button"
        className="btn"
        ref={triggerRef}
        id={ids.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={ids.menu}
        onClick={toggleMenu}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
            return;
          }
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            closeMenu({ restoreFocus: true });
          }
        }}
      >
        <span className="learn-menu-trigger-icon" aria-hidden="true">
          <IconLearn size={16} />
        </span>
        <span>Learn</span>
        <span className="learn-menu-trigger-chevron" aria-hidden="true">
          <IconChevronDown size={16} />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          id={ids.menu}
          aria-labelledby={ids.trigger}
          className="learn-menu-popover"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeMenu({ restoreFocus: true });
              return;
            }

            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const focusedIndex = itemRefs.current.findIndex((node) => node === document.activeElement);
              const current = focusedIndex >= 0 ? focusedIndex : activeIndex;
              const lastIndex = items.length - 1;

              const nextIndex =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? lastIndex
                    : event.key === 'ArrowDown'
                      ? Math.min(lastIndex, current + 1)
                      : Math.max(0, current - 1);

              setActiveIndex(nextIndex);
              itemRefs.current[nextIndex]?.focus();
            }
          }}
        >
          {sections.map((section, sectionIndex) => {
            const baseIndex = sectionStartIndices[sectionIndex] ?? 0;

            return (
              <div
                key={section.id}
                className="learn-menu-section"
                role="group"
                aria-labelledby={`learn-menu-section-${section.id}`}
              >
                <div className="learn-menu-section-title" id={`learn-menu-section-${section.id}`}>
                  {section.label}
                </div>
                {section.items.map((item, itemOffset) => {
                  const index = baseIndex + itemOffset;

                  return (
                    <button
                      key={item.id}
                      role="menuitem"
                      type="button"
                      onClick={item.action}
                      ref={(node) => {
                        itemRefs.current[index] = node;
                      }}
                      tabIndex={index === activeIndex ? 0 : -1}
                      className="btn btn-ghost learn-menu-item"
                      onFocus={() => setActiveIndex(index)}
                    >
                      <span className="learn-menu-item-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="learn-menu-item-content">
                        <span className="learn-menu-item-title">{item.label}</span>
                        <span className="learn-menu-item-desc">{item.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default LearnMenu;
