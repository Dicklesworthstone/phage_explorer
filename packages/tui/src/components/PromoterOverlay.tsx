import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { MarkOverlay } from '../overlay-computations';

const MOTIFS = ['TATAAT', 'TTGACA', 'AGGAGG'];

interface Props {
  sequence: string;
}

function findMotifs(seq: string): Array<{ pos: number; motif: string }> {
  const hits: Array<{ pos: number; motif: string }> = [];
  for (let i = 0; i < seq.length - 5; i++) {
    const sub = seq.slice(i, i + 6);
    if (MOTIFS.includes(sub)) {
      hits.push({ pos: i + 1, motif: sub }); // 1-based for display
    }
  }
  return hits;
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

export function PromoterOverlay({ sequence }: Props): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const colors = theme.colors;
  const overlayData = usePhageStore(s => s.overlayData.promoter) as MarkOverlay | undefined;

  const hits = useMemo(() => {
    const baseHits = overlayData && 'positions' in overlayData
      ? overlayData.positions.map(pos => ({ pos, motif: 'motif' })) // motif unknown when precomputed; keep placeholder
      : findMotifs(sequence.toUpperCase()).map(h => ({ pos: h.pos, motif: h.motif }));
    return baseHits.slice(0, 12);
  }, [sequence, overlayData]);

  const spark = useMemo(() => {
    const positions = overlayData && 'positions' in overlayData
      ? overlayData.positions
      : findMotifs(sequence.toUpperCase()).map(h => h.pos);
    return densitySparkline(positions, sequence.length);
  }, [sequence, overlayData]);

  useInput((input, key) => {
    if (key.escape || input === 'p' || input === 'P') closeOverlay('promoter');
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
        <Text color={colors.accent} bold>PROMOTER / RBS MOTIFS (P KEY)</Text>
        <Text color={colors.textDim}>ESC/P to close</Text>
      </Box>
      {sequence.length === 0 ? (
        <Text color={colors.textDim}>No sequence loaded</Text>
      ) : hits.length === 0 ? (
        <Text color={colors.textDim}>No canonical -10/-35/RBS motifs found (quick scan)</Text>
      ) : (
        <>
          <Text color={colors.textDim}>
            Density sparkline: {spark} (▁ low motif density → █ high)
          </Text>
          <Text color={colors.textDim}>Showing first {hits.length} hits (pos, motif):</Text>
          {hits.map(hit => (
            <Text key={`${hit.pos}-${hit.motif}`} color={colors.text}>
              {hit.pos.toLocaleString().padStart(8, ' ')}  {hit.motif}
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}
