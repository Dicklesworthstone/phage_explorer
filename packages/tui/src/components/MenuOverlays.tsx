import React, { useMemo } from 'react';
import { Box } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { SIMULATION_METADATA } from '@phage-explorer/core';
import { getSimulationRegistry } from '../simulations/registry';
import type { MenuCategory } from './ModalMenu';
import { ModalMenu } from './ModalMenu';
import type { OverlayId } from '@phage-explorer/state';

interface MenuOverlayProps {
  onClose: () => void;
}

export function AnalysisMenuOverlay({ onClose }: MenuOverlayProps): React.ReactElement {
  const toggleViewMode = usePhageStore(s => s.toggleViewMode);
  const cycleReadingFrame = usePhageStore(s => s.cycleReadingFrame);
  const cycleTheme = usePhageStore(s => s.cycleTheme);
  const toggleDiff = usePhageStore(s => s.toggleDiff);
  const openComparison = usePhageStore(s => s.openComparison);
  const openOverlay = usePhageStore(s => s.openOverlay);
  const helpDetail = usePhageStore(s => s.helpDetail);
  const setHelpDetail = usePhageStore(s => s.setHelpDetail);

  const categories: MenuCategory[] = useMemo(() => [
    {
      name: 'Navigation',
      items: [
        {
          id: 'analysis-toggle-view',
          label: 'Toggle DNA / Amino Acid View',
          description: 'Switch between nucleotide grid and translated amino acid grid',
          icon: '🧬',
          shortcut: 'Space',
          action: toggleViewMode,
          minLevel: 'novice',
        },
        {
          id: 'analysis-cycle-frame',
          label: 'Cycle Reading Frame',
          description: 'Advance reading frame (1 → 2 → 3)',
          icon: '↪',
          shortcut: 'F',
          action: cycleReadingFrame,
          minLevel: 'novice',
        },
      ],
    },
    {
      name: 'Analysis',
      items: [
        {
          id: 'analysis-diff',
          label: 'Toggle Diff vs Reference',
          description: 'Enable/disable diff mode against reference phage',
          icon: '≠',
          shortcut: 'D',
          action: toggleDiff,
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-search',
          label: 'Search Phages',
          description: 'Open search overlay for names, hosts, families, accessions',
          icon: '🔍',
          shortcut: 'S',
          action: () => openOverlay('search'),
          minLevel: 'novice',
        },
        {
          id: 'analysis-comparison',
          label: 'Open Genome Comparison',
          description: 'Launch comparison overlay between two phages',
          icon: '📊',
          shortcut: 'W',
          action: openComparison,
          minLevel: 'intermediate',
        },
        // Quick overlays grouped
        {
          id: 'analysis-complexity',
          label: 'Sequence Complexity Overlay',
          description: 'Show compression-based complexity sparkline (X)',
          icon: '🧠',
          shortcut: 'X',
          action: () => openOverlay('complexity'),
          minLevel: 'intermediate',
        },
          {
            id: 'analysis-transcription',
            label: 'Transcription Flow Overlay',
            description: 'Heuristic flow from promoters/terminators (Y)',
            icon: '🧪',
            shortcut: 'Y',
            action: () => openOverlay('transcriptionFlow'),
            minLevel: 'intermediate',
          },
          {
            id: 'analysis-pressure',
            label: 'Packaging Pressure Gauge',
            description: 'Packaging motor pressure vs fill fraction (V)',
            icon: '📦',
            shortcut: 'V',
            action: () => openOverlay('pressure'),
            minLevel: 'intermediate',
          },
        {
          id: 'analysis-stability',
          label: 'Virion Stability Predictor',
          description: 'Capsid robustness vs temperature / salt',
          icon: '🧊',
          shortcut: 'A→VS',
          action: () => openOverlay('stability' as OverlayId),
          minLevel: 'intermediate',
        },
          {
            id: 'analysis-gcskew',
            label: 'GC Skew Overlay',
            description: 'Visualize cumulative GC skew (G)',
            icon: '🧮',
          shortcut: 'G',
          action: () => openOverlay('gcSkew'),
          minLevel: 'intermediate',
        },
          {
            id: 'analysis-kmer',
            label: 'K-mer Anomaly Map',
            description: 'Detect composition islands via JSD (J)',
            icon: '🧮',
          shortcut: 'J',
          action: () => openOverlay('kmerAnomaly'),
          minLevel: 'power',
        },
        {
          id: 'analysis-cgr',
          label: 'CGR Fractal Fingerprint',
          description: 'Chaos Game Representation of k-mer space (C)',
          icon: '🌀',
          shortcut: 'A→CGR',
          action: () => openOverlay('cgr'),
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-dotplot',
          label: 'Self-Homology Dot Plot',
          description: 'Direct vs inverted repeat matrix',
          icon: '⬛',
          shortcut: 'A→Dot',
          action: () => openOverlay('dotPlot'),
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-selection-pressure',
          label: 'Selection Pressure (dN/dS)',
          description: 'Detect purifying vs positive selection windows',
          icon: '📈',
          shortcut: 'A→dN/dS',
          action: () => openOverlay('selectionPressure'),
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-anomaly',
          label: 'Anomaly Scanner',
          description: 'Find HGT/repeats via KL divergence (Z)',
          icon: '⚠️',
          shortcut: 'Z',
          action: () => openOverlay('anomaly'),
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-non-b',
          label: 'Non-B DNA Map',
          description: 'G-Quadruplexes & Z-DNA (N)',
          icon: '🧬',
          shortcut: 'A→NonB',
          action: () => openOverlay('non-b-dna'),
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-hilbert',
          label: 'Hilbert Genome Atlas',
          description: '2D Space-filling curve map (H)',
          icon: '🗺',
          shortcut: 'A→Hilbert',
          action: () => openOverlay('hilbert'),
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-gel',
          label: 'Virtual Agarose Gel',
          description: 'Restriction digest simulation (R)',
          icon: '🧪',
          shortcut: 'A→Gel',
          action: () => openOverlay('gel'),
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-modules',
          label: 'Module Coherence',
            description: 'Capsid/tail/lysis stoichiometry check (L)',
            icon: '🧩',
          shortcut: 'L',
          action: () => openOverlay('modules'),
          minLevel: 'power',
        },
        {
          id: 'analysis-tropism',
          label: 'Tail Fiber Tropism',
          description: 'Receptor atlas per tail fiber (E)',
          icon: '🧲',
          shortcut: 'E',
          action: () => openOverlay('tropism' as OverlayId),
          minLevel: 'intermediate',
        },
        {
          id: 'analysis-structure-constraints',
          label: 'Structure Constraints',
          description: 'Fragility scan for capsid/tail proteins',
          icon: '🧱',
          shortcut: 'SC',
          action: () => openOverlay('structureConstraints'),
          minLevel: 'power',
        },
          {
            id: 'analysis-bias',
            label: 'Dinucleotide Bias Decomposition',
            description: 'PCA of dinucleotide frequencies across phages',
            icon: '📊',
            shortcut: 'B1',
            action: () => openOverlay('biasDecomposition'),
            minLevel: 'power',
          },
          {
            id: 'analysis-phase-portraits',
            label: 'AA Property Phase Portraits',
            description: 'PCA of hydropathy/charge/aromaticity windows',
            icon: '📈',
            shortcut: 'A → PP',
            action: () => openOverlay('phasePortrait'),
            minLevel: 'power',
          },
          {
            id: 'analysis-crispr',
            label: 'CRISPR Spacer Reference Evidence',
            description: 'Load sourced spacers, inspect matches and verify replay (I)',
            icon: '🛡️',
          shortcut: 'I',
          action: () => openOverlay('crispr'),
          minLevel: 'power',
        },
	        {
	          id: 'analysis-synteny',
	          label: 'Functional Synteny Alignment',
	          description: 'Align gene order via DTW (Shift+Y)',
	          icon: '🔗',
	            shortcut: 'Shift+Y',
	            action: () => openOverlay('synteny'),
	            minLevel: 'power',
	          },
	        {
	          id: 'analysis-mosaic-radar',
	          label: 'Mosaic / Recombination Radar',
	          description: 'Sliding‑window donor shifts and breakpoints',
	          icon: '🧬',
	          shortcut: 'A → MR',
	          action: () => openOverlay('mosaicRadar'),
	          minLevel: 'power',
	        },
	          {
	            id: 'analysis-command-palette',
	          label: 'Command Palette',
          description: 'Fuzzy commands (Ctrl+P / :)',
          icon: '⌘',
          shortcut: 'Ctrl+P',
          action: () => openOverlay('commandPalette'),
          minLevel: 'power',
        },
        {
          id: 'analysis-help',
          label: 'Toggle Help Detail',
          description: 'Switch help overlay between essentials/detailed',
          icon: '❔',
          shortcut: '?',
          action: () => setHelpDetail(
            helpDetail === 'essential' ? 'detailed' : 'essential'
          ),
          minLevel: 'novice',
        },
      ],
    },
    {
      name: 'Appearance',
      items: [
        {
          id: 'analysis-theme',
          label: 'Cycle Theme',
          description: 'Rotate through color themes',
          icon: '🎨',
          shortcut: 'T',
          action: cycleTheme,
          minLevel: 'novice',
        },
      ],
    },
  ], [toggleViewMode, cycleReadingFrame, toggleDiff, openOverlay, openComparison, cycleTheme, helpDetail, setHelpDetail]);

  return (
    <Box>
      <ModalMenu
        title="Analysis Menu"
        categories={categories}
        onClose={onClose}
      />
    </Box>
  );
}

