/**
 * useTheme Hook for Phage Explorer Web
 *
 * Provides theme state management with localStorage persistence
 * and CSS custom property updates.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Theme, ThemeContextValue, ThemeId } from '../theme/types';
import { THEMES, DEFAULT_THEME, getThemeById, getNextTheme } from '../theme/themes';

const STORAGE_KEY = 'phage-explorer-theme';
const TRANSITION_CLASS = 'theme-transitioning';
const TRANSITION_DURATION = 300;

/**
 * Apply theme CSS custom properties to the document
 */
function applyThemeToDocument(theme: Theme, animate = true): void {
  const root = document.documentElement;
  const { palette, nucleotides } = theme;

  // Add transition class for smooth theme changes
  if (animate) {
    root.classList.add(TRANSITION_CLASS);
  }

  // Core colors
  root.style.setProperty('--color-primary', palette.primary);
  root.style.setProperty('--color-secondary', palette.secondary);
  root.style.setProperty('--color-accent', palette.accent);
  root.style.setProperty('--color-background', palette.background);
  root.style.setProperty('--color-background-alt', palette.backgroundAlt);

  // Text hierarchy
  root.style.setProperty('--color-text', palette.text);
  root.style.setProperty('--color-text-dim', palette.textDim);
  root.style.setProperty('--color-text-muted', palette.textMuted);

  // Borders
  root.style.setProperty('--color-border', palette.border);
  root.style.setProperty('--color-border-focus', palette.borderFocus);
  root.style.setProperty('--color-border-light', palette.borderLight);

  // Status colors
  root.style.setProperty('--color-success', palette.success);
  root.style.setProperty('--color-warning', palette.warning);
  root.style.setProperty('--color-error', palette.error);
  root.style.setProperty('--color-info', palette.info);

  // Visualization
  root.style.setProperty('--color-diff-highlight', palette.diffHighlight);
  root.style.setProperty('--color-gene-forward', palette.geneForward);
  root.style.setProperty('--color-gene-reverse', palette.geneReverse);
  root.style.setProperty('--color-gene-highlight', palette.geneHighlight);

  // Gradients
  root.style.setProperty('--color-gradient-low', palette.gradientLow);
  root.style.setProperty('--color-gradient-mid', palette.gradientMid);
  root.style.setProperty('--color-gradient-high', palette.gradientHigh);

  // K-mer
  root.style.setProperty('--color-kmer-normal', palette.kmerNormal);
  root.style.setProperty('--color-kmer-anomaly', palette.kmerAnomaly);

  // Effects
  root.style.setProperty('--color-shadow', palette.shadow);
  root.style.setProperty('--color-highlight', palette.highlight);
  root.style.setProperty('--color-glow', palette.glow);

  // UI elements
  root.style.setProperty('--color-badge', palette.badge);
  root.style.setProperty('--color-badge-text', palette.badgeText);
  root.style.setProperty('--color-separator', palette.separator);

  // Icons
  root.style.setProperty('--color-icon-primary', palette.iconPrimary);
  root.style.setProperty('--color-icon-secondary', palette.iconSecondary);

  // Panels
  root.style.setProperty('--color-panel-header', palette.panelHeader);
  root.style.setProperty('--color-panel-border', palette.panelBorder);
  root.style.setProperty('--color-panel-shadow', palette.panelShadow);

  // Sparkline gradient
  palette.sparkline.forEach((color, i) => {
    root.style.setProperty(`--sparkline-${i}`, color);
  });

  // Nucleotide colors
  const nucleotideKeys: Array<'A' | 'C' | 'G' | 'T' | 'N'> = ['A', 'C', 'G', 'T', 'N'];
  nucleotideKeys.forEach((nuc) => {
    const colors = nucleotides[nuc];
    root.style.setProperty(`--nucleotide-${nuc.toLowerCase()}-fg`, colors.fg);
    root.style.setProperty(`--nucleotide-${nuc.toLowerCase()}-bg`, colors.bg);
  });

  // Update color-scheme for scrollbars and form controls
  const isLightTheme = theme.id === 'pastel';
  root.style.setProperty('color-scheme', isLightTheme ? 'light' : 'dark');

  // Set data attribute for theme-specific CSS rules
  root.dataset.theme = theme.id;

  // Remove transition class after animation completes
  if (animate) {
    setTimeout(() => {
      root.classList.remove(TRANSITION_CLASS);
    }, TRANSITION_DURATION);
  }
}

/**
 * Get initial theme from localStorage or system preference
 */
function getInitialTheme(): Theme {
  // Check localStorage first
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return getThemeById(stored);
    }

    // Check system preference for light/dark
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? DEFAULT_THEME : getThemeById('pastel');
  }

  return DEFAULT_THEME;
}

/**
 * useTheme hook
 *
 * Manages theme state with localStorage persistence and CSS updates.
 *
 * @example
 * const { theme, themeId, setTheme, nextTheme, availableThemes } = useTheme();
 *
 * // Change theme
 * setTheme('matrix');
 *
 * // Cycle to next theme
 * nextTheme();
 */
export function useTheme(): ThemeContextValue {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  // Apply theme on mount and when theme changes
  useEffect(() => {
    applyThemeToDocument(theme, false);
  }, []);

  // Set theme by ID
  const setTheme = useCallback((id: string) => {
    const newTheme = getThemeById(id);
    setThemeState(newTheme);
    applyThemeToDocument(newTheme, true);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  // Cycle to next theme
  const cycleNextTheme = useCallback(() => {
    const newTheme = getNextTheme(theme.id);
    setThemeState(newTheme);
    applyThemeToDocument(newTheme, true);
    localStorage.setItem(STORAGE_KEY, newTheme.id);
  }, [theme.id]);

  // Memoized context value
  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themeId: theme.id as ThemeId,
      setTheme,
      nextTheme: cycleNextTheme,
      availableThemes: THEMES,
    }),
    [theme, setTheme, cycleNextTheme]
  );

  return contextValue;
}

/**
 * Get nucleotide color classes
 */
export function getNucleotideClass(nucleotide: string): string {
  const nuc = nucleotide.toUpperCase();
  if (['A', 'C', 'G', 'T', 'N'].includes(nuc)) {
    return `nucleotide nucleotide-${nuc.toLowerCase()}`;
  }
  return 'nucleotide nucleotide-n';
}

export default useTheme;
