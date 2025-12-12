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

  const queueStats = useMemo(() => {
    if (state.ribosomes.length === 0) {
      return { longestQueue: 0, queues: 0 };
    }
    const sorted = [...state.ribosomes].sort((a, b) => a - b);
    let longest = 1;
    let current = 1;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] <= footprint) {
        current += 1;
        longest = Math.max(longest, current);
      } else {
        current = 1;
      }
    }
    return { longestQueue: longest, queues: Math.max(1, Math.ceil(sorted.length / longest)) };
  }, [state.ribosomes, footprint]);

  const slowSites = useMemo(() => {
    const annotated = state.codonRates.map((rate, idx) => ({ rate, idx }));
    const median =
      annotated.length === 0
        ? 0
        : annotated
            .map(a => a.rate)
            .sort((a, b) => a - b)
            [Math.floor(annotated.length / 2)];
    return annotated
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 3)
      .map(s => ({
        ...s,
        rate: Number(s.rate.toFixed(2)),
        slowdown: median > 0 ? Number(((median - s.rate) / median).toFixed(2)) : 0,
      }));
  }, [state.codonRates]);

  const densitySpark = useMemo(() => toSpark(state.densityHistory, 40), [state.densityHistory]);
  const productionSpark = useMemo(() => {
    if (state.productionHistory.length < 2) return '';
    const deltas: number[] = [];
    for (let i = 1; i < state.productionHistory.length; i++) {
      deltas.push(state.productionHistory[i] - state.productionHistory[i - 1]);
    }
    return toSpark(deltas, 40);
  }, [state.productionHistory]);

  const stallSpark = useMemo(() => {
    if (state.productionHistory.length < 2) return '';
    const deltas: number[] = [];
    const stalls = state.stallEvents;
    deltas.push(stalls);
    return toSpark(deltas, 40);
  }, [state.stallEvents, state.productionHistory.length]);

  const track = useMemo(() => {
    const cells = Array.from({ length: window }, () => '·');
    const rates = Array.from({ length: window }, () => 0);

    const rateMin = Math.min(...state.codonRates);
    const rateMax = Math.max(...state.codonRates);

    const slowIdxSet = new Set(slowSites.map(s => Math.floor((s.idx / length) * window)));

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

    // Overlay slow hotspots
    slowIdxSet.forEach(i => {
      if (i >= 0 && i < cells.length && cells[i] === '·') {
        cells[i] = '▏';
      }
    });

    return { cells, rates };
  }, [state.ribosomes, state.codonRates, length, footprint, slowSites]);

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

      <Box marginTop={1} flexDirection="column" gap={0}>
        <Text color={colors.accent} bold>Queues & throughput</Text>
        <Text color={colors.text}>
          Longest queue: {queueStats.longestQueue} ribosomes · Proteins/step spark: {productionSpark || 'n/a'} · Active ribosomes spark: {densitySpark || 'n/a'}
        </Text>
        {stallSpark && (
          <Text color={colors.textDim} dimColor>Stall trend: {stallSpark}</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.accent} bold>Slow sites (top 3)</Text>
        {slowSites.map(s => (
          <Text key={s.idx} color={colors.text}>
            Codon {s.idx + 1}: rate {s.rate} ({s.slowdown > 0 ? `${(s.slowdown * 100).toFixed(0)}% slower vs median` : 'at/near median'})
          </Text>
        ))}
        <Text color={colors.textDim} dimColor>▏ marks slow windows on track; background darker = slower codons</Text>
      </Box>
    </Box>
  );
}
