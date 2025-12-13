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
import { useTheme } from '../../hooks/useTheme';
import { useOverlay, useOverlayZIndex, type OverlayId } from './OverlayProvider';
import {
  IconAlertTriangle,
  IconAperture,
  IconBookmark,
  IconCube,
  IconDna,
  IconFlask,
  IconKeyboard,
  IconLayers,
  IconMagnet,
  IconRepeat,
  IconSearch,
  IconShield,
  IconTarget,
  IconTrendingUp,
  IconUsers,
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
  aaKey: <IconDna size={OVERLAY_ICON_SIZE} />,
  aaLegend: <IconBookmark size={OVERLAY_ICON_SIZE} />,
  analysisMenu: <IconFlask size={OVERLAY_ICON_SIZE} />,
  simulationHub: <IconFlask size={OVERLAY_ICON_SIZE} />,
  complexity: <IconCube size={OVERLAY_ICON_SIZE} />,
  gcSkew: <IconTrendingUp size={OVERLAY_ICON_SIZE} />,
  bendability: <IconAperture size={OVERLAY_ICON_SIZE} />,
  promoter: <IconTarget size={OVERLAY_ICON_SIZE} />,
  repeats: <IconRepeat size={OVERLAY_ICON_SIZE} />,
  transcriptionFlow: <IconFlask size={OVERLAY_ICON_SIZE} />,
  pressure: <IconMagnet size={OVERLAY_ICON_SIZE} />,
  modules: <IconLayers size={OVERLAY_ICON_SIZE} />,
  kmerAnomaly: <IconFlask size={OVERLAY_ICON_SIZE} />,
  anomaly: <IconAlertTriangle size={OVERLAY_ICON_SIZE} />,
  hilbert: <IconAperture size={OVERLAY_ICON_SIZE} />,
  crispr: <IconDna size={OVERLAY_ICON_SIZE} />,
  tropism: <IconTarget size={OVERLAY_ICON_SIZE} />,
  cgr: <IconDna size={OVERLAY_ICON_SIZE} />,
  stability: <IconShield size={OVERLAY_ICON_SIZE} />,
  welcome: <IconDna size={OVERLAY_ICON_SIZE} />,
  collaboration: <IconUsers size={OVERLAY_ICON_SIZE} />,
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
  const { isOpen, close, stack } = useOverlay();
  const zIndex = useOverlayZIndex(id);
  const { theme } = useTheme();
  const colors = theme.colors;
  const overlayRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [isBackdropHovered, setIsBackdropHovered] = useState(false);

  const overlayIsOpen = isOpen(id);
  const overlayStackItem = stack.find((item) => item.id === id);
  const closeOnEscape = overlayStackItem?.config.closeOnEscape ?? true;
  const closeOnBackdrop = overlayStackItem?.config.closeOnBackdrop ?? true;
  const isPhone = typeof window !== 'undefined' && (window.matchMedia?.('(max-width: 640px)')?.matches ?? false);
  const effectivePosition: OverlayPosition = isPhone && position === 'center' ? 'bottom' : position;
  const isBottomSheet = isPhone && effectivePosition === 'bottom';
  const overlayBorderRadius = isBottomSheet ? '16px 16px 0 0' : '8px';
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
    padding: isBottomSheet ? 0 : isPhone ? '1rem' : effectivePosition === 'center' ? '2rem' : 0,
    zIndex,
    cursor: showBackdrop && closeOnBackdrop && isBackdropHovered ? 'pointer' : 'default',
    transition: showBackdrop ? 'background-color var(--duration-fast) var(--ease-out)' : undefined,
  };

  const overlayStyle: CSSProperties = {
    width: isBottomSheet ? '100%' : SIZE_WIDTHS[size],
    maxWidth: isBottomSheet ? '100%' : '95vw',
    maxHeight: isBottomSheet ? '85dvh' : SIZE_MAX_HEIGHTS[size],
    backgroundColor: colors.background,
    border: `2px solid ${colors.borderFocus}`,
    borderRadius: overlayBorderRadius,
    boxShadow: `0 0 20px ${colors.shadow}, 0 0 60px ${colors.shadow}`,
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
    borderBottom: `1px solid ${colors.borderLight}`,
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
    paddingBottom: isBottomSheet ? 'calc(1rem + env(safe-area-inset-bottom))' : '1rem',
  };

  const footerStyle: CSSProperties = {
    padding: '0.75rem 1rem',
    borderTop: `1px solid ${colors.borderLight}`,
    paddingBottom: isBottomSheet ? 'calc(0.75rem + env(safe-area-inset-bottom))' : '0.75rem',
  };

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
              style={{ color: colors.primary, fontSize: '1.1rem', display: 'inline-flex', alignItems: 'center' }}
            >
              {resolvedIcon}
            </span>
            <span
              id={`overlay-title-${id}`}
              style={{ color: colors.primary, fontWeight: 'bold', fontSize: '1rem' }}
            >
              {title}
            </span>
            {hotkey && (
              <span
                style={{
                  color: colors.accent,
                  fontSize: '0.85rem',
                  padding: '0.1rem 0.4rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                }}
              >
                [{hotkey}]
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span style={{ color: colors.textMuted, fontSize: '0.85rem' }}>
              ESC{hotkey ? ` or ${hotkey}` : ''} to close
            </span>
            <button
              onClick={handleClose}
              style={{
                background: 'none',
                border: 'none',
                color: colors.textDim,
                cursor: 'pointer',
                fontSize: '1.2rem',
                padding: '0.25rem',
                lineHeight: 1,
              }}
              aria-label="Close overlay"
            >
              ×
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
