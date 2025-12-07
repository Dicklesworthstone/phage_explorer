import React from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';

export function Footer(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const viewMode = usePhageStore(s => s.viewMode);
  const overlays = usePhageStore(s => s.overlays);
  const modal = (() => {
    for (let i = overlays.length - 1; i >= 0; i--) {
      const o = overlays[i];
      if (o === 'analysisMenu' || o === 'simulationHub' || o === 'commandPalette' || o === 'comparison') {
        return o;
      }
    }
    return null;
  })();
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
    { key: 'O', action: '3D pause' },
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

      <Box gap={2} alignItems="center">
        <Text color={colors.textDim}>
          Overlays: {overlays.filter(o =>
            o === 'gcSkew' || o === 'complexity' || o === 'bendability' || o === 'promoter' || o === 'repeats' || o === 'kmerAnomaly' || o === 'modules'
          ).map(o => {
            if (o === 'gcSkew') return 'G';
            if (o === 'complexity') return 'X';
            if (o === 'bendability') return 'B';
            if (o === 'kmerAnomaly') return 'J';
            if (o === 'modules') return 'L';
            if (o === 'promoter') return 'P';
            if (o === 'repeats') return 'R';
            return o;
          }).join(' ') || 'none'}
        </Text>
        <Text color={colors.textDim}>
          Modal: {modal ? (
            modal === 'analysisMenu' ? 'Analysis' :
            modal === 'simulationHub' ? 'Simulation' :
            modal === 'commandPalette' ? 'Palette' :
            modal === 'comparison' ? 'Comparison' : modal
          ) : 'none'}
        </Text>
        <Text color={colors.textDim}>[Q] quit</Text>
      </Box>
    </Box>
  );
}
