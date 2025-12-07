import React from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';

// Unicode decorative elements for visual polish
const ICONS = {
  dna: '🧬',
  phage: '🦠',
  arrow: '▶',
  bullet: '●',
  diamond: '◆',
  gene: '◉',
  diff: '⇄',
  frame: '◫',
  virus: '◎',
  host: '⬡',
  size: '◐',
  gc: '◑',
  chevronRight: '›',
  chevronLeft: '‹',
  separator: '│',
  dotSeparator: '·',
  star: '★',
  starEmpty: '☆',
  circle: '○',
  circleFilled: '●',
  box: '▣',
  triangleRight: '▸',
  triangleDown: '▾',
} as const;

// Format large numbers with K/M suffixes
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// Create a mini GC bar visualization
function GCBar({ gc, width = 10, colors }: { gc: number; width?: number; colors: any }): React.ReactElement {
  const filledWidth = Math.round((gc / 100) * width);
  const emptyWidth = width - filledWidth;

  // Color based on GC content (typical phage range is 30-70%)
  const barColor = gc < 35 ? colors.info :
                   gc > 65 ? colors.warning :
                   colors.success;

  return (
    <Box gap={0}>
      <Text color={barColor}>{'▓'.repeat(filledWidth)}</Text>
      <Text color={colors.textMuted}>{'░'.repeat(emptyWidth)}</Text>
    </Box>
  );
}

