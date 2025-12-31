/**
 * EmptyState - Premium empty state component
 *
 * Provides consistent, visually polished empty states across the application
 * for scenarios like: no search results, empty lists, loading failures, etc.
 */

import React from 'react';

export type EmptyStateSize = 'compact' | 'default' | 'large';
export type EmptyStateVariant = 'default' | 'search' | 'error' | 'loading';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'ghost';
}

export interface EmptyStateProps {
  /** Icon to display (component, not JSX element) */
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  /** Main title text */
  title: string;
  /** Optional descriptive text */
  description?: string;
  /** Primary action button */
  action?: EmptyStateAction;
  /** Secondary action button */
  secondaryAction?: EmptyStateAction;
  /** Visual size variant */
  size?: EmptyStateSize;
  /** Visual style variant */
  variant?: EmptyStateVariant;
  /** Additional className */
  className?: string;
  /** Children content (rendered below description) */
  children?: React.ReactNode;
}

/**
 * Get icon size based on component size
 */
function getIconSize(size: EmptyStateSize): number {
  switch (size) {
    case 'compact':
      return 32;
    case 'large':
      return 56;
    default:
      return 44;
  }
}

/**
 * Build className string from props
 */
function getEmptyStateClasses(
  size: EmptyStateSize,
  variant: EmptyStateVariant,
  className?: string
): string {
  const classes = ['empty-state'];

  if (size !== 'default') {
    classes.push(`empty-state--${size}`);
  }

  if (variant !== 'default') {
    classes.push(`empty-state--${variant}`);
  }

  if (className) {
    classes.push(className);
  }

  return classes.join(' ');
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  size = 'default',
  variant = 'default',
  className,
  children,
}: EmptyStateProps): React.ReactElement {
  const containerClass = getEmptyStateClasses(size, variant, className);
  const iconSize = getIconSize(size);

  return (
    <div className={containerClass} role="status" aria-live="polite">
      {Icon && (
        <div className="empty-state__icon">
          <Icon size={iconSize} />
        </div>
      )}

      <h3 className="empty-state__title">{title}</h3>

      {description && (
        <p className="empty-state__description">{description}</p>
      )}

      {children && (
        <div className="empty-state__content">{children}</div>
      )}

      {(action || secondaryAction) && (
        <div className="empty-state__actions">
          {action && (
            <button
              type="button"
              className={`btn ${action.variant === 'ghost' ? 'btn-ghost' : 'btn-primary'}`}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              className={`btn ${secondaryAction.variant === 'ghost' ? 'btn-ghost' : 'btn-primary'}`}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default EmptyState;
