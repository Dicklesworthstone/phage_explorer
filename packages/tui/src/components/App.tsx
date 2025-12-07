import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';

import { Header } from './Header';
import { PhageList } from './PhageList';
import { SequenceGrid } from './SequenceGrid';
import { Model3DView } from './Model3DView';
import { GeneMap } from './GeneMap';
import { Footer } from './Footer';
import { HelpOverlay } from './HelpOverlay';
import { AAKeyOverlay } from './AAKeyOverlay';
import { SearchOverlay } from './SearchOverlay';
import { ComparisonOverlay } from './ComparisonOverlay';
import { AALegend } from './AALegend';

interface AppProps {
  repository: PhageRepository;
}

export function App({ repository }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Store state
  const phages = usePhageStore(s => s.phages);
  const setPhages = usePhageStore(s => s.setPhages);
  const currentPhageIndex = usePhageStore(s => s.currentPhageIndex);
  const setCurrentPhage = usePhageStore(s => s.setCurrentPhage);
  const setLoadingPhage = usePhageStore(s => s.setLoadingPhage);
  const viewMode = usePhageStore(s => s.viewMode);
  const theme = usePhageStore(s => s.currentTheme);
  const activeOverlay = usePhageStore(s => s.activeOverlay);
  const terminalCols = usePhageStore(s => s.terminalCols);
  const terminalRows = usePhageStore(s => s.terminalRows);
  const setTerminalSize = usePhageStore(s => s.setTerminalSize);
  const error = usePhageStore(s => s.error);
  const setError = usePhageStore(s => s.setError);

  // Actions
  const nextPhage = usePhageStore(s => s.nextPhage);
  const prevPhage = usePhageStore(s => s.prevPhage);
  const scrollBy = usePhageStore(s => s.scrollBy);
  const scrollToStart = usePhageStore(s => s.scrollToStart);
  const scrollToEnd = usePhageStore(s => s.scrollToEnd);
  const toggleViewMode = usePhageStore(s => s.toggleViewMode);
  const cycleReadingFrame = usePhageStore(s => s.cycleReadingFrame);
  const cycleTheme = usePhageStore(s => s.cycleTheme);
  const toggleDiff = usePhageStore(s => s.toggleDiff);
  const toggle3DModel = usePhageStore(s => s.toggle3DModel);
  const toggle3DModelPause = usePhageStore(s => s.toggle3DModelPause);
  const toggle3DModelFullscreen = usePhageStore(s => s.toggle3DModelFullscreen);
  const cycle3DModelQuality = usePhageStore(s => s.cycle3DModelQuality);
  const model3DFullscreen = usePhageStore(s => s.model3DFullscreen);
  const setActiveOverlay = usePhageStore(s => s.setActiveOverlay);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const openComparison = usePhageStore(s => s.openComparison);

  // Sequence state
  const [sequence, setSequence] = useState<string>('');

  // Update terminal size
  useEffect(() => {
    const updateSize = () => {
      setTerminalSize(stdout.columns ?? 80, stdout.rows ?? 24);
    };

    updateSize();
    stdout.on?.('resize', updateSize);

    return () => {
      stdout.off?.('resize', updateSize);
    };
  }, [stdout, setTerminalSize]);

  // Load phage list on mount
  useEffect(() => {
    const loadPhages = async () => {
      try {
        const list = await repository.listPhages();
        setPhages(list);
      } catch (err) {
        setError(`Failed to load phages: ${err}`);
      }
    };

    loadPhages();
  }, [repository, setPhages, setError]);

  // Load current phage data when index changes
  useEffect(() => {
    if (phages.length === 0) return;

    const loadPhage = async () => {
      setLoadingPhage(true);
      try {
        const phage = await repository.getPhageByIndex(currentPhageIndex);
        setCurrentPhage(phage);

        // Load sequence
        if (phage) {
          const length = await repository.getFullGenomeLength(phage.id);
          const seq = await repository.getSequenceWindow(phage.id, 0, length);
          setSequence(seq);
        }

        // Prefetch nearby phages
        repository.prefetchAround(currentPhageIndex, 3);
      } catch (err) {
        setError(`Failed to load phage: ${err}`);
      } finally {
        setLoadingPhage(false);
      }
    };

    loadPhage();
  }, [repository, phages, currentPhageIndex, setCurrentPhage, setLoadingPhage, setError]);

  // Layout constants
  const sidebarWidth = 32;
  const gridWidth = Math.max(40, terminalCols - sidebarWidth - 4);
  const mainHeight = terminalRows - 12;

  // Handle keyboard input
  useInput((input, key) => {
    // Global keys (work everywhere)
    if (input === 'q' || input === 'Q') {
      exit();
      return;
    }

    // Escape: exit fullscreen first, then close overlay
    if (key.escape) {
      if (model3DFullscreen) {
        toggle3DModelFullscreen();
      } else {
        closeOverlay();
      }
      return;
    }

    // If in fullscreen 3D mode, only allow limited controls
    if (model3DFullscreen) {
      if (input === 'z' || input === 'Z') {
        toggle3DModelFullscreen();
      } else if (input === 'p' || input === 'P') {
        toggle3DModelPause();
      } else if (input === 'r' || input === 'R') {
        cycle3DModelQuality();
      }
      // Ignore all other keys in fullscreen mode
      return;
    }

    // If overlay is active, don't process other keys (comparison handles its own input)
    if (activeOverlay && activeOverlay !== 'search' && activeOverlay !== 'comparison') {
      if (input === '?' || input === 'h' || input === 'H') {
        closeOverlay();
      } else if (input === 'k' || input === 'K') {
        closeOverlay();
      }
      return;
    }

    // Comparison overlay handles its own input
    if (activeOverlay === 'comparison') {
      return;
    }

    // Navigation
    if (key.downArrow) {
      nextPhage();
    } else if (key.upArrow) {
      prevPhage();
    } else if (key.leftArrow) {
      scrollBy(-10);
    } else if (key.rightArrow) {
      scrollBy(10);
    } else if (key.pageDown) {
      scrollBy(100);
    } else if (key.pageUp) {
      scrollBy(-100);
    }
    // Home/End keys - check escape sequences
    else if (input === '\x1b[H' || input === '\x1b[1~' || input === '\x1bOH') {
      scrollToStart();
    } else if (input === '\x1b[F' || input === '\x1b[4~' || input === '\x1bOF') {
      scrollToEnd();
    }

    // View controls
    else if (input === 'n' || input === 'N' || input === 'c' || input === 'C' || input === ' ') {
      toggleViewMode();
    } else if (input === 'f' || input === 'F') {
      cycleReadingFrame();
    } else if (input === 't' || input === 'T') {
      cycleTheme();
    } else if (input === 'd' || input === 'D') {
      toggleDiff();
    } else if (input === 'm' || input === 'M') {
      toggle3DModel();
    } else if (input === 'p' || input === 'P') {
      toggle3DModelPause();
    } else if (input === 'z' || input === 'Z') {
      toggle3DModelFullscreen();
    } else if (input === 'r' || input === 'R') {
      cycle3DModelQuality();
    }

    // Overlays (we already returned early if overlay is active, so just open)
    else if (input === '?' || input === 'h' || input === 'H') {
      setActiveOverlay('help');
    } else if (input === 'k' || input === 'K') {
      setActiveOverlay('aaKey');
    } else if (input === 's' || input === 'S' || input === '/') {
      setActiveOverlay('search');
    } else if (input === 'w' || input === 'W') {
      openComparison();
    }
  });

  const colors = theme.colors;

  // Calculate list height (account for 3D model view)
  const listHeight = Math.max(5, mainHeight - 18);

  // Error display
  if (error) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red" bold>Error: {error}</Text>
        <Text color="gray">Press Q to quit</Text>
      </Box>
    );
  }

  // Loading display
  if (phages.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color={colors.accent}>Loading phage database...</Text>
      </Box>
    );
  }

  // Fullscreen 3D model mode
  if (model3DFullscreen) {
    return (
      <Box flexDirection="column" width={terminalCols} height={terminalRows}>
        <Model3DView
          width={terminalCols}
          height={terminalRows - 1}
          fullscreen
        />
        <Box paddingX={1}>
          <Text color={colors.textDim}>
            Z: Exit Fullscreen  P: Pause  R: Quality  Q: Quit
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={terminalCols} height={terminalRows}>
      {/* Header */}
      <Header />

      {/* Main content area */}
      <Box flexGrow={1}>
        {/* Sidebar: Phage list + 3D model */}
        <Box flexDirection="column" width={sidebarWidth}>
          <PhageList width={sidebarWidth} height={listHeight} />
          <Model3DView width={sidebarWidth} height={16} />
        </Box>

        {/* Sequence grid */}
        <SequenceGrid
          sequence={sequence}
          width={gridWidth}
          height={mainHeight}
        />
      </Box>

      {/* Gene map */}
      <GeneMap width={terminalCols - 2} />

      {/* Amino acid legend (shows in corner when in AA view mode) */}
      {viewMode === 'aa' && (
        <Box position="absolute" marginLeft={Math.max(0, terminalCols - 28)} marginTop={1}>
          <AALegend />
        </Box>
      )}

      {/* Footer */}
      <Footer />

      {/* Overlays */}
      {activeOverlay === 'help' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 50) / 2)}
          marginTop={Math.floor((terminalRows - 20) / 2)}
        >
          <HelpOverlay />
        </Box>
      )}

      {activeOverlay === 'aaKey' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 60) / 2)}
          marginTop={Math.floor((terminalRows - 18) / 2)}
        >
          <AAKeyOverlay />
        </Box>
      )}

      {activeOverlay === 'search' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 60) / 2)}
          marginTop={Math.floor((terminalRows - 16) / 2)}
        >
          <SearchOverlay repository={repository} />
        </Box>
      )}

      {activeOverlay === 'comparison' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 90) / 2)}
          marginTop={Math.floor((terminalRows - 35) / 2)}
        >
          <ComparisonOverlay repository={repository} />
        </Box>
      )}
    </Box>
  );
}
