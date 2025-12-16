/**
 * featureRegistry.ts - Central Feature Registry
 *
 * Defines all application features with their metadata for the FullFeatureModal.
 * Features are grouped by category and include shortcuts, descriptions, icons,
 * and action functions.
 */

import type { OverlayId } from '../components/overlays/OverlayProvider';

// =============================================================================
// Types
// =============================================================================

export type FeatureCategory =
  | 'navigation'
  | 'view'
  | 'analysis'
  | '3d'
  | 'simulation'
  | 'comparison'
  | 'education'
  | 'export'
  | 'settings';

export type ExperienceLevel = 'novice' | 'intermediate' | 'power';

export interface Feature {
  id: string;
  label: string;
  description?: string;
  category: FeatureCategory;
  /** SVG icon name from IconRegistry */
  icon?: string;
  /** Keyboard shortcuts that trigger this feature */
  shortcuts?: string[];
  /** Action to execute when the feature is activated */
  action: (ctx: FeatureContext) => void;
  /** Check if feature is currently active/toggled on */
  isActive?: (ctx: FeatureContext) => boolean;
  /** Check if feature is enabled/available */
  isEnabled?: (ctx: FeatureContext) => boolean;
  /** Searchable tags for fuzzy matching */
  tags?: string[];
  /** Minimum experience level required to show this feature */
  minLevel?: ExperienceLevel;
}

export interface FeatureContext {
  openOverlay: (id: OverlayId) => void;
  closeOverlay: (id?: OverlayId) => void;
  closeAllOverlays: () => void;
  toggleViewMode: () => void;
  toggle3DModel: () => void;
  toggle3DModelFullscreen: () => void;
  toggle3DModelPause: () => void;
  toggleDiff: () => void;
  cycleTheme: () => void;
  cycleReadingFrame: () => void;
  scrollToStart: () => void;
  scrollToEnd: () => void;
  nextPhage: () => void;
  prevPhage: () => void;
  toggleBeginnerMode: () => void;
  openGlossary: () => void;
  startTour: (tourId: string) => void;
  // State getters
  hasPhage: boolean;
  viewMode: 'dna' | 'aa';
  show3DModel: boolean;
  diffEnabled: boolean;
  beginnerModeEnabled: boolean;
}

// =============================================================================
// Category Metadata
// =============================================================================

export interface CategoryMeta {
  id: FeatureCategory;
  label: string;
  description: string;
  icon: string;
  color: string;
}

export const CATEGORY_META: Record<FeatureCategory, CategoryMeta> = {
  navigation: {
    id: 'navigation',
    label: 'Navigation',
    description: 'Move through genomes and sequences',
    icon: 'arrow-right',
    color: 'var(--color-info)',
  },
  view: {
    id: 'view',
    label: 'View',
    description: 'Toggle display modes and visual settings',
    icon: 'aperture',
    color: 'var(--color-success)',
  },
  analysis: {
    id: 'analysis',
    label: 'Analysis',
    description: 'Computational analysis tools',
    icon: 'trending-up',
    color: 'var(--color-warning)',
  },
  '3d': {
    id: '3d',
    label: '3D Model',
    description: '3D visualization controls',
    icon: 'cube',
    color: 'var(--color-accent)',
  },
  simulation: {
    id: 'simulation',
    label: 'Simulation',
    description: 'Run biological simulations',
    icon: 'zap',
    color: 'var(--color-secondary)',
  },
  comparison: {
    id: 'comparison',
    label: 'Comparison',
    description: 'Compare genomes and sequences',
    icon: 'git-compare',
    color: 'var(--color-primary)',
  },
  education: {
    id: 'education',
    label: 'Education',
    description: 'Learning tools and tours',
    icon: 'learn',
    color: 'var(--color-info)',
  },
  export: {
    id: 'export',
    label: 'Export',
    description: 'Export data and sequences',
    icon: 'download',
    color: 'var(--color-text-muted)',
  },
  settings: {
    id: 'settings',
    label: 'Settings',
    description: 'Application settings and preferences',
    icon: 'settings',
    color: 'var(--color-text-dim)',
  },
};

