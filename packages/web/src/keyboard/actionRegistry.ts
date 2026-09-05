/**
 * Action Registry
 *
 * Metadata-only registry for keyboard-driven actions.
 * Intentionally lightweight and safe to import without pulling UI bundles.
 */

import type { ExperienceLevel, KeyCombo } from './types';

import type { ProvenanceLevel } from '../components/overlays/primitives/OverlayProvenance';

export type ActionScope = 'global' | 'contextual';
export type ActionSurface = 'web' | 'tui';

export const ActionIds = {
  NavNextPhage: 'nav.nextPhage',
  NavPrevPhage: 'nav.prevPhage',
  ViewCycleTheme: 'view.cycleTheme',
  ViewCycleMode: 'view.cycleMode',
  ViewCycleReadingFrame: 'view.cycleReadingFrame',
  ViewScrollStart: 'view.scrollStart',
  ViewScrollEnd: 'view.scrollEnd',
  ViewZoomIn: 'view.zoomIn',
  ViewZoomOut: 'view.zoomOut',
  ViewToggle3DModel: 'view.toggleThreeDModel',
  DiffToggle: 'diff.toggle',
  DiffNext: 'diff.next',
  DiffPrev: 'diff.prev',
  OverlayHelp: 'overlay.help',
  OverlaySearch: 'overlay.search',
  OverlayCommandPalette: 'overlay.commandPalette',
  OverlaySettings: 'overlay.settings',
  OverlayCloseAll: 'overlay.closeAll',
  OverlayAnalysisMenu: 'overlay.analysisMenu',
  OverlaySimulationHub: 'overlay.simulationHub',
  OverlayComparison: 'overlay.comparison',
  OverlayAAKey: 'overlay.aaKey',
  OverlayAALegend: 'overlay.aaLegend',
  OverlayPackagingPressure: 'overlay.packagingPressure',
  OverlayTranscriptionFlow: 'overlay.transcriptionFlow',
  OverlaySelectionPressure: 'overlay.selectionPressure',
  OverlayTropism: 'overlay.tropism',
  OverlayGCSkew: 'overlay.gcSkew',
  OverlayComplexity: 'overlay.complexity',
  OverlayBendability: 'overlay.bendability',
  OverlayPromoter: 'overlay.promoter',
  OverlayRepeats: 'overlay.repeats',
  OverlayKmerAnomaly: 'overlay.kmerAnomaly',
  OverlayCGR: 'overlay.cgr',
  OverlayHilbert: 'overlay.hilbert',
  OverlayLogo: 'overlay.logo',
  OverlayDotPlot: 'overlay.dotPlot',
  OverlaySynteny: 'overlay.synteny',
  OverlayPhasePortrait: 'overlay.phasePortrait',
  OverlayGel: 'overlay.gel',
  OverlayPeriodicity: 'overlay.periodicity',
  OverlayMosaicRadar: 'overlay.mosaicRadar',
  OverlayHGT: 'overlay.hgt',
  OverlayCRISPR: 'overlay.crispr',
  OverlayNonBDNA: 'overlay.nonBDNA',
  OverlayAnomaly: 'overlay.anomaly',
  OverlayGenomicSignaturePCA: 'overlay.genomicSignaturePCA',
  OverlayProphageExcision: 'overlay.prophageExcision',
  OverlayCodonBias: 'overlay.codonBias',
  OverlayCodonAdaptation: 'overlay.codonAdaptation',
  OverlayAMGPathway: 'overlay.amgPathway',
  OverlayBiasDecomposition: 'overlay.biasDecomposition',
  OverlayProteinDomains: 'overlay.proteinDomains',
  OverlayFoldQuickview: 'overlay.foldQuickview',
  OverlayRNAStructure: 'overlay.rnaStructure',
  OverlayDefenseArmsRace: 'overlay.defenseArmsRace',
  OverlayEpistasis: 'overlay.epistasis',
  OverlayCocktailCompatibility: 'overlay.cocktailCompatibility',
  OverlayStructureConstraint: 'overlay.structureConstraint',
  OverlayVirionStability: 'overlay.virionStability',
  OverlayModules: 'overlay.modules',
  OverlayResistanceEvolution: 'overlay.resistanceEvolution',
  OverlayNicheNetwork: 'overlay.nicheNetwork',
  OverlayPhylodynamics: 'overlay.phylodynamics',
  OverlayEnvironmentalProvenance: 'overlay.environmentalProvenance',
  OverlayLatentSpaceAtlas: 'overlay.latentSpaceAtlas',
  OverlayHostInteractions: 'overlay.hostInteractions',
  OverlayPangenomeGraph: 'overlay.pangenomeGraph',
  OverlayGpuWasmBenchmark: 'overlay.gpuWasmBenchmark',
  OverlayCollaboration: 'overlay.collaboration',
  AnalysisGenomicSignatureRecenter: 'analysis.genomicSignature.recenter',
  HelpToggleDetail: 'help.toggleDetail',
  EducationToggleBeginnerMode: 'education.toggleBeginnerMode',
  EducationStartTour: 'education.startTour',
  NavGoto: 'nav.goto',
  ExportFasta: 'export.fasta',
  ExportCopy: 'export.copy',
  ExportJson: 'export.json',
} as const;

