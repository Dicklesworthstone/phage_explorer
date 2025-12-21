import React, { useRef, useEffect } from 'react';
import type { PhageSummary } from '@phage-explorer/core';
import { useReducedMotion } from '../hooks/useReducedMotion';

interface PhageListProps {
  phages: PhageSummary[];
  currentIndex: number;
  onSelect: (index: number) => void;
  onClose?: () => void;
  mobileListOpen?: boolean;
  hasSelection?: boolean;
  isMobile?: boolean;
}

export function PhageList({
  phages,
  currentIndex,
  onSelect,
  onClose,
  mobileListOpen,
  hasSelection,
  isMobile,
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

  return (
    <div className={`column column--list ${isMobile && hasSelection && mobileListOpen ? 'mobile-drawer' : ''}`}>
      <div className="panel-header">
        <h3>Phages</h3>
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
      <div className="list">
        {phages.map((phage, idx) => {
          const isActive = idx === currentIndex;
          return (
            <button
              key={phage.id}
              ref={isActive ? activeItemRef : undefined}
              className={`list-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelect(idx)}
              type="button"
            >
              <div className="list-item-main">
                <div className="list-title">{phage.name}</div>
                <div className="list-subtitle text-dim">
                  {phage.host ?? 'Unknown host'} · {(phage.genomeLength ?? 0).toLocaleString()} bp
                </div>
              </div>
              <div className="list-item-meta">
                {phage.lifecycle && (
                  <span className={`badge badge-tiny ${phage.lifecycle === 'lytic' ? 'badge-warning' : 'badge-info'}`}>
                    {phage.lifecycle}
                  </span>
                )}
                {phage.gcContent != null && (
                  <span className="meta-gc text-dim">{phage.gcContent.toFixed(1)}%</span>
                )}
              </div>
            </button>
          );
        })}
        {phages.length === 0 && (
          <div className="text-dim" style={{ padding: '1rem' }}>
            Phage list will appear once the database loads.
          </div>
        )}
      </div>
    </div>
  );
}
