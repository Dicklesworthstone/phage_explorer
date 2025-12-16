/**
 * PhagePickerSheet - Bottom sheet for quick phage selection
 *
 * Features:
 * - Searchable list of all phages
 * - Current phage highlighted
 * - Tap to select and close
 * - Uses BottomSheet for native-feeling interaction
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { BottomSheet } from './BottomSheet';

interface PhageListItem {
  id: number;
  name: string;
  host?: string | null;
  genomeLength?: number | null;
}

interface PhagePickerSheetProps {
  /** Whether the sheet is open */
  isOpen: boolean;
  /** Handler to close the sheet */
  onClose: () => void;
  /** List of all phages */
  phages: PhageListItem[];
  /** Index of currently selected phage */
  currentIndex: number;
  /** Handler when a phage is selected */
  onSelectPhage: (index: number) => void;
}

/**
 * Search icon SVG
 */
function SearchIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/**
 * Check icon for selected item
 */
function CheckIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function PhagePickerSheet({
  isOpen,
  onClose,
  phages,
  currentIndex,
  onSelectPhage,
}: PhagePickerSheetProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter phages by search query
  const filteredPhages = useMemo(() => {
    if (!searchQuery.trim()) return phages;
    const query = searchQuery.toLowerCase();
    return phages.filter(
      (phage) =>
        phage.name.toLowerCase().includes(query) ||
        phage.host?.toLowerCase().includes(query)
    );
  }, [phages, searchQuery]);

  // Handle phage selection
  const handleSelect = useCallback(
    (index: number) => {
      onSelectPhage(index);
      onClose();
      setSearchQuery(''); // Reset search on close
    },
    [onSelectPhage, onClose]
  );

  // Focus search input when sheet opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      // Small delay to let animation start
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Reset search when sheet closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen]);

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="Select Phage"
      initialSnapPoint="half"
      maxHeight={85}
    >
      <div className="phage-picker-sheet">
        {/* Search Input */}
        <div className="phage-picker-sheet__search">
          <SearchIcon />
          <input
            ref={searchInputRef}
            type="search"
            placeholder="Search phages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="phage-picker-sheet__search-input"
            aria-label="Search phages"
          />
        </div>

        {/* Phage List */}
        <div
          className="phage-picker-sheet__list"
          role="listbox"
          aria-label="Phage list"
        >
          {filteredPhages.length === 0 ? (
            <div className="phage-picker-sheet__empty">
              No phages match "{searchQuery}"
            </div>
          ) : (
            filteredPhages.map((phage) => {
              // Find original index (for navigation)
              const originalIndex = phages.findIndex((p) => p.id === phage.id);
              const isSelected = originalIndex === currentIndex;

              return (
                <button
                  key={phage.id}
                  type="button"
                  className={`phage-picker-sheet__item ${
                    isSelected ? 'phage-picker-sheet__item--selected' : ''
                  }`}
                  onClick={() => handleSelect(originalIndex)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div className="phage-picker-sheet__item-content">
                    <span className="phage-picker-sheet__item-name">
                      {phage.name}
                    </span>
                    <span className="phage-picker-sheet__item-meta">
                      {phage.host ?? 'Unknown host'}
                      {phage.genomeLength && (
                        <>
                          {' '}
                          · {phage.genomeLength.toLocaleString()} bp
                        </>
                      )}
                    </span>
                  </div>
                  {isSelected && (
                    <span className="phage-picker-sheet__item-check">
                      <CheckIcon />
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

export default PhagePickerSheet;