export function SimulationMenuOverlay({ onClose }: MenuOverlayProps): React.ReactElement {
  const toggle3DModel = usePhageStore(s => s.toggle3DModel);
  const toggle3DModelPause = usePhageStore(s => s.toggle3DModelPause);
  const toggle3DModelFullscreen = usePhageStore(s => s.toggle3DModelFullscreen);
  const cycle3DModelQuality = usePhageStore(s => s.cycle3DModelQuality);
  const set3DModelSpeed = usePhageStore(s => s.set3DModelSpeed);
  const openComparison = usePhageStore(s => s.openComparison);
  const launchSimulation = usePhageStore(s => s.launchSimulation);
  const currentPhage = usePhageStore(s => s.currentPhage);
  const registry = useMemo(() => getSimulationRegistry(), []);

  const categories: MenuCategory[] = useMemo(() => [
    {
      name: 'Dynamic Simulations',
      items: SIMULATION_METADATA.map(sim => ({
        id: `sim-${sim.id}`,
        label: sim.name,
        description: sim.description,
        icon: sim.icon,
        action: () => {
          const definition = registry.get(sim.id);
          if (!definition) return;
          const initial = definition.init(currentPhage ?? null, undefined);
          launchSimulation(definition.id, initial);
          onClose();
        },
        minLevel: 'intermediate',
      })),
    },
    {
      name: '3D Model',
      items: [
        {
          id: 'sim-toggle-3d',
          label: 'Toggle 3D Model',
          description: 'Show or hide the phage 3D model panel',
          icon: '🛰',
          shortcut: 'M',
          action: toggle3DModel,
          minLevel: 'novice',
        },
        {
          id: 'sim-toggle-pause',
          label: 'Pause / Resume Animation',
          description: 'Pause or resume model rotation',
          icon: '⏯',
          shortcut: 'P',
          action: toggle3DModelPause,
          minLevel: 'novice',
        },
        {
          id: 'sim-fullscreen',
          label: 'Toggle 3D Fullscreen',
          description: 'Enter/exit fullscreen model mode',
          icon: '🖥',
          shortcut: 'Z',
          action: toggle3DModelFullscreen,
          minLevel: 'intermediate',
        },
        {
          id: 'sim-quality',
          label: 'Cycle 3D Quality',
          description: 'Switch between low/medium/high/ultra shading',
          icon: '💡',
          shortcut: 'R',
          action: cycle3DModelQuality,
          minLevel: 'novice',
        },
        {
          id: 'sim-speed',
          label: 'Boost Spin Speed',
          description: 'Increase model spin speed slightly',
          icon: '⚡',
          shortcut: '+',
          action: () => set3DModelSpeed(1.5),
          minLevel: 'intermediate',
        },
        {
          id: 'sim-speed-reset',
          label: 'Reset Spin Speed',
          description: 'Return model spin speed to normal',
          icon: '🔄',
          shortcut: '0',
          action: () => set3DModelSpeed(1),
          minLevel: 'novice',
        },
      ],
    },
    {
      name: 'Comparisons',
      items: [
        {
          id: 'sim-open-comparison',
          label: 'Open Genome Comparison',
          description: 'Jump to comparison overlay (W)',
          icon: '📈',
          shortcut: 'W',
          action: openComparison,
          minLevel: 'intermediate',
        },
      ],
    },
  ], [toggle3DModel, toggle3DModelPause, toggle3DModelFullscreen, cycle3DModelQuality, set3DModelSpeed, openComparison, launchSimulation, currentPhage, registry, onClose]);

  return (
    <Box>
      <ModalMenu
        title="Simulation Hub"
        categories={categories}
        onClose={onClose}
      />
    </Box>
  );
}
