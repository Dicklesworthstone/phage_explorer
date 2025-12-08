import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { usePhageStore, useOverlayStack } from '@phage-explorer/state';
import type { OverlayId, ExperienceLevel } from '@phage-explorer/state';
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
import { NonBDNAOverlay } from './NonBDNAOverlay';
import { AnomalyOverlay } from './AnomalyOverlay';
import { DotPlotOverlay } from './DotPlotOverlay';
import { CGROverlay } from './CGROverlay';
import { HilbertOverlay } from './HilbertOverlay';
import { GelOverlay } from './GelOverlay';
import { CRISPROverlay } from './CRISPROverlay';
import { SyntenyOverlay } from './SyntenyOverlay';
import { TropismOverlay } from './TropismOverlay';
import { StructureConstraintOverlay } from './StructureConstraintOverlay';
import {
  computeGCskew,
  computeComplexity,
  computeBendability,
  computePromoterMarks,
  computeRepeatMarks,
  computeKmerAnomaly,
} from '../overlay-computations';
import { SimulationHubOverlay } from './SimulationHubOverlay';
import { SimulationView } from './SimulationView';
import { KmerAnomalyOverlay } from './KmerAnomalyOverlay';
import type { KmerAnomalyOverlay as KmerOverlayType } from '../overlay-computations';
import { ModuleOverlay } from './ModuleOverlay';
import { FoldQuickview } from './FoldQuickview';
import { HGTOverlay } from './HGTOverlay';
import { BiasDecompositionOverlay } from './BiasDecompositionOverlay';
import { analyzeHGTProvenance, analyzeTailFiberTropism } from '@phage-explorer/comparison';
import type { FoldEmbedding, StructuralConstraintReport } from '@phage-explorer/core';
import { analyzeStructuralConstraints } from '@phage-explorer/core';

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
const STRUCTURE_ID: OverlayId = 'structureConstraints';
const ANOMALY_ID: OverlayId = 'anomaly';
const DOTPLOT_ID: OverlayId = 'dotPlot';
const NONB_ID: OverlayId = 'non-b-dna';

interface AppProps {
  repository: PhageRepository;
  foldEmbeddings?: FoldEmbedding[]; // Optional preloaded embeddings
}

