/**
 * Unit tests for Phage Explorer Zustand Store
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { usePhageStore } from './store';
import type { PhageSummary, PhageFull } from '@phage-explorer/core';

// Reset store before each test
beforeEach(() => {
  usePhageStore.getState().reset();
});

// Mock phage data
const mockPhages: PhageSummary[] = [
  { id: 1, name: 'Phage A', slug: 'phage-a', genomeLength: 50000 },
  { id: 2, name: 'Lambda', slug: 'lambda', genomeLength: 48502 },
  { id: 3, name: 'Phage C', slug: 'phage-c', genomeLength: 45000 },
];

const mockPhageFull: PhageFull = {
  id: 1,
  name: 'Phage A',
  slug: 'phage-a',
  genomeLength: 50000,
  sequence: 'ATCG'.repeat(12500),
  genes: [],
  gcContent: 45.5,
  ncbiAccession: 'NC_001234',
};

describe('PhageExplorerStore - Phage Navigation', () => {
  it('sets phages list', () => {
    const { setPhages } = usePhageStore.getState();
    setPhages(mockPhages);

    expect(usePhageStore.getState().phages).toEqual(mockPhages);
  });

  it('sets current phage index within bounds', () => {
    const store = usePhageStore.getState();
    store.setPhages(mockPhages);
    store.setCurrentPhageIndex(2);

    expect(usePhageStore.getState().currentPhageIndex).toBe(2);
  });

  it('ignores out-of-bounds phage index', () => {
    const store = usePhageStore.getState();
    store.setPhages(mockPhages);
    store.setCurrentPhageIndex(10); // Out of bounds

    expect(usePhageStore.getState().currentPhageIndex).toBe(0);
  });

  it('navigates to next phage', () => {
    const store = usePhageStore.getState();
    store.setPhages(mockPhages);
    store.setCurrentPhageIndex(0);
    store.nextPhage();

    expect(usePhageStore.getState().currentPhageIndex).toBe(1);
  });

  it('stops at last phage when navigating next', () => {
    const store = usePhageStore.getState();
    store.setPhages(mockPhages);
    store.setCurrentPhageIndex(2);
    store.nextPhage();

    expect(usePhageStore.getState().currentPhageIndex).toBe(2);
  });

  it('navigates to previous phage', () => {
    const store = usePhageStore.getState();
    store.setPhages(mockPhages);
    store.setCurrentPhageIndex(2);
    store.prevPhage();

    expect(usePhageStore.getState().currentPhageIndex).toBe(1);
  });

  it('stops at first phage when navigating previous', () => {
    const store = usePhageStore.getState();
    store.setPhages(mockPhages);
    store.setCurrentPhageIndex(0);
    store.prevPhage();

    expect(usePhageStore.getState().currentPhageIndex).toBe(0);
  });

  it('resets scroll position when changing phages', () => {
    const store = usePhageStore.getState();
    store.setPhages(mockPhages);
    store.setScrollPosition(1000);
    store.nextPhage();

    expect(usePhageStore.getState().scrollPosition).toBe(0);
  });
});

describe('PhageExplorerStore - View Mode', () => {
  it('toggles view mode: dna -> aa -> dual -> dna', () => {
    const store = usePhageStore.getState();

    expect(store.viewMode).toBe('dna');
    store.toggleViewMode();
    expect(usePhageStore.getState().viewMode).toBe('aa');
    usePhageStore.getState().toggleViewMode();
    expect(usePhageStore.getState().viewMode).toBe('dual');
    usePhageStore.getState().toggleViewMode();
    expect(usePhageStore.getState().viewMode).toBe('dna');
  });

  it('sets view mode directly', () => {
    const store = usePhageStore.getState();
    store.setViewMode('aa');

    expect(usePhageStore.getState().viewMode).toBe('aa');
  });

  it('resets scroll position when setting view mode', () => {
    const store = usePhageStore.getState();
    store.setScrollPosition(500);
    store.setViewMode('aa');

    expect(usePhageStore.getState().scrollPosition).toBe(0);
  });
});

describe('PhageExplorerStore - Reading Frame', () => {
  it('cycles through reading frames: 0 -> 1 -> 2 -> -1 -> -2 -> -3 -> 0', () => {
    const store = usePhageStore.getState();

    expect(store.readingFrame).toBe(0);
    store.cycleReadingFrame();
    expect(usePhageStore.getState().readingFrame).toBe(1);
    usePhageStore.getState().cycleReadingFrame();
    expect(usePhageStore.getState().readingFrame).toBe(2);
    usePhageStore.getState().cycleReadingFrame();
    expect(usePhageStore.getState().readingFrame).toBe(-1);
    usePhageStore.getState().cycleReadingFrame();
    expect(usePhageStore.getState().readingFrame).toBe(-2);
    usePhageStore.getState().cycleReadingFrame();
    expect(usePhageStore.getState().readingFrame).toBe(-3);
    usePhageStore.getState().cycleReadingFrame();
    expect(usePhageStore.getState().readingFrame).toBe(0);
  });

  it('sets reading frame directly', () => {
    const store = usePhageStore.getState();
    store.setReadingFrame(-2);

    expect(usePhageStore.getState().readingFrame).toBe(-2);
  });
});

describe('PhageExplorerStore - Scroll Position', () => {
  it('sets scroll position', () => {
    const store = usePhageStore.getState();
    store.setScrollPosition(1000);

    expect(usePhageStore.getState().scrollPosition).toBe(1000);
  });

  it('clamps scroll position to minimum 0', () => {
    const store = usePhageStore.getState();
    store.setScrollPosition(-100);

    expect(usePhageStore.getState().scrollPosition).toBe(0);
  });

  it('scrolls by delta', () => {
    const store = usePhageStore.getState();
    store.setScrollPosition(500);
    store.scrollBy(100);

    expect(usePhageStore.getState().scrollPosition).toBe(600);
  });

  it('scrolls by negative delta (up)', () => {
    const store = usePhageStore.getState();
    store.setScrollPosition(500);
    store.scrollBy(-200);

    expect(usePhageStore.getState().scrollPosition).toBe(300);
  });

  it('clamps scroll to 0 when scrolling past start', () => {
    const store = usePhageStore.getState();
    store.setScrollPosition(100);
    store.scrollBy(-500);

    expect(usePhageStore.getState().scrollPosition).toBe(0);
  });

  it('scrolls to start', () => {
    const store = usePhageStore.getState();
    store.setScrollPosition(1000);
    store.scrollToStart();

    expect(usePhageStore.getState().scrollPosition).toBe(0);
  });
});

describe('PhageExplorerStore - 3D Model Controls', () => {
  it('toggles 3D model visibility', () => {
    const store = usePhageStore.getState();

    expect(store.show3DModel).toBe(true);
    store.toggle3DModel();
    expect(usePhageStore.getState().show3DModel).toBe(false);
    usePhageStore.getState().toggle3DModel();
    expect(usePhageStore.getState().show3DModel).toBe(true);
  });

  it('toggles 3D model pause state', () => {
    const store = usePhageStore.getState();

    expect(store.model3DPaused).toBe(true); // Default paused
    store.toggle3DModelPause();
    expect(usePhageStore.getState().model3DPaused).toBe(false);
    usePhageStore.getState().toggle3DModelPause();
    expect(usePhageStore.getState().model3DPaused).toBe(true);
  });

  it('cycles 3D model quality: low -> medium -> high -> ultra -> low', () => {
    const store = usePhageStore.getState();

    // Start at medium (default)
    expect(store.model3DQuality).toBe('medium');
    store.cycle3DModelQuality();
    expect(usePhageStore.getState().model3DQuality).toBe('high');
    usePhageStore.getState().cycle3DModelQuality();
    expect(usePhageStore.getState().model3DQuality).toBe('ultra');
    usePhageStore.getState().cycle3DModelQuality();
    expect(usePhageStore.getState().model3DQuality).toBe('low');
    usePhageStore.getState().cycle3DModelQuality();
    expect(usePhageStore.getState().model3DQuality).toBe('medium');
  });

  it('sets 3D model speed', () => {
    const store = usePhageStore.getState();
    store.set3DModelSpeed(2.5);

    expect(usePhageStore.getState().model3DSpeed).toBe(2.5);
  });
});

describe('PhageExplorerStore - Overlay Management', () => {
  it('opens overlay and adds to stack', () => {
    const store = usePhageStore.getState();
    store.openOverlay('help');

    expect(usePhageStore.getState().overlays).toContain('help');
  });

  it('closes overlay by id', () => {
    const store = usePhageStore.getState();
    store.openOverlay('help');
    store.openOverlay('search');
    store.closeOverlay('help');

    const overlays = usePhageStore.getState().overlays;
    expect(overlays).not.toContain('help');
    expect(overlays).toContain('search');
  });

  it('closes top overlay when no id specified', () => {
    const store = usePhageStore.getState();
    store.openOverlay('help');
    store.openOverlay('search');
    store.closeOverlay();

    const overlays = usePhageStore.getState().overlays;
    expect(overlays).toContain('help');
    expect(overlays).not.toContain('search');
  });

  it('toggles overlay', () => {
    const store = usePhageStore.getState();
    store.toggleOverlay('help');
    expect(usePhageStore.getState().overlays).toContain('help');

    usePhageStore.getState().toggleOverlay('help');
    expect(usePhageStore.getState().overlays).not.toContain('help');
  });

  it('closes all overlays', () => {
    const store = usePhageStore.getState();
    store.openOverlay('help');
    store.openOverlay('search');
    store.openOverlay('analysisMenu');
    store.closeAllOverlays();

    expect(usePhageStore.getState().overlays).toHaveLength(0);
  });

  it('limits overlay stack to 3', () => {
    const store = usePhageStore.getState();
    store.openOverlay('help');
    store.openOverlay('search');
    store.openOverlay('analysisMenu');
    store.openOverlay('complexity'); // 4th overlay

    const overlays = usePhageStore.getState().overlays;
    expect(overlays.length).toBeLessThanOrEqual(3);
    expect(overlays).toContain('complexity'); // Most recent should be included
  });

  it('moves overlay to top when reopened', () => {
    const store = usePhageStore.getState();
    store.openOverlay('help');
    store.openOverlay('search');
    store.openOverlay('help'); // Reopen help

    const overlays = usePhageStore.getState().overlays;
    expect(overlays.at(-1)).toBe('help'); // help should be on top
  });
});

describe('PhageExplorerStore - Comparison Tab Navigation', () => {
  it('cycles to next comparison tab', () => {
    const store = usePhageStore.getState();

    expect(store.comparisonTab).toBe('summary');
    store.nextComparisonTab();
    expect(usePhageStore.getState().comparisonTab).toBe('kmer');
    usePhageStore.getState().nextComparisonTab();
    expect(usePhageStore.getState().comparisonTab).toBe('information');
  });

  it('wraps around to summary from last tab', () => {
    const store = usePhageStore.getState();
    store.setComparisonTab('structural');
    store.nextComparisonTab();

    expect(usePhageStore.getState().comparisonTab).toBe('summary');
  });

  it('cycles to previous comparison tab', () => {
    const store = usePhageStore.getState();
    store.setComparisonTab('information');
    store.prevComparisonTab();

    expect(usePhageStore.getState().comparisonTab).toBe('kmer');
  });

  it('wraps around to structural from summary', () => {
    const store = usePhageStore.getState();
    store.setComparisonTab('summary');
    store.prevComparisonTab();

    expect(usePhageStore.getState().comparisonTab).toBe('structural');
  });
});

describe('PhageExplorerStore - Experience Level', () => {
  it('sets experience level', () => {
    const store = usePhageStore.getState();
    store.setExperienceLevel('power');

    expect(usePhageStore.getState().experienceLevel).toBe('power');
  });

  it('promotes experience level (novice -> intermediate)', () => {
    const store = usePhageStore.getState();
    expect(store.experienceLevel).toBe('novice');

    store.promoteExperienceLevel('intermediate');
    expect(usePhageStore.getState().experienceLevel).toBe('intermediate');
  });

  it('promotes experience level (novice -> power)', () => {
    const store = usePhageStore.getState();
    store.promoteExperienceLevel('power');

    expect(usePhageStore.getState().experienceLevel).toBe('power');
  });

  it('does not demote experience level', () => {
    const store = usePhageStore.getState();
    store.setExperienceLevel('power');
    store.promoteExperienceLevel('novice');

    expect(usePhageStore.getState().experienceLevel).toBe('power');
  });

  it('does not change when promoting to same level', () => {
    const store = usePhageStore.getState();
    store.setExperienceLevel('intermediate');
    store.promoteExperienceLevel('intermediate');

    expect(usePhageStore.getState().experienceLevel).toBe('intermediate');
  });
});

describe('PhageExplorerStore - Recent Commands', () => {
  it('adds recent command', () => {
    const store = usePhageStore.getState();
    store.addRecentCommand('gcSkew');

    expect(usePhageStore.getState().recentCommands).toContain('gcSkew');
  });

  it('moves duplicate command to front', () => {
    const store = usePhageStore.getState();
    store.addRecentCommand('gcSkew');
    store.addRecentCommand('complexity');
    store.addRecentCommand('gcSkew');

    const commands = usePhageStore.getState().recentCommands;
    expect(commands[0]).toBe('gcSkew');
    expect(commands.filter(c => c === 'gcSkew').length).toBe(1);
  });

  it('limits to 10 recent commands', () => {
    const store = usePhageStore.getState();
    for (let i = 0; i < 15; i++) {
      store.addRecentCommand(`cmd-${i}`);
    }

    expect(usePhageStore.getState().recentCommands.length).toBeLessThanOrEqual(10);
  });
});

describe('PhageExplorerStore - Comparison Phage Selection', () => {
  it('starts selecting phage A', () => {
    const store = usePhageStore.getState();
    store.startSelectingPhage('A');

    expect(usePhageStore.getState().comparisonSelectingPhage).toBe('A');
  });

  it('confirms phage A selection', () => {
    const store = usePhageStore.getState();
    store.startSelectingPhage('A');
    store.confirmPhageSelection(5);

    expect(usePhageStore.getState().comparisonPhageAIndex).toBe(5);
    expect(usePhageStore.getState().comparisonSelectingPhage).toBeNull();
  });

  it('confirms phage B selection', () => {
    const store = usePhageStore.getState();
    store.startSelectingPhage('B');
    store.confirmPhageSelection(7);

    expect(usePhageStore.getState().comparisonPhageBIndex).toBe(7);
    expect(usePhageStore.getState().comparisonSelectingPhage).toBeNull();
  });

  it('cancels phage selection', () => {
    const store = usePhageStore.getState();
    store.startSelectingPhage('A');
    store.cancelPhageSelection();

    expect(usePhageStore.getState().comparisonSelectingPhage).toBeNull();
  });

  it('swaps comparison phages', () => {
    const store = usePhageStore.getState();
    store.setComparisonPhageA(1);
    store.setComparisonPhageB(5);
    store.swapComparisonPhages();

    expect(usePhageStore.getState().comparisonPhageAIndex).toBe(5);
    expect(usePhageStore.getState().comparisonPhageBIndex).toBe(1);
  });
});

describe('PhageExplorerStore - Simulation Controls', () => {
  it('launches simulation', () => {
    const store = usePhageStore.getState();
    const initialState = { time: 0, type: 'test' as const };
    store.launchSimulation('pacman', initialState as any);

    expect(usePhageStore.getState().activeSimulationId).toBe('pacman');
    expect(usePhageStore.getState().simulationState).toEqual(initialState);
    expect(usePhageStore.getState().simulationPaused).toBe(false);
    expect(usePhageStore.getState().overlays).toContain('simulationView');
  });

  it('closes simulation', () => {
    const store = usePhageStore.getState();
    store.launchSimulation('pacman', { time: 0, type: 'test' } as any);
    store.closeSimulation();

    expect(usePhageStore.getState().activeSimulationId).toBeNull();
    expect(usePhageStore.getState().simulationState).toBeNull();
    expect(usePhageStore.getState().overlays).not.toContain('simulationView');
  });

  it('toggles simulation pause', () => {
    const store = usePhageStore.getState();
    store.launchSimulation('pacman', { time: 0, type: 'test' } as any);

    expect(usePhageStore.getState().simulationPaused).toBe(false);
    store.toggleSimulationPause();
    expect(usePhageStore.getState().simulationPaused).toBe(true);
    usePhageStore.getState().toggleSimulationPause();
    expect(usePhageStore.getState().simulationPaused).toBe(false);
  });

  it('sets simulation paused directly', () => {
    const store = usePhageStore.getState();
    store.setSimulationPaused(true);

    expect(usePhageStore.getState().simulationPaused).toBe(true);
  });

  it('updates simulation state', () => {
    const store = usePhageStore.getState();
    const newState = { time: 100, type: 'test' as const };
    store.updateSimulationState(newState as any);

    expect(usePhageStore.getState().simulationState).toEqual(newState);
  });

  it('resets simulation', () => {
    const store = usePhageStore.getState();
    store.launchSimulation('pacman', { time: 50, type: 'test' } as any);
    const initialState = { time: 0, type: 'test' as const };
    store.resetSimulation(initialState as any);

    expect(usePhageStore.getState().simulationState).toEqual(initialState);
    expect(usePhageStore.getState().simulationPaused).toBe(true);
  });
});

describe('PhageExplorerStore - Beginner Mode', () => {
  it('toggles beginner mode', () => {
    const store = usePhageStore.getState();

    expect(store.beginnerModeEnabled).toBe(false);
    store.toggleBeginnerMode();
    expect(usePhageStore.getState().beginnerModeEnabled).toBe(true);
    usePhageStore.getState().toggleBeginnerMode();
    expect(usePhageStore.getState().beginnerModeEnabled).toBe(false);
  });

  it('sets beginner mode directly', () => {
    const store = usePhageStore.getState();
    store.setBeginnerModeEnabled(true);

    expect(usePhageStore.getState().beginnerModeEnabled).toBe(true);
  });

  it('opens and closes glossary', () => {
    const store = usePhageStore.getState();
    store.openGlossary();
    expect(usePhageStore.getState().glossarySidebarOpen).toBe(true);

    usePhageStore.getState().closeGlossary();
    expect(usePhageStore.getState().glossarySidebarOpen).toBe(false);
  });

  it('starts and cancels tour', () => {
    const store = usePhageStore.getState();
    store.startTour('intro');
    expect(usePhageStore.getState().activeTourId).toBe('intro');

    usePhageStore.getState().cancelTour();
    expect(usePhageStore.getState().activeTourId).toBeNull();
  });

  it('completes tour', () => {
    const store = usePhageStore.getState();
    store.startTour('intro');
    store.completeTour('intro');

    expect(usePhageStore.getState().completedTours).toContain('intro');
    expect(usePhageStore.getState().activeTourId).toBeNull();
  });

  it('does not duplicate completed tours', () => {
    const store = usePhageStore.getState();
    store.completeTour('intro');
    store.completeTour('intro');

    expect(usePhageStore.getState().completedTours.filter(t => t === 'intro').length).toBe(1);
  });

  it('completes module', () => {
    const store = usePhageStore.getState();
    store.completeModule('basics');

    expect(usePhageStore.getState().completedModules).toContain('basics');
  });

  it('does not duplicate completed modules', () => {
    const store = usePhageStore.getState();
    store.completeModule('basics');
    store.completeModule('basics');

    expect(usePhageStore.getState().completedModules.filter(m => m === 'basics').length).toBe(1);
  });

  it('resets beginner progress', () => {
    const store = usePhageStore.getState();
    store.completeTour('intro');
    store.completeModule('basics');
    store.startTour('advanced');
    store.resetBeginnerProgress();

    expect(usePhageStore.getState().completedTours).toHaveLength(0);
    expect(usePhageStore.getState().completedModules).toHaveLength(0);
    expect(usePhageStore.getState().activeTourId).toBeNull();
  });
});

describe('PhageExplorerStore - Error Handling', () => {
  it('sets and clears error', () => {
    const store = usePhageStore.getState();
    store.setError('Something went wrong');
    expect(usePhageStore.getState().error).toBe('Something went wrong');

    store.setError(null);
    expect(usePhageStore.getState().error).toBeNull();
  });
});

describe('PhageExplorerStore - Terminal Size', () => {
  it('sets terminal size', () => {
    const store = usePhageStore.getState();
    store.setTerminalSize(120, 40);

    expect(usePhageStore.getState().terminalCols).toBe(120);
    expect(usePhageStore.getState().terminalRows).toBe(40);
  });
});

describe('PhageExplorerStore - Mouse Position', () => {
  it('sets mouse position', () => {
    const store = usePhageStore.getState();
    store.setMousePosition(100, 50);

    expect(usePhageStore.getState().mouseX).toBe(100);
    expect(usePhageStore.getState().mouseY).toBe(50);
  });

  it('sets hovered amino acid', () => {
    const store = usePhageStore.getState();
    const aa = {
      letter: 'M',
      name: 'Methionine',
      threeCode: 'Met',
      property: 'nonpolar',
      position: 42,
    };
    store.setHoveredAminoAcid(aa);

    expect(usePhageStore.getState().hoveredAminoAcid).toEqual(aa);
  });

  it('clears hovered amino acid', () => {
    const store = usePhageStore.getState();
    store.setHoveredAminoAcid({
      letter: 'M',
      name: 'Methionine',
      threeCode: 'Met',
      property: 'nonpolar',
      position: 42,
    });
    store.setHoveredAminoAcid(null);

    expect(usePhageStore.getState().hoveredAminoAcid).toBeNull();
  });
});

describe('PhageExplorerStore - Reset', () => {
  it('resets to initial state', () => {
    const store = usePhageStore.getState();

    // Modify various state
    store.setPhages(mockPhages);
    store.setScrollPosition(1000);
    store.setViewMode('aa');
    store.openOverlay('help');
    store.setError('test error');

    // Reset
    store.reset();

    const state = usePhageStore.getState();
    expect(state.phages).toHaveLength(0);
    expect(state.scrollPosition).toBe(0);
    expect(state.viewMode).toBe('dna');
    expect(state.overlays).toHaveLength(0);
    expect(state.error).toBeNull();
  });
});

describe('PhageExplorerStore - Quit Confirmation', () => {
  it('sets quit confirmation pending', () => {
    const store = usePhageStore.getState();
    store.setQuitConfirmPending(true);

    expect(usePhageStore.getState().quitConfirmPending).toBe(true);
  });

  it('clears quit confirmation pending', () => {
    const store = usePhageStore.getState();
    store.setQuitConfirmPending(true);
    store.setQuitConfirmPending(false);

    expect(usePhageStore.getState().quitConfirmPending).toBe(false);
  });
});
