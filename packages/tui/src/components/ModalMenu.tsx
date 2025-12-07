import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { usePhageStore } from '@phage-explorer/state';
import type { Theme } from '@phage-explorer/core';

export interface MenuItem {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  shortcut?: string;
  action: () => void;
}

export interface MenuCategory {
  name: string;
  items: MenuItem[];
}

interface ModalMenuProps {
  title: string;
  categories: MenuCategory[];
  onClose: () => void;
  width?: number;
  height?: number;
}

interface RankedItem extends MenuItem {
  category: string;
  score: number;
}

function scoreItem(query: string, item: MenuItem): number {
  if (!query.trim()) return 0;
  const q = query.toLowerCase();
  const haystack = `${item.label} ${item.description ?? ''} ${item.shortcut ?? ''}`.toLowerCase();

  // Basic scoring: prefix match > substring match
  if (haystack.startsWith(q)) return 3;
  if (haystack.includes(q)) return 1 + Math.min(q.length / 10, 1);

  // Token-based bonus
  const tokens = q.split(/\s+/).filter(Boolean);
  let bonus = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) {
      bonus += Math.min(t.length / 8, 0.5);
    }
  }
  return bonus;
}

function rankItems(query: string, categories: MenuCategory[]): RankedItem[] {
  const ranked: RankedItem[] = [];
  for (const category of categories) {
    for (const item of category.items) {
      const score = scoreItem(query, item);
      // If query exists, drop items with zero score
      if (query.trim() && score === 0) continue;
      ranked.push({ ...item, category: category.name, score });
    }
  }

  // If no query, preserve original ordering
  if (!query.trim()) {
    return ranked;
  }

  return ranked.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function renderItem(
  item: RankedItem,
  isSelected: boolean,
  theme: Theme
): React.ReactElement {
  const colors = theme.colors;
  return (
    <Box key={item.id} flexDirection="column" paddingX={1}>
      <Box>
        <Text color={isSelected ? colors.accent : colors.text} bold={isSelected}>
          {isSelected ? '▶ ' : '  '}
          {item.icon ? `${item.icon} ` : ''}
          {item.label}
        </Text>
        {item.shortcut && (
          <Text color={colors.textDim} dimColor>
            {' '}
            [{item.shortcut}]
          </Text>
        )}
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

export function ModalMenu({
  title,
  categories,
  onClose,
  width = 70,
  height = 18,
}: ModalMenuProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const ranked = useMemo(
    () => rankItems(query, categories),
    [query, categories]
  );

  // Clamp selection when list shrinks
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

  // Determine viewport for items (leave space for header/search/footer)
  const itemsVisible = Math.max(5, height - 6);
  const start = Math.max(0, safeIndex - Math.floor(itemsVisible / 2));
  const end = Math.min(start + itemsVisible, ranked.length);
  const visibleItems = ranked.slice(start, end);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      width={width}
      height={height}
      paddingX={1}
      paddingY={1}
    >
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          {title.toUpperCase()}
        </Text>
        <Text color={colors.textDim}>ESC to close</Text>
      </Box>

      {/* Search */}
      <Box marginBottom={1}>
        <Text color={colors.textDim}>Search: </Text>
        <TextInput value={query} onChange={setQuery} placeholder="Type to filter..." />
      </Box>

      {/* Results */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleItems.length === 0 ? (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text color={colors.textDim}>No matching items</Text>
          </Box>
        ) : (
          visibleItems.map((item, idx) =>
            renderItem(item, start + idx === safeIndex, theme)
          )
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color={colors.textDim} dimColor>
          ↑/↓ navigate · Enter to run
        </Text>
        <Text color={colors.textDim} dimColor>
          Categories: {categories.map(c => c.name).join(' · ')}
        </Text>
      </Box>
    </Box>
  );
}

