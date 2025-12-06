import React from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { AminoAcid } from '@phage-explorer/core';

// Compact amino acid property legend
// Shows color coding for different amino acid properties
// Uses one representative amino acid per group for the color sample
export function AALegend(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  // Property groups with representative amino acids for color display
  const propertyGroups: Array<{ label: string; sample: AminoAcid; members: string }> = [
    { label: 'Hydrophobic', sample: 'L', members: 'AVLIMFWP' },
    { label: 'Polar', sample: 'S', members: 'STYNQC' },
    { label: 'Basic (+)', sample: 'K', members: 'KRH' },
    { label: 'Acidic (-)', sample: 'D', members: 'DE' },
    { label: 'Special', sample: 'G', members: 'G*' },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      paddingX={1}
    >
      <Text color={colors.primary} bold>AA Key (K)</Text>
      {propertyGroups.map(group => {
        const colorPair = theme.aminoAcids[group.sample];
        return (
          <Box key={group.label}>
            <Text backgroundColor={colorPair.bg} color={colorPair.fg}>
              {' '}{group.members.charAt(0)}{' '}
            </Text>
            <Text color={colors.textDim}> {group.label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
