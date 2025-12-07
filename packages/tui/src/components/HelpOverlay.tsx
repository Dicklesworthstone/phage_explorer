import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { HudTheme } from '@phage-explorer/core';

type HelpRow = { key: string; desc: string; note?: string };

// Category colors for different types of keys
type KeyCategory = 'navigation' | 'view' | 'analysis' | 'overlay' | 'system';

function getCategoryColor(category: KeyCategory, colors: HudTheme): string {
  switch (category) {
    case 'navigation': return colors.info;
    case 'view': return colors.success;
    case 'analysis': return colors.warning;
    case 'overlay': return colors.accent;
    case 'system': return colors.textDim;
  }
}

function Section({
  title,
  rows,
  category,
  colors,
}: {
  title: string;
  rows: HelpRow[];
  category: KeyCategory;
  colors: HudTheme;
}): React.ReactElement {
  const catColor = getCategoryColor(category, colors);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1} marginBottom={0}>
        <Text color={catColor}>◉</Text>
        <Text color={colors.primary} bold>
          {title}
        </Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        {rows.map(({ key, desc, note }) => (
          <Box key={key} gap={1}>
            <Text color={catColor} bold>{key.padEnd(12)}</Text>
            <Text color={colors.text}>{desc}</Text>
            {note && (
              <Text color={colors.textMuted}> · {note}</Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function HelpOverlay(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const viewMode = usePhageStore(s => s.viewMode);
  const readingFrame = usePhageStore(s => s.readingFrame);
  const diffEnabled = usePhageStore(s => s.diffEnabled);
  const helpDetail = usePhageStore(s => s.helpDetail);
  const overlays = usePhageStore(s => s.overlays);
  const experienceLevel = usePhageStore(s => s.experienceLevel);
  const setHelpDetail = usePhageStore(s => s.setHelpDetail);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const colors = theme.colors;

  useInput((input, key) => {
    if (key.escape) {
      closeOverlay('help');
      return;
    }
    if (input === '?') {
      setHelpDetail(helpDetail === 'essential' ? 'detailed' : 'essential');
    }
  });

  const essential = useMemo(() => {
    return {
      left: [
        {
          title: 'Navigation',
          category: 'navigation' as KeyCategory,
          rows: [
            { key: '↑ / ↓', desc: 'Previous / next phage' },
            { key: '← / →', desc: 'Scroll sequence left / right' },
            { key: 'PgUp/PgDn', desc: 'Scroll by page' },
            { key: 'Home/End', desc: 'Jump to start / end' },
            { key: '[ / ]', desc: 'Jump to prev / next gene' },
          ],
        },
        {
          title: 'View Controls',
          category: 'view' as KeyCategory,
          rows: [
            { key: 'N / C', desc: 'Toggle DNA / AA view' },
            { key: 'F', desc: `Reading frame (${readingFrame + 1})`, note: 'AA only' },
            { key: 'T', desc: `Theme: ${theme.name}` },
            { key: 'D', desc: `Diff mode ${diffEnabled ? '●' : '○'}` },
          ],
        },
        {
          title: '3D Model',
          category: 'view' as KeyCategory,
          rows: [
            { key: 'M', desc: 'Toggle 3D model' },
            { key: 'O', desc: 'Pause / resume' },
            { key: 'Z', desc: 'Fullscreen mode' },
            { key: 'R', desc: 'Cycle quality' },
          ],
        },
      ],
      right: [
        {
          title: 'Quick Overlays',
          category: 'analysis' as KeyCategory,
          rows: [
            { key: 'G', desc: 'GC skew', note: 'origin/terminus' },
            { key: 'X', desc: 'Complexity', note: 'HGT/repeats' },
            { key: 'V', desc: 'Packaging pressure' },
            { key: 'B', desc: 'Bendability', note: 'AT proxy' },
            { key: 'J', desc: 'K-mer anomaly' },
            { key: 'H', desc: 'HGT passport', note: 'donor islands' },
            { key: 'P', desc: 'Promoter/RBS motifs' },
            { key: 'E', desc: 'Tail fiber tropism', note: 'receptor atlas' },
          ],
        },
        {
          title: 'Menus & Search',
          category: 'overlay' as KeyCategory,
          rows: [
            { key: 'S / /', desc: 'Search phages' },
            { key: 'W', desc: 'Compare genomes' },
            { key: 'A', desc: 'Analysis menu' },
            { key: 'A → Phase portraits / Shift+P', desc: 'AA property PCA / domain map' },
            { key: 'A → Bias', desc: 'Bias PCA (1=di, 2=codon)' },
            { key: 'Shift+S', desc: 'Simulation hub' },
            { key: ': / Ctrl+P', desc: 'Command palette' },
          ],
        },
        {
          title: 'System',
          category: 'system' as KeyCategory,
          rows: [
            { key: '?', desc: 'Toggle help detail' },
            { key: 'K', desc: 'AA color legend' },
            { key: 'Esc', desc: 'Close overlay' },
            { key: 'Q', desc: 'Quit' },
          ],
        },
      ],
    };
  }, [readingFrame, diffEnabled, theme.name]);

  const detailed = useMemo(() => {
    return {
      left: [
        ...essential.left,
        {
          title: 'Current State',
          category: 'system' as KeyCategory,
          rows: [
            { key: 'Mode', desc: viewMode === 'aa' ? 'Amino acids' : 'DNA nucleotides' },
            { key: 'Level', desc: experienceLevel },
            { key: 'Overlays', desc: overlays.length > 0 ? overlays.join(', ') : 'None' },
          ],
        },
      ],
      right: [
        ...essential.right,
        {
          title: 'Advanced Analysis',
          category: 'analysis' as KeyCategory,
          rows: [
            { key: 'L', desc: 'Module coherence' },
            { key: 'Y', desc: 'Transcription flow' },
            { key: 'R', desc: 'Repeats/palindromes' },
            { key: 'Ctrl+F', desc: 'Fold quickview' },
          ],
        },
      ],
    };
  }, [essential, viewMode, experienceLevel, overlays]);

  const layout = helpDetail === 'essential' ? essential : detailed;

  // Level indicator
  const levelBadge = experienceLevel === 'power' ? '◆ Power' :
                     experienceLevel === 'intermediate' ? '◇ Mid' : '○ New';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.borderFocus}
      paddingX={2}
      paddingY={1}
    >
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box gap={1}>
          <Text color={colors.primary} bold>◉ HELP</Text>
          <Text color={colors.accent}>
            [{helpDetail === 'essential' ? 'Essentials' : 'Detailed'}]
          </Text>
        </Box>
        <Box gap={2}>
          <Text
            color={experienceLevel === 'power' ? colors.accent :
                   experienceLevel === 'intermediate' ? colors.info : colors.textMuted}
          >
            {levelBadge}
          </Text>
          <Text color={colors.textMuted}>? toggle │ ESC close</Text>
        </Box>
      </Box>

      {/* Separator */}
      <Box marginBottom={1}>
        <Text color={colors.borderLight}>{'─'.repeat(76)}</Text>
      </Box>

      {/* Two-column layout */}
      <Box gap={4}>
        <Box flexDirection="column" width={38}>
          {layout.left.map(section => (
            <Section
              key={section.title}
              title={section.title}
              rows={section.rows}
              category={section.category}
              colors={colors}
            />
          ))}
        </Box>
        <Box flexDirection="column" width={38}>
          {layout.right.map(section => (
            <Section
              key={section.title}
              title={section.title}
              rows={section.rows}
              category={section.category}
              colors={colors}
            />
          ))}
        </Box>
      </Box>

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text color={colors.borderLight}>{'─'.repeat(76)}</Text>
      </Box>
      <Box justifyContent="center" marginTop={0}>
        <Text color={colors.textMuted}>
          Features unlock as you explore: 5 min → intermediate, 60 min → power
        </Text>
      </Box>
    </Box>
  );
}
