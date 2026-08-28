/**
 * Toast - Queued notification system
 *
 * Provides ToastProvider context and useToast() hook for showing
 * auto-dismissing, stacked notifications with progress bars.
 * Follows the OverlayProvider pattern.
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconX } from './icons';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Unique id (auto-generated if omitted) */
  id?: string;
  /** Title text (bold) */
  title?: string;
  /** Body message */
  message: string;
  /** Visual variant */
  variant?: ToastVariant;
  /** Auto-dismiss duration in ms (0 = manual dismiss only) */
  duration?: number;
  /** Action buttons */
  actions?: ToastAction[];
  /** Icon character or element */
  icon?: ReactNode;
}

interface ToastEntry extends Required<Pick<ToastOptions, 'message' | 'variant' | 'duration'>> {
  id: string;
  title?: string;
  actions?: ToastAction[];
  icon?: ReactNode;
  createdAt: number;
  paused: boolean;
  exiting: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ToastContextValue {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Hook to show toast notifications. Must be used within <ToastProvider>. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a <ToastProvider>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 4000;
const EXIT_DURATION = 150;

let nextId = 0;

const VARIANT_ICONS: Record<ToastVariant, string> = {
  info: '\u2139',    // ℹ
  success: '\u2713', // ✓
  warning: '!',
  error: '\u2717',   // ✗
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const startTimer = useCallback((id: string, remaining: number) => {
    if (remaining <= 0) return;
    const existing = timersRef.current.get(id);
    if (existing) clearTimeout(existing);

    timersRef.current.set(
      id,
      setTimeout(() => {
        timersRef.current.delete(id);
        // Begin exit animation
        setToasts((prev) =>
          prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
        );
        // Remove after exit animation
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, EXIT_DURATION);
      }, remaining)
    );
  }, []);

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_DURATION);
  }, []);

  const dismissAll = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    setToasts((prev) => prev.map((t) => ({ ...t, exiting: true })));
    setTimeout(() => setToasts([]), EXIT_DURATION);
  }, []);

  const toast = useCallback(
    (options: ToastOptions): string => {
      const id = options.id ?? `toast-${++nextId}`;
      const variant = options.variant ?? 'info';
      const duration = options.duration ?? DEFAULT_DURATION;

      const entry: ToastEntry = {
        id,
        message: options.message,
        title: options.title,
        variant,
        duration,
        actions: options.actions,
        icon: options.icon,
        createdAt: Date.now(),
        paused: false,
        exiting: false,
      };

      setToasts((prev) => {
        // Replace existing toast with same id
        const filtered = prev.filter((t) => t.id !== id);
        const next = [...filtered, entry];
        return next.length > MAX_VISIBLE ? next.slice(-MAX_VISIBLE) : next;
      });

      if (duration > 0) {
        startTimer(id, duration);
      }

      return id;
    },
    [startTimer]
  );

  const pause = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, paused: true } : t))
    );
  }, []);

  const resume = useCallback(
    (id: string) => {
      const t = toasts.find((x) => x.id === id);
      if (!t || t.duration <= 0) return;
      const elapsed = Date.now() - t.createdAt;
      const remaining = Math.max(t.duration - elapsed, 500);
      startTimer(id, remaining);
      setToasts((prev) =>
        prev.map((x) => (x.id === id ? { ...x, paused: false } : x))
      );
    },
    [toasts, startTimer]
  );

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const contextValue = useMemo<ToastContextValue>(
    () => ({ toast, dismiss, dismissAll }),
    [toast, dismiss, dismissAll]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          <div className="toast-container" role="region" aria-label="Notifications">
            {toasts.map((t) => (
              <ToastItem
                key={t.id}
                entry={t}
                onDismiss={dismiss}
                onPause={pause}
                onResume={resume}
              />
            ))}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Toast Item
// ---------------------------------------------------------------------------

interface ToastItemProps {
  entry: ToastEntry;
  onDismiss: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}

function ToastItem({ entry, onDismiss, onPause, onResume }: ToastItemProps): React.ReactElement {
  const { id, title, message, variant, duration, actions, icon, exiting, paused, createdAt } = entry;
  const [progress, setProgress] = useState(100);
  const rafRef = useRef<number | null>(null);

  // Animate progress bar
  useEffect(() => {
    if (duration <= 0 || paused) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const tick = () => {
      const elapsed = Date.now() - createdAt;
      const pct = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(pct);
      if (pct > 0) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [duration, paused, createdAt]);

  const resolvedIcon = icon ?? VARIANT_ICONS[variant];

  const className = [
    'toast-item',
    `toast-item--${variant}`,
    exiting ? 'toast-item--exiting' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      role="alert"
      aria-live="polite"
      onMouseEnter={() => onPause(id)}
      onMouseLeave={() => onResume(id)}
    >
      <div className="toast-item__body">
        {resolvedIcon && (
          <span className="toast-item__icon" aria-hidden="true">
            {resolvedIcon}
          </span>
        )}
        <div className="toast-item__content">
          {title && <div className="toast-item__title">{title}</div>}
          <div className="toast-item__message">{message}</div>
        </div>
        <button
          className="toast-item__close"
          onClick={() => onDismiss(id)}
          aria-label="Dismiss notification"
        >
          <IconX size={14} />
        </button>
      </div>

      {actions && actions.length > 0 && (
        <div className="toast-item__actions">
          {actions.map((action, i) => (
            <button
              key={i}
              type="button"
              className={`btn btn-sm ${i === 0 ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => {
                action.onClick();
                onDismiss(id);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {duration > 0 && (
        <div
          className="toast-item__progress"
          style={{ width: `${progress}%` }}
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      )}
    </div>
  );
}
