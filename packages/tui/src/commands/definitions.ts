import { usePhageStore } from '@phage-explorer/state';
import { registerCommand } from './registry';

export function initializeCommands(): void {
  const store = usePhageStore.getState();

  // Navigation
  registerCommand({
    id: 'nav-next',
    label: 'Next phage',
    description: 'Move down the list',
    keywords: ['arrow', 'down'],
    category: 'Navigation',
    shortcut: '↓',
    action: () => usePhageStore.getState().nextPhage(),
  });

  registerCommand({
    id: 'nav-prev',
    label: 'Previous phage',
    description: 'Move up the list',
    keywords: ['arrow', 'up'],
    category: 'Navigation',
    shortcut: '↑',
    action: () => usePhageStore.getState().prevPhage(),
  });

  registerCommand({
    id: 'search',
    label: 'Search phages',
    description: 'Open search overlay',
    keywords: ['find'],
    category: 'Navigation',
    shortcut: 'S or /',
    action: () => usePhageStore.getState().openOverlay('search'),
  });

  // View
  registerCommand({
    id: 'view-toggle',
    label: 'Toggle DNA / AA view',
    description: 'Switch sequence mode',
    keywords: ['mode', 'view'],
    category: 'View',
    shortcut: 'Space',
    action: () => usePhageStore.getState().toggleViewMode(),
  });

  registerCommand({
    id: 'frame-cycle',
    label: 'Cycle reading frame',
    description: 'Frame 1 → 2 → 3',
    keywords: ['frame'],
    category: 'View',
    shortcut: 'F',
    action: () => usePhageStore.getState().cycleReadingFrame(),
  });

  registerCommand({
    id: 'theme-cycle',
    label: 'Cycle theme',
    description: 'Rotate color themes',
    keywords: ['colors'],
    category: 'View',
    shortcut: 'T',
    action: () => usePhageStore.getState().cycleTheme(),
  });

  // Analysis
  registerCommand({
    id: 'diff-toggle',
    label: 'Toggle diff',
    description: 'Diff vs reference',
    keywords: ['compare'],
    category: 'Analysis',
    shortcut: 'D',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleDiff(),
  });

  registerCommand({
    id: 'comparison',
    label: 'Genome comparison',
    description: 'Open comparison overlay',
    keywords: ['compare', 'genome'],
    category: 'Analysis',
    shortcut: 'W',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().openComparison(),
  });

  // 3D Model
  registerCommand({
    id: 'model-toggle',
    label: 'Toggle 3D model',
    description: 'Show/hide 3D model',
    keywords: ['3d', 'model'],
    category: '3D',
    shortcut: 'M',
    action: () => usePhageStore.getState().toggle3DModel(),
  });

  registerCommand({
    id: 'model-pause',
    label: 'Pause/resume 3D model',
    description: 'Pause/resume rotation (O key)',
    keywords: ['3d', 'pause'],
    category: '3D',
    shortcut: 'O/P',
    action: () => usePhageStore.getState().toggle3DModelPause(),
  });

  registerCommand({
    id: 'model-fullscreen',
    label: 'Fullscreen 3D model',
    description: 'Enter/exit fullscreen',
    keywords: ['3d', 'fullscreen'],
    category: '3D',
    shortcut: 'Z',
    action: () => usePhageStore.getState().toggle3DModelFullscreen(),
  });

  registerCommand({
    id: 'model-quality',
    label: 'Cycle 3D quality',
    description: 'Change shading quality',
    keywords: ['3d', 'quality'],
    category: '3D',
    shortcut: 'R',
    action: () => usePhageStore.getState().cycle3DModelQuality(),
  });

  // Advanced Overlays
  registerCommand({
    id: 'analysis-menu',
    label: 'Analysis menu',
    description: 'Open analysis menu',
    keywords: ['menu', 'analysis'],
    category: 'Menu',
    shortcut: 'A',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().openOverlay('analysisMenu'),
  });

  registerCommand({
    id: 'complexity',
    label: 'Sequence complexity',
    description: 'Open complexity overlay',
    keywords: ['entropy', 'complexity'],
    category: 'Overlay',
    shortcut: 'X',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('complexity'),
  });

  registerCommand({
    id: 'gc-skew',
    label: 'GC skew',
    description: 'Open GC skew overlay',
    keywords: ['gc'],
    category: 'Overlay',
    shortcut: 'G',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('gcSkew'),
  });

  registerCommand({
    id: 'bendability',
    label: 'Bendability',
    description: 'AT-rich bendability proxy overlay',
    keywords: ['bend', 'at'],
    category: 'Overlay',
    shortcut: 'B',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('bendability'),
  });

  registerCommand({
    id: 'promoter',
    label: 'Promoter/RBS motifs',
    description: 'Scan for -10/-35 and Shine-Dalgarno',
    keywords: ['promoter', 'rbs'],
    category: 'Overlay',
    shortcut: 'P',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('promoter'),
  });

  registerCommand({
    id: 'repeats',
    label: 'Repeats / palindromes',
    description: 'Detect short palindromic repeats',
    keywords: ['repeat', 'palindrome'],
    category: 'Overlay',
    shortcut: 'R',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('repeats'),
  });

  registerCommand({
    id: 'kmer',
    label: 'K-mer anomaly',
    description: 'Highlight composition shifts',
    keywords: ['kmer', 'anomaly'],
    category: 'Overlay',
    shortcut: 'J',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('kmerAnomaly'),
  });

  registerCommand({
    id: 'modules',
    label: 'Module coherence',
    description: 'Capsid/tail/lysis module view',
    keywords: ['module', 'stoichiometry'],
    category: 'Overlay',
    shortcut: 'L',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('modules'),
  });

  registerCommand({
    id: 'pressure',
    label: 'Packaging pressure gauge',
    description: 'Estimate capsid filling pressure',
    keywords: ['pressure', 'packing'],
    category: 'Overlay',
    shortcut: 'V',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('pressure'),
  });

  registerCommand({
    id: 'dot-plot',
    label: 'Self-homology dot plot',
    description: 'Direct vs inverted repeat map',
    keywords: ['dot', 'homology', 'repeat'],
    category: 'Overlay',
    shortcut: 'A→Dot',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().openOverlay('dotPlot'),
  });

  registerCommand({
    id: 'cgr',
    label: 'CGR fractal fingerprint',
    description: 'Chaos Game Representation of sequence',
    keywords: ['cgr', 'fractal', 'kmer'],
    category: 'Overlay',
    shortcut: 'A→CGR',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().openOverlay('cgr'),
  });

  registerCommand({
    id: 'hilbert',
    label: 'Hilbert genome atlas',
    description: 'Space-filling curve view',
    keywords: ['hilbert', 'map'],
    category: 'Overlay',
    shortcut: 'A→Hilbert',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().openOverlay('hilbert'),
  });

  registerCommand({
    id: 'gel',
    label: 'Virtual agarose gel',
    description: 'Restriction digest simulation',
    keywords: ['gel', 'digest', 'restriction'],
    category: 'Overlay',
    shortcut: 'A→Gel',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().openOverlay('gel'),
  });

  registerCommand({
    id: 'nonb',
    label: 'Non-B DNA structures',
    description: 'G4/Z-DNA motif scanner',
    keywords: ['non-b', 'g4', 'z-dna'],
    category: 'Overlay',
    shortcut: 'A→NonB',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('non-b-dna'),
  });

  registerCommand({
    id: 'anomaly',
    label: 'Sequence anomaly scanner',
    description: 'Info-theoretic anomaly map (KL + compression)',
    keywords: ['anomaly', 'kl', 'compression'],
    category: 'Overlay',
    shortcut: 'Shift+A',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('anomaly'),
  });

  registerCommand({
    id: 'phase-portraits',
    label: 'AA property phase portraits',
    description: 'PCA of hydropathy/charge/aromaticity trajectories',
    keywords: ['phase', 'portrait', 'protein', 'property'],
    category: 'Overlay',
    shortcut: 'Shift+P',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('phasePortrait'),
  });

  registerCommand({
    id: 'bias-decomposition',
    label: 'Dinucleotide bias decomposition',
    description: 'PCA on dinucleotide frequencies across phages',
    keywords: ['bias', 'dinucleotide', 'pca'],
    category: 'Overlay',
    shortcut: 'A→Bias',
    minLevel: 'intermediate',
    action: () => usePhageStore.getState().toggleOverlay('biasDecomposition'),
  });

  registerCommand({
    id: 'mosaic-radar',
    label: 'Mosaic / recombination radar',
    description: 'Sliding‑window donor shifts and breakpoints',
    keywords: ['recombination', 'mosaic', 'donor', 'breakpoint'],
    category: 'Overlay',
    shortcut: 'A→MR',
    minLevel: 'power',
    action: () => usePhageStore.getState().openOverlay('mosaicRadar'),
  });

  // Power Commands
  registerCommand({
    id: 'command-palette',
    label: 'Command palette',
    description: 'Fuzzy commands (Ctrl+P / :)',
    keywords: ['palette', 'commands'],
    category: 'Menu',
    shortcut: 'Ctrl+P',
    minLevel: 'power',
    action: () => usePhageStore.getState().openOverlay('commandPalette'),
  });

  registerCommand({
    id: 'fold-quickview',
    label: 'Fold quickview',
    description: 'View fold embeddings (Ctrl+F)',
    keywords: ['fold', 'structure'],
    category: 'Analysis',
    shortcut: 'Ctrl+F',
    minLevel: 'power',
    action: () => usePhageStore.getState().openOverlay('foldQuickview'),
  });

  registerCommand({
    id: 'simulation-hub',
    label: 'Simulation hub',
    description: 'Open simulation hub',
    keywords: ['simulation', 'hub'],
    category: 'Simulation',
    shortcut: 'Shift+S',
    minLevel: 'power',
    action: () => usePhageStore.getState().openOverlay('simulationHub'),
  });

  // Novice Hints
  registerCommand({
    id: 'unlock-advanced',
    label: 'Unlock advanced overlays',
    description: 'Promote experience to access advanced tools',
    keywords: ['unlock', 'advanced', 'promote'],
    minLevel: 'novice',
    maxLevel: 'novice',
    action: () => usePhageStore.getState().setError('Advanced overlays unlock automatically after time; ask to promote to power.'),
  });
}
