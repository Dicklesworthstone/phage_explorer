/**
 * FullFeatureModal - Comprehensive Feature Browser
 *
 * A full-screen modal showing ALL application features organized by category.
 * Features:
 * - Fuzzy search with highlighting
 * - Category filtering with visual pills
 * - Keyboard navigation (arrows, enter, escape)
 * - Experience level filtering
 * - Recent features tracking
 */

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { useTheme } from '../../hooks/useTheme';
import { useOverlay, type OverlayId } from '../overlays/OverlayProvider';
import { Overlay } from '../overlays/Overlay';
import {
  FEATURES,
  CATEGORY_META,
  getFeaturesForLevel,
  getFeaturesByCategory,
  type Feature,
  type FeatureCategory,
  type FeatureContext,
  type ExperienceLevel,
} from '../../lib/featureRegistry';
import {
  IconChevronDown,
  IconChevronUp,
  IconArrowRight,
  IconSearch,
  IconCommand,
  IconLayers,
  IconCube,
  IconZap,
  IconFlask,
  IconGitCompare,
  IconLearn,
  IconDownload,
  IconSettings,
  IconTarget,
} from '../ui';
import './FullFeatureModal.css';

// =============================================================================
// Fuzzy Search
// =============================================================================

interface FuzzyResult {
  feature: Feature;
  score: number;
  labelIndices: number[];
  descIndices: number[];
}

function fuzzyMatch(
  pattern: string,
  str: string
): { match: boolean; score: number; indices: number[] } {
  if (!pattern) return { match: true, score: 0, indices: [] };

  const patternLower = pattern.toLowerCase();
  const strLower = str.toLowerCase();
  const indices: number[] = [];
  let patternIdx = 0;
  let score = 0;
  let prevMatchIdx = -1;

  for (let i = 0; i < strLower.length && patternIdx < patternLower.length; i++) {
    if (strLower[i] === patternLower[patternIdx]) {
      indices.push(i);
      // Consecutive match bonus
      if (prevMatchIdx === i - 1) {
        score += 2;
      }
      // Word start bonus
      if (i === 0 || strLower[i - 1] === ' ' || strLower[i - 1] === ':') {
        score += 3;
      }
      score += 1;
      prevMatchIdx = i;
      patternIdx++;
    }
  }

  return {
    match: patternIdx === patternLower.length,
    score,
    indices,
  };
}

