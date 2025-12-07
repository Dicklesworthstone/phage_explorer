/**
 * Theme Definitions for Phage Explorer Web
 *
 * Ported from @phage-explorer/core/themes.ts
 * Optimized for CSS custom properties
 */

import type { Theme, NucleotideTheme, AminoTheme, ThemePalette } from './types';

// ============================================================================
// CYBERPUNK THEME (Default)
// ============================================================================

const cyberpunkPalette: ThemePalette = {
  primary: '#00ffff',
  secondary: '#ff00ff',
  accent: '#ffff00',
  background: '#0d0d1a',
  backgroundAlt: '#1a1a2e',
  text: '#e0e0ff',
  textDim: '#8888aa',
  textMuted: '#555577',
  border: '#ff00ff',
  borderFocus: '#00ffff',
  borderLight: '#4a4a6a',
  success: '#00ff88',
  warning: '#ffff00',
  error: '#ff0055',
  info: '#00e5ff',
  diffHighlight: '#ff00ff',
  geneForward: '#00ffff',
  geneReverse: '#ff00ff',
  geneHighlight: '#ffff00',
  gradientLow: '#1a0a2e',
  gradientMid: '#ff00ff',
  gradientHigh: '#00ffff',
  kmerNormal: '#6666aa',
  kmerAnomaly: '#ff0055',
  shadow: '#000000',
  highlight: '#ffffff',
  glow: '#ff00ff',
  badge: '#2a2a4a',
  badgeText: '#00ffff',
  separator: '#ff00ff',
  iconPrimary: '#00ffff',
  iconSecondary: '#ff00ff',
  panelHeader: '#1a1a3a',
  panelBorder: '#ff00ff',
  panelShadow: '#050510',
  sparkline: ['#1a0a2e', '#7b1fa2', '#ff00ff', '#00ffff', '#00ff88'],
};

const cyberpunkNucleotides: NucleotideTheme = {
  A: { fg: '#000000', bg: '#00ffff' },
  C: { fg: '#000000', bg: '#ff00ff' },
  G: { fg: '#000000', bg: '#ffff00' },
  T: { fg: '#000000', bg: '#ff0080' },
  N: { fg: '#ffffff', bg: '#2a2a3a' },
};

const cyberpunkAminoAcids: AminoTheme = {
  A: { fg: '#000000', bg: '#00e5ff' },
  V: { fg: '#000000', bg: '#7b1fa2' },
  L: { fg: '#000000', bg: '#7b1fa2' },
  I: { fg: '#000000', bg: '#7b1fa2' },
  M: { fg: '#000000', bg: '#ffea00' },
  F: { fg: '#ffffff', bg: '#4a148c' },
  W: { fg: '#ffffff', bg: '#311b92' },
  P: { fg: '#000000', bg: '#ff6d00' },
  S: { fg: '#000000', bg: '#00e676' },
  T: { fg: '#000000', bg: '#00e676' },
  Y: { fg: '#ffffff', bg: '#4a148c' },
  N: { fg: '#000000', bg: '#18ffff' },
  Q: { fg: '#000000', bg: '#18ffff' },
  C: { fg: '#000000', bg: '#ffea00' },
  K: { fg: '#ffffff', bg: '#0091ea' },
  R: { fg: '#ffffff', bg: '#0091ea' },
  H: { fg: '#000000', bg: '#00b0ff' },
  D: { fg: '#ffffff', bg: '#f50057' },
  E: { fg: '#ffffff', bg: '#f50057' },
  G: { fg: '#000000', bg: '#e0e0e0' },
  '*': { fg: '#ffffff', bg: '#ff1744' },
  X: { fg: '#ffffff', bg: '#2a2a3a' },
};

export const CYBERPUNK_THEME: Theme = {
  id: 'cyberpunk',
  name: 'Cyberpunk',
  palette: cyberpunkPalette,
  nucleotides: cyberpunkNucleotides,
  aminoAcids: cyberpunkAminoAcids,
};

// ============================================================================
// CLASSIC THEME
// ============================================================================

