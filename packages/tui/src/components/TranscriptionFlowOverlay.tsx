import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { simulateTranscriptionFlow } from '@phage-explorer/core';

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
      width={90}
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
          <Box marginTop={1}>
            <Text color={colors.textDim} dimColor>
              Heuristic model: promoters seed flow, palindromic repeats attenuate. Future: σ-factor presets, terminator prediction.
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}