function searchFeatures(features: Feature[], query: string): FuzzyResult[] {
  if (!query.trim()) {
    return features.map((f) => ({
      feature: f,
      score: 0,
      labelIndices: [],
      descIndices: [],
    }));
  }

  const results: FuzzyResult[] = [];

  for (const feature of features) {
    const labelMatch = fuzzyMatch(query, feature.label);
    const descMatch = feature.description
      ? fuzzyMatch(query, feature.description)
      : { match: false, score: 0, indices: [] };
    const tagMatch = feature.tags
      ? feature.tags.some((tag) => fuzzyMatch(query, tag).match)
      : false;

    if (labelMatch.match || descMatch.match || tagMatch) {
      results.push({
        feature,
        score: Math.max(labelMatch.score, descMatch.score * 0.5),
        labelIndices: labelMatch.indices,
        descIndices: descMatch.indices,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// =============================================================================
// Highlight Component
// =============================================================================

function HighlightedText({
  text,
  indices,
  highlightClass,
}: {
  text: string;
  indices: number[];
  highlightClass: string;
}): React.ReactElement {
  if (indices.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;

  for (const idx of indices) {
    if (idx > lastIdx) {
      parts.push(
        <span key={`text-${lastIdx}`}>{text.slice(lastIdx, idx)}</span>
      );
    }
    parts.push(
      <span key={`hl-${idx}`} className={highlightClass}>
        {text[idx]}
      </span>
    );
    lastIdx = idx + 1;
  }

  if (lastIdx < text.length) {
    parts.push(<span key={`text-end`}>{text.slice(lastIdx)}</span>);
  }

  return <>{parts}</>;
}

// =============================================================================
// Category Icon Component
// =============================================================================

const CATEGORY_ICON_MAP: Record<FeatureCategory, React.ReactNode> = {
  navigation: <IconArrowRight size={16} />,
  view: <IconLayers size={16} />,
  analysis: <IconFlask size={16} />,
  '3d': <IconCube size={16} />,
  simulation: <IconZap size={16} />,
  comparison: <IconGitCompare size={16} />,
  education: <IconLearn size={16} />,
  export: <IconDownload size={16} />,
  settings: <IconSettings size={16} />,
};

// =============================================================================
// Recent Features Storage
// =============================================================================

const RECENT_FEATURES_KEY = 'phage-explorer-recent-features';
const MAX_RECENT = 8;

function getRecentFeatures(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FEATURES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function addRecentFeature(featureId: string): void {
  try {
    const recent = getRecentFeatures().filter((id) => id !== featureId);
    recent.unshift(featureId);
    localStorage.setItem(
      RECENT_FEATURES_KEY,
      JSON.stringify(recent.slice(0, MAX_RECENT))
    );
  } catch {
    // Ignore storage errors
  }
}

// =============================================================================
// Main Component
// =============================================================================

export function FullFeatureModal(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, close, open } = useOverlay();
  const modalOpen = isOpen('commandPalette'); // Reusing commandPalette slot for now

  // State
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState<FeatureCategory | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Store state for feature context
  const experienceLevel = usePhageStore((s) => s.experienceLevel) as ExperienceLevel;
  const setExperienceLevel = usePhageStore((s) => s.setExperienceLevel);
  const viewMode = usePhageStore((s) => s.viewMode);
  const currentPhage = usePhageStore((s) => s.currentPhage);
  const show3DModel = usePhageStore((s) => s.show3DModel);
  const diffEnabled = usePhageStore((s) => s.diffEnabled);
  const beginnerModeEnabled = usePhageStore((s) => s.beginnerModeEnabled);

  // Store actions
  const toggleViewMode = usePhageStore((s) => s.toggleViewMode);
  const toggle3DModel = usePhageStore((s) => s.toggle3DModel);
  const toggle3DModelFullscreen = usePhageStore((s) => s.toggle3DModelFullscreen);
  const toggle3DModelPause = usePhageStore((s) => s.toggle3DModelPause);
  const toggleDiff = usePhageStore((s) => s.toggleDiff);
  const cycleTheme = usePhageStore((s) => s.cycleTheme);
  const cycleReadingFrame = usePhageStore((s) => s.cycleReadingFrame);
  const scrollToStart = usePhageStore((s) => s.scrollToStart);
  const scrollToEnd = usePhageStore((s) => s.scrollToEnd);
  const nextPhage = usePhageStore((s) => s.nextPhage);
  const prevPhage = usePhageStore((s) => s.prevPhage);
  const toggleBeginnerMode = usePhageStore((s) => s.toggleBeginnerMode);
  const openGlossary = usePhageStore((s) => s.openGlossary);
  const startTour = usePhageStore((s) => s.startTour);
  const closeAllOverlays = usePhageStore((s) => s.closeAllOverlays);

  // Build feature context
  const featureContext = useMemo<FeatureContext>(
    () => ({
      openOverlay: (id: OverlayId) => {
        close('commandPalette');
        open(id);
      },
      closeOverlay: (id?: OverlayId) => {
        if (id) close(id);
        else close('commandPalette');
      },
      closeAllOverlays: () => {
        closeAllOverlays();
      },
      toggleViewMode,
      toggle3DModel,
      toggle3DModelFullscreen,
      toggle3DModelPause,
      toggleDiff,
      cycleTheme,
      cycleReadingFrame,
      scrollToStart,
      scrollToEnd,
      nextPhage,
      prevPhage,
      toggleBeginnerMode,
      openGlossary,
      startTour,
      hasPhage: Boolean(currentPhage),
      viewMode: viewMode as 'dna' | 'aa',
      show3DModel,
      diffEnabled,
      beginnerModeEnabled,
    }),
    [
      close,
      open,
      closeAllOverlays,
      toggleViewMode,
      toggle3DModel,
      toggle3DModelFullscreen,
      toggle3DModelPause,
      toggleDiff,
      cycleTheme,
      cycleReadingFrame,
      scrollToStart,
      scrollToEnd,
      nextPhage,
      prevPhage,
      toggleBeginnerMode,
      openGlossary,
      startTour,
      currentPhage,
      viewMode,
      show3DModel,
      diffEnabled,
      beginnerModeEnabled,
    ]
  );

  // Load recent features on mount
  useEffect(() => {
    setRecentIds(getRecentFeatures());
  }, []);

  // Filter features by experience level
  const levelFilteredFeatures = useMemo(
    () => getFeaturesForLevel(experienceLevel),
    [experienceLevel]
  );

  // Filter by category if selected
  const categoryFilteredFeatures = useMemo(() => {
    if (!selectedCategory) return levelFilteredFeatures;
    return levelFilteredFeatures.filter((f) => f.category === selectedCategory);
  }, [levelFilteredFeatures, selectedCategory]);

  // Search/filter features
  const searchResults = useMemo(
    () => searchFeatures(categoryFilteredFeatures, query),
    [categoryFilteredFeatures, query]
  );

  // Get recent features that are still available
  const recentFeatures = useMemo(() => {
    if (query.trim()) return []; // Hide recent when searching
    return recentIds
      .map((id) => levelFilteredFeatures.find((f) => f.id === id))
      .filter((f): f is Feature => f !== undefined)
      .slice(0, 5);
  }, [recentIds, levelFilteredFeatures, query]);

  // Total navigable items
  const showRecent = recentFeatures.length > 0 && !query.trim();
  const totalItems = (showRecent ? recentFeatures.length : 0) + searchResults.length;

  // Get item at flat index
  const getItemAtIndex = useCallback(
    (index: number): FuzzyResult | undefined => {
      if (showRecent) {
        if (index < recentFeatures.length) {
          return {
            feature: recentFeatures[index],
            score: 0,
            labelIndices: [],
            descIndices: [],
          };
        }
        return searchResults[index - recentFeatures.length];
      }
      return searchResults[index];
    },
    [showRecent, recentFeatures, searchResults]
  );

  // Execute feature action
  const executeFeature = useCallback(
    (feature: Feature) => {
      // Check if enabled
      if (feature.isEnabled && !feature.isEnabled(featureContext)) {
        return;
      }

      addRecentFeature(feature.id);
      setRecentIds(getRecentFeatures());
      feature.action(featureContext);
      close('commandPalette');
    },
    [featureContext, close]
  );

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchResults.length, selectedCategory]);

  // Focus input when opened
  useEffect(() => {
    if (modalOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
      setSelectedIndex(0);
      setSelectedCategory(null);
    }
  }, [modalOpen]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, totalItems - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          const item = getItemAtIndex(selectedIndex);
          if (item) {
            executeFeature(item.feature);
          }
          break;
        case 'Tab':
          e.preventDefault();
          // Cycle through categories
          const categories = Object.keys(CATEGORY_META) as FeatureCategory[];
          if (selectedCategory === null) {
            setSelectedCategory(categories[0]);
          } else {
            const currentIdx = categories.indexOf(selectedCategory);
            const nextIdx = (currentIdx + 1) % (categories.length + 1);
            setSelectedCategory(nextIdx === categories.length ? null : categories[nextIdx]);
          }
          break;
      }
    },
    [totalItems, selectedIndex, getItemAtIndex, executeFeature, selectedCategory]
  );

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selectedElement = list.querySelector<HTMLElement>(
      `[data-feature-index="${selectedIndex}"]`
    );
    selectedElement?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!modalOpen) {
    return null;
  }

  // Group search results by category for display
  const groupedResults = new Map<FeatureCategory, FuzzyResult[]>();
  for (const result of searchResults) {
    const cat = result.feature.category;
    const existing = groupedResults.get(cat) ?? [];
    existing.push(result);
    groupedResults.set(cat, existing);
  }

  let flatIndex = 0;

  return (
    <Overlay
      id="commandPalette"
      title="ALL FEATURES"
      hotkey=":"
      size="lg"
      position="center"
    >
      <div className="full-feature-modal">
        {/* Experience Level Selector */}
        <div className="ffm-level-selector" role="group" aria-label="Experience level">
          <span className="ffm-level-label">Level:</span>
          {(['novice', 'intermediate', 'power'] as ExperienceLevel[]).map((level) => {
            const active = level === experienceLevel;
            return (
              <button
                key={level}
                type="button"
                className={`ffm-level-btn ${active ? 'ffm-level-btn--active' : ''}`}
                onClick={() => setExperienceLevel(level)}
                aria-pressed={active}
              >
                {level === 'novice' && '1'}
                {level === 'intermediate' && '2'}
                {level === 'power' && '3'}
                <span className="ffm-level-btn-label">{level}</span>
              </button>
            );
          })}
        </div>

        {/* Category Pills */}
        <div className="ffm-category-pills" role="group" aria-label="Category filter">
          <button
            type="button"
            className={`ffm-category-pill ${selectedCategory === null ? 'ffm-category-pill--active' : ''}`}
            onClick={() => setSelectedCategory(null)}
            aria-pressed={selectedCategory === null}
          >
            All
          </button>
          {(Object.keys(CATEGORY_META) as FeatureCategory[]).map((cat) => {
            const meta = CATEGORY_META[cat];
            const active = selectedCategory === cat;
            const count = levelFilteredFeatures.filter((f) => f.category === cat).length;
            return (
              <button
                key={cat}
                type="button"
                className={`ffm-category-pill ${active ? 'ffm-category-pill--active' : ''}`}
                onClick={() => setSelectedCategory(cat)}
                aria-pressed={active}
              >
                <span className="ffm-category-pill-icon">
                  {CATEGORY_ICON_MAP[cat]}
                </span>
                {meta.label}
                <span className="ffm-category-pill-count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="ffm-search-container">
          <IconSearch size={18} className="ffm-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="ffm-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search features..."
            autoComplete="off"
            spellCheck={false}
            aria-label="Search features"
            role="combobox"
            aria-expanded="true"
            aria-controls="ffm-feature-list"
            aria-activedescendant={
              totalItems > 0 ? `ffm-item-${selectedIndex}` : undefined
            }
          />
          {query && (
            <button
              type="button"
              className="ffm-search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >
              &times;
            </button>
          )}
        </div>

        {/* Results Count */}
        <div className="ffm-results-count" aria-live="polite">
          {query.trim()
            ? `${searchResults.length} features found`
            : `${totalItems} features available`}
        </div>

        {/* Feature List */}
        <div
          ref={listRef}
          id="ffm-feature-list"
          className="ffm-feature-list"
          role="listbox"
          aria-label="Features"
        >
          {/* Recent Features Section */}
          {showRecent && (
            <div className="ffm-section" role="group" aria-label="Recent features">
              <div className="ffm-section-header">
                <span className="ffm-section-icon">&#9203;</span>
                Recent
              </div>
              {recentFeatures.map((feature) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;
                const isEnabled = !feature.isEnabled || feature.isEnabled(featureContext);
                const isActive = feature.isActive?.(featureContext);

                return (
                  <div
                    key={`recent-${feature.id}`}
                    id={`ffm-item-${currentIndex}`}
                    data-feature-index={currentIndex}
                    className={`ffm-feature-item ${isSelected ? 'ffm-feature-item--selected' : ''} ${!isEnabled ? 'ffm-feature-item--disabled' : ''} ${isActive ? 'ffm-feature-item--active' : ''}`}
                    onClick={() => executeFeature(feature)}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={!isEnabled}
                    tabIndex={-1}
                  >
                    <span className="ffm-feature-icon">
                      {CATEGORY_ICON_MAP[feature.category]}
                    </span>
                    <div className="ffm-feature-content">
                      <span className="ffm-feature-label">{feature.label}</span>
                      {feature.description && (
                        <span className="ffm-feature-desc">
                          {feature.description}
                        </span>
                      )}
                    </div>
                    {feature.shortcuts && feature.shortcuts.length > 0 && (
                      <span className="ffm-feature-shortcut">
                        {feature.shortcuts[0]}
                      </span>
                    )}
                    {isActive && <span className="ffm-feature-active-badge">ON</span>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Grouped Features */}
          {Array.from(groupedResults.entries()).map(([category, results]) => {
            const meta = CATEGORY_META[category];
            return (
              <div
                key={category}
                className="ffm-section"
                role="group"
                aria-label={`${meta.label} features`}
              >
                <div className="ffm-section-header">
                  <span className="ffm-section-icon">
                    {CATEGORY_ICON_MAP[category]}
                  </span>
                  {meta.label}
                  <span className="ffm-section-count">({results.length})</span>
                </div>
                {results.map((result) => {
                  const currentIndex = flatIndex++;
                  const isSelected = currentIndex === selectedIndex;
                  const feature = result.feature;
                  const isEnabled = !feature.isEnabled || feature.isEnabled(featureContext);
                  const isActive = feature.isActive?.(featureContext);

                  return (
                    <div
                      key={feature.id}
                      id={`ffm-item-${currentIndex}`}
                      data-feature-index={currentIndex}
                      className={`ffm-feature-item ${isSelected ? 'ffm-feature-item--selected' : ''} ${!isEnabled ? 'ffm-feature-item--disabled' : ''} ${isActive ? 'ffm-feature-item--active' : ''}`}
                      onClick={() => executeFeature(feature)}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={!isEnabled}
                      tabIndex={-1}
                    >
                      <span className="ffm-feature-icon">
                        {CATEGORY_ICON_MAP[feature.category]}
                      </span>
                      <div className="ffm-feature-content">
                        <span className="ffm-feature-label">
                          <HighlightedText
                            text={feature.label}
                            indices={result.labelIndices}
                            highlightClass="ffm-highlight"
                          />
                        </span>
                        {feature.description && (
                          <span className="ffm-feature-desc">
                            <HighlightedText
                              text={feature.description}
                              indices={result.descIndices}
                              highlightClass="ffm-highlight"
                            />
                          </span>
                        )}
                      </div>
                      {feature.shortcuts && feature.shortcuts.length > 0 && (
                        <span className="ffm-feature-shortcut">
                          {feature.shortcuts[0]}
                        </span>
                      )}
                      {isActive && (
                        <span className="ffm-feature-active-badge">ON</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Empty State */}
          {searchResults.length === 0 && (
            <div className="ffm-empty">
              No features found for "{query}"
            </div>
          )}
        </div>

        {/* Footer Hints */}
        <div className="ffm-footer">
          <span className="ffm-hint">
            <kbd>&uarr;</kbd><kbd>&darr;</kbd> Navigate
          </span>
          <span className="ffm-hint">
            <kbd>Enter</kbd> Select
          </span>
          <span className="ffm-hint">
            <kbd>Tab</kbd> Category
          </span>
          <span className="ffm-hint">
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </Overlay>
  );
}

export default FullFeatureModal;
