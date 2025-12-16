/**
 * PhagePickerTrigger - Tappable header element for phage selection
 *
 * Displays the current phage name with a dropdown chevron and position badge.
 * Tapping opens the PhagePickerSheet for quick phage navigation.
 */

import React from 'react';

interface PhagePickerTriggerProps {
  /** Current phage name or fallback text */
  phageName: string;
  /** Current position in the phage list (0-indexed) */
  currentIndex: number;
  /** Total number of phages */
  totalCount: number;
  /** Handler when trigger is tapped */
  onClick: () => void;
  /** Whether the picker sheet is currently open */
  isOpen?: boolean;
}

/**
 * Chevron down SVG icon
 */
function ChevronDown(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function PhagePickerTrigger({
  phageName,
  currentIndex,
  totalCount,
  onClick,
  isOpen = false,
}: PhagePickerTriggerProps): React.ReactElement {
  const positionLabel = totalCount > 0
    ? `${currentIndex + 1}/${totalCount}`
    : '';

  return (
    <button
      type="button"
      className={`phage-picker-trigger ${isOpen ? 'phage-picker-trigger--open' : ''}`}
      onClick={onClick}
      aria-haspopup="listbox"
      aria-expanded={isOpen}
      aria-label={`Select phage. Currently viewing ${phageName}, ${currentIndex + 1} of ${totalCount}`}
    >
      <span className="phage-picker-trigger__name">{phageName}</span>
      <ChevronDown />
      {positionLabel && (
        <span className="phage-picker-trigger__badge">{positionLabel}</span>
      )}
    </button>
  );
}

export default PhagePickerTrigger;
