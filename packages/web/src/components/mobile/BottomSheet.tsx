import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { haptics } from '../../utils/haptics';

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Optional footer content (e.g., action buttons) */
  footer?: ReactNode;
  /** Whether to show the drag handle (default: true) */
  showHandle?: boolean;
  /** Whether to close on backdrop tap (default: true) */
  closeOnBackdropTap?: boolean;
  /** Whether to enable swipe-to-dismiss (default: true) */
  swipeToDismiss?: boolean;
  /** Minimum height as percentage of viewport (default: 30) */
  minHeight?: number;
  /** Maximum height as percentage of viewport (default: 90) */
  maxHeight?: number;
}

/**
 * BottomSheet - iOS/Android-style modal
 *
 * Features:
 * - Slides up from bottom with spring animation
 * - Swipe down to dismiss
 * - Drag handle for visual affordance
 * - Haptic feedback on open/close
 * - Backdrop blur effect
 * - Safe area padding for notched devices
 *
 * Follows Apple Human Interface Guidelines and Material Design patterns.
 */
export function BottomSheet({
  isOpen,
  onClose,
  title,
  children,
  footer,
  showHandle = true,
  closeOnBackdropTap = true,
  swipeToDismiss = true,
  minHeight = 30,
  maxHeight = 90,
}: BottomSheetProps): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragY, setDragY] = useState(0);
  const startY = useRef(0);
  const startScrollTop = useRef(0);

  // Haptic feedback on open
  useEffect(() => {
    if (isOpen) {
      haptics.medium();
    }
  }, [isOpen]);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        haptics.light();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (closeOnBackdropTap && e.target === e.currentTarget) {
        haptics.light();
        onClose();
      }
    },
    [closeOnBackdropTap, onClose]
  );

  // Swipe to dismiss handlers
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!swipeToDismiss) return;

      // Only allow drag from handle or when content is scrolled to top
      const content = contentRef.current;
      const isHandle = (e.target as HTMLElement).closest('.bottom-sheet__handle');
      const isAtTop = content ? content.scrollTop <= 0 : true;

      if (!isHandle && !isAtTop) return;

      setIsDragging(true);
      startY.current = e.touches[0].clientY;
      startScrollTop.current = content?.scrollTop ?? 0;
      haptics.selection();
    },
    [swipeToDismiss]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging) return;

      const currentY = e.touches[0].clientY;
      const deltaY = currentY - startY.current;

      // Only allow downward drag (positive deltaY)
      if (deltaY > 0) {
        setDragY(deltaY);
        e.preventDefault();
      }
    },
    [isDragging]
  );

  const handleTouchEnd = useCallback(() => {
    if (!isDragging) return;

    setIsDragging(false);

    // Dismiss if dragged more than 25% of container height
    const container = containerRef.current;
    const threshold = container ? container.clientHeight * 0.25 : 100;

    if (dragY > threshold) {
      haptics.medium();
      onClose();
    } else {
      // Snap back
      setDragY(0);
    }
  }, [isDragging, dragY, onClose]);

  // Close button handler
  const handleClose = useCallback(() => {
    haptics.light();
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  const sheetStyle = {
    minHeight: `${minHeight}vh`,
    maxHeight: `${maxHeight}vh`,
    transform: isDragging ? `translateY(${dragY}px)` : undefined,
    transition: isDragging ? 'none' : undefined,
  };

  return createPortal(
    <div
      className={`bottom-sheet ${isOpen ? 'is-open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'bottom-sheet-title' : undefined}
    >
      {/* Backdrop */}
      <div
        className="bottom-sheet__backdrop"
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* Sheet container */}
      <div
        ref={containerRef}
        className="bottom-sheet__container"
        style={sheetStyle}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag handle */}
        {showHandle && (
          <div className="bottom-sheet__handle" aria-hidden="true" />
        )}

        {/* Header */}
        {title && (
          <header className="bottom-sheet__header">
            <h2 id="bottom-sheet-title" className="bottom-sheet__title">
              {title}
            </h2>
            <button
              type="button"
              className="bottom-sheet__close"
              onClick={handleClose}
              aria-label="Close"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </header>
        )}

        {/* Content */}
        <div ref={contentRef} className="bottom-sheet__content">
          {children}
        </div>

        {/* Footer */}
        {footer && <footer className="bottom-sheet__footer">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}

export default BottomSheet;
