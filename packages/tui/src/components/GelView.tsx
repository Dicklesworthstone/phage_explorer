import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { 
  RESTRICTION_ENZYMES, 
  digestGenome, 
  calculateMigration 
} from '@phage-explorer/core';

// Ladder markers (bp)
const LADDER = [20000, 10000, 5000, 2000, 1000, 500, 200];

export function GelView({ sequence }: { sequence: string }): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  const currentPhage = usePhageStore(s => s.currentPhage);
  const [topologyChoice, setTopologyChoice] = useState<{ phageId: number | undefined; circular: boolean } | null>(null);
  const isCircular = topologyChoice && topologyChoice.phageId === currentPhage?.id
    ? topologyChoice.circular
    : currentPhage?.localGenome?.topology === 'circular';
  
  const [selectedEnzymeIndex, setSelectedEnzymeIndex] = useState(0);
  const enzyme = RESTRICTION_ENZYMES[selectedEnzymeIndex];

  const digest = useMemo(() => {
    if (!sequence) return null;
    return digestGenome(sequence, enzyme, isCircular);
  }, [sequence, enzyme, isCircular]);

  useInput((input, key) => {
    if (input.toLowerCase() === 'c') {
      setTopologyChoice({ phageId: currentPhage?.id, circular: !isCircular });
    }
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
  
  const renderLane = (bands: number[], _color: string) => {
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
                  <Text color={colors.textDim}>{char === '▬' ? `—${LADDER.find(l => Math.floor(calculateMigration(l, gelHeight - 1)) === i) || ''}—` : '│' /* ubs:ignore — compares a public gel drawing character, not a secret. */}</Text>
                </Box>
              ))}
            </Box>
            <Box flexDirection="column" width={laneWidth} alignItems="center">
              <Text color={colors.textMuted}>Sample</Text>
              {sampleGrid.map((char, i) => (
                <Box key={i} width={laneWidth} justifyContent="center">
                  <Text color={colors.accent}>{char === '▬' ? '▬▬▬' : ' ' /* ubs:ignore — compares a public gel drawing character, not a secret. */}</Text>
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
            <Text color={colors.info}>Cuts: {digest?.cutSites.length ?? 0}; fragments: {digest?.fragments.length ?? 0}</Text>
          </Box>
        </Box>
      </Box>

      <Text color={colors.textDim} dimColor>
        [↑/↓] Select enzyme · [C] Topology: {isCircular ? 'circular' : 'linear'}
      </Text>
      <Text color={colors.textDim}>Ideal complete digest; unresolved bases do not imply cuts.</Text>
      <Text color={colors.textDim}>No methylation, partial digestion or circular mobility model.</Text>
    </Box>
  );
}
