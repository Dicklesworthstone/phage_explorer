import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { usePhageStore, useOverlayStack } from '@phage-explorer/state';
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
import { AnalysisMenuOverlay } from './MenuOverlays';
import { GCOverlay } from './GCOverlay';
import { CommandPalette } from './CommandPalette';
import { SequenceComplexityOverlay } from './SequenceComplexityOverlay';
import { BendabilityOverlay } from './BendabilityOverlay';
import { PromoterOverlay } from './PromoterOverlay';
import { RepeatOverlay } from './RepeatOverlay';
import { PackagingPressureOverlay } from './PackagingPressureOverlay';
import { TranscriptionFlowOverlay } from './TranscriptionFlowOverlay';
import { PhasePortraitOverlay } from './PhasePortraitOverlay';
import { computeAllOverlays } from '../overlay-computations';
import { SimulationHubOverlay } from './SimulationHubOverlay';
import { SimulationView } from './SimulationView';
import { KmerAnomalyOverlay } from './KmerAnomalyOverlay';
import type { KmerAnomalyOverlay as KmerOverlayType } from '../overlay-computations';
import { ModuleOverlay } from './ModuleOverlay';
import { FoldQuickview } from './FoldQuickview';
import { HGTOverlay } from './HGTOverlay';
import { analyzeHGTProvenance, analyzeTailFiberTropism, type TropismAnalysis } from '@phage-explorer/comparison';
import type { FoldEmbedding } from '@phage-explorer/core';
import type { OverlayId, ExperienceLevel } from '@phage-explorer/state';
import { BiasDecompositionOverlay } from './BiasDecompositionOverlay';
import { CRISPROverlay } from './CRISPROverlay';
import { SyntenyOverlay } from './SyntenyOverlay';
import { TropismOverlay } from './TropismOverlay';

const ANALYSIS_MENU_ID: OverlayId = 'analysisMenu';
const SIMULATION_MENU_ID: OverlayId = 'simulationHub';
const SIMULATION_VIEW_ID: OverlayId = 'simulationView';
const COMPLEXITY_ID: OverlayId = 'complexity';
const GC_SKEW_ID: OverlayId = 'gcSkew';
const BENDABILITY_ID: OverlayId = 'bendability';
const PROMOTER_ID: OverlayId = 'promoter';
const REPEAT_ID: OverlayId = 'repeats';
const KMER_ID: OverlayId = 'kmerAnomaly';
const MODULES_ID: OverlayId = 'modules';
const PRESSURE_ID: OverlayId = 'pressure';
const TRANSCRIPTION_ID: OverlayId = 'transcriptionFlow';
const BIAS_ID: OverlayId = 'biasDecomposition';
const HGT_ID: OverlayId = 'hgt';
const CRISPR_ID: OverlayId = 'crispr';
const SYNTENY_ID: OverlayId = 'synteny';
const TROPISM_ID: OverlayId = 'tropism';

interface AppProps {
  repository: PhageRepository;
  foldEmbeddings?: FoldEmbedding[]; // Optional preloaded embeddings
}

