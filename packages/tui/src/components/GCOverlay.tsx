import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { analyzeGCSkew, GC_SKEW_LIMITS } from '../../../core/src/analysis/gc-skew';
import { Sparkline } from './Sparkline';

interface GCOverlayProps {
  sequence: string;
}

export function computeTerminalGCSkew(sequence: string) {
  // Bound both the display allocation and Sparkline's range calculation. The
  // core still counts every base and every intervening G/C in each prefix.
  const stepSize = Math.max(1, Math.ceil(sequence.length / GC_SKEW_LIMITS.windows));
  const scan = analyzeGCSkew(sequence, { windowSize: 1, stepSize });
  const percent = (count: number) => scan.sequenceLength ? count / scan.sequenceLength * 100 : 0;
  return {
    scan, stepSize,
    values: scan.windows.map(window => window.cumulative),
    gcPercent: percent(scan.gcBases),
    atPercent: percent(scan.resolvedBases - scan.gcBases),
    ambiguousPercent: percent(scan.sequenceLength - scan.resolvedBases),
  };
}

export function GCOverlay({ sequence }: GCOverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  // The sequence-strip cache contains normalized window ratios, not cumulative
  // counts. It must never replace this panel's exact input-derived evidence.
  const result = useMemo(() => computeTerminalGCSkew(sequence), [sequence]);

  useInput((input, key) => {
    if (key.escape || input === 'g' || input === 'G') {
      closeOverlay('gcSkew');
    }
  });

  const colors = theme.colors;
  const minimum = result.scan.originPosition;
  const maximum = result.scan.terminusPosition;
  const compositionScale = 40 / Math.max(1, sequence.length);
  const gcWidth = Math.round(result.scan.gcBases * compositionScale);
  const resolvedWidth = Math.round(result.scan.resolvedBases * compositionScale);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.borderFocus}
      paddingX={2}
      paddingY={1}
      width={80}
    >
      {/* Header with close hint */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box gap={1}>
          <Text color={colors.primary} bold>◉ GC SKEW ANALYSIS</Text>
          <Text color={colors.accent}>[G]</Text>
        </Box>
        <Text color={colors.textMuted}>ESC or G to close</Text>
      </Box>

      {/* Separator */}
      <Box marginBottom={1}>
        <Text color={colors.borderLight}>{'─'.repeat(74)}</Text>
      </Box>

      {sequence.length === 0 ? (
        <Text color={colors.textDim}>No sequence loaded</Text>
      ) : (
        <>
          {/* Stats row */}
          <Box gap={3} marginBottom={1}>
            <Box gap={1}>
              <Text color={colors.textDim}>GC Content:</Text>
              <Text color={colors.success} bold>{result.gcPercent.toFixed(1)}%</Text>
            </Box>
            <Box gap={1}>
              <Text color={colors.textDim}>AT Content:</Text>
              <Text color={colors.warning} bold>{result.atPercent.toFixed(1)}%</Text>
            </Box>
            <Box gap={1}>
              <Text color={colors.textDim}>Ambiguous:</Text>
              <Text color={colors.text}>{result.ambiguousPercent.toFixed(1)}%</Text>
            </Box>
          </Box>
          <Text color={colors.textDim}>
            Percent of all {sequence.length.toLocaleString()} bases; {result.scan.resolvedBases.toLocaleString()} resolved A/C/G/T.
          </Text>

          {/* Every input base belongs to GC, AT, or unresolved IUPAC content. */}
          <Box marginBottom={1}>
            <Text color={colors.textDim}>Ratio: </Text>
            <Text color={colors.success}>{'█'.repeat(gcWidth)}</Text>
            <Text color={colors.warning}>{'█'.repeat(resolvedWidth - gcWidth)}</Text>
            <Text color={colors.textMuted}>{'░'.repeat(40 - resolvedWidth)} GC│AT│ambiguous</Text>
          </Box>

          {/* Sparkline visualization */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color={colors.textDim} bold>Cumulative G-minus-C (bases):</Text>
            <Sparkline
              values={result.values}
              width={70}
              colors={colors}
              gradient={true}
              showRange={true}
            />
            <Text color={colors.textDim}>
              Inclusive prefix every {result.stepSize.toLocaleString()} bp; {result.values.length.toLocaleString()} samples, averaged to fit the chart.
            </Text>
          </Box>

          {/* Sampled composition extrema are not measured replication sites. */}
          <Box flexDirection="column" marginTop={1}>
            <Box gap={2}>
              <Box gap={1}>
                <Text color={colors.info}>▼</Text>
                <Text color={colors.textDim}>First sampled minimum:</Text>
                <Text color={colors.text} bold>{minimum === null ? 'unavailable' : `${(minimum + 1).toLocaleString()} bp`}</Text>
              </Box>
            </Box>
            <Box gap={2}>
              <Box gap={1}>
                <Text color={colors.warning}>▲</Text>
                <Text color={colors.textDim}>First sampled maximum:</Text>
                <Text color={colors.text} bold>{maximum === null ? 'unavailable' : `${(maximum + 1).toLocaleString()} bp`}</Text>
              </Box>
            </Box>
            <Text color={colors.textDim}>
              Positions are 1-based; ties use the first sample. Extrema require two samples including G or C.
            </Text>
          </Box>

          {/* Explanation */}
          <Box marginTop={1}>
            <Text color={colors.textMuted}>
              Composition extrema do not establish replication origins, termini or direction.
              Ambiguous bases contribute neither G nor C; unsampled extrema may differ.
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