// =============================================================================
// Feature Registry
// =============================================================================

export const FEATURES: Feature[] = [
  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------
  {
    id: 'nav:next-phage',
    label: 'Next Phage',
    description: 'Navigate to the next phage in the list',
    category: 'navigation',
    icon: 'arrow-down',
    shortcuts: ['ArrowDown', 'j'],
    action: (ctx) => ctx.nextPhage(),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['navigate', 'phage', 'next', 'forward'],
    minLevel: 'novice',
  },
  {
    id: 'nav:prev-phage',
    label: 'Previous Phage',
    description: 'Navigate to the previous phage in the list',
    category: 'navigation',
    icon: 'arrow-up',
    shortcuts: ['ArrowUp', 'k'],
    action: (ctx) => ctx.prevPhage(),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['navigate', 'phage', 'previous', 'back'],
    minLevel: 'novice',
  },
  {
    id: 'nav:scroll-start',
    label: 'Go to Start',
    description: 'Jump to the beginning of the sequence',
    category: 'navigation',
    icon: 'arrow-left',
    shortcuts: ['Home', 'gg'],
    action: (ctx) => ctx.scrollToStart(),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['navigate', 'start', 'beginning', 'home'],
    minLevel: 'novice',
  },
  {
    id: 'nav:scroll-end',
    label: 'Go to End',
    description: 'Jump to the end of the sequence',
    category: 'navigation',
    icon: 'arrow-right',
    shortcuts: ['End', 'G'],
    action: (ctx) => ctx.scrollToEnd(),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['navigate', 'end', 'last'],
    minLevel: 'novice',
  },
  {
    id: 'nav:goto-position',
    label: 'Go to Position...',
    description: 'Jump to a specific nucleotide position',
    category: 'navigation',
    icon: 'target',
    shortcuts: ['Ctrl+g'],
    action: (ctx) => ctx.openOverlay('goto'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['navigate', 'position', 'jump', 'goto'],
    minLevel: 'novice',
  },
  {
    id: 'nav:search',
    label: 'Search Phages',
    description: 'Search for phages by name or accession',
    category: 'navigation',
    icon: 'search',
    shortcuts: ['s', '/'],
    action: (ctx) => ctx.openOverlay('search'),
    tags: ['search', 'find', 'phage', 'query'],
    minLevel: 'novice',
  },

  // -------------------------------------------------------------------------
  // View
  // -------------------------------------------------------------------------
  {
    id: 'view:toggle-mode',
    label: 'Toggle DNA/Amino Acid',
    description: 'Switch between DNA and amino acid view modes',
    category: 'view',
    icon: 'layers',
    shortcuts: ['Space', 'v'],
    action: (ctx) => ctx.toggleViewMode(),
    isActive: (ctx) => ctx.viewMode === 'aa',
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['view', 'mode', 'dna', 'amino', 'acid', 'protein', 'toggle'],
    minLevel: 'novice',
  },
  {
    id: 'view:reading-frame',
    label: 'Cycle Reading Frame',
    description: 'Cycle through reading frames (+1, +2, +3, -1, -2, -3)',
    category: 'view',
    icon: 'layers',
    shortcuts: ['f'],
    action: (ctx) => ctx.cycleReadingFrame(),
    isEnabled: (ctx) => ctx.hasPhage && ctx.viewMode === 'aa',
    tags: ['frame', 'reading', 'codon', 'translate'],
    minLevel: 'intermediate',
  },
  {
    id: 'view:toggle-diff',
    label: 'Toggle Diff Mode',
    description: 'Highlight differences from reference sequence',
    category: 'view',
    icon: 'git-compare',
    shortcuts: ['d'],
    action: (ctx) => ctx.toggleDiff(),
    isActive: (ctx) => ctx.diffEnabled,
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['diff', 'compare', 'difference', 'reference'],
    minLevel: 'intermediate',
  },
  {
    id: 'view:cycle-theme',
    label: 'Cycle Theme',
    description: 'Switch to the next color theme',
    category: 'view',
    icon: 'contrast',
    shortcuts: ['t'],
    action: (ctx) => ctx.cycleTheme(),
    tags: ['theme', 'color', 'dark', 'light', 'appearance'],
    minLevel: 'novice',
  },
  {
    id: 'view:aa-key',
    label: 'Amino Acid Key',
    description: 'Show amino acid properties reference card',
    category: 'view',
    icon: 'bookmark',
    shortcuts: ['k'],
    action: (ctx) => ctx.openOverlay('aaKey'),
    tags: ['amino', 'acid', 'key', 'legend', 'reference'],
    minLevel: 'novice',
  },
  {
    id: 'view:aa-legend',
    label: 'Amino Acid Legend',
    description: 'Show compact amino acid color legend',
    category: 'view',
    icon: 'bookmark',
    shortcuts: ['l'],
    action: (ctx) => ctx.openOverlay('aaLegend'),
    tags: ['amino', 'acid', 'legend', 'colors'],
    minLevel: 'novice',
  },

  // -------------------------------------------------------------------------
  // 3D Model
  // -------------------------------------------------------------------------
  {
    id: '3d:toggle',
    label: 'Toggle 3D Model',
    description: 'Show or hide the 3D phage model',
    category: '3d',
    icon: 'cube',
    shortcuts: ['m'],
    action: (ctx) => ctx.toggle3DModel(),
    isActive: (ctx) => ctx.show3DModel,
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['3d', 'model', 'visualize', 'phage', 'structure'],
    minLevel: 'novice',
  },
  {
    id: '3d:fullscreen',
    label: '3D Fullscreen',
    description: 'Toggle fullscreen 3D model view',
    category: '3d',
    icon: 'maximize',
    shortcuts: ['z'],
    action: (ctx) => ctx.toggle3DModelFullscreen(),
    isEnabled: (ctx) => ctx.hasPhage && ctx.show3DModel,
    tags: ['3d', 'fullscreen', 'expand', 'maximize'],
    minLevel: 'intermediate',
  },
  {
    id: '3d:pause',
    label: 'Pause/Play Animation',
    description: 'Toggle 3D model animation',
    category: '3d',
    icon: 'play',
    shortcuts: ['p'],
    action: (ctx) => ctx.toggle3DModelPause(),
    isEnabled: (ctx) => ctx.hasPhage && ctx.show3DModel,
    tags: ['3d', 'pause', 'play', 'animation', 'rotate'],
    minLevel: 'intermediate',
  },

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------
  {
    id: 'analysis:menu',
    label: 'Analysis Menu',
    description: 'Open the full analysis menu',
    category: 'analysis',
    icon: 'flask',
    shortcuts: ['a'],
    action: (ctx) => ctx.openOverlay('analysisMenu'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['analysis', 'menu', 'tools', 'all'],
    minLevel: 'novice',
  },
  {
    id: 'analysis:gc-skew',
    label: 'GC Skew Analysis',
    description: 'Visualize GC skew across the genome',
    category: 'analysis',
    icon: 'dna',
    shortcuts: ['g'],
    action: (ctx) => ctx.openOverlay('gcSkew'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['gc', 'skew', 'content', 'nucleotide', 'composition'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:complexity',
    label: 'Sequence Complexity',
    description: 'Analyze sequence complexity and entropy',
    category: 'analysis',
    icon: 'chart-bar',
    shortcuts: ['x'],
    action: (ctx) => ctx.openOverlay('complexity'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['complexity', 'entropy', 'information', 'sequence'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:bendability',
    label: 'DNA Bendability',
    description: 'Predict DNA structural flexibility',
    category: 'analysis',
    icon: 'trending-up',
    shortcuts: ['b'],
    action: (ctx) => ctx.openOverlay('bendability'),
    isEnabled: (ctx) => ctx.hasPhage && ctx.viewMode === 'dna',
    tags: ['bendability', 'flexibility', 'structure', 'dna'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:promoter',
    label: 'Promoter/RBS Sites',
    description: 'Identify potential promoters and ribosome binding sites',
    category: 'analysis',
    icon: 'target',
    shortcuts: ['P'],
    action: (ctx) => ctx.openOverlay('promoter'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['promoter', 'rbs', 'ribosome', 'binding', 'transcription'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:repeats',
    label: 'Repeat Finder',
    description: 'Find direct and inverted repeats',
    category: 'analysis',
    icon: 'repeat',
    shortcuts: ['r'],
    action: (ctx) => ctx.openOverlay('repeats'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['repeats', 'tandem', 'inverted', 'direct'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:kmer-anomaly',
    label: 'K-mer Anomaly',
    description: 'Detect unusual k-mer frequencies',
    category: 'analysis',
    icon: 'alert-triangle',
    shortcuts: ['V'],
    action: (ctx) => ctx.openOverlay('kmerAnomaly'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['kmer', 'anomaly', 'unusual', 'frequency'],
    minLevel: 'power',
  },
  {
    id: 'analysis:hgt',
    label: 'HGT Provenance',
    description: 'Horizontal gene transfer analysis',
    category: 'analysis',
    icon: 'magnet',
    shortcuts: ['Y'],
    action: (ctx) => ctx.openOverlay('hgt'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['hgt', 'horizontal', 'gene', 'transfer', 'provenance'],
    minLevel: 'power',
  },
  {
    id: 'analysis:crispr',
    label: 'CRISPR Arrays',
    description: 'Detect CRISPR-Cas systems',
    category: 'analysis',
    icon: 'target',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('crispr'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['crispr', 'cas', 'spacer', 'repeat'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:cgr',
    label: 'Chaos Game Representation',
    description: 'Visualize sequence as CGR fractal',
    category: 'analysis',
    icon: 'aperture',
    shortcuts: ['Alt+Shift+C'],
    action: (ctx) => ctx.openOverlay('cgr'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['cgr', 'chaos', 'game', 'fractal', 'visualization'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:hilbert',
    label: 'Hilbert Curve',
    description: 'Visualize sequence on a Hilbert curve',
    category: 'analysis',
    icon: 'aperture',
    shortcuts: ['H'],
    action: (ctx) => ctx.openOverlay('hilbert'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['hilbert', 'curve', 'visualization', 'space-filling'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:gel',
    label: 'Virtual Gel Electrophoresis',
    description: 'Simulate restriction enzyme digestion',
    category: 'analysis',
    icon: 'bar-chart',
    shortcuts: ['G'],
    action: (ctx) => ctx.openOverlay('gel'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['gel', 'electrophoresis', 'restriction', 'enzyme'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:dotplot',
    label: 'Synteny Dotplot',
    description: 'Self vs self dotplot for repeat detection',
    category: 'analysis',
    icon: 'grid',
    shortcuts: ['.'],
    action: (ctx) => ctx.openOverlay('dotPlot'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['dotplot', 'synteny', 'alignment', 'self'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:phase-portrait',
    label: 'Phase Portrait',
    description: 'Dinucleotide frequency phase space',
    category: 'analysis',
    icon: 'trending-up',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('phasePortrait'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['phase', 'portrait', 'dinucleotide', 'frequency'],
    minLevel: 'power',
  },
  {
    id: 'analysis:bias-decomposition',
    label: 'Codon Bias Decomposition',
    description: 'Analyze codon usage bias',
    category: 'analysis',
    icon: 'bar-chart',
    shortcuts: ['J'],
    action: (ctx) => ctx.openOverlay('biasDecomposition'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['codon', 'bias', 'usage', 'decomposition'],
    minLevel: 'power',
  },
  {
    id: 'analysis:non-b-dna',
    label: 'Non-B DNA Structures',
    description: 'Predict G-quadruplexes, Z-DNA, etc.',
    category: 'analysis',
    icon: 'dna',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('nonBDNA'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['non-b', 'quadruplex', 'z-dna', 'structure'],
    minLevel: 'power',
  },
  {
    id: 'analysis:structure-constraints',
    label: 'Structure Constraints',
    description: 'Structural constraint analysis',
    category: 'analysis',
    icon: 'lock',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('structureConstraint'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['structure', 'constraints', 'folding'],
    minLevel: 'power',
  },
  {
    id: 'analysis:anomaly',
    label: 'Anomaly Detection',
    description: 'Detect genomic anomalies',
    category: 'analysis',
    icon: 'alert-triangle',
    shortcuts: ['A'],
    action: (ctx) => ctx.openOverlay('anomaly'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['anomaly', 'detection', 'unusual', 'outlier'],
    minLevel: 'power',
  },
  {
    id: 'analysis:tropism',
    label: 'Tropism & Receptors',
    description: 'Predict host tropism and receptors',
    category: 'analysis',
    icon: 'target',
    shortcuts: ['0'],
    action: (ctx) => ctx.openOverlay('tropism'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['tropism', 'receptor', 'host', 'binding'],
    minLevel: 'power',
  },
  {
    id: 'analysis:selection-pressure',
    label: 'Selection Pressure',
    description: 'Analyze dN/dS ratios',
    category: 'analysis',
    icon: 'trending-up',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('selectionPressure'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['selection', 'pressure', 'dn', 'ds', 'ratio'],
    minLevel: 'power',
  },
  {
    id: 'analysis:stability',
    label: 'Virion Stability',
    description: 'Predict virion stability',
    category: 'analysis',
    icon: 'shield',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('stability'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['virion', 'stability', 'capsid'],
    minLevel: 'power',
  },
  {
    id: 'analysis:defense-arms-race',
    label: 'Defense Arms Race',
    description: 'Phage-host defense system analysis',
    category: 'analysis',
    icon: 'shield',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('defenseArmsRace'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['defense', 'arms', 'race', 'anti-crispr'],
    minLevel: 'power',
  },
  {
    id: 'analysis:codon-bias',
    label: 'Codon Bias',
    description: 'Detailed codon usage statistics',
    category: 'analysis',
    icon: 'bar-chart',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('codonBias'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['codon', 'bias', 'usage', 'statistics'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:codon-adaptation',
    label: 'Codon Adaptation Index',
    description: 'Calculate CAI for gene expression',
    category: 'analysis',
    icon: 'bar-chart',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('codonAdaptation'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['cai', 'codon', 'adaptation', 'expression'],
    minLevel: 'power',
  },
  {
    id: 'analysis:protein-domains',
    label: 'Protein Domains',
    description: 'Identify protein domain architecture',
    category: 'analysis',
    icon: 'layers',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('proteinDomains'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['protein', 'domain', 'architecture', 'pfam'],
    minLevel: 'intermediate',
  },
  {
    id: 'analysis:amg-pathway',
    label: 'AMG Pathways',
    description: 'Auxiliary metabolic gene pathway analysis',
    category: 'analysis',
    icon: 'git-branch',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('amgPathway'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['amg', 'metabolic', 'pathway', 'auxiliary'],
    minLevel: 'power',
  },
  {
    id: 'analysis:genomic-signature-pca',
    label: 'Genomic Signature PCA',
    description: 'Principal component analysis of genomic signatures',
    category: 'analysis',
    icon: 'trending-up',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('genomicSignaturePCA'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['pca', 'genomic', 'signature', 'principal', 'component'],
    minLevel: 'power',
  },

  // -------------------------------------------------------------------------
  // Comparison
  // -------------------------------------------------------------------------
  {
    id: 'comparison:open',
    label: 'Genome Comparison',
    description: 'Compare two phage genomes',
    category: 'comparison',
    icon: 'git-compare',
    shortcuts: ['c', 'w'],
    action: (ctx) => ctx.openOverlay('comparison'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['compare', 'genome', 'alignment', 'diff'],
    minLevel: 'intermediate',
  },
  {
    id: 'comparison:synteny',
    label: 'Synteny Analysis',
    description: 'Analyze gene order conservation',
    category: 'comparison',
    icon: 'git-merge',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('synteny'),
    isEnabled: (ctx) => ctx.hasPhage,
    tags: ['synteny', 'gene', 'order', 'conservation'],
    minLevel: 'intermediate',
  },

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------
  {
    id: 'simulation:hub',
    label: 'Simulation Hub',
    description: 'Launch biological simulations',
    category: 'simulation',
    icon: 'zap',
    shortcuts: ['S'],
    action: (ctx) => ctx.openOverlay('simulationHub'),
    tags: ['simulation', 'model', 'dynamics', 'run'],
    minLevel: 'intermediate',
  },

  // -------------------------------------------------------------------------
  // Education
  // -------------------------------------------------------------------------
  {
    id: 'edu:toggle-beginner',
    label: 'Toggle Beginner Mode',
    description: 'Show/hide educational tooltips and explanations',
    category: 'education',
    icon: 'learn',
    shortcuts: ['Ctrl+b'],
    action: (ctx) => ctx.toggleBeginnerMode(),
    isActive: (ctx) => ctx.beginnerModeEnabled,
    tags: ['beginner', 'education', 'learn', 'tooltips', 'help'],
    minLevel: 'novice',
  },
  {
    id: 'edu:glossary',
    label: 'Open Glossary',
    description: 'View biology terms glossary',
    category: 'education',
    icon: 'book',
    shortcuts: [],
    action: (ctx) => ctx.openGlossary(),
    tags: ['glossary', 'terms', 'definitions', 'learn'],
    minLevel: 'novice',
  },
  {
    id: 'edu:welcome-tour',
    label: 'Start Welcome Tour',
    description: 'Take a guided tour of the application',
    category: 'education',
    icon: 'compass',
    shortcuts: [],
    action: (ctx) => ctx.startTour('welcome'),
    tags: ['tour', 'guide', 'welcome', 'intro', 'tutorial'],
    minLevel: 'novice',
  },
  {
    id: 'edu:illustration',
    label: 'Phage Illustration',
    description: 'View annotated phage diagram',
    category: 'education',
    icon: 'image',
    shortcuts: [],
    action: (ctx) => ctx.openOverlay('illustration'),
    tags: ['illustration', 'diagram', 'anatomy', 'structure'],
    minLevel: 'novice',
  },

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  {
    id: 'settings:open',
    label: 'Open Settings',
    description: 'Configure application settings',
    category: 'settings',
    icon: 'settings',
    shortcuts: ['Ctrl+,'],
    action: (ctx) => ctx.openOverlay('settings'),
    tags: ['settings', 'preferences', 'configure', 'options'],
    minLevel: 'novice',
  },
  {
    id: 'settings:help',
    label: 'Show Help',
    description: 'View keyboard shortcuts and help',
    category: 'settings',
    icon: 'help',
    shortcuts: ['?', 'F1'],
    action: (ctx) => ctx.openOverlay('help'),
    tags: ['help', 'shortcuts', 'keyboard', 'documentation'],
    minLevel: 'novice',
  },
  {
    id: 'settings:command-palette',
    label: 'Command Palette',
    description: 'Open quick command search',
    category: 'settings',
    icon: 'command',
    shortcuts: [':'],
    action: (ctx) => ctx.openOverlay('commandPalette'),
    tags: ['command', 'palette', 'quick', 'search'],
    minLevel: 'intermediate',
  },
];

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get features grouped by category
 */
export function getFeaturesByCategory(): Map<FeatureCategory, Feature[]> {
  const grouped = new Map<FeatureCategory, Feature[]>();

  for (const feature of FEATURES) {
    const existing = grouped.get(feature.category) ?? [];
    existing.push(feature);
    grouped.set(feature.category, existing);
  }

  return grouped;
}

/**
 * Get features filtered by experience level
 */
export function getFeaturesForLevel(level: ExperienceLevel): Feature[] {
  const levelOrder: Record<ExperienceLevel, number> = {
    novice: 0,
    intermediate: 1,
    power: 2,
  };

  const userLevelNum = levelOrder[level];

  return FEATURES.filter((feature) => {
    const requiredLevel = feature.minLevel ?? 'novice';
    return levelOrder[requiredLevel] <= userLevelNum;
  });
}

/**
 * Find a feature by ID
 */
export function getFeatureById(id: string): Feature | undefined {
  return FEATURES.find((f) => f.id === id);
}

/**
 * Get all unique shortcuts
 */
export function getAllShortcuts(): Map<string, Feature> {
  const shortcuts = new Map<string, Feature>();

  for (const feature of FEATURES) {
    if (feature.shortcuts) {
      for (const shortcut of feature.shortcuts) {
        shortcuts.set(shortcut, feature);
      }
    }
  }

  return shortcuts;
}
