import React, { useMemo } from 'react';
import { Box } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { SIMULATION_METADATA } from '@phage-explorer/core';
import { getSimulationRegistry } from '../simulations/registry';
import type { MenuCategory } from './ModalMenu';
import { ModalMenu } from './ModalMenu';

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
  const experienceLevel = usePhageStore(s => s.experienceLevel);

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
        },
        {
          id: 'analysis-cycle-frame',
          label: 'Cycle Reading Frame',
          description: 'Advance reading frame (1 → 2 → 3)',
          icon: '↪',
          shortcut: 'F',
          action: cycleReadingFrame,
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
        },
        {
          id: 'analysis-search',
          label: 'Search Phages',
          description: 'Open search overlay for names, hosts, families, accessions',
          icon: '🔍',
          shortcut: 'S',
          action: () => openOverlay('search'),
        },
        {
          id: 'analysis-comparison',
          label: 'Open Genome Comparison',
          description: 'Launch comparison overlay between two phages',
          icon: '📊',
          shortcut: 'W',
          action: openComparison,
        },
        ...(experienceLevel === 'novice' ? [] : [
          {
            id: 'analysis-complexity',
            label: 'Sequence Complexity Overlay',
            description: 'Show compression-based complexity sparkline (X)',
            icon: '🧠',
            shortcut: 'X',
            action: () => openOverlay('complexity'),
          },
          {
            id: 'analysis-pressure',
            label: 'Packaging Pressure Gauge',
            description: 'Packaging motor pressure vs fill fraction (V)',
            icon: '📦',
            shortcut: 'V',
            action: () => openOverlay('pressure'),
          },
          {
            id: 'analysis-gcskew',
            label: 'GC Skew Overlay',
            description: 'Visualize cumulative GC skew (G)',
            icon: '🧮',
            shortcut: 'G',
            action: () => openOverlay('gcSkew'),
          },
          {
            id: 'analysis-kmer',
            label: 'K-mer Anomaly Map',
            description: 'Detect composition islands via JSD (J)',
            icon: '🧮',
            shortcut: 'J',
            action: () => openOverlay('kmerAnomaly'),
          },
          {
            id: 'analysis-modules',
            label: 'Module Coherence',
            description: 'Capsid/tail/lysis stoichiometry check (L)',
            icon: '🧩',
            shortcut: 'L',
            action: () => openOverlay('modules'),
          },
        ]),
        ...(experienceLevel === 'power'
          ? [{
              id: 'analysis-command-palette',
              label: 'Command Palette',
              description: 'Fuzzy commands (Ctrl+P / :)',
              icon: '⌘',
              shortcut: 'Ctrl+P',
              action: () => openOverlay('commandPalette'),
            }]
          : []),
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
        },
      ],
    },
  ], [toggleViewMode, cycleReadingFrame, toggleDiff, openOverlay, openComparison, cycleTheme, experienceLevel]);

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
  const experienceLevel = usePhageStore(s => s.experienceLevel);
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
        },
        {
          id: 'sim-toggle-pause',
          label: 'Pause / Resume Animation',
          description: 'Pause or resume model rotation',
          icon: '⏯',
          shortcut: 'P',
          action: toggle3DModelPause,
        },
        {
          id: 'sim-fullscreen',
          label: 'Toggle 3D Fullscreen',
          description: 'Enter/exit fullscreen model mode',
          icon: '🖥',
          shortcut: 'Z',
          action: toggle3DModelFullscreen,
        },
        {
          id: 'sim-quality',
          label: 'Cycle 3D Quality',
          description: 'Switch between low/medium/high/ultra shading',
          icon: '💡',
          shortcut: 'R',
          action: cycle3DModelQuality,
        },
        {
          id: 'sim-speed',
          label: 'Boost Spin Speed',
          description: 'Increase model spin speed slightly',
          icon: '⚡',
          shortcut: '+',
          action: () => set3DModelSpeed(1.5),
        },
        {
          id: 'sim-speed-reset',
          label: 'Reset Spin Speed',
          description: 'Return model spin speed to normal',
          icon: '🔄',
          shortcut: '0',
          action: () => set3DModelSpeed(1),
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
        },
      ],
    },
  ].filter(cat => {
    if (cat.name === 'Dynamic Simulations' && experienceLevel === 'novice') {
      return false;
    }
    return true;
  }), [toggle3DModel, toggle3DModelPause, toggle3DModelFullscreen, cycle3DModelQuality, set3DModelSpeed, openComparison, launchSimulation, currentPhage, registry, experienceLevel, onClose]);

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
