import type { Nucleotide, AminoAcid } from './types';

// Color pair for foreground and background
export interface ColorPair {
  fg: string;
  bg: string;
}

// Nucleotide color theme
export type NucleotideTheme = Record<Nucleotide, ColorPair>;

// Amino acid color theme
export type AminoTheme = Record<AminoAcid, ColorPair>;

// HUD/UI color theme - Extended for rich visualizations
export interface HudTheme {
  // Core colors
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  backgroundAlt: string;      // Alternative/lighter background for panels

  // Text hierarchy
  text: string;
  textDim: string;
  textMuted: string;          // Even dimmer for background elements

  // Borders
  border: string;
  borderFocus: string;
  borderLight: string;        // Subtle inner borders

  // Status colors
  success: string;
  warning: string;
  error: string;
  info: string;               // Informational (blue-ish)

  // Specialized visualization colors
  diffHighlight: string;

  // Gene visualization
  geneForward: string;        // Forward strand genes
  geneReverse: string;        // Reverse strand genes
  geneHighlight: string;      // Currently selected gene

  // Analysis gradients (for sparklines)
  gradientLow: string;        // Low value in gradient
  gradientMid: string;        // Middle value
  gradientHigh: string;       // High value

  // K-mer and anomaly
  kmerNormal: string;         // Normal k-mer composition
  kmerAnomaly: string;        // Anomalous regions

  // Overlay effects
  shadow: string;             // For pseudo-shadow effects
  highlight: string;          // Bright highlight for selections

  // Enhanced visual elements
  sparklineGradient: string[];  // Extended gradient for sparklines (5+ colors)
  glow: string;                 // Glow effect color for focused elements
  badge: string;                // Badge/tag background
  badgeText: string;            // Badge/tag text
  separator: string;            // Visual separator color

  // Unicode decorations
  iconPrimary: string;          // Primary icon color
  iconSecondary: string;        // Secondary icon color

  // Panel styling
  panelHeader: string;          // Panel header background
  panelBorder: string;          // Panel border (distinct from main border)
  panelShadow: string;          // Panel shadow (darker)
}

// Complete theme definition
export interface Theme {
  id: string;
  name: string;
  colors: HudTheme;
  nucleotides: NucleotideTheme;
  aminoAcids: AminoTheme;
}

// Classic theme - vibrant colors based on traditional bioinformatics coloring
const classicNucleotides: NucleotideTheme = {
  'A': { fg: '#000000', bg: '#5cb85c' }, // Green
  'C': { fg: '#ffffff', bg: '#0275d8' }, // Blue
  'G': { fg: '#000000', bg: '#f0ad4e' }, // Amber/Yellow
  'T': { fg: '#ffffff', bg: '#d9534f' }, // Red
  'N': { fg: '#ffffff', bg: '#6c757d' }, // Gray
};

// RasMol-inspired amino acid colors (by property)
const classicAminoAcids: AminoTheme = {
  // Hydrophobic - orange/brown tones
  'A': { fg: '#000000', bg: '#c8c8c8' }, // Alanine - light gray
  'V': { fg: '#000000', bg: '#0f820f' }, // Valine - green
  'L': { fg: '#000000', bg: '#0f820f' }, // Leucine - green
  'I': { fg: '#000000', bg: '#0f820f' }, // Isoleucine - green
  'M': { fg: '#000000', bg: '#e6e600' }, // Methionine - yellow
  'F': { fg: '#ffffff', bg: '#3232aa' }, // Phenylalanine - blue
  'W': { fg: '#ffffff', bg: '#b45ab4' }, // Tryptophan - purple
  'P': { fg: '#000000', bg: '#dc9682' }, // Proline - salmon

  // Polar - teal/cyan tones
  'S': { fg: '#000000', bg: '#fa9600' }, // Serine - orange
  'T': { fg: '#000000', bg: '#fa9600' }, // Threonine - orange
  'Y': { fg: '#ffffff', bg: '#3232aa' }, // Tyrosine - blue
  'N': { fg: '#000000', bg: '#00dcdc' }, // Asparagine - cyan
  'Q': { fg: '#000000', bg: '#00dcdc' }, // Glutamine - cyan
  'C': { fg: '#000000', bg: '#e6e600' }, // Cysteine - yellow

  // Basic - blue tones
  'K': { fg: '#ffffff', bg: '#145aff' }, // Lysine - bright blue
  'R': { fg: '#ffffff', bg: '#145aff' }, // Arginine - bright blue
  'H': { fg: '#ffffff', bg: '#8282d2' }, // Histidine - light blue

  // Acidic - red tones
  'D': { fg: '#ffffff', bg: '#e60a0a' }, // Aspartate - red
  'E': { fg: '#ffffff', bg: '#e60a0a' }, // Glutamate - red

  // Special
  'G': { fg: '#000000', bg: '#ebebeb' }, // Glycine - white/light gray
  'X': { fg: '#ffffff', bg: '#6c757d' }, // Unknown

  // Stop codon
  '*': { fg: '#ffffff', bg: '#ff0000' }, // Stop - bright red
};

