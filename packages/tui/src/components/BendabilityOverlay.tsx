import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { NumericOverlay } from '../overlay-computations';

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const scale = max === min ? 1 : (SPARK.length - 1) / (max - min);
  const step = Math.max(1, Math.floor(values.length / width));
  const out: string[] = [];
  for (let i = 0; i < values.length; i += step) {
    const v = values[i];
    const idx = Math.max(0, Math.min(SPARK.length - 1, Math.floor((v - min) * scale)));
    out.push(SPARK[idx]);
  }
  return out.join('');
}

function computeBendability(seq: string, window = 400): { values: number[] } {
  const values: number[] = [];
  for (let i = 0; i <= seq.length - window; i += window) {
    let at = 0;
    let gc = 0;
    for (let j = i; j < i + window; j++) {
      const c = seq[j];
      if (c === 'A' || c === 'T') at++;
      else if (c === 'G' || c === 'C') gc++;
    }
    const total = at + gc || 1;
    values.push(at / total);
  }
  return { values };
}

interface Props {
  sequence: string;
}

export function BendabilityOverlay({ sequence }: Props): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const overlayData = usePhageStore(s => s.overlayData.bendability) as NumericOverlay | undefined;

  const data = useMemo(() => {
    if (overlayData && 'values' in overlayData) {
      return { values: overlayData.values };
    }
    return computeBendability(sequence.toUpperCase());
  }, [sequence, overlayData]);
  const line = useMemo(() => sparkline(data.values, 70), [data.values]);

  useInput((input, key) => {
    if (key.escape || input === 'b' || input === 'B') closeOverlay('bendability');
  });

  const colors = theme.colors;

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={76}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>BENDABILITY (B KEY)</Text>
        <Text color={colors.textDim}>ESC/B to close</Text>
      </Box>
      {sequence.length === 0 ? (
        <Text color={colors.textDim}>No sequence loaded</Text>
      ) : (
        <>
          <Text color={colors.text}>Proxy = AT fraction per 400 bp window (higher = more bendable)</Text>
          <Text color={colors.textDim}>Sparkline: ▁ low AT (stiffer) → █ high AT (bendable)</Text>
          <Text color={colors.text}>{line}</Text>
        </>
      )}
    </Box>
  );
}
