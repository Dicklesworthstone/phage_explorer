import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { RibosomeTrafficState } from '@phage-explorer/core';

interface RibosomeTrafficViewProps {
  state: RibosomeTrafficState;
}

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function toSpark(values: number[], width = 40): string {
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return BARS[0].repeat(Math.min(values.length, width));
  const step = Math.max(1, Math.floor(values.length / width));
  const points: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    points.push(values[i]);
  }
  return points
    .map(v => {
      const t = (v - min) / (max - min);
      const idx = Math.min(BARS.length - 1, Math.max(0, Math.round(t * (BARS.length - 1))));
      return BARS[idx];
    })
    .join('');
}

export function RibosomeTrafficView({ state }: RibosomeTrafficViewProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  const length = state.codonRates.length;
  const window = 80;
  const footprint = Number(state.params.footprint ?? 9);

  const track = useMemo(() => {
    const cells = Array.from({ length: window }, () => '·');
    const rates = Array.from({ length: window }, () => 0);

    const rateMin = Math.min(...state.codonRates);
    const rateMax = Math.max(...state.codonRates);

    for (let i = 0; i < window; i++) {
      const idx = Math.floor((i / window) * length);
      const rate = state.codonRates[idx] ?? 0;
      const norm = rateMax === rateMin ? 0.5 : (rate - rateMin) / (rateMax - rateMin);
      rates[i] = norm;
    }

    for (const pos of state.ribosomes) {
      const i = Math.floor((pos / length) * window);
      for (let j = 0; j < footprint && i + j < window; j++) {
        cells[i + j] = j === 0 ? '▶' : '█';
      }
    }

    return { cells, rates };
  }, [state.ribosomes, state.codonRates, length, footprint]);

  return (
    <Box flexDirection="column" gap={0}>
      <Text color={colors.text}>
        Track (length {length} codons) — ribosomes: {state.ribosomes.length} · proteins: {state.proteinsProduced} · stalls: {state.stallEvents}
      </Text>
      <Text color={colors.textDim} dimColor>
        Ribosomes show footprint (▶ head); background bar indicates slow codons (darker = slower)
      </Text>
      <Box>
        <Text color={colors.textDim}>mRNA </Text>
        {track.cells.map((cell, idx) => {
          const rate = track.rates[idx];
          const shadeIdx = Math.min(BARS.length - 1, Math.max(0, Math.round((1 - rate) * (BARS.length - 1))));
          const bgChar = BARS[shadeIdx];
          if (cell === '·') {
            return (
              <Text key={idx} color={colors.textDim}>
                {bgChar}
              </Text>
            );
          }
          return (
            <Text key={idx} color={colors.accent} bold>
              {cell}
            </Text>
          );
        })}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.accent} bold>Codon rate sparkline</Text>
        <Text color={colors.text}>{toSpark(state.codonRates, 60)}</Text>
        <Text color={colors.textDim} dimColor>▁ slow — █ fast</Text>
      </Box>
    </Box>
  );
}

