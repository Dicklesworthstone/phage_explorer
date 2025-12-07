import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';

const SPARKLINE_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

interface GCOverlayProps {
  sequence: string;
}

function computeCumulativeSkew(sequence: string) {
  let cum = 0;
  const values: number[] = new Array(sequence.length);
  let gCount = 0;
  let cCount = 0;

  for (let i = 0; i < sequence.length; i++) {
    const ch = sequence[i];
    if (ch === 'G') {
      cum += 1;
      gCount++;
    } else if (ch === 'C') {
      cum -= 1;
      cCount++;
    }
    values[i] = cum;
  }

  let minVal = Number.POSITIVE_INFINITY;
  let maxVal = Number.NEGATIVE_INFINITY;
  let minIdx = 0;
  let maxIdx = 0;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < minVal) {
      minVal = v;
      minIdx = i;
    }
    if (v > maxVal) {
      maxVal = v;
      maxIdx = i;
    }
  }

  const gcPercent = sequence.length > 0 ? ((gCount + cCount) / sequence.length) * 100 : 0;

  return { values, minIdx, maxIdx, gcPercent };
}

function mapValueToBar(v: number, min: number, max: number): string {
  if (max === min) return SPARKLINE_BARS[0];
  const norm = (v - min) / (max - min);
  const idx = Math.min(
    SPARKLINE_BARS.length - 1,
    Math.max(0, Math.floor(norm * (SPARKLINE_BARS.length - 1)))
  );
  return SPARKLINE_BARS[idx];
}

function buildSparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (values.length <= width) {
    return values.map(v => mapValueToBar(v, min, max)).join('');
  }

  const step = values.length / width;
  const chars: string[] = [];
  for (let i = 0; i < width; i++) {
    const idx = Math.floor(i * step);
    chars.push(mapValueToBar(values[idx], min, max));
  }
  return chars.join('');
}

export function GCOverlay({ sequence }: GCOverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const result = useMemo(() => computeCumulativeSkew(sequence.toUpperCase()), [sequence]);
  const sparkline = useMemo(() => buildSparkline(result.values, 64), [result.values]);

  useInput((input, key) => {
    if (key.escape || input === 'g' || input === 'G') {
      closeOverlay('gcSkew');
    }
  });

  const colors = theme.colors;
  const originPos = result.minIdx + 1; // 1-based
  const terminusPos = result.maxIdx + 1;

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
        <Text color={colors.accent} bold>GC SKEW (G KEY)</Text>
        <Text color={colors.textDim}>ESC/G to close</Text>
      </Box>

      {sequence.length === 0 ? (
        <Text color={colors.textDim}>No sequence loaded</Text>
      ) : (
        <>
          <Box flexDirection="column" marginBottom={1}>
            <Text color={colors.text}>
              GC% {result.gcPercent.toFixed(1)} · Origin ≈ {originPos.toLocaleString()} bp · Terminus ≈ {terminusPos.toLocaleString()} bp
            </Text>
          </Box>

          <Box flexDirection="column">
            <Text color={colors.text}>{sparkline}</Text>
            <Text color={colors.textDim} dimColor>
              min @ {originPos.toLocaleString()} | max @ {terminusPos.toLocaleString()}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

