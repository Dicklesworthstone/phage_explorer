import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { 
  RESTRICTION_ENZYMES, 
  digestGenome, 
  calculateMigration, 
  type DigestResult 
} from '@phage-explorer/core';

// Ladder markers (bp)
const LADDER = [20000, 10000, 5000, 2000, 1000, 500, 200];

export function GelView({ sequence }: { sequence: string }): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  
  const [selectedEnzymeIndex, setSelectedEnzymeIndex] = useState(0);
  const enzyme = RESTRICTION_ENZYMES[selectedEnzymeIndex];

  const digest = useMemo(() => {
    if (!sequence) return null;
    // Digest as linear genome (default for database sequences).
    // Future: toggle for circular forms (e.g. plasmids, prophages).
    return digestGenome(sequence, enzyme, false); 
  }, [sequence, enzyme]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedEnzymeIndex(i => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      setSelectedEnzymeIndex(i => Math.min(RESTRICTION_ENZYMES.length - 1, i + 1));
    }
  });

  // Render Gel
  // Height 20 chars
  const gelHeight = 20;
  const laneWidth = 12;
  
  const renderLane = (bands: number[], color: string) => {
    const grid = Array(gelHeight).fill(' ');
    
    bands.forEach(len => {
      const pos = Math.floor(calculateMigration(len, gelHeight - 1));
      if (pos >= 0 && pos < gelHeight) {
        grid[pos] = '▬'; // Band marker
      }
    });
    
    return grid;
  };

  const ladderGrid = renderLane(LADDER, colors.textDim);
  const sampleGrid = digest ? renderLane(digest.fragments.map(f => f.length), colors.accent) : [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.border} paddingX={1} width={80}>
      <Box justifyContent="space-between">
        <Text color={colors.accent} bold>VIRTUAL AGAROSE GEL</Text>
        <Text color={colors.textDim}>Enzyme: {enzyme.name} ({enzyme.site})</Text>
      </Box>

      <Box marginY={1}>
        {/* Enzyme List */}
        <Box flexDirection="column" width={20} marginRight={2}>
          <Text color={colors.textMuted} underline>Enzymes</Text>
          {RESTRICTION_ENZYMES.map((e, i) => (
            <Text key={e.name} color={i === selectedEnzymeIndex ? colors.accent : colors.textDim}>
              {i === selectedEnzymeIndex ? '> ' : '  '}{e.name}
            </Text>
          )).slice(Math.max(0, selectedEnzymeIndex - 5), Math.max(10, selectedEnzymeIndex + 5))}
        </Box>

        {/* Gel */}
        <Box flexDirection="column" borderStyle="single" borderColor={colors.border}>
          <Box>
            <Box flexDirection="column" width={laneWidth} alignItems="center">
              <Text color={colors.textMuted}>Ladder</Text>
              {ladderGrid.map((char, i) => (
                <Box key={i} width={laneWidth} justifyContent="center">
                  <Text color={colors.textDim}>{char === '▬' ? `—${LADDER.find(l => Math.floor(calculateMigration(l, 19)) === i) || ''}—` : '│'}</Text>
                </Box>
              ))}
            </Box>
            <Box flexDirection="column" width={laneWidth} alignItems="center">
              <Text color={colors.textMuted}>Sample</Text>
              {sampleGrid.map((char, i) => (
                <Box key={i} width={laneWidth} justifyContent="center">
                  <Text color={colors.accent}>{char === '▬' ? '▬▬▬' : ' '}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
        
        {/* Stats */}
        <Box flexDirection="column" marginLeft={2}>
          <Text color={colors.textMuted} underline>Fragments</Text>
          {digest?.fragments.slice(0, 10).map((f, i) => (
            <Text key={i} color={colors.text}>
              {f.length.toLocaleString()} bp
            </Text>
          ))}
          {(digest?.fragments.length ?? 0) > 10 && <Text color={colors.textDim}>...</Text>}
          <Box marginTop={1}>
            <Text color={colors.info}>Total: {digest?.fragments.length ?? 0} cuts</Text>
          </Box>
        </Box>
      </Box>

      <Text color={colors.textDim} dimColor>
        [↑/↓] Select Enzyme
      </Text>
    </Box>
  );
}
