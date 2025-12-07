import React from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';

export function HelpOverlay(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const colors = theme.colors;

  const sections = [
    {
      title: 'Navigation',
      keys: [
        { key: '↑ / ↓', desc: 'Previous / next phage' },
        { key: '← / →', desc: 'Scroll sequence left / right' },
        { key: 'PgUp / PgDn', desc: 'Scroll by page' },
        { key: 'Home / End', desc: 'Jump to start / end' },
        { key: '[ / ]', desc: 'Previous / next gene' },
        { key: '1-9', desc: 'Jump to gene by number' },
      ],
    },
    {
      title: 'View',
      keys: [
        { key: 'N / C', desc: 'Toggle DNA / AA (codon) view' },
        { key: 'F', desc: 'Cycle reading frame (1, 2, 3)' },
        { key: 'T', desc: 'Cycle color theme' },
        { key: 'D', desc: 'Toggle diff mode' },
        { key: 'W', desc: 'Compare genomes (stats)' },
        { key: 'K', desc: 'Toggle amino acid key' },
        { key: 'M', desc: 'Toggle 3D model' },
      ],
    },
    {
      title: 'Other',
      keys: [
        { key: 'S / /', desc: 'Search phages' },
        { key: 'G', desc: 'Go to position' },
        { key: '?', desc: 'Toggle this help' },
        { key: 'Esc', desc: 'Close overlay' },
        { key: 'Q', desc: 'Quit' },
      ],
    },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="center" marginBottom={1}>
        <Text color={colors.accent} bold>
          PHAGE-EXPLORER HELP
        </Text>
      </Box>

      {sections.map((section, i) => (
        <Box key={section.title} flexDirection="column" marginBottom={1}>
          <Text color={colors.primary} bold underline>
            {section.title}
          </Text>
          {section.keys.map(({ key, desc }) => (
            <Box key={key} gap={2}>
              <Text color={colors.accent}>{key.padEnd(12)}</Text>
              <Text color={colors.text}>{desc}</Text>
            </Box>
          ))}
        </Box>
      ))}

      <Box justifyContent="center" marginTop={1}>
        <Text color={colors.textDim}>Press Esc or ? to close</Text>
      </Box>
    </Box>
  );
}