export function Header(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const phage = usePhageStore(s => s.currentPhage);
  const phageIndex = usePhageStore(s => s.currentPhageIndex);
  const phages = usePhageStore(s => s.phages);
  const viewMode = usePhageStore(s => s.viewMode);
  const readingFrame = usePhageStore(s => s.readingFrame);
  const diffEnabled = usePhageStore(s => s.diffEnabled);
  const experienceLevel = usePhageStore(s => s.experienceLevel);

  const colors = theme.colors;
  const muted = colors.textDim;
  const infoColor = colors.accent;

  // Get glow and icon colors from enhanced theme
  const glowColor = colors.glow ?? colors.primary;
  const iconPrimary = colors.iconPrimary ?? colors.primary;
  const iconSecondary = colors.iconSecondary ?? colors.accent;

  // Create visual experience level indicator with filled/empty stars
  const levelIndicator = experienceLevel === 'power'
    ? `${ICONS.star}${ICONS.star}${ICONS.star}`
    : experienceLevel === 'intermediate'
    ? `${ICONS.star}${ICONS.star}${ICONS.starEmpty}`
    : `${ICONS.star}${ICONS.starEmpty}${ICONS.starEmpty}`;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      paddingX={1}
    >
      {/* Title bar with enhanced branding */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={glowColor} bold>
            ╔══
          </Text>
          <Text color={iconPrimary}>{ICONS.virus}</Text>
          <Text color={colors.accent} bold>
            PHAGE EXPLORER
          </Text>
          <Text color={iconPrimary}>{ICONS.virus}</Text>
          <Text color={glowColor} bold>
            ══╗
          </Text>
          <Text color={colors.textMuted}>v1.0</Text>
        </Box>
        <Box gap={2}>
          <Text color={experienceLevel === 'power' ? colors.accent : muted}>{levelIndicator}</Text>
          <Text color={colors.separator ?? colors.textMuted}>{ICONS.separator}</Text>
          <Box gap={0}>
            <Text color={colors.accent} bold>[T]</Text>
            <Text color={colors.textDim}>heme</Text>
          </Box>
          <Box gap={0}>
            <Text color={colors.accent} bold>[?]</Text>
            <Text color={colors.textDim}>Help</Text>
          </Box>
          <Box gap={0}>
            <Text color={colors.error ?? colors.accent} bold>[Q]</Text>
            <Text color={colors.textDim}>uit</Text>
          </Box>
        </Box>
      </Box>

      {/* Phage info row with enhanced styling */}
      <Box justifyContent="space-between" marginTop={0}>
        <Box gap={1}>
          <Text color={iconSecondary}>{ICONS.triangleRight}</Text>
          <Text color={colors.text} bold>
            {phage?.name ?? 'Loading...'}
          </Text>
          {phage?.family && (
            <Text color={colors.badge ?? muted} backgroundColor={colors.backgroundAlt}>
              {' '}{phage.family}{' '}
            </Text>
          )}
        </Box>
        <Box gap={1}>
          <Text color={colors.textMuted}>{ICONS.chevronLeft}</Text>
          <Text color={colors.primary} bold>
            {phageIndex + 1}
          </Text>
          <Text color={colors.textMuted}>/</Text>
          <Text color={colors.text}>
            {phages.length}
          </Text>
          <Text color={colors.textMuted}>{ICONS.chevronRight}</Text>
          <Text color={colors.textDim}> Phages</Text>
        </Box>
      </Box>

      {/* Stats row with visual bars and better separation */}
      <Box gap={2} flexWrap="wrap">
        {phage && (
          <>
            {/* Host info with icon */}
            <Box gap={1}>
              <Text color={iconSecondary}>{ICONS.host}</Text>
              <Text color={colors.textDim}>Host</Text>
              <Text color={colors.separator ?? colors.textMuted}>{ICONS.separator}</Text>
              <Text color={colors.text}>{phage.host ?? 'Unknown'}</Text>
            </Box>

            <Text color={colors.separator ?? colors.textMuted}>{ICONS.dotSeparator}</Text>

            {/* Genome size with visual indicator */}
            <Box gap={1}>
              <Text color={colors.success}>{ICONS.size}</Text>
              <Text color={colors.textDim}>Size</Text>
              <Text color={colors.separator ?? colors.textMuted}>{ICONS.separator}</Text>
              <Text color={colors.text} bold>{formatNumber(phage.genomeLength ?? 0)}</Text>
              <Text color={colors.textMuted}>bp</Text>
            </Box>

            <Text color={colors.separator ?? colors.textMuted}>{ICONS.dotSeparator}</Text>

            {/* GC content with mini bar */}
            <Box gap={1}>
              <Text color={colors.warning}>{ICONS.gc}</Text>
              <Text color={colors.textDim}>GC</Text>
              <Text color={colors.separator ?? colors.textMuted}>{ICONS.separator}</Text>
              <Text color={colors.text}>{phage.gcContent?.toFixed(1) ?? '?'}%</Text>
              {phage.gcContent && <GCBar gc={phage.gcContent} width={8} colors={colors} />}
            </Box>

            <Text color={colors.separator ?? colors.textMuted}>{ICONS.dotSeparator}</Text>

            {/* Gene count */}
            <Box gap={1}>
              <Text color={colors.secondary}>{ICONS.gene}</Text>
              <Text color={colors.textDim}>Genes</Text>
              <Text color={colors.separator ?? colors.textMuted}>{ICONS.separator}</Text>
              <Text color={colors.text} bold>{phage.genes?.length ?? '?'}</Text>
            </Box>
          </>
        )}
      </Box>

      {/* Mode row with visual pill-style indicators */}
      <Box gap={2} marginTop={0}>
        {/* View mode toggle - pill style */}
        <Box gap={0}>
          <Text color={colors.separator ?? colors.textMuted}>╭─</Text>
          <Text
            color={viewMode === 'dna' ? colors.text : muted}
            bold={viewMode === 'dna'}
            backgroundColor={viewMode === 'dna' ? colors.success : undefined}
          >
            {viewMode === 'dna' ? ' DNA ' : ' dna '}
          </Text>
          <Text color={colors.separator ?? colors.textMuted}>│</Text>
          <Text
            color={viewMode === 'aa' ? colors.text : muted}
            bold={viewMode === 'aa'}
            backgroundColor={viewMode === 'aa' ? colors.accent : undefined}
          >
            {viewMode === 'aa' ? ' AA ' : ' aa '}
          </Text>
          <Text color={colors.separator ?? colors.textMuted}>─╮</Text>
        </Box>

        {/* Reading frame (only shown in AA mode) - compact */}
        {viewMode === 'aa' && (
          <Box gap={0}>
            <Text color={infoColor}>{ICONS.frame}</Text>
            <Text color={colors.textDim}>Frame</Text>
            <Text color={colors.separator ?? colors.textMuted}>[</Text>
            {[0, 1, 2].map(f => (
              <Text
                key={f}
                color={readingFrame === f ? colors.accent : muted}
                bold={readingFrame === f}
                backgroundColor={readingFrame === f ? colors.backgroundAlt : undefined}
              >
                {readingFrame === f ? `«${f + 1}»` : ` ${f + 1} `}
              </Text>
            ))}
            <Text color={colors.separator ?? colors.textMuted}>]</Text>
          </Box>
        )}

        {/* Diff mode indicator - flashing style */}
        {diffEnabled && (
          <Box gap={0}>
            <Text color={colors.warning} bold backgroundColor={colors.backgroundAlt}>
              {'░'}{ICONS.diff}{' DIFF '}{ICONS.diff}{'░'}
            </Text>
          </Box>
        )}

        {/* Theme indicator with color swatch */}
        <Box gap={1}>
          <Text color={colors.primary}>█</Text>
          <Text color={colors.secondary}>█</Text>
          <Text color={colors.accent}>█</Text>
          <Text color={colors.textDim}>{theme.name}</Text>
        </Box>
      </Box>
    </Box>
  );
}