export type ActionId = (typeof ActionIds)[keyof typeof ActionIds];

export interface ActionDefinition {
  id: ActionId;
  title: string;
  category: string;
  description?: string;
  defaultShortcut: KeyCombo | KeyCombo[];
  scope: ActionScope;
  surfaces?: ActionSurface[];
  minLevel?: ExperienceLevel;
  overlayId?: string;
  overlayAction?: 'open' | 'toggle';
  /**
   * This action only does anything in a development build.
   *
   * The GPU/WASM benchmark overlay returns `null` unless `import.meta.env.DEV`,
   * but its registry entry carried no such condition, so it appeared in the
   * Analysis Menu and the Command Palette in production. A user could find it,
   * select it, and get nothing at all -- no overlay, no error, no explanation.
   *
   * Marking it here rather than adding an id to each menu's exclusion list
   * keeps the reason with the action: the entry is hidden BECAUSE the component
   * does not render, so if the component ever ships this flag comes off and all
   * three surfaces follow. `isVisibleToUser` below is the single place that
   * reads it.
   */
  devOnly?: boolean;
  /**
   * Where this overlay's numbers come from. Declared here as well as rendered
   * inside the overlay so the Analysis Menu and Command Palette can show it
   * BEFORE the user opens anything -- the niche-network overlay carried an
   * honest disclaimer in its body while sitting in the plain "Analysis"
   * category, which meant the user only learned it was synthetic after
   * choosing it.
   *
   * Required for every entry with an `overlayId`; enforced by
   * overlay-provenance.test.ts.
   */
  provenance?: ProvenanceLevel;
  /**
   * The weaker provenance this overlay degrades to when its data source is
   * unavailable, if it degrades at all.
   *
   * Two overlays fetch live data and fall back to synthetic data when the fetch
   * returns too little to analyse. Declaring only the successful case made the
   * menu badge them "External data" unconditionally, including in the case that
   * is common in practice: an offline user, a rate-limited endpoint, or a phage
   * with too few dated records. The badge was then wrong exactly when the user
   * most needed it to be right.
   *
   * The menu is rendered BEFORE the overlay opens, so the achieved provenance
   * is genuinely unknown at that moment. The honest statement is not one level
   * or the other, it is the range. Entries that always deliver their declared
   * level leave this unset.
   *
   * Enforced by overlay-provenance.test.ts: an overlay whose source contains a
   * demo fallback must declare one.
   */
  provenanceFallback?: ProvenanceLevel;
}