const classicHud: HudTheme = {
  // Core colors
  primary: '#5cb85c',
  secondary: '#0275d8',
  accent: '#f0ad4e',
  background: '#1a1a2e',
  backgroundAlt: '#252542',

  // Text hierarchy
  text: '#e0e0e0',
  textDim: '#8c8ca0',
  textMuted: '#4d4d66',

  // Borders
  border: '#3d3d5c',
  borderFocus: '#5cb85c',
  borderLight: '#2d2d4a',

  // Status colors
  success: '#5cb85c',
  warning: '#f0ad4e',
  error: '#d9534f',
  info: '#5bc0de',

  // Diff
  diffHighlight: '#ff6b6b',

  // Gene visualization
  geneForward: '#5cb85c',
  geneReverse: '#0275d8',
  geneHighlight: '#f0ad4e',

  // Analysis gradients
  gradientLow: '#264653',
  gradientMid: '#2a9d8f',
  gradientHigh: '#e9c46a',

  // K-mer
  kmerNormal: '#6c757d',
  kmerAnomaly: '#e76f51',

  // Effects
  shadow: '#0d0d1a',
  highlight: '#ffffff',

  // Enhanced visual elements
  sparklineGradient: ['#1a535c', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
  glow: '#5cb85c',
  badge: '#3d3d5c',
  badgeText: '#e0e0e0',
  separator: '#4d4d66',

  // Unicode decorations
  iconPrimary: '#5cb85c',
  iconSecondary: '#0275d8',

  // Panel styling
  panelHeader: '#2a2a42',
  panelBorder: '#4d4d6c',
  panelShadow: '#0a0a15',
};

export const CLASSIC_THEME: Theme = {
  id: 'classic',
  name: 'Classic',
  colors: classicHud,
  nucleotides: classicNucleotides,
  aminoAcids: classicAminoAcids,
};

// Ocean theme - cooler, blue-based palette
const oceanNucleotides: NucleotideTheme = {
  'A': { fg: '#ffffff', bg: '#1a535c' }, // Teal
  'C': { fg: '#ffffff', bg: '#4ecdc4' }, // Cyan
  'G': { fg: '#000000', bg: '#ffe66d' }, // Yellow
  'T': { fg: '#ffffff', bg: '#ff6b6b' }, // Coral
  'N': { fg: '#ffffff', bg: '#495057' }, // Gray
};

const oceanAminoAcids: AminoTheme = {
  'A': { fg: '#000000', bg: '#a8dadc' },
  'V': { fg: '#ffffff', bg: '#457b9d' },
  'L': { fg: '#ffffff', bg: '#457b9d' },
  'I': { fg: '#ffffff', bg: '#457b9d' },
  'M': { fg: '#000000', bg: '#e9c46a' },
  'F': { fg: '#ffffff', bg: '#264653' },
  'W': { fg: '#ffffff', bg: '#6d597a' },
  'P': { fg: '#000000', bg: '#f4a261' },
  'S': { fg: '#000000', bg: '#2a9d8f' },
  'T': { fg: '#000000', bg: '#2a9d8f' },
  'Y': { fg: '#ffffff', bg: '#264653' },
  'N': { fg: '#000000', bg: '#48cae4' },
  'Q': { fg: '#000000', bg: '#48cae4' },
  'C': { fg: '#000000', bg: '#e9c46a' },
  'K': { fg: '#ffffff', bg: '#023e8a' },
  'R': { fg: '#ffffff', bg: '#023e8a' },
  'H': { fg: '#ffffff', bg: '#0077b6' },
  'D': { fg: '#ffffff', bg: '#e63946' },
  'E': { fg: '#ffffff', bg: '#e63946' },
  'G': { fg: '#000000', bg: '#f1faee' },
  '*': { fg: '#ffffff', bg: '#d62828' },
  'X': { fg: '#ffffff', bg: '#495057' },
};

const oceanHud: HudTheme = {
  // Core colors
  primary: '#4ecdc4',
  secondary: '#1a535c',
  accent: '#ffe66d',
  background: '#0a1628',
  backgroundAlt: '#142840',

  // Text hierarchy
  text: '#e0f7fa',
  textDim: '#7ca0b8',
  textMuted: '#3d5a6d',

  // Borders
  border: '#264653',
  borderFocus: '#4ecdc4',
  borderLight: '#1a3342',

  // Status colors
  success: '#4ecdc4',
  warning: '#ffe66d',
  error: '#ff6b6b',
  info: '#48cae4',

  // Diff
  diffHighlight: '#ff9f1c',

  // Gene visualization
  geneForward: '#4ecdc4',
  geneReverse: '#1a535c',
  geneHighlight: '#ffe66d',

  // Analysis gradients
  gradientLow: '#0a2342',
  gradientMid: '#2a9d8f',
  gradientHigh: '#48cae4',

  // K-mer
  kmerNormal: '#5c7080',
  kmerAnomaly: '#ff6b6b',

  // Effects
  shadow: '#050d14',
  highlight: '#ffffff',

  // Enhanced visual elements
  sparklineGradient: ['#0a2342', '#1a535c', '#2a9d8f', '#48cae4', '#ffe66d'],
  glow: '#4ecdc4',
  badge: '#264653',
  badgeText: '#e0f7fa',
  separator: '#3d5a6d',

  // Unicode decorations
  iconPrimary: '#4ecdc4',
  iconSecondary: '#ffe66d',

  // Panel styling
  panelHeader: '#1a3342',
  panelBorder: '#264653',
  panelShadow: '#030810',
};

export const OCEAN_THEME: Theme = {
  id: 'ocean',
  name: 'Ocean',
  colors: oceanHud,
  nucleotides: oceanNucleotides,
  aminoAcids: oceanAminoAcids,
};

// Matrix theme - classic green terminal style
const matrixNucleotides: NucleotideTheme = {
  'A': { fg: '#00ff00', bg: '#001400' },
  'C': { fg: '#00cc00', bg: '#001100' },
  'G': { fg: '#00ff66', bg: '#001600' },
  'T': { fg: '#33ff33', bg: '#001800' },
  'N': { fg: '#006600', bg: '#000800' },
};

const matrixAminoAcids: AminoTheme = {
  'A': { fg: '#00ff00', bg: '#001000' },
  'V': { fg: '#00ee00', bg: '#000e00' },
  'L': { fg: '#00dd00', bg: '#000c00' },
  'I': { fg: '#00cc00', bg: '#000a00' },
  'M': { fg: '#33ff33', bg: '#001400' },
  'F': { fg: '#00bb00', bg: '#000800' },
  'W': { fg: '#00aa00', bg: '#000600' },
  'P': { fg: '#00ff66', bg: '#001200' },
  'S': { fg: '#66ff66', bg: '#001600' },
  'T': { fg: '#66ff66', bg: '#001600' },
  'Y': { fg: '#00bb00', bg: '#000800' },
  'N': { fg: '#99ff99', bg: '#001a00' },
  'Q': { fg: '#99ff99', bg: '#001a00' },
  'C': { fg: '#33ff33', bg: '#001400' },
  'K': { fg: '#00ffcc', bg: '#001000' },
  'R': { fg: '#00ffcc', bg: '#001000' },
  'H': { fg: '#00ff99', bg: '#000e00' },
  'D': { fg: '#ff3300', bg: '#140000' },
  'E': { fg: '#ff3300', bg: '#140000' },
  'G': { fg: '#ccffcc', bg: '#001c00' },
  '*': { fg: '#ff0000', bg: '#1a0000' },
  'X': { fg: '#006600', bg: '#000800' },
};

const matrixHud: HudTheme = {
  // Core colors
  primary: '#00ff00',
  secondary: '#00cc00',
  accent: '#00ff66',
  background: '#000000',
  backgroundAlt: '#0a1a0a',

  // Text hierarchy
  text: '#00ff00',
  textDim: '#00aa00',
  textMuted: '#005500',

  // Borders
  border: '#003300',
  borderFocus: '#00ff00',
  borderLight: '#002200',

  // Status colors
  success: '#00ff00',
  warning: '#ffff00',
  error: '#ff0000',
  info: '#00ffff',

  // Diff
  diffHighlight: '#ff6600',

  // Gene visualization
  geneForward: '#00ff00',
  geneReverse: '#00cc00',
  geneHighlight: '#00ff66',

  // Analysis gradients
  gradientLow: '#001a00',
  gradientMid: '#00aa00',
  gradientHigh: '#00ff00',

  // K-mer
  kmerNormal: '#006600',
  kmerAnomaly: '#ff3300',

  // Effects
  shadow: '#000000',
  highlight: '#33ff33',

  // Enhanced visual elements
  sparklineGradient: ['#001a00', '#003300', '#006600', '#00aa00', '#00ff00'],
  glow: '#00ff00',
  badge: '#003300',
  badgeText: '#00ff00',
  separator: '#005500',

  // Unicode decorations
  iconPrimary: '#00ff00',
  iconSecondary: '#00ff66',

  // Panel styling
  panelHeader: '#0a1a0a',
  panelBorder: '#004400',
  panelShadow: '#000000',
};

export const MATRIX_THEME: Theme = {
  id: 'matrix',
  name: 'Matrix',
  colors: matrixHud,
  nucleotides: matrixNucleotides,
  aminoAcids: matrixAminoAcids,
};

// Sunset theme - warm colors
const sunsetNucleotides: NucleotideTheme = {
  'A': { fg: '#ffffff', bg: '#ff6b35' }, // Orange
  'C': { fg: '#ffffff', bg: '#f7c59f' }, // Peach
  'G': { fg: '#000000', bg: '#efa00b' }, // Gold
  'T': { fg: '#ffffff', bg: '#d62246' }, // Rose
  'N': { fg: '#ffffff', bg: '#4a4e69' }, // Slate
};

const sunsetAminoAcids: AminoTheme = {
  'A': { fg: '#000000', bg: '#ffd166' },
  'V': { fg: '#ffffff', bg: '#ef476f' },
  'L': { fg: '#ffffff', bg: '#ef476f' },
  'I': { fg: '#ffffff', bg: '#ef476f' },
  'M': { fg: '#000000', bg: '#ffd166' },
  'F': { fg: '#ffffff', bg: '#9b2335' },
  'W': { fg: '#ffffff', bg: '#6b2737' },
  'P': { fg: '#000000', bg: '#f78c6b' },
  'S': { fg: '#000000', bg: '#83c5be' },
  'T': { fg: '#000000', bg: '#83c5be' },
  'Y': { fg: '#ffffff', bg: '#9b2335' },
  'N': { fg: '#000000', bg: '#edf6f9' },
  'Q': { fg: '#000000', bg: '#edf6f9' },
  'C': { fg: '#000000', bg: '#ffd166' },
  'K': { fg: '#ffffff', bg: '#118ab2' },
  'R': { fg: '#ffffff', bg: '#118ab2' },
  'H': { fg: '#ffffff', bg: '#06d6a0' },
  'D': { fg: '#ffffff', bg: '#d62246' },
  'E': { fg: '#ffffff', bg: '#d62246' },
  'G': { fg: '#000000', bg: '#fefae0' },
  'X': { fg: '#ffffff', bg: '#4a4e69' },
  '*': { fg: '#ffffff', bg: '#9b2335' },
};

const sunsetHud: HudTheme = {
  // Core colors
  primary: '#ff6b35',
  secondary: '#f7c59f',
  accent: '#efa00b',
  background: '#1e1e2f',
  backgroundAlt: '#2a2a42',

  // Text hierarchy
  text: '#fefae0',
  textDim: '#b8a8b0',
  textMuted: '#6a5a68',

  // Borders
  border: '#4a4e69',
  borderFocus: '#ff6b35',
  borderLight: '#3a3a52',

  // Status colors
  success: '#06d6a0',
  warning: '#ffd166',
  error: '#d62246',
  info: '#118ab2',

  // Diff
  diffHighlight: '#ef476f',

  // Gene visualization
  geneForward: '#ff6b35',
  geneReverse: '#f7c59f',
  geneHighlight: '#efa00b',

  // Analysis gradients
  gradientLow: '#2d1b30',
  gradientMid: '#ff6b35',
  gradientHigh: '#ffd166',

  // K-mer
  kmerNormal: '#9a8c98',
  kmerAnomaly: '#d62246',

  // Effects
  shadow: '#0f0f1a',
  highlight: '#ffffff',

  // Enhanced visual elements
  sparklineGradient: ['#2d1b30', '#6b2737', '#d62246', '#ff6b35', '#ffd166'],
  glow: '#ff6b35',
  badge: '#4a4e69',
  badgeText: '#fefae0',
  separator: '#6a5a68',

  // Unicode decorations
  iconPrimary: '#ff6b35',
  iconSecondary: '#efa00b',

  // Panel styling
  panelHeader: '#2a2a42',
  panelBorder: '#5a4e69',
  panelShadow: '#0a0a12',
};

export const SUNSET_THEME: Theme = {
  id: 'sunset',
  name: 'Sunset',
  colors: sunsetHud,
  nucleotides: sunsetNucleotides,
  aminoAcids: sunsetAminoAcids,
};

// Forest theme - natural greens and earth tones
const forestNucleotides: NucleotideTheme = {
  'A': { fg: '#ffffff', bg: '#2d6a4f' }, // Forest green
  'C': { fg: '#ffffff', bg: '#40916c' }, // Medium green
  'G': { fg: '#000000', bg: '#95d5b2' }, // Light green
  'T': { fg: '#ffffff', bg: '#8b4513' }, // Saddle brown
  'N': { fg: '#ffffff', bg: '#6b705c' }, // Olive gray
};

const forestAminoAcids: AminoTheme = {
  'A': { fg: '#000000', bg: '#b7e4c7' },
  'V': { fg: '#ffffff', bg: '#2d6a4f' },
  'L': { fg: '#ffffff', bg: '#2d6a4f' },
  'I': { fg: '#ffffff', bg: '#2d6a4f' },
  'M': { fg: '#000000', bg: '#d4a373' },
  'F': { fg: '#ffffff', bg: '#1b4332' },
  'W': { fg: '#ffffff', bg: '#081c15' },
  'P': { fg: '#000000', bg: '#ccd5ae' },
  'S': { fg: '#000000', bg: '#95d5b2' },
  'T': { fg: '#000000', bg: '#95d5b2' },
  'Y': { fg: '#ffffff', bg: '#1b4332' },
  'N': { fg: '#000000', bg: '#d8f3dc' },
  'Q': { fg: '#000000', bg: '#d8f3dc' },
  'C': { fg: '#000000', bg: '#d4a373' },
  'K': { fg: '#ffffff', bg: '#344e41' },
  'R': { fg: '#ffffff', bg: '#344e41' },
  'H': { fg: '#ffffff', bg: '#588157' },
  'D': { fg: '#ffffff', bg: '#bc4749' },
  'E': { fg: '#ffffff', bg: '#bc4749' },
  'G': { fg: '#000000', bg: '#f0ead2' },
  'X': { fg: '#ffffff', bg: '#6b705c' },
  '*': { fg: '#ffffff', bg: '#9b2226' },
};

const forestHud: HudTheme = {
  // Core colors
  primary: '#40916c',
  secondary: '#2d6a4f',
  accent: '#95d5b2',
  background: '#0d1b0f',
  backgroundAlt: '#1a2e1f',

  // Text hierarchy
  text: '#d8f3dc',
  textDim: '#8fa890',
  textMuted: '#4a5c4d',

  // Borders
  border: '#344e41',
  borderFocus: '#40916c',
  borderLight: '#263832',

  // Status colors
  success: '#40916c',
  warning: '#d4a373',
  error: '#bc4749',
  info: '#588157',

  // Diff
  diffHighlight: '#e9c46a',

  // Gene visualization
  geneForward: '#40916c',
  geneReverse: '#2d6a4f',
  geneHighlight: '#95d5b2',

  // Analysis gradients
  gradientLow: '#1b4332',
  gradientMid: '#40916c',
  gradientHigh: '#95d5b2',

  // K-mer
  kmerNormal: '#6b705c',
  kmerAnomaly: '#bc4749',

  // Effects
  shadow: '#061008',
  highlight: '#b7e4c7',

  // Enhanced visual elements
  sparklineGradient: ['#1b4332', '#2d6a4f', '#40916c', '#74c69d', '#b7e4c7'],
  glow: '#40916c',
  badge: '#344e41',
  badgeText: '#d8f3dc',
  separator: '#4a5c4d',

  // Unicode decorations
  iconPrimary: '#40916c',
  iconSecondary: '#95d5b2',

  // Panel styling
  panelHeader: '#1a2e1f',
  panelBorder: '#344e41',
  panelShadow: '#030805',
};

export const FOREST_THEME: Theme = {
  id: 'forest',
  name: 'Forest',
  colors: forestHud,
  nucleotides: forestNucleotides,
  aminoAcids: forestAminoAcids,
};

// Cyberpunk theme - neon on dark, futuristic vibes
const cyberpunkNucleotides: NucleotideTheme = {
  'A': { fg: '#000000', bg: '#00ffff' }, // Cyan
  'C': { fg: '#000000', bg: '#ff00ff' }, // Magenta
  'G': { fg: '#000000', bg: '#ffff00' }, // Yellow
  'T': { fg: '#000000', bg: '#ff0080' }, // Hot pink
  'N': { fg: '#ffffff', bg: '#2a2a3a' }, // Dark
};

const cyberpunkAminoAcids: AminoTheme = {
  'A': { fg: '#000000', bg: '#00e5ff' },
  'V': { fg: '#000000', bg: '#7b1fa2' },
  'L': { fg: '#000000', bg: '#7b1fa2' },
  'I': { fg: '#000000', bg: '#7b1fa2' },
  'M': { fg: '#000000', bg: '#ffea00' },
  'F': { fg: '#ffffff', bg: '#4a148c' },
  'W': { fg: '#ffffff', bg: '#311b92' },
  'P': { fg: '#000000', bg: '#ff6d00' },
  'S': { fg: '#000000', bg: '#00e676' },
  'T': { fg: '#000000', bg: '#00e676' },
  'Y': { fg: '#ffffff', bg: '#4a148c' },
  'N': { fg: '#000000', bg: '#18ffff' },
  'Q': { fg: '#000000', bg: '#18ffff' },
  'C': { fg: '#000000', bg: '#ffea00' },
  'K': { fg: '#ffffff', bg: '#0091ea' },
  'R': { fg: '#ffffff', bg: '#0091ea' },
  'H': { fg: '#000000', bg: '#00b0ff' },
  'D': { fg: '#ffffff', bg: '#f50057' },
  'E': { fg: '#ffffff', bg: '#f50057' },
  'G': { fg: '#000000', bg: '#e0e0e0' },
  '*': { fg: '#ffffff', bg: '#ff1744' },
  'X': { fg: '#ffffff', bg: '#2a2a3a' },
};

const cyberpunkHud: HudTheme = {
  // Core colors - neon vibes
  primary: '#00ffff',
  secondary: '#ff00ff',
  accent: '#ffff00',
  background: '#0d0d1a',
  backgroundAlt: '#1a1a2e',

  // Text hierarchy
  text: '#e0e0ff',
  textDim: '#8888aa',
  textMuted: '#555577',

  // Borders - glowing effect
  border: '#ff00ff',
  borderFocus: '#00ffff',
  borderLight: '#4a4a6a',

  // Status colors
  success: '#00ff88',
  warning: '#ffff00',
  error: '#ff0055',
  info: '#00e5ff',

  // Diff
  diffHighlight: '#ff00ff',

  // Gene visualization
  geneForward: '#00ffff',
  geneReverse: '#ff00ff',
  geneHighlight: '#ffff00',

  // Analysis gradients
  gradientLow: '#1a0a2e',
  gradientMid: '#ff00ff',
  gradientHigh: '#00ffff',

  // K-mer
  kmerNormal: '#6666aa',
  kmerAnomaly: '#ff0055',

  // Effects
  shadow: '#000000',
  highlight: '#ffffff',

  // Enhanced visual elements
  sparklineGradient: ['#1a0a2e', '#7b1fa2', '#ff00ff', '#00ffff', '#00ff88'],
  glow: '#ff00ff',
  badge: '#2a2a4a',
  badgeText: '#00ffff',
  separator: '#ff00ff',

  // Unicode decorations
  iconPrimary: '#00ffff',
  iconSecondary: '#ff00ff',

  // Panel styling
  panelHeader: '#1a1a3a',
  panelBorder: '#ff00ff',
  panelShadow: '#050510',
};

export const CYBERPUNK_THEME: Theme = {
  id: 'cyberpunk',
  name: 'Cyberpunk',
  colors: cyberpunkHud,
  nucleotides: cyberpunkNucleotides,
  aminoAcids: cyberpunkAminoAcids,
};

// Pastel theme - soft, accessible colors
const pastelNucleotides: NucleotideTheme = {
  'A': { fg: '#2d3436', bg: '#a8e6cf' }, // Mint
  'C': { fg: '#2d3436', bg: '#dcedc1' }, // Light green
  'G': { fg: '#2d3436', bg: '#ffd3b6' }, // Peach
  'T': { fg: '#2d3436', bg: '#ffaaa5' }, // Salmon
  'N': { fg: '#636e72', bg: '#dfe6e9' }, // Light gray
};

const pastelAminoAcids: AminoTheme = {
  'A': { fg: '#2d3436', bg: '#b8e0d2' },
  'V': { fg: '#2d3436', bg: '#95b8d1' },
  'L': { fg: '#2d3436', bg: '#95b8d1' },
  'I': { fg: '#2d3436', bg: '#95b8d1' },
  'M': { fg: '#2d3436', bg: '#f0e6ef' },
  'F': { fg: '#2d3436', bg: '#d4a5a5' },
  'W': { fg: '#2d3436', bg: '#c9b1ff' },
  'P': { fg: '#2d3436', bg: '#ffd6a5' },
  'S': { fg: '#2d3436', bg: '#caffbf' },
  'T': { fg: '#2d3436', bg: '#caffbf' },
  'Y': { fg: '#2d3436', bg: '#d4a5a5' },
  'N': { fg: '#2d3436', bg: '#9bf6ff' },
  'Q': { fg: '#2d3436', bg: '#9bf6ff' },
  'C': { fg: '#2d3436', bg: '#fdffb6' },
  'K': { fg: '#2d3436', bg: '#a0c4ff' },
  'R': { fg: '#2d3436', bg: '#a0c4ff' },
  'H': { fg: '#2d3436', bg: '#bdb2ff' },
  'D': { fg: '#2d3436', bg: '#ffc6ff' },
  'E': { fg: '#2d3436', bg: '#ffc6ff' },
  'G': { fg: '#2d3436', bg: '#f0f0f0' },
  '*': { fg: '#2d3436', bg: '#ffb5b5' },
  'X': { fg: '#636e72', bg: '#dfe6e9' },
};

const pastelHud: HudTheme = {
  // Core colors - soft and pleasant
  primary: '#74b9ff',
  secondary: '#a29bfe',
  accent: '#ffeaa7',
  background: '#f8f9fa',
  backgroundAlt: '#ffffff',

  // Text hierarchy
  text: '#2d3436',
  textDim: '#636e72',
  textMuted: '#b2bec3',

  // Borders
  border: '#dfe6e9',
  borderFocus: '#74b9ff',
  borderLight: '#e8eaed',

  // Status colors
  success: '#00cec9',
  warning: '#fdcb6e',
  error: '#ff7675',
  info: '#74b9ff',

  // Diff
  diffHighlight: '#fab1a0',

  // Gene visualization
  geneForward: '#55efc4',
  geneReverse: '#81ecec',
  geneHighlight: '#ffeaa7',

  // Analysis gradients
  gradientLow: '#dfe6e9',
  gradientMid: '#74b9ff',
  gradientHigh: '#00b894',

  // K-mer
  kmerNormal: '#b2bec3',
  kmerAnomaly: '#e17055',

  // Effects
  shadow: '#c8d6e5',
  highlight: '#ffffff',

  // Enhanced visual elements
  sparklineGradient: ['#dfe6e9', '#a8e6cf', '#74b9ff', '#a29bfe', '#fd79a8'],
  glow: '#74b9ff',
  badge: '#e8eaed',
  badgeText: '#2d3436',
  separator: '#dfe6e9',

  // Unicode decorations
  iconPrimary: '#74b9ff',
  iconSecondary: '#a29bfe',

  // Panel styling
  panelHeader: '#f1f2f6',
  panelBorder: '#dfe6e9',
  panelShadow: '#e8eaed',
};

export const PASTEL_THEME: Theme = {
  id: 'pastel',
  name: 'Pastel',
  colors: pastelHud,
  nucleotides: pastelNucleotides,
  aminoAcids: pastelAminoAcids,
};

// Monochrome theme - elegant grayscale with accents
const monochromeNucleotides: NucleotideTheme = {
  'A': { fg: '#ffffff', bg: '#1a1a1a' }, // Darkest
  'C': { fg: '#ffffff', bg: '#3a3a3a' }, // Dark
  'G': { fg: '#000000', bg: '#8a8a8a' }, // Medium
  'T': { fg: '#000000', bg: '#c0c0c0' }, // Light
  'N': { fg: '#ffffff', bg: '#555555' }, // Mid-gray
};

const monochromeAminoAcids: AminoTheme = {
  'A': { fg: '#000000', bg: '#d0d0d0' },
  'V': { fg: '#ffffff', bg: '#404040' },
  'L': { fg: '#ffffff', bg: '#404040' },
  'I': { fg: '#ffffff', bg: '#404040' },
  'M': { fg: '#000000', bg: '#b0b0b0' },
  'F': { fg: '#ffffff', bg: '#303030' },
  'W': { fg: '#ffffff', bg: '#202020' },
  'P': { fg: '#000000', bg: '#909090' },
  'S': { fg: '#000000', bg: '#c0c0c0' },
  'T': { fg: '#000000', bg: '#c0c0c0' },
  'Y': { fg: '#ffffff', bg: '#303030' },
  'N': { fg: '#000000', bg: '#e0e0e0' },
  'Q': { fg: '#000000', bg: '#e0e0e0' },
  'C': { fg: '#000000', bg: '#b0b0b0' },
  'K': { fg: '#ffffff', bg: '#505050' },
  'R': { fg: '#ffffff', bg: '#505050' },
  'H': { fg: '#000000', bg: '#707070' },
  'D': { fg: '#000000', bg: '#a0a0a0' },
  'E': { fg: '#000000', bg: '#a0a0a0' },
  'G': { fg: '#000000', bg: '#f0f0f0' },
  '*': { fg: '#ffffff', bg: '#000000' },
  'X': { fg: '#ffffff', bg: '#555555' },
};

const monochromeHud: HudTheme = {
  // Core colors - elegant grayscale
  primary: '#ffffff',
  secondary: '#b0b0b0',
  accent: '#ffd700',  // Gold accent for important elements
  background: '#0a0a0a',
  backgroundAlt: '#151515',

  // Text hierarchy
  text: '#e0e0e0',
  textDim: '#808080',
  textMuted: '#505050',

  // Borders
  border: '#404040',
  borderFocus: '#ffd700',
  borderLight: '#303030',

  // Status colors
  success: '#90ee90',
  warning: '#ffd700',
  error: '#ff6b6b',
  info: '#87ceeb',

  // Diff
  diffHighlight: '#ffd700',

  // Gene visualization
  geneForward: '#c0c0c0',
  geneReverse: '#707070',
  geneHighlight: '#ffd700',

  // Analysis gradients
  gradientLow: '#202020',
  gradientMid: '#606060',
  gradientHigh: '#c0c0c0',

  // K-mer
  kmerNormal: '#505050',
  kmerAnomaly: '#ff6b6b',

  // Effects
  shadow: '#000000',
  highlight: '#ffffff',

  // Enhanced visual elements
  sparklineGradient: ['#202020', '#404040', '#606060', '#909090', '#c0c0c0'],
  glow: '#ffd700',
  badge: '#303030',
  badgeText: '#e0e0e0',
  separator: '#404040',

  // Unicode decorations
  iconPrimary: '#ffd700',
  iconSecondary: '#c0c0c0',

  // Panel styling
  panelHeader: '#1a1a1a',
  panelBorder: '#505050',
  panelShadow: '#000000',
};

export const MONOCHROME_THEME: Theme = {
  id: 'monochrome',
  name: 'Monochrome',
  colors: monochromeHud,
  nucleotides: monochromeNucleotides,
  aminoAcids: monochromeAminoAcids,
};

// All available themes
export const THEMES: Theme[] = [
  CLASSIC_THEME,
  OCEAN_THEME,
  MATRIX_THEME,
  SUNSET_THEME,
  FOREST_THEME,
  CYBERPUNK_THEME,
  PASTEL_THEME,
  MONOCHROME_THEME,
];

// Get theme by ID
export function getThemeById(id: string): Theme {
  return THEMES.find(t => t.id === id) ?? CLASSIC_THEME;
}

// Get next theme in cycle
export function getNextTheme(currentId: string): Theme {
  const currentIndex = THEMES.findIndex(t => t.id === currentId);
  const nextIndex = (currentIndex + 1) % THEMES.length;
  return THEMES[nextIndex];
}

// Get nucleotide color for a character
export function getNucleotideColor(theme: Theme, nucleotide: string): ColorPair {
  const upper = nucleotide.toUpperCase() as Nucleotide;
  return theme.nucleotides[upper] ?? theme.nucleotides['N'];
}

// Get amino acid color for a character
export function getAminoAcidColor(theme: Theme, aminoAcid: string): ColorPair {
  const upper = aminoAcid.toUpperCase() as AminoAcid;
  return theme.aminoAcids[upper] ?? theme.aminoAcids['*'];
}