const classicPalette: ThemePalette = {
  primary: '#5cb85c',
  secondary: '#0275d8',
  accent: '#f0ad4e',
  background: '#1a1a2e',
  backgroundAlt: '#252542',
  text: '#e0e0e0',
  textDim: '#8c8ca0',
  textMuted: '#4d4d66',
  border: '#3d3d5c',
  borderFocus: '#5cb85c',
  borderLight: '#2d2d4a',
  success: '#5cb85c',
  warning: '#f0ad4e',
  error: '#d9534f',
  info: '#5bc0de',
  diffHighlight: '#ff6b6b',
  geneForward: '#5cb85c',
  geneReverse: '#0275d8',
  geneHighlight: '#f0ad4e',
  gradientLow: '#264653',
  gradientMid: '#2a9d8f',
  gradientHigh: '#e9c46a',
  kmerNormal: '#6c757d',
  kmerAnomaly: '#e76f51',
  shadow: '#0d0d1a',
  highlight: '#ffffff',
  glow: '#5cb85c',
  badge: '#3d3d5c',
  badgeText: '#e0e0e0',
  separator: '#4d4d66',
  iconPrimary: '#5cb85c',
  iconSecondary: '#0275d8',
  panelHeader: '#2a2a42',
  panelBorder: '#4d4d6c',
  panelShadow: '#0a0a15',
  sparkline: ['#1a535c', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
};

const classicNucleotides: NucleotideTheme = {
  A: { fg: '#000000', bg: '#5cb85c' },
  C: { fg: '#ffffff', bg: '#0275d8' },
  G: { fg: '#000000', bg: '#f0ad4e' },
  T: { fg: '#ffffff', bg: '#d9534f' },
  N: { fg: '#ffffff', bg: '#6c757d' },
};

const classicAminoAcids: AminoTheme = {
  A: { fg: '#000000', bg: '#c8c8c8' },
  V: { fg: '#000000', bg: '#0f820f' },
  L: { fg: '#000000', bg: '#0f820f' },
  I: { fg: '#000000', bg: '#0f820f' },
  M: { fg: '#000000', bg: '#e6e600' },
  F: { fg: '#ffffff', bg: '#3232aa' },
  W: { fg: '#ffffff', bg: '#b45ab4' },
  P: { fg: '#000000', bg: '#dc9682' },
  S: { fg: '#000000', bg: '#fa9600' },
  T: { fg: '#000000', bg: '#fa9600' },
  Y: { fg: '#ffffff', bg: '#3232aa' },
  N: { fg: '#000000', bg: '#00dcdc' },
  Q: { fg: '#000000', bg: '#00dcdc' },
  C: { fg: '#000000', bg: '#e6e600' },
  K: { fg: '#ffffff', bg: '#145aff' },
  R: { fg: '#ffffff', bg: '#145aff' },
  H: { fg: '#ffffff', bg: '#8282d2' },
  D: { fg: '#ffffff', bg: '#e60a0a' },
  E: { fg: '#ffffff', bg: '#e60a0a' },
  G: { fg: '#000000', bg: '#ebebeb' },
  X: { fg: '#ffffff', bg: '#6c757d' },
  '*': { fg: '#ffffff', bg: '#ff0000' },
};

export const CLASSIC_THEME: Theme = {
  id: 'classic',
  name: 'Classic',
  palette: classicPalette,
  nucleotides: classicNucleotides,
  aminoAcids: classicAminoAcids,
};

// ============================================================================
// OCEAN THEME
// ============================================================================

const oceanPalette: ThemePalette = {
  primary: '#4ecdc4',
  secondary: '#1a535c',
  accent: '#ffe66d',
  background: '#0a1628',
  backgroundAlt: '#142840',
  text: '#e0f7fa',
  textDim: '#7ca0b8',
  textMuted: '#3d5a6d',
  border: '#264653',
  borderFocus: '#4ecdc4',
  borderLight: '#1a3342',
  success: '#4ecdc4',
  warning: '#ffe66d',
  error: '#ff6b6b',
  info: '#48cae4',
  diffHighlight: '#ff9f1c',
  geneForward: '#4ecdc4',
  geneReverse: '#1a535c',
  geneHighlight: '#ffe66d',
  gradientLow: '#0a2342',
  gradientMid: '#2a9d8f',
  gradientHigh: '#48cae4',
  kmerNormal: '#5c7080',
  kmerAnomaly: '#ff6b6b',
  shadow: '#050d14',
  highlight: '#ffffff',
  glow: '#4ecdc4',
  badge: '#264653',
  badgeText: '#e0f7fa',
  separator: '#3d5a6d',
  iconPrimary: '#4ecdc4',
  iconSecondary: '#ffe66d',
  panelHeader: '#1a3342',
  panelBorder: '#264653',
  panelShadow: '#030810',
  sparkline: ['#0a2342', '#1a535c', '#2a9d8f', '#48cae4', '#ffe66d'],
};

const oceanNucleotides: NucleotideTheme = {
  A: { fg: '#ffffff', bg: '#1a535c' },
  C: { fg: '#ffffff', bg: '#4ecdc4' },
  G: { fg: '#000000', bg: '#ffe66d' },
  T: { fg: '#ffffff', bg: '#ff6b6b' },
  N: { fg: '#ffffff', bg: '#495057' },
};

const oceanAminoAcids: AminoTheme = {
  A: { fg: '#000000', bg: '#a8dadc' },
  V: { fg: '#ffffff', bg: '#457b9d' },
  L: { fg: '#ffffff', bg: '#457b9d' },
  I: { fg: '#ffffff', bg: '#457b9d' },
  M: { fg: '#000000', bg: '#e9c46a' },
  F: { fg: '#ffffff', bg: '#264653' },
  W: { fg: '#ffffff', bg: '#6d597a' },
  P: { fg: '#000000', bg: '#f4a261' },
  S: { fg: '#000000', bg: '#2a9d8f' },
  T: { fg: '#000000', bg: '#2a9d8f' },
  Y: { fg: '#ffffff', bg: '#264653' },
  N: { fg: '#000000', bg: '#48cae4' },
  Q: { fg: '#000000', bg: '#48cae4' },
  C: { fg: '#000000', bg: '#e9c46a' },
  K: { fg: '#ffffff', bg: '#023e8a' },
  R: { fg: '#ffffff', bg: '#023e8a' },
  H: { fg: '#ffffff', bg: '#0077b6' },
  D: { fg: '#ffffff', bg: '#e63946' },
  E: { fg: '#ffffff', bg: '#e63946' },
  G: { fg: '#000000', bg: '#f1faee' },
  '*': { fg: '#ffffff', bg: '#d62828' },
  X: { fg: '#ffffff', bg: '#495057' },
};

export const OCEAN_THEME: Theme = {
  id: 'ocean',
  name: 'Ocean',
  palette: oceanPalette,
  nucleotides: oceanNucleotides,
  aminoAcids: oceanAminoAcids,
};

// ============================================================================
// MATRIX THEME
// ============================================================================

const matrixPalette: ThemePalette = {
  primary: '#00ff00',
  secondary: '#00cc00',
  accent: '#00ff66',
  background: '#000000',
  backgroundAlt: '#0a1a0a',
  text: '#00ff00',
  textDim: '#00aa00',
  textMuted: '#005500',
  border: '#003300',
  borderFocus: '#00ff00',
  borderLight: '#002200',
  success: '#00ff00',
  warning: '#ffff00',
  error: '#ff0000',
  info: '#00ffff',
  diffHighlight: '#ff6600',
  geneForward: '#00ff00',
  geneReverse: '#00cc00',
  geneHighlight: '#00ff66',
  gradientLow: '#001a00',
  gradientMid: '#00aa00',
  gradientHigh: '#00ff00',
  kmerNormal: '#006600',
  kmerAnomaly: '#ff3300',
  shadow: '#000000',
  highlight: '#33ff33',
  glow: '#00ff00',
  badge: '#003300',
  badgeText: '#00ff00',
  separator: '#005500',
  iconPrimary: '#00ff00',
  iconSecondary: '#00ff66',
  panelHeader: '#0a1a0a',
  panelBorder: '#004400',
  panelShadow: '#000000',
  sparkline: ['#001a00', '#003300', '#006600', '#00aa00', '#00ff00'],
};

const matrixNucleotides: NucleotideTheme = {
  A: { fg: '#00ff00', bg: '#001400' },
  C: { fg: '#00cc00', bg: '#001100' },
  G: { fg: '#00ff66', bg: '#001600' },
  T: { fg: '#33ff33', bg: '#001800' },
  N: { fg: '#006600', bg: '#000800' },
};

const matrixAminoAcids: AminoTheme = {
  A: { fg: '#00ff00', bg: '#001000' },
  V: { fg: '#00ee00', bg: '#000e00' },
  L: { fg: '#00dd00', bg: '#000c00' },
  I: { fg: '#00cc00', bg: '#000a00' },
  M: { fg: '#33ff33', bg: '#001400' },
  F: { fg: '#00bb00', bg: '#000800' },
  W: { fg: '#00aa00', bg: '#000600' },
  P: { fg: '#00ff66', bg: '#001200' },
  S: { fg: '#66ff66', bg: '#001600' },
  T: { fg: '#66ff66', bg: '#001600' },
  Y: { fg: '#00bb00', bg: '#000800' },
  N: { fg: '#99ff99', bg: '#001a00' },
  Q: { fg: '#99ff99', bg: '#001a00' },
  C: { fg: '#33ff33', bg: '#001400' },
  K: { fg: '#00ffcc', bg: '#001000' },
  R: { fg: '#00ffcc', bg: '#001000' },
  H: { fg: '#00ff99', bg: '#000e00' },
  D: { fg: '#ff3300', bg: '#140000' },
  E: { fg: '#ff3300', bg: '#140000' },
  G: { fg: '#ccffcc', bg: '#001c00' },
  '*': { fg: '#ff0000', bg: '#1a0000' },
  X: { fg: '#006600', bg: '#000800' },
};

export const MATRIX_THEME: Theme = {
  id: 'matrix',
  name: 'Matrix',
  palette: matrixPalette,
  nucleotides: matrixNucleotides,
  aminoAcids: matrixAminoAcids,
};

// ============================================================================
// SUNSET THEME
// ============================================================================

const sunsetPalette: ThemePalette = {
  primary: '#ff6b35',
  secondary: '#f7c59f',
  accent: '#efa00b',
  background: '#1e1e2f',
  backgroundAlt: '#2a2a42',
  text: '#fefae0',
  textDim: '#b8a8b0',
  textMuted: '#6a5a68',
  border: '#4a4e69',
  borderFocus: '#ff6b35',
  borderLight: '#3a3a52',
  success: '#06d6a0',
  warning: '#ffd166',
  error: '#d62246',
  info: '#118ab2',
  diffHighlight: '#ef476f',
  geneForward: '#ff6b35',
  geneReverse: '#f7c59f',
  geneHighlight: '#efa00b',
  gradientLow: '#2d1b30',
  gradientMid: '#ff6b35',
  gradientHigh: '#ffd166',
  kmerNormal: '#9a8c98',
  kmerAnomaly: '#d62246',
  shadow: '#0f0f1a',
  highlight: '#ffffff',
  glow: '#ff6b35',
  badge: '#4a4e69',
  badgeText: '#fefae0',
  separator: '#6a5a68',
  iconPrimary: '#ff6b35',
  iconSecondary: '#efa00b',
  panelHeader: '#2a2a42',
  panelBorder: '#5a4e69',
  panelShadow: '#0a0a12',
  sparkline: ['#2d1b30', '#6b2737', '#d62246', '#ff6b35', '#ffd166'],
};

const sunsetNucleotides: NucleotideTheme = {
  A: { fg: '#ffffff', bg: '#ff6b35' },
  C: { fg: '#ffffff', bg: '#f7c59f' },
  G: { fg: '#000000', bg: '#efa00b' },
  T: { fg: '#ffffff', bg: '#d62246' },
  N: { fg: '#ffffff', bg: '#4a4e69' },
};

const sunsetAminoAcids: AminoTheme = {
  A: { fg: '#000000', bg: '#ffd166' },
  V: { fg: '#ffffff', bg: '#ef476f' },
  L: { fg: '#ffffff', bg: '#ef476f' },
  I: { fg: '#ffffff', bg: '#ef476f' },
  M: { fg: '#000000', bg: '#ffd166' },
  F: { fg: '#ffffff', bg: '#9b2335' },
  W: { fg: '#ffffff', bg: '#6b2737' },
  P: { fg: '#000000', bg: '#f78c6b' },
  S: { fg: '#000000', bg: '#83c5be' },
  T: { fg: '#000000', bg: '#83c5be' },
  Y: { fg: '#ffffff', bg: '#9b2335' },
  N: { fg: '#000000', bg: '#edf6f9' },
  Q: { fg: '#000000', bg: '#edf6f9' },
  C: { fg: '#000000', bg: '#ffd166' },
  K: { fg: '#ffffff', bg: '#118ab2' },
  R: { fg: '#ffffff', bg: '#118ab2' },
  H: { fg: '#ffffff', bg: '#06d6a0' },
  D: { fg: '#ffffff', bg: '#d62246' },
  E: { fg: '#ffffff', bg: '#d62246' },
  G: { fg: '#000000', bg: '#fefae0' },
  X: { fg: '#ffffff', bg: '#4a4e69' },
  '*': { fg: '#ffffff', bg: '#9b2335' },
};

export const SUNSET_THEME: Theme = {
  id: 'sunset',
  name: 'Sunset',
  palette: sunsetPalette,
  nucleotides: sunsetNucleotides,
  aminoAcids: sunsetAminoAcids,
};

// ============================================================================
// FOREST THEME
// ============================================================================

const forestPalette: ThemePalette = {
  primary: '#40916c',
  secondary: '#2d6a4f',
  accent: '#95d5b2',
  background: '#0d1b0f',
  backgroundAlt: '#1a2e1f',
  text: '#d8f3dc',
  textDim: '#8fa890',
  textMuted: '#4a5c4d',
  border: '#344e41',
  borderFocus: '#40916c',
  borderLight: '#263832',
  success: '#40916c',
  warning: '#d4a373',
  error: '#bc4749',
  info: '#588157',
  diffHighlight: '#e9c46a',
  geneForward: '#40916c',
  geneReverse: '#2d6a4f',
  geneHighlight: '#95d5b2',
  gradientLow: '#1b4332',
  gradientMid: '#40916c',
  gradientHigh: '#95d5b2',
  kmerNormal: '#6b705c',
  kmerAnomaly: '#bc4749',
  shadow: '#061008',
  highlight: '#b7e4c7',
  glow: '#40916c',
  badge: '#344e41',
  badgeText: '#d8f3dc',
  separator: '#4a5c4d',
  iconPrimary: '#40916c',
  iconSecondary: '#95d5b2',
  panelHeader: '#1a2e1f',
  panelBorder: '#344e41',
  panelShadow: '#030805',
  sparkline: ['#1b4332', '#2d6a4f', '#40916c', '#74c69d', '#b7e4c7'],
};

const forestNucleotides: NucleotideTheme = {
  A: { fg: '#ffffff', bg: '#2d6a4f' },
  C: { fg: '#ffffff', bg: '#40916c' },
  G: { fg: '#000000', bg: '#95d5b2' },
  T: { fg: '#ffffff', bg: '#8b4513' },
  N: { fg: '#ffffff', bg: '#6b705c' },
};

const forestAminoAcids: AminoTheme = {
  A: { fg: '#000000', bg: '#b7e4c7' },
  V: { fg: '#ffffff', bg: '#2d6a4f' },
  L: { fg: '#ffffff', bg: '#2d6a4f' },
  I: { fg: '#ffffff', bg: '#2d6a4f' },
  M: { fg: '#000000', bg: '#d4a373' },
  F: { fg: '#ffffff', bg: '#1b4332' },
  W: { fg: '#ffffff', bg: '#081c15' },
  P: { fg: '#000000', bg: '#ccd5ae' },
  S: { fg: '#000000', bg: '#95d5b2' },
  T: { fg: '#000000', bg: '#95d5b2' },
  Y: { fg: '#ffffff', bg: '#1b4332' },
  N: { fg: '#000000', bg: '#d8f3dc' },
  Q: { fg: '#000000', bg: '#d8f3dc' },
  C: { fg: '#000000', bg: '#d4a373' },
  K: { fg: '#ffffff', bg: '#344e41' },
  R: { fg: '#ffffff', bg: '#344e41' },
  H: { fg: '#ffffff', bg: '#588157' },
  D: { fg: '#ffffff', bg: '#bc4749' },
  E: { fg: '#ffffff', bg: '#bc4749' },
  G: { fg: '#000000', bg: '#f0ead2' },
  X: { fg: '#ffffff', bg: '#6b705c' },
  '*': { fg: '#ffffff', bg: '#9b2226' },
};

export const FOREST_THEME: Theme = {
  id: 'forest',
  name: 'Forest',
  palette: forestPalette,
  nucleotides: forestNucleotides,
  aminoAcids: forestAminoAcids,
};

// ============================================================================
// PASTEL THEME
// ============================================================================

const pastelPalette: ThemePalette = {
  primary: '#74b9ff',
  secondary: '#a29bfe',
  accent: '#ffeaa7',
  background: '#f8f9fa',
  backgroundAlt: '#ffffff',
  text: '#2d3436',
  textDim: '#636e72',
  textMuted: '#b2bec3',
  border: '#dfe6e9',
  borderFocus: '#74b9ff',
  borderLight: '#e8eaed',
  success: '#00cec9',
  warning: '#fdcb6e',
  error: '#ff7675',
  info: '#74b9ff',
  diffHighlight: '#fab1a0',
  geneForward: '#55efc4',
  geneReverse: '#81ecec',
  geneHighlight: '#ffeaa7',
  gradientLow: '#dfe6e9',
  gradientMid: '#74b9ff',
  gradientHigh: '#00b894',
  kmerNormal: '#b2bec3',
  kmerAnomaly: '#e17055',
  shadow: '#c8d6e5',
  highlight: '#ffffff',
  glow: '#74b9ff',
  badge: '#e8eaed',
  badgeText: '#2d3436',
  separator: '#dfe6e9',
  iconPrimary: '#74b9ff',
  iconSecondary: '#a29bfe',
  panelHeader: '#f1f2f6',
  panelBorder: '#dfe6e9',
  panelShadow: '#e8eaed',
  sparkline: ['#dfe6e9', '#a8e6cf', '#74b9ff', '#a29bfe', '#fd79a8'],
};

const pastelNucleotides: NucleotideTheme = {
  A: { fg: '#2d3436', bg: '#a8e6cf' },
  C: { fg: '#2d3436', bg: '#dcedc1' },
  G: { fg: '#2d3436', bg: '#ffd3b6' },
  T: { fg: '#2d3436', bg: '#ffaaa5' },
  N: { fg: '#636e72', bg: '#dfe6e9' },
};

const pastelAminoAcids: AminoTheme = {
  A: { fg: '#2d3436', bg: '#b8e0d2' },
  V: { fg: '#2d3436', bg: '#95b8d1' },
  L: { fg: '#2d3436', bg: '#95b8d1' },
  I: { fg: '#2d3436', bg: '#95b8d1' },
  M: { fg: '#2d3436', bg: '#f0e6ef' },
  F: { fg: '#2d3436', bg: '#d4a5a5' },
  W: { fg: '#2d3436', bg: '#c9b1ff' },
  P: { fg: '#2d3436', bg: '#ffd6a5' },
  S: { fg: '#2d3436', bg: '#caffbf' },
  T: { fg: '#2d3436', bg: '#caffbf' },
  Y: { fg: '#2d3436', bg: '#d4a5a5' },
  N: { fg: '#2d3436', bg: '#9bf6ff' },
  Q: { fg: '#2d3436', bg: '#9bf6ff' },
  C: { fg: '#2d3436', bg: '#fdffb6' },
  K: { fg: '#2d3436', bg: '#a0c4ff' },
  R: { fg: '#2d3436', bg: '#a0c4ff' },
  H: { fg: '#2d3436', bg: '#bdb2ff' },
  D: { fg: '#2d3436', bg: '#ffc6ff' },
  E: { fg: '#2d3436', bg: '#ffc6ff' },
  G: { fg: '#2d3436', bg: '#f0f0f0' },
  '*': { fg: '#2d3436', bg: '#ffb5b5' },
  X: { fg: '#636e72', bg: '#dfe6e9' },
};

export const PASTEL_THEME: Theme = {
  id: 'pastel',
  name: 'Pastel',
  palette: pastelPalette,
  nucleotides: pastelNucleotides,
  aminoAcids: pastelAminoAcids,
};

// ============================================================================
// MONOCHROME THEME
// ============================================================================

const monochromePalette: ThemePalette = {
  primary: '#ffffff',
  secondary: '#b0b0b0',
  accent: '#ffd700',
  background: '#0a0a0a',
  backgroundAlt: '#151515',
  text: '#e0e0e0',
  textDim: '#808080',
  textMuted: '#505050',
  border: '#404040',
  borderFocus: '#ffd700',
  borderLight: '#303030',
  success: '#90ee90',
  warning: '#ffd700',
  error: '#ff6b6b',
  info: '#87ceeb',
  diffHighlight: '#ffd700',
  geneForward: '#c0c0c0',
  geneReverse: '#707070',
  geneHighlight: '#ffd700',
  gradientLow: '#202020',
  gradientMid: '#606060',
  gradientHigh: '#c0c0c0',
  kmerNormal: '#505050',
  kmerAnomaly: '#ff6b6b',
  shadow: '#000000',
  highlight: '#ffffff',
  glow: '#ffd700',
  badge: '#303030',
  badgeText: '#e0e0e0',
  separator: '#404040',
  iconPrimary: '#ffd700',
  iconSecondary: '#c0c0c0',
  panelHeader: '#1a1a1a',
  panelBorder: '#505050',
  panelShadow: '#000000',
  sparkline: ['#202020', '#404040', '#606060', '#909090', '#c0c0c0'],
};

const monochromeNucleotides: NucleotideTheme = {
  A: { fg: '#ffffff', bg: '#1a1a1a' },
  C: { fg: '#ffffff', bg: '#3a3a3a' },
  G: { fg: '#000000', bg: '#8a8a8a' },
  T: { fg: '#000000', bg: '#c0c0c0' },
  N: { fg: '#ffffff', bg: '#555555' },
};

const monochromeAminoAcids: AminoTheme = {
  A: { fg: '#000000', bg: '#d0d0d0' },
  V: { fg: '#ffffff', bg: '#404040' },
  L: { fg: '#ffffff', bg: '#404040' },
  I: { fg: '#ffffff', bg: '#404040' },
  M: { fg: '#000000', bg: '#b0b0b0' },
  F: { fg: '#ffffff', bg: '#303030' },
  W: { fg: '#ffffff', bg: '#202020' },
  P: { fg: '#000000', bg: '#909090' },
  S: { fg: '#000000', bg: '#c0c0c0' },
  T: { fg: '#000000', bg: '#c0c0c0' },
  Y: { fg: '#ffffff', bg: '#303030' },
  N: { fg: '#000000', bg: '#e0e0e0' },
  Q: { fg: '#000000', bg: '#e0e0e0' },
  C: { fg: '#000000', bg: '#b0b0b0' },
  K: { fg: '#ffffff', bg: '#505050' },
  R: { fg: '#ffffff', bg: '#505050' },
  H: { fg: '#000000', bg: '#707070' },
  D: { fg: '#000000', bg: '#a0a0a0' },
  E: { fg: '#000000', bg: '#a0a0a0' },
  G: { fg: '#000000', bg: '#f0f0f0' },
  '*': { fg: '#ffffff', bg: '#000000' },
  X: { fg: '#ffffff', bg: '#555555' },
};

export const MONOCHROME_THEME: Theme = {
  id: 'monochrome',
  name: 'Monochrome',
  palette: monochromePalette,
  nucleotides: monochromeNucleotides,
  aminoAcids: monochromeAminoAcids,
};

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * All available themes
 */
export const THEMES: readonly Theme[] = [
  CYBERPUNK_THEME,
  CLASSIC_THEME,
  OCEAN_THEME,
  MATRIX_THEME,
  SUNSET_THEME,
  FOREST_THEME,
  PASTEL_THEME,
  MONOCHROME_THEME,
] as const;

/**
 * Default theme
 */
export const DEFAULT_THEME = CYBERPUNK_THEME;

/**
 * Get theme by ID
 */
export function getThemeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}

/**
 * Get next theme in cycle
 */
export function getNextTheme(currentId: string): Theme {
  const currentIndex = THEMES.findIndex((t) => t.id === currentId);
  const nextIndex = (currentIndex + 1) % THEMES.length;
  return THEMES[nextIndex];
}
