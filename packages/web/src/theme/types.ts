/**
 * Theme Type Definitions for Phage Explorer Web
 *
 * These interfaces mirror the @phage-explorer/core theme system
 * but are optimized for CSS custom properties in the browser.
 */

/**
 * Color pair for foreground/background
 */
export interface ColorPair {
  fg: string;
  bg: string;
}

/**
 * Nucleotide characters
 */
export type Nucleotide = 'A' | 'C' | 'G' | 'T' | 'N';

/**
 * Amino acid single-letter codes
 */
export type AminoAcid =
  | 'A' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'K' | 'L'
  | 'M' | 'N' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'V' | 'W' | 'Y'
  | 'X' | '*';

/**
 * HUD/UI color palette
 */
export interface ThemePalette {
  // Core colors
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  backgroundAlt: string;

  // Text hierarchy
  text: string;
  textDim: string;
  textMuted: string;

  // Borders
  border: string;
  borderFocus: string;
  borderLight: string;

  // Status colors
  success: string;
  warning: string;
  error: string;
  info: string;

  // Visualization
  diffHighlight: string;
  geneForward: string;
  geneReverse: string;
  geneHighlight: string;

  // Gradients
  gradientLow: string;
  gradientMid: string;
  gradientHigh: string;

  // K-mer
  kmerNormal: string;
  kmerAnomaly: string;

  // Effects
  shadow: string;
  highlight: string;
  glow: string;

  // UI elements
  badge: string;
  badgeText: string;
  separator: string;

  // Icons
  iconPrimary: string;
  iconSecondary: string;

  // Panels
  panelHeader: string;
  panelBorder: string;
  panelShadow: string;

  // Sparkline gradient (5 stops)
  sparkline: [string, string, string, string, string];
}

/**
 * Nucleotide color mapping
 */
export type NucleotideTheme = Record<Nucleotide, ColorPair>;

/**
 * Amino acid color mapping
 */
export type AminoTheme = Record<AminoAcid, ColorPair>;

/**
 * Complete theme definition
 */
export interface Theme {
  id: string;
  name: string;
  palette: ThemePalette;
  nucleotides: NucleotideTheme;
  aminoAcids: AminoTheme;
}

/**
 * Theme context value
 */
export interface ThemeContextValue {
  theme: Theme;
  themeId: string;
  setTheme: (id: string) => void;
  nextTheme: () => void;
  availableThemes: readonly Theme[];
}

/**
 * All available theme IDs
 */
export type ThemeId =
  | 'cyberpunk'
  | 'classic'
  | 'ocean'
  | 'matrix'
  | 'sunset'
  | 'forest'
  | 'pastel'
  | 'monochrome';
