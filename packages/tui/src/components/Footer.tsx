import React from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { HudTheme } from '@phage-explorer/core';

// Key hint categories with associated colors and icons
type HintCategory = 'navigation' | 'view' | 'analysis' | 'overlay' | 'system';

interface KeyHint {
  key: string;
  action: string;
  category: HintCategory;
}

// Category icons for visual grouping
const CATEGORY_ICONS: Record<HintCategory, string> = {
  navigation: '⬡',  // Hexagon for navigation
  view: '◐',        // Half circle for view
  analysis: '◈',    // Diamond for analysis
  overlay: '◉',     // Circle for overlay
  system: '⚙',      // Gear for system
};

// Get color for category
function getCategoryColor(category: HintCategory, colors: HudTheme): string {
  switch (category) {
    case 'navigation': return colors.info;
    case 'view': return colors.success;
    case 'analysis': return colors.warning;
    case 'overlay': return colors.accent;
    case 'system': return colors.textDim;
    default: return colors.text;
  }
}

// Group hints by category
function groupHintsByCategory(hints: KeyHint[]): Map<HintCategory, KeyHint[]> {
  const groups = new Map<HintCategory, KeyHint[]>();
  for (const hint of hints) {
    const existing = groups.get(hint.category) ?? [];
    existing.push(hint);
    groups.set(hint.category, existing);
  }
  return groups;
}

// Get overlay display character
function getOverlayChar(o: string): string {
  const map: Record<string, string> = {
    gcSkew: 'G',
    complexity: 'X',
    bendability: 'B',
    kmerAnomaly: 'J',
    modules: 'L',
    promoter: 'P',
    repeats: 'R',
    pressure: 'V',
    transcriptionFlow: 'Y',
  };
  return map[o] ?? o.charAt(0).toUpperCase();
}

// Get overlay display name
function getOverlayName(o: string): string {
  const map: Record<string, string> = {
    analysisMenu: 'Analysis',
    simulationHub: 'Simulations',
    commandPalette: 'Palette',
    comparison: 'Compare',
    phasePortrait: 'Phase portraits',
    help: 'Help',
    search: 'Search',
    aaKey: 'AA Key',
    simulationView: 'Sim View',
  };
  return map[o] ?? o;
}

export function Footer(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const viewMode = usePhageStore(s => s.viewMode);
  const overlays = usePhageStore(s => s.overlays);
  const experienceLevel = usePhageStore(s => s.experienceLevel);

  // Find active modal (top-level menu-like overlay)
  const modal = (() => {
    for (let i = overlays.length - 1; i >= 0; i--) {
      const o = overlays[i];
      if (
        o === 'analysisMenu' ||
        o === 'simulationHub' ||
        o === 'commandPalette' ||
        o === 'comparison' ||
        o === 'phasePortrait' ||
        o === 'help' ||
        o === 'search'
      ) {
        return o;
      }
    }
    return null;
  })();

  const colors = theme.colors;

  // Active data overlays
  const dataOverlays = overlays.filter(o =>
    ['gcSkew', 'complexity', 'bendability', 'promoter', 'repeats', 'kmerAnomaly', 'modules', 'pressure', 'transcriptionFlow'].includes(o)
  );

  // Build key hints based on experience level
  const keyHints: KeyHint[] = [
    // Navigation (always shown)
    { key: '↑↓', action: 'phage', category: 'navigation' },
    { key: '←→', action: 'scroll', category: 'navigation' },

    // View controls
    { key: viewMode === 'dna' ? 'N' : 'C', action: viewMode === 'dna' ? 'AA' : 'DNA', category: 'view' },
    { key: 'F', action: 'frame', category: 'view' },
    { key: 'T', action: 'theme', category: 'view' },
    { key: 'D', action: 'diff', category: 'view' },

    // 3D model controls
    { key: 'M', action: '3D', category: 'view' },
    { key: 'Z', action: 'fullscreen', category: 'view' },

    // Analysis overlays (intermediate+)
    ...(experienceLevel !== 'novice' ? [
      { key: 'G', action: 'GC', category: 'analysis' } as KeyHint,
      { key: 'X', action: 'complexity', category: 'analysis' } as KeyHint,
      { key: 'V', action: 'pressure', category: 'analysis' } as KeyHint,
    ] : []),

    // System controls
    { key: 'W', action: 'compare', category: 'overlay' },
    { key: 'S', action: 'search', category: 'overlay' },
    { key: '?', action: 'help', category: 'system' },
  ];

  // Group hints by category
  const groupedHints = groupHintsByCategory(keyHints);

  // Separator element
  const Separator = () => (
    <Text color={colors.separator ?? colors.textMuted}>│</Text>
  );

  // Render a hint group
  const renderHintGroup = (category: HintCategory, hints: KeyHint[]) => {
    const categoryColor = getCategoryColor(category, colors);
    const icon = CATEGORY_ICONS[category];

    return (
      <Box key={category} gap={0}>
        <Text color={categoryColor}>{icon}</Text>
        {hints.map((hint, idx) => (
          <Box key={hint.key} gap={0}>
            <Text color={categoryColor} bold>[{hint.key}]</Text>
            <Text color={colors.textDim}>{hint.action}</Text>
            {idx < hints.length - 1 && <Text color={colors.textMuted}>·</Text>}
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box
      borderStyle="round"
      borderColor={colors.border}
      paddingX={1}
      justifyContent="space-between"
    >
      {/* Key hints grouped by category with visual separators */}
      <Box gap={1} flexWrap="wrap">
        {Array.from(groupedHints.entries()).map(([category, hints], idx) => (
          <Box key={category} gap={1}>
            {renderHintGroup(category, hints)}
            {idx < groupedHints.size - 1 && <Separator />}
          </Box>
        ))}
      </Box>

      {/* Status section with enhanced visuals */}
      <Box gap={2} alignItems="center">
        {/* Active data overlays with icons */}
        {dataOverlays.length > 0 && (
          <Box gap={1}>
            <Text color={colors.warning}>◈</Text>
            <Text color={colors.textDim}>Layers</Text>
            <Text color={colors.separator ?? colors.textMuted}>⟨</Text>
            <Box gap={0}>
              {dataOverlays.map((o, i) => (
                <Text key={o} color={colors.warning} bold>
                  {getOverlayChar(o)}{i < dataOverlays.length - 1 ? '·' : ''}
                </Text>
              ))}
            </Box>
            <Text color={colors.separator ?? colors.textMuted}>⟩</Text>
          </Box>
        )}

        {/* Active modal with glow effect */}
        {modal && (
          <Box gap={0}>
            <Text color={colors.glow ?? colors.accent}>◉</Text>
            <Text color={colors.accent} bold backgroundColor={colors.backgroundAlt}>
              {' '}{getOverlayName(modal)}{' '}
            </Text>
          </Box>
        )}

        {/* Experience level badge with enhanced styling */}
        <Box gap={0}>
          <Text
            color={experienceLevel === 'power' ? colors.accent :
                   experienceLevel === 'intermediate' ? colors.info : colors.textMuted}
            backgroundColor={colors.backgroundAlt}
          >
            {experienceLevel === 'power' ? ' ◆ Power ' :
             experienceLevel === 'intermediate' ? ' ◇ Mid ' : ' ○ New '}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}