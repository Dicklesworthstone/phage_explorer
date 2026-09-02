import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { OverlayProvenance } from './OverlayProvenance';
import { usePhageStore } from '@phage-explorer/state';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function gauge(fraction: number, width = 40): string {
  const filled = Math.round(clamp01(fraction) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function PackagingPressureOverlay(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  const phage = usePhageStore(s => s.currentPhage);
  const scroll = usePhageStore(s => s.scrollPosition);
  const viewMode = usePhageStore(s => s.viewMode);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const genomeLength = phage?.genomeLength ?? 0;

  const { fill, force, pressure, atp } = useMemo(() => {
    if (!genomeLength || genomeLength <= 0) {
      return { fill: 0, force: 0, pressure: 0, atp: 0 };
    }
    const scrollBp = viewMode === 'aa' ? scroll * 3 : scroll;
    const clampedBp = Math.max(0, Math.min(genomeLength, scrollBp));
    const fillingFraction = clamp01(clampedBp / genomeLength);
    const packedLengthNm = clampedBp * 0.34;
    const force = 5 + 50 * Math.pow(fillingFraction, 3); // pN
    const pressure = Math.min(60, 5 + 55 * fillingFraction); // atm (cap)
    const atpConsumed = Math.floor(clampedBp / 2);
    return {
      fill: fillingFraction,
      force,
      pressure,
      atp: atpConsumed,
      packedLengthNm,
    };
  }, [genomeLength, scroll, viewMode]);

  useInput((input, key) => {
    if (key.escape || input === 'v' || input === 'V') {
      closeOverlay('pressure');
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={88}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          PACKAGING PRESSURE GAUGE (V KEY)
        </Text>
        <Text color={colors.textDim}>Esc/V to close</Text>
      </Box>

      <Box marginBottom={1}>
        <OverlayProvenance level="heuristic" source="closed-form estimate from genome length" />
      </Box>

      {!genomeLength ? (
        <Text color={colors.textDim}>No genome loaded</Text>
      ) : (
        <>
          <Text color={colors.text}>
            Position: {(viewMode === 'aa' ? scroll * 3 : scroll).toLocaleString()} / {genomeLength.toLocaleString()} bp · Fill {(fill * 100).toFixed(1)}%
          </Text>
          <Text color={colors.text}>
            Force: {force.toFixed(1)} pN · Pressure: {pressure.toFixed(1)} atm · ATP consumed: {atp.toLocaleString()}
          </Text>

          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.textDim}>Fill fraction gauge</Text>
            <Text color={colors.text}>{gauge(fill)}</Text>
          </Box>

          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.textDim}>Pressure gauge (warn above 50 atm)</Text>
            <Text color={pressure > 50 ? colors.error : colors.text}>
              {gauge(pressure / 60)}
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.textDim} dimColor>
              Scroll the genome to feel pressure rise; model: force = 5 + 50·φ³, pressure capped at 60 atm.
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
