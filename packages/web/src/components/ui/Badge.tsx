/**
 * Badge - Standardized badge component
 *
 * Provides consistent badge styling across the application with
 * semantic variants, sizes, and optional interactivity.
 */

import React from 'react';

export type BadgeVariant = 'default' | 'info' | 'warning' | 'success' | 'error' | 'subtle';
export type BadgeSize = 'default' | 'small' | 'tiny';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Whether the badge is clickable/interactive */
  interactive?: boolean;
  /** Pulse animation for attention */
  pulse?: boolean;
  /** Additional className */
  className?: string;
  /** Accessible label for screen readers */
  'aria-label'?: string;
  /** Native HTML title for tooltip */
  title?: string;
  /** Click handler when interactive */
  onClick?: () => void;
  /** Inline styles override */
  style?: React.CSSProperties;
}

/**
 * Build the className string from props
 */
function getBadgeClasses(
  variant: BadgeVariant,
  size: BadgeSize,
  interactive: boolean,
  pulse: boolean,
  className?: string
): string {
  const classes = ['badge'];

  // Variant classes
  if (variant !== 'default') {
    if (variant === 'subtle') {
      classes.push('subtle');
    } else {
      classes.push(`badge-${variant}`);
    }
  }

  // Size classes
  if (size === 'small') {
    classes.push('badge-small');
  } else if (size === 'tiny') {
    classes.push('badge-tiny');
  }

  // Interactive
  if (interactive) {
    classes.push('clickable');
  }

  // Pulse animation
  if (pulse) {
    classes.push('animate-pulse');
  }

  // Additional custom classes
  if (className) {
    classes.push(className);
  }

  return classes.join(' ');
}

export function Badge({
  children,
  variant = 'default',
  size = 'default',
  interactive = false,
  pulse = false,
  className,
  'aria-label': ariaLabel,
  title,
  onClick,
  style,
}: BadgeProps): React.ReactElement {
  const badgeClass = getBadgeClasses(variant, size, interactive, pulse, className);

  // Use button when interactive, span otherwise
  const Element = interactive ? 'button' : 'span';

  return (
    <Element
      type={interactive ? 'button' : undefined}
      className={badgeClass}
      aria-label={ariaLabel}
      title={title}
      onClick={interactive ? onClick : undefined}
      style={style}
    >
      {children}
    </Element>
  );
}

/**
 * Convenience variants as separate exports for cleaner imports
 */
export function InfoBadge(props: Omit<BadgeProps, 'variant'>): React.ReactElement {
  return <Badge {...props} variant="info" />;
}

export function WarningBadge(props: Omit<BadgeProps, 'variant'>): React.ReactElement {
  return <Badge {...props} variant="warning" />;
}

export function SuccessBadge(props: Omit<BadgeProps, 'variant'>): React.ReactElement {
  return <Badge {...props} variant="success" />;
}

export function ErrorBadge(props: Omit<BadgeProps, 'variant'>): React.ReactElement {
  return <Badge {...props} variant="error" />;
}

export function SubtleBadge(props: Omit<BadgeProps, 'variant'>): React.ReactElement {
  return <Badge {...props} variant="subtle" />;
}

export default Badge;
