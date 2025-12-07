import React from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';

export function Footer(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const viewMode = usePhageStore(s => s.viewMode);
  const colors = theme.colors;

  const keyHints = [
    { key: '↑↓', action: 'phages' },
    { key: '←→', action: 'scroll' },
    { key: viewMode === 'dna' ? 'N' : 'C', action: viewMode === 'dna' ? 'AA view' : 'DNA view' },
    { key: 'F', action: 'frame' },
    { key: 'T', action: 'theme' },
    { key: 'D', action: 'diff' },
    { key: 'W', action: 'compare' },
    { key: 'M', action: '3D' },
    { key: 'S', action: 'search' },
    { key: '?', action: 'help' },
  ];

  return (
    <Box
      borderStyle="single"
      borderColor={colors.border}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={2} flexWrap="wrap">
        {keyHints.map(hint => (
          <Box key={hint.key} gap={0}>
            <Text color={colors.accent}>[{hint.key}]</Text>
            <Text color={colors.textDim}> {hint.action}</Text>
          </Box>
        ))}
      </Box>

      <Text color={colors.textDim}>[Q] quit</Text>
    </Box>
  );
}
