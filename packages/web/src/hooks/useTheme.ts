/**
 * useTheme Hook for Phage Explorer Web
 *
 * Provides theme state management with localStorage persistence
 * and CSS custom property updates.
 */

import { useMemo } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { Theme, ThemeContextValue } from '../theme/types';
import { THEMES, getThemeById, getNextTheme } from '../theme/themes';

const STORAGE_KEY = 'phage-explorer-theme';
const TRANSITION_CLASS = 'theme-transitioning';
const TRANSITION_DURATION = 300;
let transitionTimeoutId: number | null = null;

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
    if (transitionTimeoutId !== null) {
      window.clearTimeout(transitionTimeoutId);
      transitionTimeoutId = null;
    }
    transitionTimeoutId = window.setTimeout(() => {
      root.classList.remove(TRANSITION_CLASS);
      transitionTimeoutId = null;
    }, TRANSITION_DURATION);
  }
}

/**
 * Keep document styles and the persisted web preference in sync with the
 * same theme ID the explorer, controls and canvases subscribe to.
 */
export function initializeWebTheme(): () => void {
  // Older sessions may have a more recent Settings choice here than in the
  // main store's debounced preferences. Prefer it when present.
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) usePhageStore.getState().setTheme(stored);
  } catch {
    // The in-memory choice remains usable when storage is unavailable.
  }

  applyThemeToDocument(getThemeById(usePhageStore.getState().currentTheme.id), false);
  return usePhageStore.subscribe((state, previous) => {
    if (state.currentTheme.id === previous.currentTheme.id) return;
    const theme = getThemeById(state.currentTheme.id);
    applyThemeToDocument(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme.id);
    } catch {
      // Ignore storage failures (private mode, quota, disabled storage).
    }
  });
}

function cycleNextTheme(): void {
  const state = usePhageStore.getState();
  state.setTheme(getNextTheme(state.currentTheme.id).id);
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
  const theme = usePhageStore(state => getThemeById(state.currentTheme.id));
  const setTheme = usePhageStore(state => state.setTheme);
  return useMemo<ThemeContextValue>(
    () => ({
      theme,
      themeId: theme.id,
      setTheme,
      nextTheme: cycleNextTheme,
      availableThemes: THEMES,
    }),
    [theme, setTheme]
  );
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
