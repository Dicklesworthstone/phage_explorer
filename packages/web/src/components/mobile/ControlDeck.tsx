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
 * iOS/Android-style navigation with 5 direct action buttons.
 * Features:
 * - Haptic feedback on tap
 * - Visual active state indicator
 * - Accessible labels and states
 *
 * Each tap performs an action immediately (no nested tabs).
 */
export function ControlDeck({ onPrevPhage, onNextPhage }: ControlDeckProps): JSX.Element {
  const viewMode = usePhageStore(s => s.viewMode);
  const toggleViewMode = usePhageStore(s => s.toggleViewMode);
  const show3DModel = usePhageStore(s => s.show3DModel);
  const toggle3DModel = usePhageStore(s => s.toggle3DModel);
  const phages = usePhageStore(s => s.phages);
  const { open } = useOverlay();

  const viewModeLabel = viewMode === 'dna' ? 'DNA' : viewMode === 'aa' ? 'AA' : 'Both';
  const canNavigate = phages.length > 0 && onPrevPhage && onNextPhage;

  // Wrap actions with haptic feedback
  const handleViewMode = useCallback(() => {
    haptics.selection();
    toggleViewMode();
  }, [toggleViewMode]);

  const handle3DToggle = useCallback(() => {
    haptics.medium();
    toggle3DModel();
  }, [toggle3DModel]);

  const handleMore = useCallback(() => {
    haptics.light();
    open('commandPalette');
  }, [open]);

  // Phage navigation handlers - wrap with haptic feedback
  const handlePrevPhage = useCallback(() => {
    if (!onPrevPhage) return;
    haptics.selection();
    onPrevPhage();
  }, [onPrevPhage]);

  const handleNextPhage = useCallback(() => {
    if (!onNextPhage) return;
    haptics.selection();
    onNextPhage();
  }, [onNextPhage]);

  return (
    <nav className="control-deck" aria-label="Mobile navigation">
      {/* Previous Phage */}
      <button
        type="button"
        className="tab-btn"
        onClick={handlePrevPhage}
        aria-label="Previous phage"
        disabled={!canNavigate}
      >
        <span className="tab-icon">
          <IconChevronLeft size={22} />
        </span>
        <span className="tab-label">Prev</span>
      </button>

      {/* View Mode Toggle */}
      <button
        type="button"
        className="tab-btn"
        onClick={handleViewMode}
        aria-label={`View mode: ${viewModeLabel}. Tap to cycle.`}
      >
        <span className="tab-icon">
          <IconLayers size={20} />
        </span>
        <span className="tab-label">{viewModeLabel}</span>
      </button>

      {/* 3D Toggle */}
      <button
        type="button"
        className={`tab-btn ${show3DModel ? 'active' : ''}`}
        onClick={handle3DToggle}
        aria-label={`3D model: ${show3DModel ? 'on' : 'off'}`}
        aria-pressed={show3DModel}
      >
        <span className="tab-icon">
          <IconCube size={20} />
          {show3DModel && <span className="state-badge" aria-hidden="true" />}
        </span>
        <span className="tab-label">3D</span>
      </button>

      {/* Search / More - Opens Command Palette */}
      <button
        type="button"
        className="tab-btn"
        onClick={handleMore}
        aria-label="Menu and search"
      >
        <span className="tab-icon">
          <IconSearch size={20} />
        </span>
        <span className="tab-label">Menu</span>
      </button>

      {/* Next Phage */}
      <button
        type="button"
        className="tab-btn"
        onClick={handleNextPhage}
        aria-label="Next phage"
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
