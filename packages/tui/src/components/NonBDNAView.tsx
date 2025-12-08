import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { analyzeNonBDNA, type NonBStructure } from '@phage-explorer/core';

export function NonBDNAView({ sequence }: { sequence: string }): React.ReactElement {
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  useInput((input, key) => {
    if (key.escape) {
      closeOverlay('non-b-dna');
    }
  });

  const structures = useMemo(() => {
    return analyzeNonBDNA(sequence);
  }, [sequence]);

  const g4Count = structures.filter(s => s.type === 'G4').length;
  const zDnaCount = structures.filter(s => s.type === 'Z-DNA').length;

  // Render mini-map
  const mapWidth = 60;
  const mapChars = Array(mapWidth).fill('·');
  
  structures.forEach(s => {
    const idx = Math.floor((s.start / sequence.length) * mapWidth);
    if (idx < mapWidth) {
      // Priority: G4 > Z-DNA
      if (s.type === 'G4') {
        mapChars[idx] = s.strand === '+' ? '▲' : '▼';
      } else if (mapChars[idx] === '·' || mapChars[idx] === 'Z') {
        mapChars[idx] = 'Z';
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={1}
      width={80}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>NON-B DNA STRUCTURE MAP</Text>
        <Text color={colors.textDim}>Esc to close</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.textMuted}>Structure Map:</Text>
        <Text>
          {mapChars.map((c, i) => (
            <Text key={i} color={c === '▲' ? colors.geneForward : c === '▼' ? colors.geneReverse : c === 'Z' ? colors.warning : colors.textDim}>
              {c}
            </Text>
          ))}
        </Text>
      </Box>

      <Box flexDirection="column" gap={0}>
        <Box justifyContent="space-between" marginBottom={1}>
          <Text color={colors.text}>
            Found: <Text color={colors.info}>{g4Count} G4</Text> | <Text color={colors.warning}>{zDnaCount} Z-DNA</Text>
          </Text>
        </Box>

        <Text color={colors.text} bold>Top Structures:</Text>
        {structures.length === 0 ? (
          <Text color={colors.textDim}>None detected.</Text>
        ) : (
          // Show top 5 by score
          [...structures].sort((a, b) => b.score - a.score).slice(0, 5).map((s, i) => (
            <Box key={i} justifyContent="space-between">
              <Text color={colors.textDim}>{s.start.toLocaleString()}-{s.end.toLocaleString()} bp</Text>
              <Text color={s.type === 'G4' ? (s.strand === '+' ? colors.geneForward : colors.geneReverse) : colors.warning}>
                {s.type}{s.type === 'G4' ? `(${s.strand})` : ''}
              </Text>
              <Text color={colors.textMuted}>
                Score: {s.score.toFixed(2)}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