export function App({ repository, foldEmbeddings = [] }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const overlayCacheRef = React.useRef<
    Map<number, { length: number; hash: number; refVersion: number; data: Record<string, unknown> }>
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
  const [structureReport, setStructureReport] = useState<StructuralConstraintReport | null>(null);
  const terminalCols = usePhageStore(s => s.terminalCols);
  const terminalRows = usePhageStore(s => s.terminalRows);
  const setTerminalSize = usePhageStore(s => s.setTerminalSize);
  const error = usePhageStore(s => s.error);
  const setError = usePhageStore(s => s.setError);
  const overlayData = usePhageStore(s => s.overlayData);
  const currentError = usePhageStore(s => s.error);
  const diffEnabled = usePhageStore(s => s.diffEnabled);
  const diffReferencePhageId = usePhageStore(s => s.diffReferencePhageId);
  const setDiffReference = usePhageStore(s => s.setDiffReference);

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
  const quitConfirmPending = usePhageStore(s => s.quitConfirmPending);
  const setQuitConfirmPending = usePhageStore(s => s.setQuitConfirmPending);

  // Sequence state
  const [sequence, setSequence] = useState<string>('');
  const [analysisProgress, setAnalysisProgress] = useState<string>('');

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

  // Preload reference sketches (lightweight sampled genomes) for donor inference in HGT tracer
  useEffect(() => {
    if (phages.length === 0) return;
    if (Object.keys(referenceSketchesRef.current).length > 0) return;
    let cancelled = false;
    const load = async () => {
      try {
        const sampleSequence = (seq: string): string => {
          // Downsample to keep memory light: take every 5th base, cap at 50k chars
          const step = 5;
          let sampled = '';
          for (let i = 0; i < seq.length && sampled.length < 50_000; i += step) {
            sampled += seq[i];
          }
          return sampled;
        };

        const entries = await Promise.all(
          phages.map(async (p) => {
            const len = await repository.getFullGenomeLength(p.id);
            const seq = await repository.getSequenceWindow(p.id, 0, len);
            const label = `${p.name ?? `phage-${p.id}`} (${p.host ?? 'unknown host'}) #${p.id}`;
            return { label, sketch: sampleSequence(seq) };
          })
        );
        const sketches: Record<string, string> = {};
        for (const { label, sketch } of entries) {
          sketches[label] = sketch;
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
      setAnalysisProgress('Loading sequence...');
      setStructureReport(null);
      try {
        const phage = await repository.getPhageByIndex(currentPhageIndex);
        setCurrentPhage(phage);

        // Load sequence
        if (phage) {
          const length = await repository.getFullGenomeLength(phage.id);
          const seq = await repository.getSequenceWindow(phage.id, 0, length);
          setSequence(seq);
          
          // Check cache
          const seqHash = hashSeq(seq);
          const cache = overlayCacheRef.current.get(phage.id);
          
         if (cache && cache.length === length && cache.hash === seqHash && cache.refVersion === referenceVersionRef.current) {
             setOverlayData(cache.data);
             setStructureReport(cache.data[STRUCTURE_ID] as StructuralConstraintReport ?? null);
             setAnalysisProgress('');
             setLoadingPhage(false);
          } else {
             // Start incremental analysis
             setLoadingPhage(false); // Allow UI to render sequence
             const partialData: any = {};
             setOverlayData(partialData); // Clear old data
             
             const analyses = [
               { id: 'gcSkew', label: 'GC Skew', fn: () => computeGCskew(seq) },
             { id: 'complexity', label: 'Complexity', fn: () => computeComplexity(seq) },
             { id: 'bendability', label: 'Bendability', fn: () => computeBendability(seq) },
             { id: 'promoter', label: 'Promoters', fn: () => computePromoterMarks(seq) },
             { id: 'repeats', label: 'Repeats', fn: () => computeRepeatMarks(seq) },
             { id: 'kmerAnomaly', label: 'K-mer Anomaly', fn: () => computeKmerAnomaly(seq) },
             { id: 'hgt', label: 'HGT Analysis', fn: () => analyzeHGTProvenance(seq, phage.genes ?? [], referenceSketchesRef.current) },
             {
               id: STRUCTURE_ID,
               label: 'Structural constraints',
               fn: () => analyzeStructuralConstraints(seq, phage.genes ?? []),
             },
             {
               id: 'tropism',
               label: 'Tail Fiber Tropism',
               fn: () => {
                 const predictions =
                   phage.tropismPredictions?.map(p => ({
                     geneId: p.geneId ?? null,
                     locusTag: p.locusTag ?? null,
                     receptor: p.receptor,
                     confidence: p.confidence,
                     evidence: p.evidence,
                     startPos: phage.genes.find(g => g.id === p.geneId)?.startPos,
                     endPos: phage.genes.find(g => g.id === p.geneId)?.endPos,
                     strand: phage.genes.find(g => g.id === p.geneId)?.strand ?? null,
                     product: phage.genes.find(g => g.id === p.geneId)?.product ?? null,
                   })) ?? [];
                 return analyzeTailFiberTropism(phage, seq, predictions);
               },
             },
             ];

             for (const job of analyses) {
               setAnalysisProgress(`Analyzing ${job.label}...`);
               // Yield to UI
               await new Promise(resolve => setTimeout(resolve, 10));
               
               const result = job.fn();
               partialData[job.id] = result;
               setOverlayData({ ...partialData });
             }
             
             // Cache result
             overlayCacheRef.current.set(phage.id, { length, hash: seqHash, refVersion: referenceVersionRef.current, data: partialData });
             setAnalysisProgress('');
          }
        } else {
          setLoadingPhage(false);
        }

        // Prefetch nearby phages
        repository.prefetchAround(currentPhageIndex, 3);
      } catch (err) {
        setError(`Failed to load phage: ${err}`);
        setLoadingPhage(false);
        setAnalysisProgress('');
      }
    };

    loadPhage();
  }, [repository, phages, currentPhageIndex, setCurrentPhage, setLoadingPhage, setError, setOverlayData])

  // Load diff reference sequence when needed
  useEffect(() => {
    if (!diffEnabled || !diffReferencePhageId) {
      // Only clear if we have something to clear, to avoid infinite loop if setDiffReference triggers this
      if (diffEnabled === false) {
         // We don't clear here because setDiffReference might trigger re-render.
         // But actually setDiffReference(null, null) is fine.
      }
      return;
    }

    let cancelled = false;
    const loadDiffRef = async () => {
      try {
        const length = await repository.getFullGenomeLength(diffReferencePhageId);
        const seq = await repository.getSequenceWindow(diffReferencePhageId, 0, length);
        if (!cancelled) {
          setDiffReference(diffReferencePhageId, seq);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to load reference phage: ${err}`);
        }
      }
    };
    loadDiffRef();
    return () => {
      cancelled = true;
    };
  }, [diffEnabled, diffReferencePhageId, repository, setDiffReference, setError]);

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

  // F-key escape sequences (cross-terminal compatible)
  const F_KEYS: Record<string, string> = {
    '\x1bOP': 'F1', '\x1b[11~': 'F1',
    '\x1bOQ': 'F2', '\x1b[12~': 'F2',
    '\x1bOR': 'F3', '\x1b[13~': 'F3',
    '\x1bOS': 'F4', '\x1b[14~': 'F4',
    '\x1b[15~': 'F5',
    '\x1b[17~': 'F6',
    '\x1b[18~': 'F7',
    '\x1b[19~': 'F8',
    '\x1b[20~': 'F9',
    '\x1b[21~': 'F10',
    // F11 intentionally omitted (reserved for terminal fullscreen)
    '\x1b[24~': 'F12',
  };

  // Handle keyboard input
  useInput((input, key) => {
    // Check for F-key escape sequences or Ink key flags
    const fKey = F_KEYS[input];

    // Clear quit confirm if user presses anything other than Esc
    if (!key.escape && quitConfirmPending) {
      setQuitConfirmPending(false);
    }

    // Global keys (work everywhere)
    if (input === 'q' || input === 'Q') {
      if (quitConfirmPending) {
        exit();
      } else {
        setQuitConfirmPending(true);
      }
      return;
    }

    // Escape: multi-purpose with quit confirmation
    if (key.escape) {
      if (quitConfirmPending) {
        // Second Esc = quit
        exit();
        return;
      }
      if (model3DFullscreen) {
        toggle3DModelFullscreen();
      } else if (activeOverlay) {
        closeOverlay();
      } else {
        // No overlay, no fullscreen → start quit confirmation
        setQuitConfirmPending(true);
      }
      return;
    }

    // F1: Help (always available)
    if (fKey === 'F1' || key.f1) {
      toggleOverlay('help');
      return;
    }

    // F2: 3D Model toggle (visually impressive)
    if (fKey === 'F2') {
      toggle3DModel();
      return;
    }

    // F3: Phase Portraits - AA property PCA (visually stunning)
    if (fKey === 'F3') {
      promoteExperienceLevel('intermediate');
      toggleOverlay('phasePortrait');
      return;
    }

    // F4: Bias Decomposition - PCA scatter plot
    if (fKey === 'F4') {
      promoteExperienceLevel('intermediate');
      toggleOverlay(BIAS_ID);
      return;
    }

    // F5: HGT Passport - Genomic islands visualization
    if (fKey === 'F5') {
      promoteExperienceLevel('intermediate');
      toggleOverlay(HGT_ID);
      return;
    }

    // F6: CRISPR Pressure map
    if (fKey === 'F6') {
      promoteExperienceLevel('intermediate');
      toggleOverlay(CRISPR_ID);
      return;
    }

    // F7: Comparison View
    if (fKey === 'F7') {
      openComparison();
      return;
    }

    // F8: Simulation Hub
    if (fKey === 'F8') {
      promoteExperienceLevel('power');
      openOverlay(SIMULATION_MENU_ID);
      return;
    }

    // F9: GC Skew
    if (fKey === 'F9') {
      promoteExperienceLevel('intermediate');
      toggleOverlay(GC_SKEW_ID);
      return;
    }

    // F10: Analysis Menu
    if (fKey === 'F10') {
      promoteExperienceLevel('intermediate');
      openOverlay(ANALYSIS_MENU_ID);
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
    } else if (key.shift && (input === 'a' || input === 'A')) {
      promote('power');
      openOverlay(ANOMALY_ID);
    } else if (input === 'g' || input === 'G') {
      if (key.shift) {
        promote('intermediate');
        toggleOverlay(NONB_ID);
      } else {
        if (!isIntermediate) {
          setError('Advanced overlays unlock after ~5 minutes or once promoted.');
          return;
        }
        promote('intermediate');
        toggleOverlay(GC_SKEW_ID);
      }
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
    } else if (input === 'u' || input === 'U') {
      promote('intermediate');
      toggleOverlay(STRUCTURE_ID);
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

      {/* Quit Confirmation Bar */}
      {quitConfirmPending && (
        <Box
          borderStyle="round"
          borderColor={theme.colors.error}
          paddingX={2}
          justifyContent="center"
        >
          <Text color={theme.colors.error} bold>
            ⚠ Press Esc or Q again to quit, any other key to cancel
          </Text>
        </Box>
      )}

      {/* Footer */}
      {!quitConfirmPending && <Footer />}

      {/* Analysis Progress */}
      {analysisProgress && (
        <Box
          position="absolute"
          marginLeft={Math.max(0, terminalCols - 24)}
          marginTop={Math.max(0, terminalRows - 3)}
        >
          <Text color="cyan">⟳ {analysisProgress}</Text>
        </Box>
      )}

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

      {activeOverlay === STRUCTURE_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 94) / 2)}
          marginTop={Math.floor((terminalRows - 24) / 2)}
        >
          <StructureConstraintOverlay proteinReport={structureReport} />
        </Box>
      )}

      {activeOverlay === NONB_ID && (
        <Box
          position="absolute"
          marginLeft={Math.floor((terminalCols - 80) / 2)}
          marginTop={Math.floor((terminalRows - 20) / 2)}
        >
          <NonBDNAOverlay sequence={sequence} />
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
