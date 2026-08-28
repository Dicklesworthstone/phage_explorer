/**
 * Overlay - Base Overlay Component
 *
 * Provides the visual shell for all overlays with:
 * - Themed styling matching TUI design
 * - Focus trapping
 * - Backdrop click handling
 * - Keyboard support
 * - Animation support
 */

import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { useOverlay, useOverlayZIndex, type OverlayId } from './OverlayProvider';
import { BottomSheet } from '../mobile/BottomSheet';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { detectCoarsePointerDevice, getEffectiveScanlines, useWebPreferences } from '../../store/createWebStore';
import {
  IconAlertTriangle,
  IconAperture,
  IconArrowRight,
  IconBookmark,
  IconCube,
  IconDna,
  IconDiff,
  IconFlask,
  IconImage,
  IconKeyboard,
  IconLearn,
  IconLayers,
  IconMagnet,
  IconRepeat,
  IconSearch,
  IconSettings,
  IconShield,
  IconTarget,
  IconTrendingUp,
  IconUsers,
  IconX,
} from '../ui/icons';

export type OverlaySize = 'sm' | 'md' | 'lg' | 'xl' | 'full';
export type OverlayPosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

interface OverlayProps {
  id: OverlayId;
  title: string;
  icon?: ReactNode;
  hotkey?: string;
  size?: OverlaySize;
  position?: OverlayPosition;
  showBackdrop?: boolean;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

const SIZE_WIDTHS: Record<OverlaySize, string> = {
  sm: '400px',
  md: '600px',
  lg: '800px',
  xl: '1000px',
  full: '95vw',
};

const SIZE_MAX_HEIGHTS: Record<OverlaySize, string> = {
  sm: '400px',
  md: '600px',
  lg: '80vh',
  xl: '85vh',
  full: '95vh',
};

const OVERLAY_ICON_SIZE = 18;

const OVERLAY_HEADER_ICONS: Partial<Record<OverlayId, React.ReactNode>> = {
  help: <IconKeyboard size={OVERLAY_ICON_SIZE} />,
  search: <IconSearch size={OVERLAY_ICON_SIZE} />,
  goto: <IconArrowRight size={OVERLAY_ICON_SIZE} />,
  settings: <IconSettings size={OVERLAY_ICON_SIZE} />,
  aaKey: <IconDna size={OVERLAY_ICON_SIZE} />,
  aaLegend: <IconBookmark size={OVERLAY_ICON_SIZE} />,
  comparison: <IconDiff size={OVERLAY_ICON_SIZE} />,
  analysisMenu: <IconFlask size={OVERLAY_ICON_SIZE} />,
  simulationHub: <IconFlask size={OVERLAY_ICON_SIZE} />,
  simulationView: <IconFlask size={OVERLAY_ICON_SIZE} />,
  complexity: <IconCube size={OVERLAY_ICON_SIZE} />,
  gcSkew: <IconTrendingUp size={OVERLAY_ICON_SIZE} />,
  bendability: <IconAperture size={OVERLAY_ICON_SIZE} />,
  promoter: <IconTarget size={OVERLAY_ICON_SIZE} />,
  repeats: <IconRepeat size={OVERLAY_ICON_SIZE} />,
  transcriptionFlow: <IconFlask size={OVERLAY_ICON_SIZE} />,
  pressure: <IconMagnet size={OVERLAY_ICON_SIZE} />,
  selectionPressure: <IconTrendingUp size={OVERLAY_ICON_SIZE} />,
  modules: <IconLayers size={OVERLAY_ICON_SIZE} />,
  hgt: <IconLayers size={OVERLAY_ICON_SIZE} />,
  kmerAnomaly: <IconFlask size={OVERLAY_ICON_SIZE} />,
  anomaly: <IconAlertTriangle size={OVERLAY_ICON_SIZE} />,
  structureConstraint: <IconCube size={OVERLAY_ICON_SIZE} />,
  gel: <IconAperture size={OVERLAY_ICON_SIZE} />,
  nonBDNA: <IconDna size={OVERLAY_ICON_SIZE} />,
  foldQuickview: <IconAperture size={OVERLAY_ICON_SIZE} />,
  commandPalette: <IconKeyboard size={OVERLAY_ICON_SIZE} />,
  hilbert: <IconAperture size={OVERLAY_ICON_SIZE} />,
  phasePortrait: <IconAperture size={OVERLAY_ICON_SIZE} />,
  biasDecomposition: <IconTrendingUp size={OVERLAY_ICON_SIZE} />,
  crispr: <IconDna size={OVERLAY_ICON_SIZE} />,
  synteny: <IconDiff size={OVERLAY_ICON_SIZE} />,
  dotPlot: <IconDiff size={OVERLAY_ICON_SIZE} />,
  tropism: <IconTarget size={OVERLAY_ICON_SIZE} />,
  cgr: <IconDna size={OVERLAY_ICON_SIZE} />,
  stability: <IconShield size={OVERLAY_ICON_SIZE} />,
  welcome: <IconDna size={OVERLAY_ICON_SIZE} />,
  collaboration: <IconUsers size={OVERLAY_ICON_SIZE} />,
  tour: <IconLearn size={OVERLAY_ICON_SIZE} />,
  genomicSignaturePCA: <IconTrendingUp size={OVERLAY_ICON_SIZE} />,
  codonBias: <IconTrendingUp size={OVERLAY_ICON_SIZE} />,
  proteinDomains: <IconLayers size={OVERLAY_ICON_SIZE} />,
  amgPathway: <IconFlask size={OVERLAY_ICON_SIZE} />,
  codonAdaptation: <IconTrendingUp size={OVERLAY_ICON_SIZE} />,
  defenseArmsRace: <IconShield size={OVERLAY_ICON_SIZE} />,
  illustration: <IconImage size={OVERLAY_ICON_SIZE} />,
  logo: <IconBookmark size={OVERLAY_ICON_SIZE} />,
};

const PREVIOUS_FOCUS_BY_OVERLAY_ID = new Map<OverlayId, HTMLElement>();

export function Overlay({
  id,
  title,
  icon = '◉',
  hotkey,
  size = 'md',
  position = 'center',
  showBackdrop = true,
  onClose,
  children,
  footer,
  className = '',
}: OverlayProps): React.ReactElement | null {
  const { isOpen, close, stack, isMobile } = useOverlay();
  const zIndex = useOverlayZIndex(id);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [isBackdropHovered, setIsBackdropHovered] = useState(false);
  const reducedMotion = useReducedMotion();
  const scanlinesEnabled = useWebPreferences((s) => s.scanlines);
  const fxSafeMode = useWebPreferences((s) => s.fxSafeMode);
  const coarsePointer = useMemo(() => detectCoarsePointerDevice(), []);
  const showScanlines = getEffectiveScanlines(scanlinesEnabled, { reducedMotion, coarsePointer, safeMode: fxSafeMode });

  const overlayIsOpen = isOpen(id);
  // Exit animation state machine: when overlayIsOpen goes false, we briefly keep
  // the component mounted with exit CSS classes before removing from DOM.
  const [isExiting, setIsExiting] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasOpenRef = useRef(overlayIsOpen);

  // Track the *latest* open state so effect cleanups can distinguish between:
  // - overlay actually closing (restore focus)
  // - overlay swapping mounts (e.g. Suspense fallback -> loaded overlay) while still open
  const overlayIsOpenLatestRef = useRef(overlayIsOpen);
  const overlayStackItem = stack.find((item) => item.id === id);
  const closeOnBackdrop = overlayStackItem?.config.closeOnBackdrop ?? true;
  // Use context-provided mobile detection for consistency
  const effectivePosition: OverlayPosition = isMobile && position === 'center' ? 'bottom' : position;
  const shouldUseBottomSheet = isMobile && effectivePosition === 'bottom';

  useEffect(() => {
    overlayIsOpenLatestRef.current = overlayIsOpen;
    if (wasOpenRef.current && !overlayIsOpen && !shouldUseBottomSheet) {
      setIsExiting(true);
      const duration = reducedMotion ? 0 : 200;
      exitTimerRef.current = setTimeout(() => {
        setIsExiting(false);
        exitTimerRef.current = null;
      }, duration);
    }
    wasOpenRef.current = overlayIsOpen;
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [overlayIsOpen, reducedMotion, shouldUseBottomSheet]);
  const overlayBorderRadius = shouldUseBottomSheet ? 'var(--overlay-border-radius-mobile)' : 'var(--overlay-border-radius)';
  const resolvedIcon = typeof icon === 'string' ? OVERLAY_HEADER_ICONS[id] ?? icon : icon;

  // Handle close - use useCallback to avoid stale closures
  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
    }
    close(id);
  }, [onClose, close, id]);

  // Handle backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (!showBackdrop) return;
    if (!closeOnBackdrop) return;
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }, [closeOnBackdrop, handleClose, showBackdrop]);

  const handleBackdropMouseMove = useCallback((e: React.MouseEvent) => {
    if (!showBackdrop) return;
    if (!closeOnBackdrop) return;
    const hoveringBackdrop = e.target === e.currentTarget;
    setIsBackdropHovered((prev) => (prev === hoveringBackdrop ? prev : hoveringBackdrop));
  }, [closeOnBackdrop, showBackdrop]);

  const handleBackdropMouseLeave = useCallback(() => {
    setIsBackdropHovered(false);
  }, []);

  // Clean up focus tracking on unmount to prevent memory leaks
  // Only delete if the overlay is not open (to preserve Suspense swap behavior)
  useEffect(() => {
    const overlayId = id;
    return () => {
      // Only clean up if the overlay is actually closed.
      // If still "open" during unmount (e.g., Suspense swap), preserve the entry
      // so the replacement component can restore focus correctly.
      if (!overlayIsOpenLatestRef.current) {
        PREVIOUS_FOCUS_BY_OVERLAY_ID.delete(overlayId);
      }
    };
  }, [id]);

  // Focus trap - must be called unconditionally before any early return
  useLayoutEffect(() => {
    if (!overlayIsOpen) return;

    const overlay = overlayRef.current;
    if (!overlay) return;

    // Focus the overlay on mount
    const activeElement = document.activeElement as HTMLElement | null;
    // Preserve the original focus target across Suspense swaps (fallback -> loaded overlay),
    // so closing restores focus to what the user had before opening the overlay.
    if (!PREVIOUS_FOCUS_BY_OVERLAY_ID.has(id) && activeElement) {
      PREVIOUS_FOCUS_BY_OVERLAY_ID.set(id, activeElement);
    }
    previousFocus.current = PREVIOUS_FOCUS_BY_OVERLAY_ID.get(id) ?? activeElement;

    // Prefer focusing an explicitly marked element (e.g. command palette input),
    // otherwise focus the first focusable element, else the overlay container.
    const preferredFocus =
      overlay.querySelector<HTMLElement>('[data-overlay-autofocus]') ??
      overlay.querySelector<HTMLElement>('[autofocus]') ??
      overlay.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');

    if (preferredFocus && typeof preferredFocus.focus === 'function') {
      preferredFocus.focus();
    } else {
      overlay.focus();
    }

    // Get all focusable elements
    const focusableElements = overlay.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (!firstElement || !lastElement) return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };
    if (focusableElements.length > 0) {
      overlay.addEventListener('keydown', handleTab);
    }

    return () => {
      if (focusableElements.length > 0) {
        overlay.removeEventListener('keydown', handleTab);
      }

      // If the overlay is still open, do not restore focus or clear the stored focus target.
      // This happens when the overlay remounts while open (e.g. Suspense fallback replaced by
      // the loaded overlay).
      if (overlayIsOpenLatestRef.current) {
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const shouldRestoreFocus =
        !activeElement ||
        activeElement === document.body ||
        activeElement === document.documentElement ||
        overlay.contains(activeElement);

      const stored = PREVIOUS_FOCUS_BY_OVERLAY_ID.get(id) ?? previousFocus.current;
      PREVIOUS_FOCUS_BY_OVERLAY_ID.delete(id);

      const canFocus = stored && typeof stored.focus === 'function' && (stored as HTMLElement).isConnected;
      if (shouldRestoreFocus && canFocus) {
        stored.focus();
      }
    };
  }, [overlayIsOpen, id]);

  // Don't render if not open AND not exiting - AFTER all hooks
  if (!overlayIsOpen && !isExiting) {
    return null;
  }

  // Determine animation class: enter on open, exit on exiting
  const backdropAnimClass = isExiting ? 'overlay-backdrop-exit' : 'overlay-backdrop-enter';
  const panelAnimClass = isExiting ? 'overlay-panel-exit' : 'overlay-panel-enter';

  // Styles
  const backdropStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: showBackdrop
      ? isBackdropHovered
        ? 'rgba(0, 0, 0, 0.78)'
        : 'rgba(0, 0, 0, 0.7)'
      : 'transparent',
    display: 'flex',
    justifyContent: effectivePosition === 'left' ? 'flex-start' : effectivePosition === 'right' ? 'flex-end' : 'center',
    alignItems: effectivePosition === 'top' ? 'flex-start' : effectivePosition === 'bottom' ? 'flex-end' : 'center',
    padding: shouldUseBottomSheet
      ? 0
      : isMobile
        ? 'calc(var(--space-4) + env(safe-area-inset-top, 0px)) calc(var(--space-4) + env(safe-area-inset-right, 0px)) calc(var(--space-4) + env(safe-area-inset-bottom, 0px)) calc(var(--space-4) + env(safe-area-inset-left, 0px))'
        : effectivePosition === 'center'
          ? 'var(--space-8)'
          : 0,
    zIndex,
    cursor: showBackdrop && closeOnBackdrop && isBackdropHovered ? 'pointer' : 'default',
    pointerEvents: isExiting ? 'none' : undefined,
  };

  const overlayStyle: CSSProperties = {
    width: shouldUseBottomSheet ? '100%' : SIZE_WIDTHS[size],
    maxWidth: shouldUseBottomSheet ? '100%' : '95vw',
    maxHeight: shouldUseBottomSheet ? '85dvh' : SIZE_MAX_HEIGHTS[size],
    backgroundColor: 'var(--color-background-elevated)',
    border: 'var(--overlay-border)',
    borderRadius: overlayBorderRadius,
    boxShadow: 'var(--overlay-shadow)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    outline: 'none',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--overlay-header-padding-y) var(--overlay-header-padding-x)',
    borderBottom: 'var(--overlay-divider-border)',
    background: 'var(--color-background-alt)',
  };

  const titleStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--overlay-title-gap)',
  };

  const contentStyle: CSSProperties = {
    flex: 1,
    overflow: 'auto',
    padding: 'var(--overlay-content-padding)',
    paddingBottom: shouldUseBottomSheet
      ? 'calc(var(--overlay-content-padding) + env(safe-area-inset-bottom, 0px))'
      : 'var(--overlay-content-padding)',
  };

  const footerStyle: CSSProperties = {
    padding: 'var(--overlay-footer-padding-y) var(--overlay-footer-padding-x)',
    borderTop: 'var(--overlay-divider-border)',
    paddingBottom: shouldUseBottomSheet
      ? 'calc(var(--overlay-footer-padding-y) + env(safe-area-inset-bottom, 0px))'
      : 'var(--overlay-footer-padding-y)',
  };

  // Mobile: use BottomSheet for native gesture physics
  if (shouldUseBottomSheet) {
    return (
      <BottomSheet
        isOpen={overlayIsOpen}
        onClose={handleClose}
        title={title}
        footer={footer}
        showHandle={true}
        closeOnBackdropTap={closeOnBackdrop}
        swipeToDismiss={true}
        initialSnapPoint="full"
        minHeight={size === 'sm' ? 40 : 60}
        maxHeight={94}
      >
        <div className={`overlay overlay-${id} ${className}`} data-testid={`overlay-${id}`}>
          {children}
        </div>
      </BottomSheet>
    );
  }

  // Desktop: standard modal overlay
  return (
    <div
      style={backdropStyle}
      className={backdropAnimClass}
      onClick={isExiting ? undefined : handleBackdropClick}
      onMouseMove={isExiting ? undefined : handleBackdropMouseMove}
      onMouseLeave={isExiting ? undefined : handleBackdropMouseLeave}
    >
      <div
        ref={overlayRef}
        style={overlayStyle}
        className={`overlay overlay-${id} ${panelAnimClass} ${className}`}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`overlay-title-${id}`}
        data-testid={`overlay-${id}`}
      >
        {/* Header */}
        <div style={headerStyle}>
          <div style={titleStyle}>
            <span
              aria-hidden="true"
              style={{
                color: 'var(--color-primary)',
                fontSize: 'var(--text-lg)',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {resolvedIcon}
            </span>
            <span
              id={`overlay-title-${id}`}
              style={{
                color: 'var(--color-text)',
                fontWeight: 'var(--overlay-title-weight)',
                fontSize: 'var(--overlay-title-size)',
                lineHeight: 'var(--overlay-title-line-height)',
                letterSpacing: 'var(--overlay-title-tracking)',
              }}
            >
              {title}
            </span>
            {hotkey && (
              <span
                style={{
                  color: 'var(--color-accent)',
                  fontSize: 'var(--hotkey-font-size)',
                  padding: 'var(--hotkey-padding-y) var(--hotkey-padding-x)',
                  backgroundColor: 'var(--color-background-alt)',
                  borderRadius: 'var(--hotkey-radius)',
                }}
              >
                [{hotkey}]
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chrome-gap-lg)' }}>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--hotkey-font-size)' }}>
              ESC{hotkey ? ` or ${hotkey}` : ''} to close
            </span>
            <button
              onClick={handleClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-dim)',
                cursor: 'pointer',
                // Min 44x44 touch target for accessibility (WCAG 2.5.5)
                minWidth: '44px',
                minHeight: '44px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius-lg)',
                transition: 'background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--color-background-hover)';
                e.currentTarget.style.color = 'var(--color-text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'none';
                e.currentTarget.style.color = 'var(--color-text-dim)';
              }}
              aria-label="Close overlay"
              data-testid={`overlay-${id}-close`}
            >
              <IconX size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={contentStyle}>
          {children}
        </div>

        {/* Footer (optional) */}
        {footer && (
          <div style={footerStyle}>
            {footer}
          </div>
        )}

        {/* Scanline effect (subtle) */}
        {showScanlines && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              pointerEvents: 'none',
              background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)',
              borderRadius: overlayBorderRadius,
            }}
          />
        )}
      </div>
    </div>
  );
}

export default Overlay;