export function App({ repository, foldEmbeddings = [] }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const overlayCacheRef = React.useRef<
    Map<number, { length: number; hash: number; refVersion: number; data: ReturnType<typeof computeAllOverlays> & { hgt?: unknown; tropism?: TropismAnalysis } }>
  >(new Map());
  const referenceSketchesRef = React.useRef<Record<string, string>>({});
  const referenceVersionRef = React.useRef(0);

  const hashSeq = React.useCallback((seq: string): number => {
    let h = 0;
    // Sample every ~5000 chars to keep it fast on long genomes
    const step = Math.max(1, Math.floor(seq.length / 5000));
    for (let i = 0; i < seq.length; i += step) {
      h = (h * 31 + seq.charCodeAt(i)) >>> 0;
    }
    h = (h ^ seq.length) >>> 0;
    return h;
  }, []);

  // Store state
  const phages = usePhageStore(s => s.phages);
  const setPhages = usePhageStore(s => s.setPhages);
  const currentPhageIndex = usePhageStore(s => s.currentPhageIndex);
  const setCurrentPhage = usePhageStore(s => s.setCurrentPhage);
  const setLoadingPhage = usePhageStore(s => s.setLoadingPhage);
  const viewMode = usePhageStore(s => s.viewMode);
  const theme = usePhageStore(s => s.currentTheme);
  const overlayStack = useOverlayStack();
  const activeOverlay = overlayStack.at(-1) ?? null;
  const terminalCols = usePhageStore(s => s.terminalCols);
  const terminalRows = usePhageStore(s => s.terminalRows);
  const setTerminalSize = usePhageStore(s => s.setTerminalSize);
  const error = usePhageStore(s => s.error);
  const setError = usePhageStore(s => s.setError);
  const overlayData = usePhageStore(s => s.overlayData);
  const currentError = usePhageStore(s => s.error);

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
  const setOverlayData = usePhageStore(s => s.setOverlayData);
  const model3DFullscreen = usePhageStore(s => s.model3DFullscreen);
  const openOverlay = usePhageStore(s => s.openOverlay);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const toggleOverlay = usePhageStore(s => s.toggleOverlay);
  const openComparison = usePhageStore(s => s.openComparison);
  const helpDetail = usePhageStore(s => s.helpDetail);
  const setHelpDetail = usePhageStore(s => s.setHelpDetail);
  const experienceLevel = usePhageStore(s => s.experienceLevel);
  const promoteExperienceLevel = usePhageStore(s => s.promoteExperienceLevel);
  const currentPhage = usePhageStore(s => s.currentPhage);

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

  // Preload reference sketches (full genomes) for donor inference in HGT tracer
  useEffect(() => {
    if (phages.length === 0) return;
    if (Object.keys(referenceSketchesRef.current).length > 0) return;
    let cancelled = false;
    const load = async () => {
      try {
        const sketches: Record<string, string> = {};
        for (const p of phages) {
          const len = await repository.getFullGenomeLength(p.id);
          const seq = await repository.getSequenceWindow(p.id, 0, len);
          const label = `${p.name ?? `phage-${p.id}`} (${p.host ?? 'unknown host'}) #${p.id}`;
          sketches[label] = seq;
        }
        if (!cancelled) {
          referenceSketchesRef.current = sketches;
          referenceVersionRef.current += 1;
        }
      } catch (err) {
        if (!cancelled && !currentError) {
          setError(`Failed to preload donor sketches: ${err}`);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [phages, repository, setError, currentError]);

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
         // Use cache if available, else compute and store
         const seqHash = hashSeq(seq);
         const cache = overlayCacheRef.current.get(phage.id);
         if (cache && cache.length === length && cache.hash === seqHash && cache.refVersion === referenceVersionRef.current) {
           setOverlayData(cache.data);
         } else {
           const data = computeAllOverlays(seq);
            const hgt = analyzeHGTProvenance(seq, phage.genes ?? [], referenceSketchesRef.current);
            const tropism = analyzeTailFiberTropism(phage);
            const enriched = { ...data, hgt, tropism };
            overlayCacheRef.current.set(phage.id, { length, hash: seqHash, refVersion: referenceVersionRef.current, data: enriched });
            setOverlayData(enriched);
          }
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

  // Progressive disclosure: auto-promote after time in app (5m -> intermediate, 60m -> power)
  useEffect(() => {
    const t1 = setTimeout(() => promoteExperienceLevel('intermediate' as ExperienceLevel), 5 * 60 * 1000);
    const t2 = setTimeout(() => promoteExperienceLevel('power' as ExperienceLevel), 60 * 60 * 1000);
    
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [promoteExperienceLevel]);

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

    // Escape: exit fullscreen first, then close top overlay if present
    if (key.escape) {
      if (model3DFullscreen) {
        toggle3DModelFullscreen();
      } else if (activeOverlay) {
        closeOverlay();
      }
      return;
    }

    // If in fullscreen 3D mode, only allow limited controls
    if (model3DFullscreen) {
      if (input === 'z' || input === 'Z') {
        toggle3DModelFullscreen();
      } else if (input === 'p' || input === 'P' || input === 'o' || input === 'O') {
        toggle3DModelPause();
      } else if (input === 'r' || input === 'R') {
        cycle3DModelQuality();
      }
      // Ignore all other keys in fullscreen mode
      return;
    }

    const promote = (level: ExperienceLevel) => promoteExperienceLevel(level);
    const isIntermediate = experienceLevel !== 'novice';
    const isPower = experienceLevel === 'power';

    // If overlay is active, don't process other keys (comparison/search/menus handle their own input)
    if (activeOverlay) {
      if (activeOverlay === 'help') {
        if (input === '?') {
          setHelpDetail(helpDetail === 'essential' ? 'detailed' : 'essential');
        }
        return;
      }

      if (activeOverlay !== 'search' && activeOverlay !== 'comparison') {
        if (
          input === '?' || input === 'k' || input === 'K'
        ) {
          closeOverlay(activeOverlay);
        } else if (activeOverlay === 'complexity' && (input === 'x' || input === 'X')) {
          closeOverlay(activeOverlay);
        }
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
    } else if (input === 'g' || input === 'G') {
      if (!isIntermediate) {
        setError('Advanced overlays unlock after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(GC_SKEW_ID);
    } else if (input === 'y' || input === 'Y') {
      if (!isIntermediate) {
        setError('Transcription flow unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(TRANSCRIPTION_ID);
    } else if (input === 'v' || input === 'V') {
      if (!isIntermediate) {
        setError('Pressure gauge unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(PRESSURE_ID);
    } else if (input === 'j' || input === 'J') {
      if (!isIntermediate) {
        setError('K-mer anomaly unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(KMER_ID);
    } else if (input === 'l' || input === 'L') {
      if (!isIntermediate) {
        setError('Module coherence unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(MODULES_ID);
    } else if (input === 'h' || input === 'H') {
      if (!isIntermediate) {
        setError('HGT overlay unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(HGT_ID);
    } else if (input === 'm' || input === 'M') {
      toggle3DModel();
    } else if (input === 'z' || input === 'Z') {
      toggle3DModelFullscreen();
    } else if (input === 'b' || input === 'B') {
      if (!isIntermediate) {
        setError('Bendability overlay unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(BENDABILITY_ID);
    } else if (key.shift && (input === 'P')) {
      if (!isIntermediate) {
        setError('Phase portraits unlock after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay('phasePortrait');
    } else if (input === 'p' || input === 'P') {
      if (!isIntermediate) {
        setError('Promoter overlay unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(PROMOTER_ID);
    } else if (key.ctrl && (input === 'f' || input === 'F')) {
      promote('power');
      openOverlay('foldQuickview');
    } else if (input === 'r' || input === 'R') {
      if (!isIntermediate) {
        setError('Repeat overlay unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(REPEAT_ID);
    } else if (input === 'i' || input === 'I') {
      if (!isIntermediate) {
        setError('CRISPR overlay unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(CRISPR_ID);
    } else if (input === 'e' || input === 'E') {
      if (!isIntermediate) {
        setError('Tail fiber tropism unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(TROPISM_ID);
    } else if (key.shift && (input === 'y' || input === 'Y')) {
      if (!isIntermediate) {
        setError('Synteny alignment unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(SYNTENY_ID);
    }

    // Overlays (we already returned early if overlay is active, so just open)
    else if (input === '?') {
      toggleOverlay('help');
    } else if (input === 'k' || input === 'K') {
      toggleOverlay('aaKey');
    } else if (key.shift && input === 'S') {
      if (!isPower) {
        setError('Simulation hub unlocks at power tier (≈60 min or manual promotion).');
        return;
      }
      promote('power');
      openOverlay(SIMULATION_MENU_ID);
    } else if (input === 'a' || input === 'A') {
      if (!isIntermediate) {
        setError('Analysis menu unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      openOverlay(ANALYSIS_MENU_ID);
    } else if (input === 'x' || input === 'X') {
      if (!isIntermediate) {
        setError('Complexity overlay unlocks after ~5 minutes or once promoted.');
        return;
      }
      promote('intermediate');
      toggleOverlay(COMPLEXITY_ID);
    } else if (input === 's' || input === '/') {
      openOverlay('search');
    } else if (input === 'w' || input === 'W') {
      openComparison();
    } else if (input === ':' || (key.ctrl && (input === 'p' || input === 'P'))) {
      if (!isPower) {
        setError('Command palette unlocks at power tier.');
        return;
      }
      openOverlay('commandPalette');
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
            Z: Exit Fullscreen  O/P: Pause  R: Quality  Q: Quit
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
          genomeLength={currentPhage?.genomeLength ?? sequence.length}
          kmerOverlay={overlayData.kmerAnomaly as KmerOverlayType | null}
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

      {activeOverlay === ANALYSIS_MENU_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 70) / 2)}
          marginTop={Math.floor((terminalRows - 20) / 2)}
        >
          <AnalysisMenuOverlay onClose={() => closeOverlay(ANALYSIS_MENU_ID)} />
        </Box>
      )}

      {activeOverlay === SIMULATION_MENU_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 80) / 2)}
          marginTop={Math.floor((terminalRows - 24) / 2)}
        >
          <SimulationHubOverlay onClose={() => closeOverlay(SIMULATION_MENU_ID)} />
        </Box>
      )}

      {activeOverlay === 'gcSkew' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 80) / 2)}
          marginTop={Math.floor((terminalRows - 14) / 2)}
        >
          <GCOverlay sequence={sequence} />
        </Box>
      )}

      {activeOverlay === 'bendability' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 80) / 2)}
          marginTop={Math.floor((terminalRows - 12) / 2)}
        >
          <BendabilityOverlay sequence={sequence} />
        </Box>
      )}

      {activeOverlay === 'promoter' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 72) / 2)}
          marginTop={Math.floor((terminalRows - 12) / 2)}
        >
          <PromoterOverlay sequence={sequence} />
        </Box>
      )}

      {activeOverlay === PRESSURE_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 90) / 2)}
          marginTop={Math.floor((terminalRows - 14) / 2)}
        >
          <PackagingPressureOverlay />
        </Box>
      )}

      {activeOverlay === TRANSCRIPTION_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 90) / 2)}
          marginTop={Math.floor((terminalRows - 14) / 2)}
        >
          <TranscriptionFlowOverlay
            sequence={sequence}
            genomeLength={currentPhage?.genomeLength ?? sequence.length}
          />
        </Box>
      )}

      {activeOverlay === 'repeats' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 72) / 2)}
          marginTop={Math.floor((terminalRows - 12) / 2)}
        >
          <RepeatOverlay sequence={sequence} />
        </Box>
      )}

      {activeOverlay === 'modules' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 84) / 2)}
          marginTop={Math.floor((terminalRows - 18) / 2)}
        >
          <ModuleOverlay />
        </Box>
      )}

      {activeOverlay === 'hgt' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 92) / 2)}
          marginTop={Math.floor((terminalRows - 24) / 2)}
        >
          <HGTOverlay />
        </Box>
      )}

      {activeOverlay === TROPISM_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 84) / 2)}
          marginTop={Math.floor((terminalRows - 20) / 2)}
        >
          <TropismOverlay />
        </Box>
      )}

      {activeOverlay === CRISPR_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 74) / 2)}
          marginTop={Math.floor((terminalRows - 18) / 2)}
        >
          <CRISPROverlay sequence={sequence} genes={currentPhage?.genes ?? []} />
        </Box>
      )}

      {activeOverlay === SYNTENY_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 94) / 2)}
          marginTop={Math.floor((terminalRows - 24) / 2)}
        >
          <SyntenyOverlay repository={repository} />
        </Box>
      )}

      {activeOverlay === BIAS_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 96) / 2)}
          marginTop={Math.floor((terminalRows - 24) / 2)}
        >
          <BiasDecompositionOverlay repository={repository} />
        </Box>
      )}

      {activeOverlay === 'phasePortrait' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 84) / 2)}
          marginTop={Math.floor((terminalRows - 22) / 2)}
        >
          <PhasePortraitOverlay sequence={sequence} />
        </Box>
      )}

      {activeOverlay === 'foldQuickview' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 90) / 2)}
          marginTop={Math.floor((terminalRows - 22) / 2)}
        >
          <FoldQuickview embeddings={foldEmbeddings ?? []} />
        </Box>
      )}

      {activeOverlay === 'kmerAnomaly' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 80) / 2)}
          marginTop={Math.floor((terminalRows - 16) / 2)}
        >
          <KmerAnomalyOverlay />
        </Box>
      )}

      {activeOverlay === 'complexity' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 90) / 2)}
          marginTop={Math.floor((terminalRows - 26) / 2)}
        >
          <SequenceComplexityOverlay
            sequence={sequence}
            phageName={currentPhage?.name ?? 'Unknown phage'}
            genomeLength={currentPhage?.genomeLength ?? sequence.length}
            onClose={() => closeOverlay('complexity')}
          />
        </Box>
      )}

      {activeOverlay === 'commandPalette' && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 70) / 2)}
          marginTop={Math.floor((terminalRows - 18) / 2)}
        >
          <CommandPalette onClose={() => closeOverlay('commandPalette')} />
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

      {activeOverlay === SIMULATION_VIEW_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 90) / 2)}
          marginTop={Math.floor((terminalRows - 24) / 2)}
        >
          <SimulationView onClose={() => closeOverlay(SIMULATION_VIEW_ID)} />
        </Box>
      )}
    </Box>
  );
}
