import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import type { Theme } from '@phage-explorer/core';
import { getCommands, setCommands, type CommandItem } from '../commands/registry';

interface CommandPaletteProps {
  onClose: () => void;
}

interface RankedCommand extends CommandItem {
  score: number;
}

function scoreCommand(query: string, cmd: CommandItem): number {
  if (!query.trim()) return 0;
  const q = query.toLowerCase();
  const haystack = [
    cmd.label,
    cmd.description ?? '',
    ...(cmd.keywords ?? []),
  ].join(' ').toLowerCase();

  // Prefix and substring scoring
  if (haystack.startsWith(q)) return 3;
  if (haystack.includes(q)) return 1 + Math.min(q.length / 8, 1);

  // Token bonus
  const tokens = q.split(/\s+/).filter(Boolean);
  let bonus = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) {
      bonus += Math.min(t.length / 6, 0.5);
    }
  }
  return bonus;
}

function rankCommands(query: string, cmds: CommandItem[]): RankedCommand[] {
  const ranked: RankedCommand[] = [];
  for (const cmd of cmds) {
    const score = scoreCommand(query, cmd);
    if (query.trim() && score === 0) continue;
    ranked.push({ ...cmd, score });
  }
  if (!query.trim()) {
    return ranked;
  }
  return ranked.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function renderCommand(item: RankedCommand, isSelected: boolean, theme: Theme): React.ReactElement {
  const colors = theme.colors;
  return (
    <Box key={item.id} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={isSelected ? colors.accent : colors.text} bold={isSelected}>
          {isSelected ? '▶ ' : '  '}
          {item.label}
          {item.shortcut ? `  [${item.shortcut}]` : ''}
        </Text>
        <Text color={colors.textDim} dimColor>
          {item.category ?? ''}
        </Text>
      </Box>
      {item.description && (
        <Text color={colors.textDim} dimColor>
          {'   '}
          {item.description}
        </Text>
      )}
    </Box>
  );
}

export function CommandPalette({ onClose }: CommandPaletteProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  const nextPhage = usePhageStore(s => s.nextPhage);
  const prevPhage = usePhageStore(s => s.prevPhage);
  const toggleViewMode = usePhageStore(s => s.toggleViewMode);
  const cycleReadingFrame = usePhageStore(s => s.cycleReadingFrame);
  const cycleTheme = usePhageStore(s => s.cycleTheme);
  const toggleDiff = usePhageStore(s => s.toggleDiff);
  const openOverlay = usePhageStore(s => s.openOverlay);
  const toggleOverlay = usePhageStore(s => s.toggleOverlay);
  const openComparison = usePhageStore(s => s.openComparison);
  const setError = usePhageStore(s => s.setError);
  const experienceLevel = usePhageStore(s => s.experienceLevel);
  const toggle3DModel = usePhageStore(s => s.toggle3DModel);
  const toggle3DModelPause = usePhageStore(s => s.toggle3DModelPause);
  const toggle3DModelFullscreen = usePhageStore(s => s.toggle3DModelFullscreen);
  const cycle3DModelQuality = usePhageStore(s => s.cycle3DModelQuality);

  // Seed commands on mount/experience change
  useEffect(() => {
    const baseCommands = [
      { id: 'nav-next', label: 'Next phage', description: 'Move down the list', keywords: ['arrow', 'down'], category: 'Navigation', shortcut: '↓', action: nextPhage },
      { id: 'nav-prev', label: 'Previous phage', description: 'Move up the list', keywords: ['arrow', 'up'], category: 'Navigation', shortcut: '↑', action: prevPhage },
      { id: 'view-toggle', label: 'Toggle DNA / AA view', description: 'Switch sequence mode', keywords: ['mode', 'view'], category: 'View', shortcut: 'Space', action: toggleViewMode },
      { id: 'frame-cycle', label: 'Cycle reading frame', description: 'Frame 1 → 2 → 3', keywords: ['frame'], category: 'View', shortcut: 'F', action: cycleReadingFrame },
      { id: 'theme-cycle', label: 'Cycle theme', description: 'Rotate color themes', keywords: ['colors'], category: 'View', shortcut: 'T', action: cycleTheme },
      { id: 'diff-toggle', label: 'Toggle diff', description: 'Diff vs reference', keywords: ['compare'], category: 'Analysis', shortcut: 'D', action: toggleDiff, minLevel: 'intermediate' },
      { id: 'search', label: 'Search phages', description: 'Open search overlay', keywords: ['find'], category: 'Navigation', shortcut: 'S or /', action: () => openOverlay('search') },
      { id: 'comparison', label: 'Genome comparison', description: 'Open comparison overlay', keywords: ['compare', 'genome'], category: 'Analysis', shortcut: 'W', action: openComparison, minLevel: 'intermediate' },
      { id: 'model-toggle', label: 'Toggle 3D model', description: 'Show/hide 3D model', keywords: ['3d', 'model'], category: '3D', shortcut: 'M', action: toggle3DModel },
      { id: 'model-pause', label: 'Pause/resume 3D model', description: 'Pause/resume rotation (O key)', keywords: ['3d', 'pause'], category: '3D', shortcut: 'O/P', action: toggle3DModelPause },
      { id: 'model-fullscreen', label: 'Fullscreen 3D model', description: 'Enter/exit fullscreen', keywords: ['3d', 'fullscreen'], category: '3D', shortcut: 'Z', action: toggle3DModelFullscreen },
      { id: 'model-quality', label: 'Cycle 3D quality', description: 'Change shading quality', keywords: ['3d', 'quality'], category: '3D', shortcut: 'R', action: cycle3DModelQuality },
    ];

    const advancedCommands =
      experienceLevel === 'novice'
        ? []
        : [
            { id: 'analysis-menu', label: 'Analysis menu', description: 'Open analysis menu', keywords: ['menu', 'analysis'], category: 'Menu', shortcut: 'A', action: () => openOverlay('analysisMenu') },
            { id: 'complexity', label: 'Sequence complexity', description: 'Open complexity overlay', keywords: ['entropy', 'complexity'], category: 'Overlay', shortcut: 'X', action: () => toggleOverlay('complexity') },
            { id: 'gc-skew', label: 'GC skew', description: 'Open GC skew overlay', keywords: ['gc'], category: 'Overlay', shortcut: 'G', action: () => toggleOverlay('gcSkew') },
            { id: 'bendability', label: 'Bendability', description: 'AT-rich bendability proxy overlay', keywords: ['bend', 'at'], category: 'Overlay', shortcut: 'B', action: () => toggleOverlay('bendability') },
            { id: 'promoter', label: 'Promoter/RBS motifs', description: 'Scan for -10/-35 and Shine-Dalgarno', keywords: ['promoter', 'rbs'], category: 'Overlay', shortcut: 'P', action: () => toggleOverlay('promoter') },
            { id: 'repeats', label: 'Repeats / palindromes', description: 'Detect short palindromic repeats', keywords: ['repeat', 'palindrome'], category: 'Overlay', shortcut: 'R', action: () => toggleOverlay('repeats') },
            { id: 'kmer', label: 'K-mer anomaly', description: 'Highlight composition shifts', keywords: ['kmer', 'anomaly'], category: 'Overlay', shortcut: 'J', action: () => toggleOverlay('kmerAnomaly') },
            { id: 'modules', label: 'Module coherence', description: 'Capsid/tail/lysis module view', keywords: ['module', 'stoichiometry'], category: 'Overlay', shortcut: 'L', action: () => toggleOverlay('modules') },
            { id: 'pressure', label: 'Packaging pressure gauge', description: 'Estimate capsid filling pressure', keywords: ['pressure', 'packing'], category: 'Overlay', shortcut: 'V', action: () => toggleOverlay('pressure') },
            { id: 'phase-portraits', label: 'AA property phase portraits', description: 'PCA of hydropathy/charge/aromaticity trajectories', keywords: ['phase', 'portrait', 'protein', 'property'], category: 'Overlay', shortcut: 'Shift+P', action: () => toggleOverlay('phasePortrait') },
            { id: 'bias-decomposition', label: 'Dinucleotide bias decomposition', description: 'PCA on dinucleotide frequencies across phages', keywords: ['bias', 'dinucleotide', 'pca'], category: 'Overlay', shortcut: 'A→Bias', action: () => toggleOverlay('biasDecomposition') },
          ];

    const powerCommands =
      experienceLevel === 'power'
        ? [
            { id: 'command-palette', label: 'Command palette', description: 'Fuzzy commands (Ctrl+P / :)', keywords: ['palette', 'commands'], category: 'Menu', shortcut: 'Ctrl+P', action: () => openOverlay('commandPalette') },
            { id: 'fold-quickview', label: 'Fold quickview', description: 'View fold embeddings (Ctrl+F)', keywords: ['fold', 'structure'], category: 'Analysis', shortcut: 'Ctrl+F', action: () => openOverlay('foldQuickview') },
            { id: 'simulation-hub', label: 'Simulation hub', description: 'Open simulation hub', keywords: ['simulation', 'hub'], category: 'Simulation', shortcut: 'Shift+S', action: () => openOverlay('simulationHub') },
          ]
        : [];

    const noviceHints =
      experienceLevel === 'novice'
        ? [
            {
              id: 'unlock-advanced',
              label: 'Unlock advanced overlays',
              description: 'Promote experience to access advanced tools',
              keywords: ['unlock', 'advanced', 'promote'],
              action: () => setError('Advanced overlays unlock automatically after time; ask to promote to power.'),
            },
          ]
        : [];

    setCommands([...baseCommands, ...advancedCommands, ...powerCommands, ...noviceHints]);
  }, [
    nextPhage,
    prevPhage,
    toggleViewMode,
    cycleReadingFrame,
    cycleTheme,
    toggleDiff,
    openOverlay,
    toggleOverlay,
    openComparison,
    toggle3DModel,
    toggle3DModelPause,
    toggle3DModelFullscreen,
    cycle3DModelQuality,
    setError,
    experienceLevel,
  ]);

  const commands = getCommands();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const ranked = useMemo(
    () => rankCommands(query, commands),
    [query, commands]
  );

  const safeIndex = Math.min(selectedIndex, Math.max(ranked.length - 1, 0));

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(ranked.length - 1, i + 1));
      return;
    }
    if (key.return && ranked[safeIndex]) {
      const chosen = ranked[safeIndex];
      chosen.action();
      onClose();
    }
  });

  const itemsVisible = Math.max(5, 14);
  const start = Math.max(0, safeIndex - Math.floor(itemsVisible / 2));
  const end = Math.min(start + itemsVisible, ranked.length);
  const visibleItems = ranked.slice(start, end);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      width={70}
      height={18}
      paddingX={1}
      paddingY={1}
    >
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          COMMAND PALETTE
        </Text>
        <Text color={colors.textDim}>ESC to close</Text>
      </Box>

      {/* Search */}
      <Box marginBottom={1}>
        <Text color={colors.textDim}>Search: </Text>
        <TextInput
          value={query}
          onChange={setQuery}
          placeholder="Type a command..."
        />
      </Box>

      {/* Results */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleItems.length === 0 ? (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text color={colors.textDim}>No matching commands</Text>
          </Box>
        ) : (
          visibleItems.map((item, idx) =>
            renderCommand(item, start + idx === safeIndex, theme)
          )
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color={colors.textDim} dimColor>
          ↑/↓ navigate · PgUp/PgDn page · Enter run · ESC close
        </Text>
        <Text color={colors.textDim} dimColor>
          Total: {ranked.length}
        </Text>
      </Box>
    </Box>
  );
}
