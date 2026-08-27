import React, { useCallback } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { useOverlay } from '../overlays/OverlayProvider';
import {
  IconChevronLeft,
  IconChevronRight,
  IconCube,
  IconLayers,
  IconSearch,
} from '../ui';
import { haptics } from '../../utils/haptics';

interface ControlDeckProps {
  /** Handler for navigating to previous phage (loads full data) */
  onPrevPhage?: () => void;
  /** Handler for navigating to next phage (loads full data) */
  onNextPhage?: () => void;
}

/**
 * Mobile Bottom Tab Bar
 *
 * iOS/Android-style navigation with five direct actions. Context-dependent
 * controls stay disabled until a phage is ready, while search remains available.
 */
export function ControlDeck({ onPrevPhage, onNextPhage }: ControlDeckProps): React.ReactElement {
  const viewMode = usePhageStore((s) => s.viewMode);
  const toggleViewMode = usePhageStore((s) => s.toggleViewMode);
  const show3DModel = usePhageStore((s) => s.show3DModel);
  const toggle3DModel = usePhageStore((s) => s.toggle3DModel);
  const phages = usePhageStore((s) => s.phages);
  const currentPhage = usePhageStore((s) => s.currentPhage);
  const { open } = useOverlay();

  const viewModeLabelLong = viewMode === 'dna' ? 'DNA' : viewMode === 'aa' ? 'Amino Acids' : 'Dual';
  const viewModeLabelShort = viewMode === 'aa' ? 'AA' : viewModeLabelLong;
  const hasPhage = currentPhage !== null;
  const canNavigate = Boolean(phages.length > 1 && onPrevPhage && onNextPhage);

  const handleViewMode = useCallback(() => {
    if (!hasPhage) return;
    haptics.selection();
    toggleViewMode();
  }, [hasPhage, toggleViewMode]);

  const handle3DToggle = useCallback(() => {
    if (!hasPhage) return;
    haptics.medium();
    toggle3DModel();
  }, [hasPhage, toggle3DModel]);

  const handleSearch = useCallback(() => {
    haptics.light();
    open('search');
  }, [open]);

  const handlePrevPhage = useCallback(() => {
    if (!canNavigate || !onPrevPhage) return;
    haptics.selection();
    onPrevPhage();
  }, [canNavigate, onPrevPhage]);

  const handleNextPhage = useCallback(() => {
    if (!canNavigate || !onNextPhage) return;
    haptics.selection();
    onNextPhage();
  }, [canNavigate, onNextPhage]);

  return (
    <nav className="control-deck" aria-label="Mobile navigation">
      <button
        type="button"
        className="tab-btn"
        onClick={handlePrevPhage}
        aria-label={canNavigate ? 'Previous phage' : 'Previous phage unavailable'}
        disabled={!canNavigate}
      >
        <span className="tab-icon">
          <IconChevronLeft size={22} />
        </span>
        <span className="tab-label">Prev</span>
      </button>

      <button
        type="button"
        className="tab-btn"
        onClick={handleViewMode}
        aria-label={
          hasPhage
            ? `View mode: ${viewModeLabelLong}. Tap to cycle.`
            : 'View mode unavailable until a phage is selected'
        }
        disabled={!hasPhage}
      >
        <span className="tab-icon">
          <IconLayers size={20} />
        </span>
        <span className="tab-label">{viewModeLabelShort}</span>
      </button>

      <button
        type="button"
        className={`tab-btn ${show3DModel && hasPhage ? 'active' : ''}`}
        onClick={handle3DToggle}
        aria-label={
          hasPhage
            ? `3D model: ${show3DModel ? 'on' : 'off'}`
            : '3D model unavailable until a phage is selected'
        }
        aria-pressed={hasPhage ? show3DModel : false}
        disabled={!hasPhage}
      >
        <span className="tab-icon">
          <IconCube size={20} />
          {show3DModel && hasPhage && <span className="state-badge" aria-hidden="true" />}
        </span>
        <span className="tab-label">3D</span>
      </button>

      <button
        type="button"
        className="tab-btn"
        onClick={handleSearch}
        aria-label="Search phages, genes, and tools"
      >
        <span className="tab-icon">
          <IconSearch size={20} />
        </span>
        <span className="tab-label">Search</span>
      </button>

      <button
        type="button"
        className="tab-btn"
        onClick={handleNextPhage}
        aria-label={canNavigate ? 'Next phage' : 'Next phage unavailable'}
        disabled={!canNavigate}
      >
        <span className="tab-icon">
          <IconChevronRight size={22} />
        </span>
        <span className="tab-label">Next</span>
      </button>
    </nav>
  );
}
