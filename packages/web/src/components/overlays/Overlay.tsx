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

import React, { useRef, useEffect, type ReactNode, type CSSProperties } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { useOverlay, useOverlayZIndex, type OverlayId } from './OverlayProvider';

export type OverlaySize = 'sm' | 'md' | 'lg' | 'xl' | 'full';
export type OverlayPosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

interface OverlayProps {
  id: OverlayId;
  title: string;
  icon?: string;
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
  const { isOpen, close } = useOverlay();
  const zIndex = useOverlayZIndex(id);
  const { theme } = useTheme();
  const colors = theme.colors;
  const overlayRef = useRef<HTMLDivElement>(null);

  // Don't render if not open
  if (!isOpen(id)) {
    return null;
  }

  // Handle close
  const handleClose = () => {
    if (onClose) {
      onClose();
    }
    close(id);
  };

  // Handle backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  // Focus trap
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    // Focus the overlay on mount
    overlay.focus();

    // Get all focusable elements
    const focusableElements = overlay.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

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

    overlay.addEventListener('keydown', handleTab);
    return () => overlay.removeEventListener('keydown', handleTab);
  }, []);

  // Styles
  const backdropStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: showBackdrop ? 'rgba(0, 0, 0, 0.7)' : 'transparent',
    display: 'flex',
    justifyContent: position === 'left' ? 'flex-start' : position === 'right' ? 'flex-end' : 'center',
    alignItems: position === 'top' ? 'flex-start' : position === 'bottom' ? 'flex-end' : 'center',
    padding: position === 'center' ? '2rem' : 0,
    zIndex,
  };

  const overlayStyle: CSSProperties = {
    width: SIZE_WIDTHS[size],
    maxWidth: '95vw',
    maxHeight: SIZE_MAX_HEIGHTS[size],
    backgroundColor: colors.background,
    border: `2px solid ${colors.borderFocus}`,
    borderRadius: '8px',
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
  };

  const footerStyle: CSSProperties = {
    padding: '0.75rem 1rem',
    borderTop: `1px solid ${colors.borderLight}`,
  };

  return (
    <div style={backdropStyle} onClick={handleBackdropClick}>
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
            <span style={{ color: colors.primary, fontSize: '1.1rem' }}>{icon}</span>
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
            borderRadius: '8px',
          }}
        />
      </div>
    </div>
  );
}

export default Overlay;
