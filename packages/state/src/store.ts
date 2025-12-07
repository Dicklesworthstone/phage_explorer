import { create } from 'zustand';
import type {
  PhageSummary,
  PhageFull,
  ViewMode,
  ReadingFrame,
  GeneInfo,
  Theme,
} from '@phage-explorer/core';
import { CLASSIC_THEME, getNextTheme, getThemeById } from '@phage-explorer/core';
import type { GenomeComparisonResult } from '@phage-explorer/comparison';

// Overlay states
export type OverlayType = 'help' | 'search' | 'goto' | 'aaKey' | 'comparison' | null;

// Comparison view tab
export type ComparisonTab = 'summary' | 'kmer' | 'information' | 'correlation' | 'biological' | 'genes';

// Mouse hover info for amino acids
export interface HoveredAminoAcid {
  letter: string;
  name: string;
  threeCode: string;
  property: string;
  position: number; // position in sequence
}

// Store state interface
export interface PhageExplorerState {
  // Phage data
  phages: PhageSummary[];
  currentPhageIndex: number;
  currentPhage: PhageFull | null;
  isLoadingPhage: boolean;

  // Sequence viewing
  viewMode: ViewMode;
  readingFrame: ReadingFrame;
  scrollPosition: number;

  // Diff mode
  diffEnabled: boolean;
  diffReferencePhageId: number | null;
  diffReferenceSequence: string | null;

  // Theme
  currentTheme: Theme;

  // 3D model
  show3DModel: boolean;
  model3DPaused: boolean;
  model3DSpeed: number;
  model3DFullscreen: boolean;
  model3DQuality: 'low' | 'medium' | 'high' | 'ultra';

  // Mouse hover
  mouseX: number;
  mouseY: number;
  hoveredAminoAcid: HoveredAminoAcid | null;

  // Overlays
  activeOverlay: OverlayType;
  searchQuery: string;
  searchResults: PhageSummary[];

  // Terminal dimensions
  terminalCols: number;
  terminalRows: number;

  // Error state
  error: string | null;

  // Comparison mode
  comparisonPhageAIndex: number | null;
  comparisonPhageBIndex: number | null;
  comparisonResult: GenomeComparisonResult | null;
  comparisonLoading: boolean;
  comparisonTab: ComparisonTab;
  comparisonSelectingPhage: 'A' | 'B' | null;
}

// Store actions interface
export interface PhageExplorerActions {
  // Phage navigation
  setPhages: (phages: PhageSummary[]) => void;
  setCurrentPhageIndex: (index: number) => void;
  nextPhage: () => void;
  prevPhage: () => void;
  setCurrentPhage: (phage: PhageFull | null) => void;
  setLoadingPhage: (loading: boolean) => void;

  // Sequence viewing
  setViewMode: (mode: ViewMode) => void;
  toggleViewMode: () => void;
  setReadingFrame: (frame: ReadingFrame) => void;
  cycleReadingFrame: () => void;
  setScrollPosition: (position: number) => void;
  scrollBy: (delta: number) => void;
  scrollToStart: () => void;
  scrollToEnd: () => void;

  // Diff mode
  toggleDiff: () => void;
  setDiffReference: (phageId: number | null, sequence: string | null) => void;

  // Theme
  setTheme: (themeId: string) => void;
  cycleTheme: () => void;

  // 3D model
  toggle3DModel: () => void;
  toggle3DModelPause: () => void;
  set3DModelSpeed: (speed: number) => void;
  toggle3DModelFullscreen: () => void;
  cycle3DModelQuality: () => void;

  // Overlays
  setActiveOverlay: (overlay: OverlayType) => void;
  closeOverlay: () => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: PhageSummary[]) => void;

  // Terminal
  setTerminalSize: (cols: number, rows: number) => void;

  // Mouse
  setMousePosition: (x: number, y: number) => void;
  setHoveredAminoAcid: (aa: HoveredAminoAcid | null) => void;

  // Error
  setError: (error: string | null) => void;

  // Reset
  reset: () => void;

  // Comparison
  openComparison: () => void;
  closeComparison: () => void;
  setComparisonPhageA: (index: number | null) => void;
  setComparisonPhageB: (index: number | null) => void;
  setComparisonResult: (result: GenomeComparisonResult | null) => void;
  setComparisonLoading: (loading: boolean) => void;
  setComparisonTab: (tab: ComparisonTab) => void;
  nextComparisonTab: () => void;
  prevComparisonTab: () => void;
  startSelectingPhage: (which: 'A' | 'B') => void;
  confirmPhageSelection: (index: number) => void;
  cancelPhageSelection: () => void;
  swapComparisonPhages: () => void;
}

// Combined store type
export type PhageExplorerStore = PhageExplorerState & PhageExplorerActions;

