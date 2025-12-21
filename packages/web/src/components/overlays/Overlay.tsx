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

import React, { useRef, useEffect, useCallback, useState, type ReactNode, type CSSProperties } from 'react';
import { useOverlay, useOverlayZIndex, type OverlayId } from './OverlayProvider';
import { BottomSheet } from '../mobile/BottomSheet';
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
} from '../ui';

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

  const overlayIsOpen = isOpen(id);
  const overlayStackItem = stack.find((item) => item.id === id);
  const closeOnEscape = overlayStackItem?.config.closeOnEscape ?? true;
  const closeOnBackdrop = overlayStackItem?.config.closeOnBackdrop ?? true;
  // Use context-provided mobile detection for consistency
  const effectivePosition: OverlayPosition = isMobile && position === 'center' ? 'bottom' : position;
  const shouldUseBottomSheet = isMobile && effectivePosition === 'bottom';
  const overlayBorderRadius = shouldUseBottomSheet ? '16px 16px 0 0' : '8px';
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

  // Focus trap - must be called unconditionally before any early return
  useEffect(() => {
    if (!overlayIsOpen) return;

    const overlay = overlayRef.current;
    if (!overlay) return;

    // Focus the overlay on mount
    previousFocus.current = (document.activeElement as HTMLElement) ?? null;
    overlay.focus();

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

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!closeOnEscape) return;
      e.stopPropagation();
      handleClose();
    };

    overlay.addEventListener('keydown', handleEscape);
    if (focusableElements.length > 0) {
      overlay.addEventListener('keydown', handleTab);
    }

    return () => {
      overlay.removeEventListener('keydown', handleEscape);
      if (focusableElements.length > 0) {
        overlay.removeEventListener('keydown', handleTab);
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const shouldRestoreFocus =
        !activeElement ||
        activeElement === document.body ||
        activeElement === document.documentElement ||
        overlay.contains(activeElement);

      if (shouldRestoreFocus && previousFocus.current && typeof previousFocus.current.focus === 'function') {
        previousFocus.current.focus();
      }
    };
  }, [overlayIsOpen, handleClose, closeOnEscape]);

  // Don't render if not open - AFTER all hooks
  if (!overlayIsOpen) {
    return null;
  }

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
    padding: shouldUseBottomSheet ? 0 : isMobile ? '1rem' : effectivePosition === 'center' ? '2rem' : 0,
    zIndex,
    cursor: showBackdrop && closeOnBackdrop && isBackdropHovered ? 'pointer' : 'default',
    transition: showBackdrop ? 'background-color var(--duration-fast) var(--ease-out)' : undefined,
  };

  const overlayStyle: CSSProperties = {
    width: shouldUseBottomSheet ? '100%' : SIZE_WIDTHS[size],
    maxWidth: shouldUseBottomSheet ? '100%' : '95vw',
    maxHeight: shouldUseBottomSheet ? '85dvh' : SIZE_MAX_HEIGHTS[size],
    backgroundColor: 'var(--color-background)',
    border: '2px solid var(--color-border-focus)',
    borderRadius: overlayBorderRadius,
    boxShadow: '0 0 20px var(--color-shadow), 0 0 60px var(--color-shadow)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    outline: 'none',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    borderBottom: '1px solid var(--color-border-light)',
  };

  const titleStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  };

  const contentStyle: CSSProperties = {
    flex: 1,
    overflow: 'auto',
    padding: '1rem',
    paddingBottom: shouldUseBottomSheet ? 'calc(1rem + env(safe-area-inset-bottom))' : '1rem',
  };

  const footerStyle: CSSProperties = {
    padding: '0.75rem 1rem',
    borderTop: '1px solid var(--color-border-light)',
    paddingBottom: shouldUseBottomSheet ? 'calc(0.75rem + env(safe-area-inset-bottom))' : '0.75rem',
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
        initialSnapPoint={size === 'sm' ? 'half' : 'full'}
        minHeight={size === 'sm' ? 30 : 50}
        maxHeight={size === 'full' ? 95 : 90}
      >
        <div className={`overlay overlay-${id} ${className}`}>
          {children}
        </div>
      </BottomSheet>
    );
  }

  // Desktop: standard modal overlay
  return (
    <div
      style={backdropStyle}
      onClick={handleBackdropClick}
      onMouseMove={handleBackdropMouseMove}
      onMouseLeave={handleBackdropMouseLeave}
    >
      <div
        ref={overlayRef}
        style={overlayStyle}
        className={`overlay overlay-${id} ${className}`}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`overlay-title-${id}`}
      >
        {/* Header */}
        <div style={headerStyle}>
          <div style={titleStyle}>
            <span
              aria-hidden="true"
              style={{ color: 'var(--color-primary)', fontSize: '1.1rem', display: 'inline-flex', alignItems: 'center' }}
            >
              {resolvedIcon}
            </span>
            <span
              id={`overlay-title-${id}`}
              style={{ color: 'var(--color-primary)', fontWeight: 'bold', fontSize: '1rem' }}
            >
              {title}
            </span>
            {hotkey && (
              <span
                style={{
                  color: 'var(--color-accent)',
                  fontSize: '0.85rem',
                  padding: '0.1rem 0.4rem',
                  backgroundColor: 'var(--color-background-alt)',
                  borderRadius: '4px',
                }}
              >
                [{hotkey}]
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
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
                borderRadius: '8px',
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
      </div>
    </div>
  );
}

export default Overlay;
