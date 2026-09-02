import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { OverlayProvenance } from './OverlayProvenance';
import { usePhageStore } from '@phage-explorer/state';
import { predictVirionStabilityFromPhage } from '@phage-explorer/core';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

function gauge(fraction: number, width = 44): string {
  const filled = Math.round(clamp01(fraction) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function VirionStabilityOverlay(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const phage = usePhageStore(s => s.currentPhage);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const [temperatureC, setTemperatureC] = useState(4);
  const [saltMilliMolar, setSaltMilliMolar] = useState(100);

  const estimate = useMemo(
    () => predictVirionStabilityFromPhage(phage, { temperatureC, saltMilliMolar }),
    [phage, temperatureC, saltMilliMolar]
  );

  const colors = theme.colors;
  const name = phage?.name ?? 'No phage selected';
  const gcText = phage?.gcContent != null ? `${(phage.gcContent * 100).toFixed(1)}% GC` : 'GC n/a';
  const genomeText = phage?.genomeLength ? `${phage.genomeLength.toLocaleString()} bp` : 'Length n/a';
  const morphology = phage?.morphology ?? 'Morphology n/a';

  const statusColor =
    estimate.status === 'robust'
      ? colors.success
      : estimate.status === 'moderate'
      ? colors.warning
      : colors.error;

  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'Q') {
      closeOverlay('stability');
      return;
    }
    if (key.upArrow) {
      setTemperatureC(t => Math.min(80, t + (key.shift ? 5 : 1)));
    } else if (key.downArrow) {
      setTemperatureC(t => Math.max(-10, t - (key.shift ? 5 : 1)));
    } else if (key.rightArrow) {
      setSaltMilliMolar(s => Math.min(500, s + (key.shift ? 25 : 10)));
    } else if (key.leftArrow) {
      setSaltMilliMolar(s => Math.max(0, s - (key.shift ? 25 : 10)));
    }
  });

  if (!phage) {
    return (
      <Box
        borderStyle="double"
        borderColor={colors.accent}
        paddingX={2}
        paddingY={1}
        width={92}
        flexDirection="column"
      >
        <Text color={colors.accent} bold>
          VIRION STABILITY PREDICTOR
        </Text>
        <Text color={colors.textDim}>Select a phage to estimate stability. Esc/Q to close.</Text>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={92}
      flexDirection="column"
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          VIRION STABILITY PREDICTOR (Esc/Q to close)
        </Text>
        <Text color={colors.textDim}>
          ↑↓ temp · ←→ salt · Shift = ×5
        </Text>
      </Box>

      <Box marginBottom={1}>
        <OverlayProvenance level="heuristic" source="rule-based stability model" />
      </Box>

      <Text color={colors.text}>
        {name} · {genomeText} · {gcText} · {morphology}
      </Text>
      <Text color={colors.textDim}>
        Env: {temperatureC.toFixed(0)}°C · {saltMilliMolar.toFixed(0)} mM (sweet spot ≈100 mM)
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.text}>
          Integrity: <Text color={statusColor} bold>{(estimate.integrity * 100).toFixed(1)}%</Text>{' '}
          ({estimate.status})
        </Text>
        <Text color={statusColor}>{gauge(estimate.integrity)}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.textDim}>
          Base index {Math.round(estimate.baseIndex * 100)}% · Packaging penalty {Math.round(estimate.packagingPenalty * 100)}%
        </Text>
        <Text color={colors.textDim}>
          Temp factor {Math.round(estimate.temperatureFactor * 100)}% · Salt factor {Math.round(estimate.saltFactor * 100)}%
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.text}>
          Melting onset ~ {estimate.meltingTempC.toFixed(1)}°C · Recommended ≤
          {estimate.recommendedStorage.temperatureC}°C, {estimate.recommendedStorage.saltMilliMolar} mM
        </Text>
      </Box>

      {estimate.warnings.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.warning} bold>
            Warnings:
          </Text>
          {estimate.warnings.map((w, idx) => (
            <Text key={idx} color={colors.warning}>
              • {w}
            </Text>
          ))}
        </Box>
      )}

      {estimate.notes.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.textDim} bold>
            Notes:
          </Text>
          {estimate.notes.map((w, idx) => (
            <Text key={idx} color={colors.textDim}>
              • {w}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

