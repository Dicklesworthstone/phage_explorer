import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { analyzeNonBDNA, type NonBStructure } from '@phage-explorer/core';

interface NonBDNAOverlayProps {
  sequence: string;
}

export function NonBDNAOverlay({ sequence }: NonBDNAOverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const colors = theme.colors;

  const analysis = useMemo<NonBStructure[] | null>(() => {
    if (!sequence) return null;
    return analyzeNonBDNA(sequence);
  }, [sequence]);

  useInput((_, key) => {
    // Esc closes; avoid letter shortcuts to prevent collisions with other overlays
    if (key.escape) {
      closeOverlay('non-b-dna');
    }
  });

  if (!analysis) return <Text>Analyzing DNA structure...</Text>;

  const structures = analysis;
  const g4Count = structures.filter(s => s.type === 'G4').length;
  const zDnaCount = structures.filter(s => s.type === 'Z-DNA').length;
  const topStructures = structures.slice(0, 6);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={80}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>NON-B DNA STRUCTURES</Text>
        <Text color={colors.textDim}>Esc to close</Text>
      </Box>

      <Box marginBottom={1} gap={2}>
        <Text color={colors.text}>G4 Motifs: <Text bold color={colors.warning}>{g4Count}</Text></Text>
        <Text color={colors.text}>Z-DNA Regions: <Text bold color={colors.info}>{zDnaCount}</Text></Text>
      </Box>

      <Box flexDirection="column">
        <Text color={colors.textDim} underline>Top Candidates</Text>
        {topStructures.length === 0 ? (
          <Text color={colors.textDim}>No significant non-B structures found.</Text>
        ) : (
          topStructures.map((s: NonBStructure, i: number) => (
            <Box key={i} justifyContent="space-between">
              <Text color={s.type === 'G4' ? colors.warning : colors.info}>
                {s.type} ({s.strand})
              </Text>
              <Text color={colors.text}>
                {s.start.toLocaleString()}-{s.end.toLocaleString()}
              </Text>
              <Text color={colors.textDim}>
                Score: {s.score.toFixed(2)}
              </Text>
            </Box>
          ))
        )}
        {structures.length > 6 && (
          <Text color={colors.textDim}>...and {structures.length - 6} more</Text>
        )}
      </Box>
    </Box>
  );
}
