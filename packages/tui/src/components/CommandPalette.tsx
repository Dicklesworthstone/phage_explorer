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
      <Box>
        <Text color={isSelected ? colors.accent : colors.text} bold={isSelected}>
          {isSelected ? '▶ ' : '  '}
          {item.label}
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
  const toggle3DModel = usePhageStore(s => s.toggle3DModel);
  const toggle3DModelPause = usePhageStore(s => s.toggle3DModelPause);
  const toggle3DModelFullscreen = usePhageStore(s => s.toggle3DModelFullscreen);
  const cycle3DModelQuality = usePhageStore(s => s.cycle3DModelQuality);

  // Seed commands each render (lightweight)
  useEffect(() => {
    setCommands([
      { id: 'nav-next', label: 'Next phage', description: 'Move down the list', keywords: ['arrow', 'down'], action: nextPhage },
      { id: 'nav-prev', label: 'Previous phage', description: 'Move up the list', keywords: ['arrow', 'up'], action: prevPhage },
      { id: 'view-toggle', label: 'Toggle DNA / AA view', description: 'Switch sequence mode', keywords: ['mode', 'view'], action: toggleViewMode },
      { id: 'frame-cycle', label: 'Cycle reading frame', description: 'Frame 1 → 2 → 3', keywords: ['frame'], action: cycleReadingFrame },
      { id: 'theme-cycle', label: 'Cycle theme', description: 'Rotate color themes', keywords: ['colors'], action: cycleTheme },
      { id: 'diff-toggle', label: 'Toggle diff', description: 'Diff vs reference', keywords: ['compare'], action: toggleDiff },
      { id: 'search', label: 'Search phages', description: 'Open search overlay', keywords: ['find'], action: () => openOverlay('search') },
      { id: 'analysis-menu', label: 'Analysis menu', description: 'Open analysis menu', keywords: ['menu', 'analysis'], action: () => openOverlay('analysisMenu') },
      { id: 'simulation-menu', label: 'Simulation hub', description: 'Open simulation menu', keywords: ['menu', 'simulation'], action: () => openOverlay('simulationMenu') },
      { id: 'complexity', label: 'Sequence complexity', description: 'Open complexity overlay', keywords: ['entropy', 'complexity'], action: () => toggleOverlay('complexity') },
      { id: 'gc-skew', label: 'GC skew', description: 'Open GC skew overlay', keywords: ['gc'], action: () => toggleOverlay('gcSkew') },
      { id: 'comparison', label: 'Genome comparison', description: 'Open comparison overlay', keywords: ['compare', 'genome'], action: openComparison },
      { id: 'model-toggle', label: 'Toggle 3D model', description: 'Show/hide 3D model', keywords: ['3d', 'model'], action: toggle3DModel },
      { id: 'model-pause', label: 'Pause/resume 3D model', description: 'Pause/resume rotation', keywords: ['3d', 'pause'], action: toggle3DModelPause },
      { id: 'model-fullscreen', label: 'Fullscreen 3D model', description: 'Enter/exit fullscreen', keywords: ['3d', 'fullscreen'], action: toggle3DModelFullscreen },
      { id: 'model-quality', label: 'Cycle 3D quality', description: 'Change shading quality', keywords: ['3d', 'quality'], action: cycle3DModelQuality },
    ]);
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
      ranked[safeIndex].action();
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
          ↑/↓ navigate · Enter to run
        </Text>
        <Text color={colors.textDim} dimColor>
          Total: {ranked.length}
        </Text>
      </Box>
    </Box>
  );
}