// NOTE: This is a foundational set. Additional actions will be added as
// hotkeys are migrated to the registry.
export const ActionRegistry: Record<ActionId, ActionDefinition> = {
  [ActionIds.NavNextPhage]: {
    id: ActionIds.NavNextPhage,
    title: 'Next phage',
    category: 'Navigation',
    description: 'Move to the next phage in the list',
    defaultShortcut: [{ key: 'j' }, { key: 'ArrowDown' }],
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.NavPrevPhage]: {
    id: ActionIds.NavPrevPhage,
    title: 'Previous phage',
    category: 'Navigation',
    description: 'Move to the previous phage in the list',
    defaultShortcut: [{ key: 'k' }, { key: 'ArrowUp' }],
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.ViewCycleTheme]: {
    id: ActionIds.ViewCycleTheme,
    title: 'Cycle theme',
    category: 'View',
    description: 'Rotate the active color theme',
    defaultShortcut: { key: 't' },
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.ViewCycleMode]: {
    id: ActionIds.ViewCycleMode,
    title: 'Cycle view mode',
    category: 'View',
    description: 'Cycle DNA / Amino Acid / Dual view',
    // Space as well as `v`. Taught by the KeyboardPrimer and previously unbound.
    defaultShortcut: [{ key: 'v' }, { key: ' ' }],
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.ViewCycleReadingFrame]: {
    id: ActionIds.ViewCycleReadingFrame,
    title: 'Cycle reading frame',
    category: 'View',
    description: 'Advance to the next reading frame',
    defaultShortcut: { key: 'f' },
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.ViewScrollStart]: {
    id: ActionIds.ViewScrollStart,
    title: 'Jump to start',
    category: 'Navigation',
    description: 'Scroll to the beginning of the sequence',
    // `gg` as well as Home. The in-app KeyboardPrimer -- the first thing a new
    // user reads, shown from the welcome modal -- taught `g g`, `G` and `Space`,
    // and none of the three was bound. A newcomer's first three attempts to use
    // the app failed silently, which defeats the depth-layer system's stated
    // goal of discoverability for beginners at step one.
    //
    // Bound rather than removed from the primer: the app is vim-inspired by
    // design and these are the idiomatic vim motions, so the primer was right
    // and the bindings were missing.
    defaultShortcut: [{ key: 'Home' }, { sequence: ['g', 'g'] }],
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.ViewScrollEnd]: {
    id: ActionIds.ViewScrollEnd,
    title: 'Jump to end',
    category: 'Navigation',
    description: 'Scroll to the end of the sequence',
    defaultShortcut: [{ key: 'End' }, { key: 'G', modifiers: { shift: true } }],
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.ViewZoomIn]: {
    id: ActionIds.ViewZoomIn,
    title: 'Zoom in',
    category: 'View',
    description: 'Increase sequence zoom level',
    defaultShortcut: [{ key: '+' }, { key: '=' }],
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.ViewZoomOut]: {
    id: ActionIds.ViewZoomOut,
    title: 'Zoom out',
    category: 'View',
    description: 'Decrease sequence zoom level',
    defaultShortcut: { key: '-' },
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.ViewToggle3DModel]: {
    id: ActionIds.ViewToggle3DModel,
    title: 'Toggle 3D model',
    category: 'View',
    description: 'Show or hide the 3D structure viewer',
    defaultShortcut: { key: 'm' },
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.DiffToggle]: {
    id: ActionIds.DiffToggle,
    title: 'Toggle diff mode',
    category: 'Comparison',
    description: 'Toggle diff highlighting against reference',
    defaultShortcut: { key: 'd' },
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.DiffNext]: {
    id: ActionIds.DiffNext,
    title: 'Next diff',
    category: 'Comparison',
    description: 'Jump to the next diff segment',
    defaultShortcut: { key: ']' },
    scope: 'contextual',
    surfaces: ['web'],
  },
  [ActionIds.DiffPrev]: {
    id: ActionIds.DiffPrev,
    title: 'Previous diff',
    category: 'Comparison',
    description: 'Jump to the previous diff segment',
    defaultShortcut: { key: '[' },
    scope: 'contextual',
    surfaces: ['web'],
  },
  [ActionIds.OverlayHelp]: {
    id: ActionIds.OverlayHelp,
    title: 'Help overlay',
    category: 'Overlays',
    description: 'Open keyboard shortcuts help',
    defaultShortcut: { key: '?' },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'help',
    overlayAction: 'toggle',
  },
  [ActionIds.OverlaySearch]: {
    id: ActionIds.OverlaySearch,
    title: 'Search overlay',
    category: 'Search',
    description: 'Open the phage search overlay',
    defaultShortcut: { key: '/' },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'search',
    overlayAction: 'open',
  },
  [ActionIds.OverlayCommandPalette]: {
    id: ActionIds.OverlayCommandPalette,
    title: 'Command palette',
    category: 'Overlays',
    description: 'Open the command palette',
    // Platform standard: Cmd+K (mac) / Ctrl+K (win/linux), plus ':' for vim-style users
    defaultShortcut: [
      { key: 'k', modifiers: { meta: true } },
      { key: 'k', modifiers: { ctrl: true } },
      { key: ':' },
    ],
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'commandPalette',
    overlayAction: 'toggle',
  },
  [ActionIds.OverlaySettings]: {
    id: ActionIds.OverlaySettings,
    title: 'Settings overlay',
    category: 'Overlays',
    description: 'Open settings',
    // Platform standard: Cmd+, (mac) / Ctrl+, (win/linux)
    defaultShortcut: [
      { key: ',', modifiers: { meta: true } },
      { key: ',', modifiers: { ctrl: true } },
    ],
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'settings',
    overlayAction: 'open',
  },
  [ActionIds.OverlayCloseAll]: {
    id: ActionIds.OverlayCloseAll,
    title: 'Close overlays',
    category: 'Overlays',
    description: 'Close open overlays',
    defaultShortcut: { key: 'Escape' },
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.OverlayAnalysisMenu]: {
    id: ActionIds.OverlayAnalysisMenu,
    title: 'Analysis menu',
    category: 'Overlays',
    description: 'Open the analysis menu',
    defaultShortcut: { key: 'a' },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'analysisMenu',
    overlayAction: 'toggle',
  },
  [ActionIds.OverlaySimulationHub]: {
    id: ActionIds.OverlaySimulationHub,
    title: 'Simulation hub',
    category: 'Simulation',
    description: 'Open the simulation hub',
    defaultShortcut: { key: 'S', modifiers: { shift: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'simulationHub',
    overlayAction: 'toggle',
  },
  [ActionIds.OverlayComparison]: {
    id: ActionIds.OverlayComparison,
    title: 'Compare genomes',
    category: 'Comparison',
    description: 'Open genome comparison overlay',
    defaultShortcut: { key: 'c' },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'comparison',
    overlayAction: 'open',
    provenance: 'measured',
  },
  [ActionIds.OverlayAAKey]: {
    id: ActionIds.OverlayAAKey,
    title: 'Amino acid key',
    category: 'Overlays',
    description: 'Open the amino acid key',
    defaultShortcut: { key: 'K', modifiers: { shift: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'aaKey',
    overlayAction: 'toggle',
  },
  [ActionIds.OverlayAALegend]: {
    id: ActionIds.OverlayAALegend,
    title: 'Amino acid legend',
    category: 'Overlays',
    description: 'Open the amino acid legend',
    defaultShortcut: { key: 'L', modifiers: { shift: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'aaLegend',
    overlayAction: 'toggle',
  },
  [ActionIds.OverlayPackagingPressure]: {
    id: ActionIds.OverlayPackagingPressure,
    title: 'Packaging pressure',
    category: 'Analysis',
    description: 'Open the packaging pressure overlay',
    defaultShortcut: { key: 'V', modifiers: { shift: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'pressure',
    overlayAction: 'toggle',
    provenance: 'heuristic',
  },
  [ActionIds.OverlaySelectionPressure]: {
    id: ActionIds.OverlaySelectionPressure,
    title: 'Selection pressure (dN/dS)',
    category: 'Analysis',
    description: 'Gene-aware dN/dS landscape against the diff reference genome',
    defaultShortcut: { key: 's', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'selectionPressure',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayTranscriptionFlow]: {
    id: ActionIds.OverlayTranscriptionFlow,
    title: 'Transcription flow',
    category: 'Analysis',
    description: 'Open the transcription flow overlay',
    defaultShortcut: { key: 'y' },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'transcriptionFlow',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayTropism]: {
    id: ActionIds.OverlayTropism,
    title: 'Tropism atlas',
    category: 'Analysis',
    description: 'Open the tropism overlay',
    defaultShortcut: { key: '0' },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'tropism',
    overlayAction: 'toggle',
    // precomputed trigram embeddings
    provenance: 'heuristic',
  },
  [ActionIds.OverlayGCSkew]: {
    id: ActionIds.OverlayGCSkew,
    title: 'GC skew analysis',
    category: 'Analysis',
    description: 'Open GC skew analysis',
    defaultShortcut: { key: 'g' },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'gcSkew',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayComplexity]: {
    id: ActionIds.OverlayComplexity,
    title: 'Sequence complexity',
    category: 'Analysis',
    description: 'Open sequence complexity analysis',
    defaultShortcut: { key: 'x' },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'complexity',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayBendability]: {
    id: ActionIds.OverlayBendability,
    title: 'DNA bendability',
    category: 'Analysis',
    description: 'Open bendability analysis',
    defaultShortcut: { key: 'b' },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'bendability',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayPromoter]: {
    id: ActionIds.OverlayPromoter,
    title: 'Promoter & RBS sites',
    category: 'Analysis',
    description: 'Open promoter and RBS analysis',
    defaultShortcut: { key: 'p' },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'promoter',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayRepeats]: {
    id: ActionIds.OverlayRepeats,
    title: 'Repeats & palindromes',
    category: 'Analysis',
    description: 'Open repeats and palindromes analysis',
    defaultShortcut: { key: 'r' },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'repeats',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayKmerAnomaly]: {
    id: ActionIds.OverlayKmerAnomaly,
    title: 'K-mer anomaly cartography',
    category: 'Analysis',
    description: 'Open k-mer anomaly overlay',
    defaultShortcut: { key: 'J', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'kmerAnomaly',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayCGR]: {
    id: ActionIds.OverlayCGR,
    title: 'Chaos game representation',
    category: 'Analysis',
    description: 'Open CGR overlay',
    defaultShortcut: { key: 'c', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'cgr',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayHilbert]: {
    id: ActionIds.OverlayHilbert,
    title: 'Hilbert curve',
    category: 'Analysis',
    description: 'Open Hilbert curve overlay',
    defaultShortcut: { key: 'h', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'hilbert',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayLogo]: {
    id: ActionIds.OverlayLogo,
    title: 'Sequence logo',
    category: 'Analysis',
    description: 'Open sequence logo overlay',
    defaultShortcut: { key: 'o' },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'logo',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayDotPlot]: {
    id: ActionIds.OverlayDotPlot,
    title: 'Dot plot analysis',
    category: 'Analysis',
    description: 'Open dot plot analysis',
    defaultShortcut: { key: 'o', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'dotPlot',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlaySynteny]: {
    id: ActionIds.OverlaySynteny,
    title: 'Synteny analysis',
    category: 'Analysis',
    description: 'Open synteny analysis',
    defaultShortcut: { key: 's', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'synteny',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayPhasePortrait]: {
    id: ActionIds.OverlayPhasePortrait,
    title: 'Phase portrait',
    category: 'Analysis',
    description: 'Open phase portrait overlay',
    defaultShortcut: { key: 'p', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'phasePortrait',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayGel]: {
    id: ActionIds.OverlayGel,
    title: 'Virtual gel electrophoresis',
    category: 'Analysis',
    description: 'Open virtual gel overlay',
    defaultShortcut: { key: 'g', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'gel',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayPeriodicity]: {
    id: ActionIds.OverlayPeriodicity,
    title: 'Periodicity spectrogram',
    category: 'Analysis',
    description: 'Open periodicity analysis',
    defaultShortcut: { key: 'w', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'periodicity',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayMosaicRadar]: {
    id: ActionIds.OverlayMosaicRadar,
    title: 'Mosaic radar',
    category: 'Comparison',
    description: 'Open mosaic radar overlay',
    defaultShortcut: { key: 'm', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'mosaicRadar',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayHGT]: {
    id: ActionIds.OverlayHGT,
    title: 'HGT provenance tracer',
    category: 'Analysis',
    description: 'Open HGT analysis',
    defaultShortcut: { key: 'h', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'hgt',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayCRISPR]: {
    id: ActionIds.OverlayCRISPR,
    title: 'CRISPR pressure map',
    category: 'Analysis',
    description: 'Open CRISPR analysis',
    defaultShortcut: { key: 'c', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'crispr',
    overlayAction: 'toggle',
    // The placeholder 6-mer spacer set is gone. What remains is the anti-CRISPR
    // prediction, a rule-based estimate over this phage's own translated genes:
    // heuristic, not demo. Spacer hits are reported only when real spacer data
    // is supplied, and the catalogue has none for any of its hosts, which the
    // overlay states explicitly rather than rendering as zero pressure.
    provenance: 'heuristic',
  },
  [ActionIds.OverlayNonBDNA]: {
    id: ActionIds.OverlayNonBDNA,
    title: 'Non-B-DNA structures',
    category: 'Analysis',
    description: 'Open non-B-DNA analysis',
    defaultShortcut: { key: 'n', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'nonBDNA',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayAnomaly]: {
    id: ActionIds.OverlayAnomaly,
    title: 'Anomaly detection',
    category: 'Analysis',
    description: 'Open anomaly detection overlay',
    defaultShortcut: { key: 'y', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'anomaly',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayGenomicSignaturePCA]: {
    id: ActionIds.OverlayGenomicSignaturePCA,
    title: 'Genomic signature PCA',
    category: 'Analysis',
    description: 'Open genomic signature PCA',
    defaultShortcut: { key: 'p', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'genomicSignaturePCA',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.AnalysisGenomicSignatureRecenter]: {
    id: ActionIds.AnalysisGenomicSignatureRecenter,
    title: 'Recenter PCA selection',
    category: 'Analysis',
    description: 'Recenter PCA on current phage',
    defaultShortcut: { key: 'l', modifiers: { alt: true } },
    scope: 'contextual',
    surfaces: ['web'],
  },
  [ActionIds.OverlayProphageExcision]: {
    id: ActionIds.OverlayProphageExcision,
    title: 'Prophage excision',
    category: 'Analysis',
    description: 'Open prophage excision overlay',
    defaultShortcut: { key: 'x', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'prophageExcision',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayCodonBias]: {
    id: ActionIds.OverlayCodonBias,
    title: 'Codon usage bias',
    category: 'Analysis',
    description: 'Open codon usage bias',
    defaultShortcut: { key: 'u', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'codonBias',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayCodonAdaptation]: {
    id: ActionIds.OverlayCodonAdaptation,
    title: 'Codon adaptation',
    category: 'Analysis',
    description: 'Open codon adaptation overlay',
    defaultShortcut: { key: 't', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'codonAdaptation',
    overlayAction: 'toggle',
    // host tRNA pools
    provenance: 'measured',
  },
  [ActionIds.OverlayAMGPathway]: {
    id: ActionIds.OverlayAMGPathway,
    title: 'AMG pathways',
    category: 'Analysis',
    description: 'Open AMG pathway overlay',
    defaultShortcut: { key: 'a', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'amgPathway',
    overlayAction: 'toggle',
    // keyword scan mapped to KEGG orthologs
    provenance: 'heuristic',
  },
  [ActionIds.OverlayBiasDecomposition]: {
    id: ActionIds.OverlayBiasDecomposition,
    title: 'Bias decomposition',
    category: 'Analysis',
    description: 'Open bias decomposition overlay',
    defaultShortcut: { key: 'b', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'biasDecomposition',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayProteinDomains]: {
    id: ActionIds.OverlayProteinDomains,
    title: 'Protein domains',
    category: 'Analysis',
    description: 'Open protein domain overlay',
    defaultShortcut: { key: 'd', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'proteinDomains',
    overlayAction: 'toggle',
    // Pfam-A via PyHMMER
    provenance: 'measured',
  },
  [ActionIds.OverlayFoldQuickview]: {
    id: ActionIds.OverlayFoldQuickview,
    title: 'Fold quickview',
    category: 'Analysis',
    description: 'Open fold quickview overlay',
    defaultShortcut: { key: 'f', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'foldQuickview',
    overlayAction: 'toggle',
    // ESM2 esm2_t6_8M_UR50D
    provenance: 'measured',
  },
  [ActionIds.OverlayLatentSpaceAtlas]: {
    id: ActionIds.OverlayLatentSpaceAtlas,
    title: 'Latent space atlas',
    category: 'Analysis',
    description: 'Open Pan-Phage Latent Space Atlas',
    defaultShortcut: { key: 'l', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'latentSpaceAtlas',
    overlayAction: 'toggle',
    // ESM2 + UMAP + HDBSCAN measured 2D manifold
    provenance: 'measured',
  },
  [ActionIds.OverlayHostInteractions]: {
    id: ActionIds.OverlayHostInteractions,
    title: 'Host interactions',
    category: 'Education',
    description: 'View available receptor evidence or explicitly select an illustrative interaction model',
    defaultShortcut: { key: 'i', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'hostInteractions',
    overlayAction: 'toggle',
    provenance: 'demo',
  },
  [ActionIds.OverlayPangenomeGraph]: {
    id: ActionIds.OverlayPangenomeGraph,
    title: 'Pangenome graph',
    category: 'Education',
    description: 'View comparative data requirements or explicitly select illustrative pangenome templates',
    defaultShortcut: { key: 'P', modifiers: { shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'pangenomeGraph',
    overlayAction: 'toggle',
    provenance: 'demo',
  },
  [ActionIds.OverlayRNAStructure]: {
    id: ActionIds.OverlayRNAStructure,
    title: 'RNA structure',
    category: 'Analysis',
    description: 'Open RNA structure overlay',
    defaultShortcut: { key: 'r', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'rnaStructure',
    overlayAction: 'toggle',
    provenance: 'heuristic',
  },
  [ActionIds.OverlayDefenseArmsRace]: {
    id: ActionIds.OverlayDefenseArmsRace,
    title: 'Defense arms race',
    category: 'Analysis',
    description: 'Open defense arms race overlay',
    defaultShortcut: { key: 'e', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'defenseArmsRace',
    overlayAction: 'toggle',
    // gene-product keyword scan
    provenance: 'heuristic',
  },
  [ActionIds.OverlayEpistasis]: {
    id: ActionIds.OverlayEpistasis,
    title: 'Epistasis explorer',
    category: 'Analysis',
    description: 'Open epistasis overlay',
    defaultShortcut: { key: 'e', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'epistasis',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayCocktailCompatibility]: {
    id: ActionIds.OverlayCocktailCompatibility,
    title: 'Cocktail compatibility matrix',
    category: 'Analysis',
    description: 'Open cocktail compatibility overlay',
    defaultShortcut: { key: 'k', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'cocktailCompatibility',
    overlayAction: 'toggle',
    provenance: 'heuristic',
  },
  [ActionIds.OverlayStructureConstraint]: {
    id: ActionIds.OverlayStructureConstraint,
    title: 'Structure constraints',
    category: 'Analysis',
    description: 'Open structure constraints overlay',
    defaultShortcut: { key: 'r', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'structureConstraint',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayVirionStability]: {
    id: ActionIds.OverlayVirionStability,
    title: 'Virion stability',
    category: 'Analysis',
    description: 'Open virion stability overlay',
    defaultShortcut: { key: 'v', modifiers: { alt: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'stability',
    overlayAction: 'toggle',
    provenance: 'heuristic',
  },
  [ActionIds.OverlayModules]: {
    id: ActionIds.OverlayModules,
    title: 'Module coherence',
    category: 'Analysis',
    description: 'Open module coherence overlay',
    defaultShortcut: { key: 'l' },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'modules',
    overlayAction: 'toggle',
    provenance: 'measured',
  },
  [ActionIds.OverlayResistanceEvolution]: {
    id: ActionIds.OverlayResistanceEvolution,
    title: 'Resistance evolution simulator',
    category: 'Simulation',
    description: 'Open resistance evolution simulation',
    defaultShortcut: { key: 'E', modifiers: { shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'resistanceEvolution',
    overlayAction: 'toggle',
    provenance: 'simulated',
  },
  [ActionIds.OverlayNicheNetwork]: {
    id: ActionIds.OverlayNicheNetwork,
    title: 'Niche network',
    // Education, not Analysis.
    //
    // The NMF and bootstrap mathematics here are real, but the community they
    // run on is synthetic: there is no co-occurrence index in the shipped
    // database. Sitting in "Analysis" next to forty overlays that do analyse
    // the loaded genome, it read as one of them, and the "EDUCATIONAL
    // SIMULATION" banner inside the overlay only appeared after the user had
    // already chosen it.
    category: 'Education',
    description: 'Explore niche co-occurrence structure on a simulated community',
    defaultShortcut: { key: 'N', modifiers: { ctrl: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'nicheNetwork',
    overlayAction: 'toggle',
    // Synthetic abundance table, now seeded from the loaded phage so the same
    // phage and parameters always give the same network.
    provenance: 'demo',
  },
  [ActionIds.OverlayPhylodynamics]: {
    id: ActionIds.OverlayPhylodynamics,
    title: 'Phylodynamics',
    category: 'Analysis',
    description: 'Open phylodynamic trajectory overlay',
    defaultShortcut: { key: 'y', modifiers: { ctrl: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'phylodynamics',
    overlayAction: 'toggle',
    // Real sequences fetched from NCBI; alignment-free Mash distance.
    // Falls back to a clearly-labelled demo path when fewer than five
    // sequences can be retrieved, which the menu must say up front.
    provenance: 'external',
    provenanceFallback: 'demo',
  },
  [ActionIds.OverlayEnvironmentalProvenance]: {
    id: ActionIds.OverlayEnvironmentalProvenance,
    title: 'Environmental provenance',
    category: 'Analysis',
    description: 'Open environmental provenance overlay',
    defaultShortcut: { key: 'e', modifiers: { ctrl: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'environmentalProvenance',
    overlayAction: 'toggle',
    // Locations, isolation sources and sample counts from NCBI SRA.
    // Catalogue distinctiveness is measured locally with MinHash. The
    // synthesised containment score is gone. Falls back to a stamped demo
    // sample set when SRA returns nothing usable.
    provenance: 'external',
    provenanceFallback: 'demo',
  },
  [ActionIds.OverlayGpuWasmBenchmark]: {
    id: ActionIds.OverlayGpuWasmBenchmark,
    title: 'GPU vs WASM benchmark',
    category: 'Dev',
    description: 'Open the GPU vs WASM benchmark',
    defaultShortcut: { key: 'b', modifiers: { alt: true, shift: true } },
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'power',
    overlayId: 'gpuWasmBenchmark',
    overlayAction: 'toggle',
    devOnly: true,
  },
  [ActionIds.OverlayCollaboration]: {
    id: ActionIds.OverlayCollaboration,
    title: 'Multi-Tab Sync',
    category: 'Overlays',
    description: 'Synchronize navigation and view state across browser tabs',
    defaultShortcut: [],
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'intermediate',
    overlayId: 'collaboration',
    overlayAction: 'toggle',
  },
  [ActionIds.HelpToggleDetail]: {
    id: ActionIds.HelpToggleDetail,
    title: 'Toggle help detail',
    category: 'Overlays',
    description: 'Toggle detailed shortcuts in help overlay',
    defaultShortcut: { key: 'd' },
    scope: 'contextual',
    surfaces: ['web'],
  },
  [ActionIds.EducationToggleBeginnerMode]: {
    id: ActionIds.EducationToggleBeginnerMode,
    title: 'Toggle beginner mode',
    category: 'Education',
    description: 'Enable or disable beginner mode',
    defaultShortcut: { key: 'b', modifiers: { ctrl: true } },
    scope: 'global',
    surfaces: ['web'],
  },
  [ActionIds.EducationStartTour]: {
    id: ActionIds.EducationStartTour,
    title: 'Take feature tour',
    category: 'Education',
    description: 'Start the guided feature tour',
    defaultShortcut: [],
    scope: 'global',
    surfaces: ['web'],
    minLevel: 'novice',
    overlayId: 'tour',
    overlayAction: 'open',
  },
  [ActionIds.NavGoto]: {
    id: ActionIds.NavGoto,
    title: 'Go to position...',
    category: 'Navigation',
    description: 'Jump to a specific genome coordinate',
    defaultShortcut: { key: 'g', modifiers: { ctrl: true } },
    scope: 'global',
    surfaces: ['web'],
    overlayId: 'goto',
    overlayAction: 'open',
  },
  [ActionIds.ExportFasta]: {
    id: ActionIds.ExportFasta,
    title: 'Export as FASTA',
    category: 'Export',
    description: 'Download current sequence as FASTA',
    defaultShortcut: [], // No default shortcut
    scope: 'contextual',
    surfaces: ['web'],
    minLevel: 'intermediate',
  },
  [ActionIds.ExportCopy]: {
    id: ActionIds.ExportCopy,
    title: 'Copy sequence',
    category: 'Export',
    description: 'Copy sequence to clipboard (rich text)',
    defaultShortcut: [], // No default shortcut
    scope: 'contextual',
    surfaces: ['web'],
    minLevel: 'novice',
  },
  [ActionIds.ExportJson]: {
    id: ActionIds.ExportJson,
    title: 'Export analysis JSON',
    category: 'Export',
    description: 'Download full analysis state',
    defaultShortcut: [], // No default shortcut
    scope: 'contextual',
    surfaces: ['web'],
    minLevel: 'power',
  },
};

export const ActionRegistryList = Object.values(ActionRegistry);

/**
 * Should this action be offered to the person using the app?
 *
 * Every surface that lists actions for a human -- the Analysis Menu, the
 * Command Palette, the Help overlay -- filters through this. Keyboard dispatch
 * deliberately does NOT: a developer who knows the shortcut can still reach a
 * dev-only overlay in a dev build, and in production the component declines to
 * render anyway, so the shortcut is inert rather than broken.
 *
 * The rule is one line, but it is a function so that the three call sites share
 * it. The previous arrangement -- each menu keeping its own exclusion list --
 * is how `gpuWasmBenchmark` ended up visible in two of them and hidden in
 * neither.
 */
export function isVisibleToUser(
  action: ActionDefinition,
  surface: ActionSurface = 'web'
): boolean {
  if (action.surfaces && !action.surfaces.includes(surface)) return false;
  if (action.devOnly && !import.meta.env.DEV) return false;
  return true;
}

export interface OverlayHotkeyAction {
  actionId: ActionId;
  overlayId: string;
  overlayAction: 'open' | 'toggle';
}

export function getOverlayHotkeyActions(): OverlayHotkeyAction[] {
  return ActionRegistryList
    .filter((action): action is ActionDefinition & { overlayId: string; overlayAction: 'open' | 'toggle' } => (
      Boolean(action.overlayId && action.overlayAction) && action.scope === 'global'
    ))
    .map((action) => ({
      actionId: action.id,
      overlayId: action.overlayId,
      overlayAction: action.overlayAction,
    }));
}
