import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout, useStdin } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import { AMINO_ACIDS, translateSequence } from '@phage-explorer/core';

import { Header } from './Header';
import { PhageList } from './PhageList';
import { SequenceGrid } from './SequenceGrid';
import { Model3DView } from './Model3DView';
import { GeneMap } from './GeneMap';
import { Footer } from './Footer';
import { HelpOverlay } from './HelpOverlay';
import { AAKeyOverlay } from './AAKeyOverlay';
import { SearchOverlay } from './SearchOverlay';
import { AminoAcidHoverInfo } from './AminoAcidHoverInfo';

// Enable SGR mouse mode for better terminal support
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h\x1b[?1003h'; // 1003 enables any-event tracking
const DISABLE_MOUSE = '\x1b[?1003l\x1b[?1000l\x1b[?1006l';

interface AppProps {
  repository: PhageRepository;
}

export function App({ repository }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();

  // Store state
  const phages = usePhageStore(s => s.phages);
  const setPhages = usePhageStore(s => s.setPhages);
  const currentPhageIndex = usePhageStore(s => s.currentPhageIndex);
  const currentPhage = usePhageStore(s => s.currentPhage);
  const setCurrentPhage = usePhageStore(s => s.setCurrentPhage);
  const isLoadingPhage = usePhageStore(s => s.isLoadingPhage);
  const setLoadingPhage = usePhageStore(s => s.setLoadingPhage);
  const viewMode = usePhageStore(s => s.viewMode);
  const scrollPosition = usePhageStore(s => s.scrollPosition);
  const theme = usePhageStore(s => s.currentTheme);
  const activeOverlay = usePhageStore(s => s.activeOverlay);
  const terminalCols = usePhageStore(s => s.terminalCols);
  const terminalRows = usePhageStore(s => s.terminalRows);
  const setTerminalSize = usePhageStore(s => s.setTerminalSize);
  const error = usePhageStore(s => s.error);
  const setError = usePhageStore(s => s.setError);
  const readingFrame = usePhageStore(s => s.readingFrame);
  const setHoveredAminoAcid = usePhageStore(s => s.setHoveredAminoAcid);

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
  const setActiveOverlay = usePhageStore(s => s.setActiveOverlay);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

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

  // Layout constants - define here so mouse tracking can use them
  const sidebarWidth = 32;
  const gridWidth = Math.max(40, terminalCols - sidebarWidth - 4);
  const mainHeight = terminalRows - 12;
  const gridStartX = sidebarWidth + 2; // After sidebar + border
  const gridStartY = 2; // After header

  // Translate sequence to amino acids for hover detection
  const aaSequence = useMemo(() => {
    if (viewMode !== 'aa' || !sequence) return '';
    return translateSequence(sequence, readingFrame);
  }, [sequence, viewMode, readingFrame]);

  // Track last hovered position to avoid redundant state updates
  const lastHoveredIndexRef = React.useRef<number | null>(null);

  // Mouse tracking for amino acid hover
  useEffect(() => {
    if (!stdin) return;

    // Enable mouse tracking
    stdout.write(ENABLE_MOUSE);

    const handleData = (data: Buffer) => {
      const str = data.toString();

      // Parse SGR mouse events: \x1b[<button;x;yM or \x1b[<button;x;ym
      const sgrMatch = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (!sgrMatch) return;

      const [, , xStr, yStr] = sgrMatch;
      const mouseX = parseInt(xStr, 10);
      const mouseY = parseInt(yStr, 10);

      // Check if mouse is within the sequence grid area
      if (
        viewMode === 'aa' &&
        mouseX >= gridStartX &&
        mouseX < gridStartX + gridWidth &&
        mouseY >= gridStartY &&
        mouseY < gridStartY + mainHeight - 1
      ) {
        // Calculate which character in the grid
        const gridCol = mouseX - gridStartX;
        const gridRow = mouseY - gridStartY - 1; // -1 for title bar

        if (gridCol >= 0 && gridRow >= 0) {
          // Calculate position in sequence
          const charIndex = scrollPosition + gridRow * gridWidth + gridCol;

          // Only update if we're hovering over a different character
          if (charIndex === lastHoveredIndexRef.current) {
            return; // Same position, no update needed
          }

          if (charIndex >= 0 && charIndex < aaSequence.length) {
            const aaLetter = aaSequence[charIndex];
            const aaInfo = AMINO_ACIDS[aaLetter as keyof typeof AMINO_ACIDS];

            if (aaInfo) {
              lastHoveredIndexRef.current = charIndex;
              setHoveredAminoAcid({
                letter: aaInfo.letter,
                name: aaInfo.name,
                threeCode: aaInfo.threeCode,
                property: aaInfo.property,
                position: charIndex + 1, // 1-indexed for display
              });
              return;
            }
          }
        }
      }

      // Clear hover if not over valid amino acid (only if we had one before)
      if (lastHoveredIndexRef.current !== null) {
        lastHoveredIndexRef.current = null;
        setHoveredAminoAcid(null);
      }
    };

    stdin.on('data', handleData);

    return () => {
      stdin.off('data', handleData);
      stdout.write(DISABLE_MOUSE);
    };
  }, [stdin, stdout, viewMode, gridStartX, gridStartY, gridWidth, mainHeight, scrollPosition, aaSequence, setHoveredAminoAcid]);

  // Handle keyboard input
  useInput((input, key) => {
    // Global keys (work even with overlays)
    if (input === 'q' || input === 'Q') {
      exit();
      return;
    }

    if (key.escape) {
      closeOverlay();
      return;
    }

    // If overlay is active, don't process other keys
    if (activeOverlay && activeOverlay !== 'search') {
      if (input === '?' || input === 'h' || input === 'H') {
        closeOverlay();
      } else if (input === 'k' || input === 'K') {
        closeOverlay();
      }
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
    }

    // Overlays (we already returned early if overlay is active, so just open)
    else if (input === '?' || input === 'h' || input === 'H') {
      setActiveOverlay('help');
    } else if (input === 'k' || input === 'K') {
      setActiveOverlay('aaKey');
    } else if (input === 's' || input === 'S' || input === '/') {
      setActiveOverlay('search');
    }
  });

  const colors = theme.colors;

  // Calculate dimensions (sidebarWidth, gridWidth, mainHeight defined earlier for mouse tracking)
  const listHeight = Math.max(5, mainHeight - 18); // Minus 3D view

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

      {/* Amino acid hover info (shows in corner when hovering over AA sequence) */}
      <Box position="absolute" marginLeft={terminalCols - 50} marginTop={0}>
        <AminoAcidHoverInfo />
      </Box>

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
    </Box>
  );
}
