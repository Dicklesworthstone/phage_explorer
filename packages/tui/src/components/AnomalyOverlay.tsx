import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { scanForAnomalies } from '@phage-explorer/core';

export function AnomalyOverlay({ sequence }: { sequence: string }): React.ReactElement {
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  useInput((input, key) => {
    if (key.escape) {
      closeOverlay('anomaly');
    }
  });

  const { windows, thresholds } = useMemo(() => {
    return scanForAnomalies(sequence);
  }, [sequence]);

  // Find anomalies
  const anomalies = windows.filter(w => w.isAnomalous);

  // Render mini-map
  // Map sequence length to width (e.g. 60 chars)
  const mapWidth = 60;
  const mapChars = Array(mapWidth).fill('·');
  
  windows.forEach(w => {
    if (w.isAnomalous) {
      const idx = Math.floor((w.position / sequence.length) * mapWidth);
      if (idx < mapWidth) {
        mapChars[idx] = w.anomalyType === 'HGT' ? 'H' : w.anomalyType === 'Repetitive' ? 'R' : '!';
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={1}
      width={80}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>SEQUENCE ANOMALY SCANNER</Text>
        <Text color={colors.textDim}>Esc to close</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.textMuted}>Anomaly Map:</Text>
        <Text>
          {mapChars.map((c, i) => (
            <Text key={i} color={c === 'H' ? colors.warning : c === 'R' ? colors.info : c === '!' ? colors.error : colors.textDim}>
              {c}
            </Text>
          ))}
        </Text>
      </Box>

      <Box flexDirection="column" gap={0}>
        <Text color={colors.text} bold>Detected Anomalies ({anomalies.length}):</Text>
        {anomalies.length === 0 ? (
          <Text color={colors.textDim}>None detected.</Text>
        ) : (
          anomalies.slice(0, 5).map((a, i) => (
            <Box key={i} justifyContent="space-between">
              <Text color={colors.textDim}>{a.position.toLocaleString()} bp</Text>
              <Text color={a.anomalyType === 'HGT' ? colors.warning : colors.info}>
                {a.anomalyType}
              </Text>
              <Text color={colors.textMuted}>
                KL: {a.klDivergence.toFixed(2)} | Comp: {a.compressionRatio.toFixed(2)}
              </Text>
            </Box>
          ))
        )}
        {anomalies.length > 5 && (
          <Text color={colors.textDim} dimColor>... and {anomalies.length - 5} more</Text>
        )}
      </Box>
      
      <Box marginTop={1} borderStyle="single" borderColor={colors.border}>
        <Text color={colors.textDim}>
          KL Threshold: {thresholds.kl.toFixed(2)} | Comp Ratio Threshold: {thresholds.compression.toFixed(2)}
        </Text>
      </Box>
    </Box>
  );
}
