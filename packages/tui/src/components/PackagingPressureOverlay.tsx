import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useOverlayWidth } from './terminal-size';
import { OverlayProvenance } from './OverlayProvenance';
import { usePhageStore } from '@phage-explorer/state';
import { packagingStateAt, PACKAGING_MIN_SPACING_NM } from '@phage-explorer/core';

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

  const state = useMemo(() => {
    if (!Number.isFinite(genomeLength) || genomeLength <= 0) return null;
    const scrollBp = viewMode === 'aa' ? scroll * 3 : scroll;
    // Match the browser cursor's default molar salt assumption. The motor's
    // editable millimolar controls are separate from this cursor experiment.
    return packagingStateAt(scrollBp, genomeLength, phage?.morphology, 0.1);
  }, [genomeLength, phage?.morphology, scroll, viewMode]);
  const withinPackingLimit = state !== null &&
    (state.spacingNm === null || state.spacingNm >= PACKAGING_MIN_SPACING_NM);

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
      width={useOverlayWidth(88)}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          PACKAGING PRESSURE GAUGE (V KEY)
        </Text>
        <Text color={colors.textDim}>Esc/V to close</Text>
      </Box>

      <Box marginBottom={1}>
        <OverlayProvenance level="simulated" source="uncalibrated spherical dsDNA energy model" />
      </Box>

      {!state ? (
        <Text color={colors.textDim}>No genome loaded</Text>
      ) : (
        <>
          <Text color={colors.text}>
            Position: {state.bpPackaged.toLocaleString()} / {genomeLength.toLocaleString()} bp · Fill {(state.fillFraction * 100).toFixed(1)}%
          </Text>
          <Text color={colors.text}>
            Force: {withinPackingLimit ? `${state.forcePn.toFixed(1)} pN` : 'Unavailable'} · Model pressure: {withinPackingLimit ? `${state.pressureAtm.toFixed(1)} atm` : 'Unavailable'}
          </Text>
          <Text color={colors.text}>
            Nominal ATP: {state.atpCount.toLocaleString()} (2 bp/ATP) · Ionic strength: 0.10 M
          </Text>
          <Text color={colors.textDim}>
            Assumed radius: {state.capsidRadiusNm.toFixed(1)} nm · Implied DNA spacing: {state.spacingNm === null ? 'empty capsid' : `${state.spacingNm.toFixed(2)} nm`}
          </Text>
          {!withinPackingLimit && <Text color={colors.warning}>
            This position requires DNA spacing below {PACKAGING_MIN_SPACING_NM} nm. Load and pressure are unavailable beyond the non-overlap limit of this spherical model.
          </Text>}

          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.textDim}>Fill fraction gauge</Text>
            <Text color={colors.text}>{gauge(state.fillFraction)}</Text>
          </Box>

          {withinPackingLimit && <Box flexDirection="column" marginTop={1}>
            <Text color={colors.textDim}>Model pressure gauge (0–60 atm display scale)</Text>
            <Text color={colors.text}>
              {gauge(state.pressureAtm / 60)}
            </Text>
          </Box>}

          <Box marginTop={1}>
            <Text color={colors.textDim} dimColor>
              Scroll to vary packaged length. Force = dE/dL; pressure = −dE/dV. Hypothetical dsDNA teaching model; no per-genome calibration.
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
