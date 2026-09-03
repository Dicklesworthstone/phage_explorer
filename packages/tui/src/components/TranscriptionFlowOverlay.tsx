import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useOverlayWidth } from './terminal-size';
import { usePhageStore } from '@phage-explorer/state';
import {
  simulateTranscriptionFlow,
  detectPromoters,
  detectTerminators,
  type PromoterHit,
  type TerminatorHit,
  computeRegulatoryConstellation,
} from '@phage-explorer/core';

const BARS = ' ▂▃▄▅▆▇█';

function sparkline(values: number[], width = 64): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return BARS[0].repeat(Math.min(width, values.length));
  const step = Math.max(1, Math.floor(values.length / width));
  const out: string[] = [];
  for (let i = 0; i < values.length; i += step) {
    const v = values[i];
    const t = (v - min) / (max - min);
    const idx = Math.min(BARS.length - 1, Math.max(0, Math.round(t * (BARS.length - 1))));
    out.push(BARS[idx]);
  }
  return out.join('');
}

interface Props {
  sequence: string;
  genomeLength: number;
}

export function TranscriptionFlowOverlay({ sequence, genomeLength }: Props): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const seq = sequence || '';
  const { values, peaks } = useMemo(() => simulateTranscriptionFlow(seq), [seq]);
  const promoters = useMemo<PromoterHit[]>(() => detectPromoters(seq), [seq]);
  const terminators = useMemo<TerminatorHit[]>(() => detectTerminators(seq), [seq]);
  const constellation = useMemo(() => computeRegulatoryConstellation(seq), [seq]);
  const motifsSummary = useMemo(() => {
    const summary = new Map<string, number>();
    for (const p of promoters) {
      summary.set(p.motif, (summary.get(p.motif) ?? 0) + 1);
    }
    return Array.from(summary.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [promoters]);
  const line = useMemo(() => sparkline(values), [values]);

  useInput((input, key) => {
    if (key.escape || input === 'y' || input === 'Y') {
      closeOverlay('transcriptionFlow');
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={useOverlayWidth(90)}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>TRANSCRIPTION FLOW (Y KEY)</Text>
        <Text color={colors.textDim}>Esc/Y to close</Text>
      </Box>
      {!seq || genomeLength === 0 ? (
        <Text color={colors.textDim}>No sequence loaded</Text>
      ) : (
        <>
          <Text color={colors.text}>
            Genome length: {genomeLength.toLocaleString()} bp · Windowed flux bins: {values.length}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.accent} bold>Flux profile</Text>
            <Text color={colors.text}>{line}</Text>
            <Text color={colors.textDim} dimColor>
              Higher bars ≈ stronger predicted transcription flow (motif-driven heuristic).
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.primary} bold>Top flow regions</Text>
            {peaks.length === 0 ? (
              <Text color={colors.textDim}>No prominent peaks detected.</Text>
            ) : (
              peaks.map(p => (
                <Text key={p.start} color={colors.text}>
                  ▸ {p.start.toLocaleString()}-{p.end.toLocaleString()} bp · flux {p.flux.toFixed(2)}
                </Text>
              ))
            )}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.accent} bold>Motif hits</Text>
            <Text color={colors.textDim}>
              Promoters/RBS: {promoters.length.toLocaleString()} · Terminators: {terminators.length.toLocaleString()}
            </Text>
            {motifsSummary.length > 0 && (
              <Text color={colors.textDim}>
                Top motifs: {motifsSummary.map(([m, c]) => `${m}(${c})`).join(', ')}
              </Text>
            )}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.primary} bold>Spacing / co-occurrence</Text>
            {constellation.edges.length === 0 ? (
              <Text color={colors.textDim}>No strong promoter→terminator pairings detected.</Text>
            ) : (
              constellation.edges.slice(0, 5).map(edge => (
                <Text key={`${edge.source}-${edge.target}`} color={colors.text}>
                  ▸ {edge.label} · {edge.distance.toLocaleString()} bp · weight {edge.weight.toFixed(2)}
                </Text>
              ))
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={colors.textDim} dimColor>
              Heuristic model: promoters seed flow, palindromic repeats/terminators attenuate. Now shows spacing-weighted co-occurrence edges.
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
