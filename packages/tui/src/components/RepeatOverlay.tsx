import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { findTerminalPalindromes, type MarkOverlay } from '../overlay-computations';

interface Props {
  sequence: string;
}

function densitySparkline(positions: number[], genomeLength: number, bins = 60): string {
  const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (genomeLength === 0) return '';
  const counts = new Array(bins).fill(0);
  const binSize = genomeLength / bins;
  for (const p of positions) {
    const idx = Math.min(bins - 1, Math.floor((p - 1) / binSize));
    counts[idx]++;
  }
  const max = Math.max(1, ...counts);
  return counts.map(c => SPARK[Math.floor((c / max) * (SPARK.length - 1))]).join('');
}

export function RepeatOverlay({ sequence }: Props): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const colors = theme.colors;
  const overlayData = usePhageStore(s => s.overlayData.repeats) as MarkOverlay | undefined;

  const hits = useMemo(() => {
    if (overlayData?.lengths && overlayData.lengths.length === overlayData.positions.length) {
      return overlayData.positions.map((pos, index) => ({ pos, len: overlayData.lengths![index] }));
    }
    return findTerminalPalindromes(sequence);
  }, [sequence, overlayData]);
  const topHits = hits.slice(0, 12);
  const spark = useMemo(() => densitySparkline(hits.map(h => h.pos), sequence.length), [hits, sequence.length]);

  useInput((input, key) => {
    if (key.escape || input === 'r' || input === 'R') closeOverlay('repeats');
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={68}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>REPEATS / PALINDROMES (R KEY)</Text>
        <Text color={colors.textDim}>ESC/R to close</Text>
      </Box>
      {sequence.length === 0 ? (
        <Text color={colors.textDim}>No sequence loaded</Text>
      ) : hits.length === 0 ? (
        <Text color={colors.textDim}>No resolved zero-gap palindromes of 6–10 bp found</Text>
      ) : (
        <>
          <Text color={colors.textDim}>
            Density sparkline: {spark} (▁ low repeats → █ high)
          </Text>
          <Text color={colors.textDim}>Linear, 1-based starts; shortest 6–10 bp zero-gap hit per start.</Text>
          <Text color={colors.textDim}>Total hits: {hits.length}. Showing first {topHits.length}.</Text>
          {topHits.map(hit => (
            <Text key={`${hit.pos}-${hit.len}`} color={colors.text}>
              {hit.pos.toLocaleString().padStart(8, ' ')}  len={hit.len}
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}
