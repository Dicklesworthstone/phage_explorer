import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import type { Theme } from '@phage-explorer/core';
import { getCommands, type CommandItem } from '../commands/registry';

interface CommandPaletteProps {
  onClose: () => void;
}

interface RankedCommand extends CommandItem {
  score: number;
}

const RECENT_LIMIT = 6;

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

  const experienceLevel = usePhageStore(s => s.experienceLevel);
  const recentCommands = usePhageStore(s => s.recentCommands);
  const addRecentCommand = usePhageStore(s => s.addRecentCommand);

  const commands = useMemo(() => {
    const all = getCommands();
    return all.filter(cmd => {
      // Min level check
      if (cmd.minLevel === 'intermediate' && experienceLevel === 'novice') return false;
      if (cmd.minLevel === 'power' && experienceLevel !== 'power') return false;

      // Max level check
      if (cmd.maxLevel === 'novice' && experienceLevel !== 'novice') return false;
      if (cmd.maxLevel === 'intermediate' && experienceLevel === 'power') return false;

      return true;
    });
  }, [experienceLevel]);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const recents = useMemo(() => {
    if (!recentCommands.length) return [];
    const items = recentCommands
      .map(id => commands.find(c => c.id === id))
      .filter((c): c is CommandItem => Boolean(c));
    const deduped: CommandItem[] = [];
    for (const c of items) {
      if (!deduped.find(d => d.id === c.id)) deduped.push(c);
    }
    return deduped.slice(0, RECENT_LIMIT).map(c => ({ ...c, score: 0 })) as RankedCommand[];
  }, [commands, recentCommands]);

  const ranked = useMemo(() => {
    const main = rankCommands(query, commands);
    if (query.trim()) return main;
    const ids = new Set(recents.map(r => r.id));
    const remainder = main.filter(r => !ids.has(r.id));
    return [...recents, ...remainder];
  }, [query, commands, recents]);

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
      addRecentCommand(chosen.id);
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