// Initial state
const initialState: PhageExplorerState = {
  phages: [],
  currentPhageIndex: 0,
  currentPhage: null,
  isLoadingPhage: false,
  viewMode: 'dna',
  readingFrame: 0,
  scrollPosition: 0,
  diffEnabled: false,
  diffReferencePhageId: null,
  diffReferenceSequence: null,
  currentTheme: CLASSIC_THEME,
  show3DModel: true,
  model3DPaused: true, // Paused by default to prevent flickering
  model3DSpeed: 1,
  model3DFullscreen: false,
  model3DQuality: 'medium',
  mouseX: 0,
  mouseY: 0,
  hoveredAminoAcid: null,
  activeOverlay: null,
  searchQuery: '',
  searchResults: [],
  terminalCols: 80,
  terminalRows: 24,
  error: null,
  comparisonPhageAIndex: null,
  comparisonPhageBIndex: null,
  comparisonResult: null,
  comparisonLoading: false,
  comparisonTab: 'summary',
  comparisonSelectingPhage: null,
};

// Create the store
export const usePhageStore = create<PhageExplorerStore>((set, get) => ({
  ...initialState,

  // Phage navigation
  setPhages: (phages) => set({ phages }),

  setCurrentPhageIndex: (index) => {
    const { phages } = get();
    if (index >= 0 && index < phages.length) {
      set({
        currentPhageIndex: index,
        scrollPosition: 0, // Reset scroll when changing phages
      });
    }
  },

  nextPhage: () => {
    const { currentPhageIndex, phages } = get();
    if (currentPhageIndex < phages.length - 1) {
      set({
        currentPhageIndex: currentPhageIndex + 1,
        scrollPosition: 0,
      });
    }
  },

  prevPhage: () => {
    const { currentPhageIndex } = get();
    if (currentPhageIndex > 0) {
      set({
        currentPhageIndex: currentPhageIndex - 1,
        scrollPosition: 0,
      });
    }
  },

  setCurrentPhage: (phage) => set({ currentPhage: phage }),
  setLoadingPhage: (loading) => set({ isLoadingPhage: loading }),

  // Sequence viewing
  setViewMode: (mode) => set({ viewMode: mode, scrollPosition: 0 }),

  toggleViewMode: () => {
    const { viewMode } = get();
    set({
      viewMode: viewMode === 'dna' ? 'aa' : 'dna',
      scrollPosition: 0,
    });
  },

  setReadingFrame: (frame) => set({ readingFrame: frame }),

  cycleReadingFrame: () => {
    const { readingFrame } = get();
    set({ readingFrame: ((readingFrame + 1) % 3) as ReadingFrame });
  },

  setScrollPosition: (position) => {
    set({ scrollPosition: Math.max(0, position) });
  },

  scrollBy: (delta) => {
    const { scrollPosition } = get();
    set({ scrollPosition: Math.max(0, scrollPosition + delta) });
  },

  scrollToStart: () => set({ scrollPosition: 0 }),

  scrollToEnd: () => {
    const { currentPhage, viewMode, terminalCols, terminalRows } = get();
    if (!currentPhage?.genomeLength) return;

    const length = viewMode === 'aa'
      ? Math.floor(currentPhage.genomeLength / 3)
      : currentPhage.genomeLength;

    // Approximate chars per screen
    const charsPerScreen = (terminalCols - 30) * (terminalRows - 10);
    set({ scrollPosition: Math.max(0, length - charsPerScreen) });
  },

  // Diff mode
  toggleDiff: () => {
    const { diffEnabled, phages, currentPhageIndex } = get();
    if (!diffEnabled && phages.length > 0) {
      // Enable diff with first phage (lambda) as reference by default
      const lambdaIndex = phages.findIndex(p =>
        p.slug === 'lambda' || p.name.toLowerCase().includes('lambda')
      );
      const refIndex = lambdaIndex >= 0 ? lambdaIndex : 0;
      set({
        diffEnabled: true,
        diffReferencePhageId: phages[refIndex].id,
      });
    } else {
      set({
        diffEnabled: false,
        diffReferencePhageId: null,
        diffReferenceSequence: null,
      });
    }
  },

  setDiffReference: (phageId, sequence) => set({
    diffReferencePhageId: phageId,
    diffReferenceSequence: sequence,
  }),

  // Theme
  setTheme: (themeId) => set({ currentTheme: getThemeById(themeId) }),

  cycleTheme: () => {
    const { currentTheme } = get();
    set({ currentTheme: getNextTheme(currentTheme.id) });
  },

  // 3D model
  toggle3DModel: () => {
    const { show3DModel } = get();
    set({ show3DModel: !show3DModel });
  },

  toggle3DModelPause: () => {
    const { model3DPaused } = get();
    set({ model3DPaused: !model3DPaused });
  },

  set3DModelSpeed: (speed) => set({ model3DSpeed: speed }),

  toggle3DModelFullscreen: () => {
    const { model3DFullscreen } = get();
    // When entering fullscreen:
    // - Automatically use high quality
    // - Unpause the animation
    // - Close any active overlay (so it doesn't appear when exiting)
    // When exiting:
    // - Return to medium quality
    // - Pause the animation to prevent flickering
    const enteringFullscreen = !model3DFullscreen;
    set({
      model3DFullscreen: enteringFullscreen,
      model3DQuality: enteringFullscreen ? 'high' : 'medium',
      model3DPaused: !enteringFullscreen, // Pause when exiting, unpause when entering
      // Close overlays when entering fullscreen to avoid hidden state
      ...(enteringFullscreen ? { activeOverlay: null, searchQuery: '', searchResults: [] } : {}),
    });
  },

  cycle3DModelQuality: () => {
    const { model3DQuality } = get();
    const qualities: Array<'low' | 'medium' | 'high' | 'ultra'> = ['low', 'medium', 'high', 'ultra'];
    const currentIndex = qualities.indexOf(model3DQuality);
    const nextIndex = (currentIndex + 1) % qualities.length;
    set({ model3DQuality: qualities[nextIndex] });
  },

  // Overlays
  setActiveOverlay: (overlay) => set({ activeOverlay: overlay }),

  closeOverlay: () => set({
    activeOverlay: null,
    searchQuery: '',
    searchResults: [],
  }),

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchResults: (results) => set({ searchResults: results }),

  // Terminal
  setTerminalSize: (cols, rows) => set({ terminalCols: cols, terminalRows: rows }),

  // Mouse
  setMousePosition: (x, y) => set({ mouseX: x, mouseY: y }),
  setHoveredAminoAcid: (aa) => set({ hoveredAminoAcid: aa }),

  // Error
  setError: (error) => set({ error }),

  // Reset
  reset: () => set(initialState),

  // Comparison
  openComparison: () => {
    const { currentPhageIndex, phages } = get();
    // Default: compare current phage with Lambda or first phage
    const lambdaIndex = phages.findIndex(p =>
      p.slug === 'lambda' || p.name.toLowerCase().includes('lambda')
    );
    const defaultB = lambdaIndex >= 0 && lambdaIndex !== currentPhageIndex
      ? lambdaIndex
      : currentPhageIndex === 0 ? 1 : 0;

    set({
      activeOverlay: 'comparison',
      comparisonPhageAIndex: currentPhageIndex,
      comparisonPhageBIndex: Math.min(defaultB, phages.length - 1),
      comparisonResult: null,
      comparisonTab: 'summary',
      comparisonSelectingPhage: null,
    });
  },

  closeComparison: () => set({
    activeOverlay: null,
    comparisonResult: null,
    comparisonSelectingPhage: null,
  }),

  setComparisonPhageA: (index) => set({
    comparisonPhageAIndex: index,
    comparisonResult: null, // Clear result when phages change
  }),

  setComparisonPhageB: (index) => set({
    comparisonPhageBIndex: index,
    comparisonResult: null,
  }),

  setComparisonResult: (result) => set({ comparisonResult: result }),

  setComparisonLoading: (loading) => set({ comparisonLoading: loading }),

  setComparisonTab: (tab) => set({ comparisonTab: tab }),

  nextComparisonTab: () => {
    const { comparisonTab } = get();
    const tabs: ComparisonTab[] = ['summary', 'kmer', 'information', 'correlation', 'biological', 'genes'];
    const currentIndex = tabs.indexOf(comparisonTab);
    const nextIndex = (currentIndex + 1) % tabs.length;
    set({ comparisonTab: tabs[nextIndex] });
  },

  prevComparisonTab: () => {
    const { comparisonTab } = get();
    const tabs: ComparisonTab[] = ['summary', 'kmer', 'information', 'correlation', 'biological', 'genes'];
    const currentIndex = tabs.indexOf(comparisonTab);
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    set({ comparisonTab: tabs[prevIndex] });
  },

  startSelectingPhage: (which) => set({ comparisonSelectingPhage: which }),

  confirmPhageSelection: (index) => {
    const { comparisonSelectingPhage } = get();
    if (comparisonSelectingPhage === 'A') {
      set({
        comparisonPhageAIndex: index,
        comparisonSelectingPhage: null,
        comparisonResult: null,
      });
    } else if (comparisonSelectingPhage === 'B') {
      set({
        comparisonPhageBIndex: index,
        comparisonSelectingPhage: null,
        comparisonResult: null,
      });
    }
  },

  cancelPhageSelection: () => set({ comparisonSelectingPhage: null }),

  swapComparisonPhages: () => {
    const { comparisonPhageAIndex, comparisonPhageBIndex } = get();
    set({
      comparisonPhageAIndex: comparisonPhageBIndex,
      comparisonPhageBIndex: comparisonPhageAIndex,
      comparisonResult: null,
    });
  },
}));

// Selector hooks for common derived state
export const useCurrentPhageSummary = () => {
  const phages = usePhageStore((s) => s.phages);
  const index = usePhageStore((s) => s.currentPhageIndex);
  return phages[index] ?? null;
};

export const useGridDimensions = () => {
  const cols = usePhageStore((s) => s.terminalCols);
  const rows = usePhageStore((s) => s.terminalRows);

  // Calculate usable grid area
  const sidebarWidth = 30;
  const hudHeight = 4;
  const footerHeight = 2;
  const geneMapHeight = 2;

  return {
    gridCols: Math.max(1, cols - sidebarWidth - 2),
    gridRows: Math.max(1, rows - hudHeight - footerHeight - geneMapHeight - 2),
    sidebarWidth,
    hudHeight,
    footerHeight,
    geneMapHeight,
  };
};
