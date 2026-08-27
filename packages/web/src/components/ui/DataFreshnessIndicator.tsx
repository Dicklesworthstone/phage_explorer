/**
 * DataFreshnessIndicator - Mobile-friendly database transfer indicator
 *
 * Distinguishes a local offline-cache load from a network download without
 * implying that the underlying scientific records themselves are newly curated.
 */

import React from 'react';
import { SubtleBadge, InfoBadge } from './Badge';

export interface DataFreshnessIndicatorProps {
  isCached: boolean;
  isLoading: boolean;
  /** Optional: show only on mobile (default: true) */
  mobileOnly?: boolean;
  className?: string;
}

export function DataFreshnessIndicator({
  isCached,
  isLoading,
  mobileOnly = true,
  className = '',
}: DataFreshnessIndicatorProps): React.ReactElement | null {
  if (isLoading) {
    return null;
  }

  const containerClass = mobileOnly
    ? `data-freshness-indicator mobile-only ${className}`.trim()
    : `data-freshness-indicator ${className}`.trim();

  return (
    <div className={containerClass}>
      {isCached ? (
        <SubtleBadge
          size="tiny"
          aria-label="Database loaded from the local offline cache"
          title="Database loaded from the local offline cache"
        >
          Offline ready
        </SubtleBadge>
      ) : (
        <InfoBadge
          size="tiny"
          aria-label="Database downloaded for this browser session"
          title="Database downloaded for this browser session"
        >
          Downloaded
        </InfoBadge>
      )}
    </div>
  );
}

export default DataFreshnessIndicator;
