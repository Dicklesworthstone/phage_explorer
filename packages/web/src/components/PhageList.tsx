import React, { useRef, useEffect } from 'react';
import type { PhageSummary } from '@phage-explorer/core';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { PhageListItemSkeleton } from './ui/Skeleton';

interface PhageListProps {
  phages: PhageSummary[];
  currentIndex: number;
  onSelect: (index: number) => void;
  onClose?: () => void;
  mobileListOpen?: boolean;
  hasSelection?: boolean;
  isMobile?: boolean;
  loading?: boolean;
}

export function PhageList({
  phages,
  currentIndex,
  onSelect,
  onClose,
  mobileListOpen,
  hasSelection,
  isMobile,
  loading = false,
}: PhageListProps): React.ReactElement {
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();

  // Scroll active item into view
  useEffect(() => {
    const node = activeItemRef.current;
    if (!node) return;
    // Don't auto-scroll if user is interacting with list, but here we just do it on index change
    node.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [currentIndex, reducedMotion]);

  if (loading) {
    return (
      <div className={`column column--list ${isMobile && hasSelection && mobileListOpen ? 'mobile-drawer' : ''}`}>
        <div className="panel-header">
          <h2>Phages</h2>
        </div>
        <div className="list">
          <PhageListItemSkeleton count={8} />
        </div>
      </div>
    );
  }

  return (
    <div className={`column column--list ${isMobile && hasSelection && mobileListOpen ? 'mobile-drawer' : ''}`}>
      <div className="panel-header">
        <h2>Phages</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="badge">{phages.length}</span>
          {isMobile && hasSelection && onClose && (
            <button
              className="btn btn-sm"
              onClick={onClose}
              type="button"
              aria-label="Close phage list"
            >
              Close
            </button>
          )}
        </div>
      </div>
      <ul className="list" role="list" data-testid="phage-list">
        {phages.map((phage, idx) => {
          const isActive = idx === currentIndex;
          const isLytic = phage.lifecycle === 'lytic';

          return (
            <li key={phage.id} role="listitem">
              <button
                ref={isActive ? activeItemRef : undefined}
                className={`list-item ${isActive ? 'active' : ''}`}
                onClick={() => onSelect(idx)}
                type="button"
                aria-current={isActive ? 'true' : undefined}
                data-testid={isActive ? 'phage-list-item-selected' : 'phage-list-item'}
              >
                <div className="list-item-main">
                  <div className="list-title">{phage.name}</div>
                  <div className="list-subtitle text-dim">
                    {phage.host ?? 'Unknown host'} · <span className="font-data">{(phage.genomeLength ?? 0).toLocaleString()} bp</span>
                  </div>
                </div>
                <div className="list-item-meta">
                  {phage.lifecycle && (
                    <span 
                      className={`badge badge-tiny ${isLytic ? 'badge-warning' : 'badge-info'}`}
                      title={isLytic ? 'Lytic lifecycle' : 'Lysogenic lifecycle'}
                    >
                      {isLytic ? '⚡' : '∞'} {phage.lifecycle}
                    </span>
                  )}
                  {phage.gcContent !== null && (
                    <span className="meta-gc text-dim" title="GC Content">
                      {phage.gcContent.toFixed(1)}% GC
                    </span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
        {phages.length === 0 && (
          <div className="text-dim" style={{ padding: '2rem', textAlign: 'center' }}>
            No phages found.
          </div>
        )}
      </ul>
    </div>
  );
}
