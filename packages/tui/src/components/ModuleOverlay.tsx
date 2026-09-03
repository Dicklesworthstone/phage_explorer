import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useOverlayWidth } from './terminal-size';
import { usePhageStore } from '@phage-explorer/state';
import { computeModuleCoherence } from '@phage-explorer/core';

const GRADIENT = ['░', '▒', '▓', '█'];

function scoreColor(score: number, colors: { success: string; warning: string; error: string }): string {
  if (score >= 0.9) return colors.success;
  if (score >= 0.6) return colors.warning;
  return colors.error;
}

export function ModuleOverlay(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const phage = usePhageStore(s => s.currentPhage);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const colors = theme.colors;

  useInput((input, key) => {
    if (key.escape || input === 'l' || input === 'L') {
      closeOverlay('modules');
    }
  });

  const report = useMemo(() => {
    if (!phage) {
      return null;
    }
    return computeModuleCoherence(phage.genes || []);
  }, [phage]);

  if (!report || !phage) {
    return (
      <Box borderStyle="double" borderColor={colors.accent} paddingX={2} paddingY={1}>
        <Text color={colors.textDim}>No phage loaded.</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={useOverlayWidth(82)}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          MODULE COHERENCE — {phage.name}
        </Text>
        <Text color={colors.textDim}>Esc/L to close</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={colors.textDim}>
          Overall score:{' '}
        </Text>
        <Text color={scoreColor(report.overall, colors)} bold>
          {(report.overall * 100).toFixed(0)}%
        </Text>
      </Box>

      {/* Ribbon */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.textDim}>Modules</Text>
        <Box>
          {report.statuses.map((s) => {
            const c = scoreColor(s.score, colors);
            const gIdx = Math.min(GRADIENT.length - 1, Math.max(0, Math.round(s.score * (GRADIENT.length - 1))));
            return (
              <Text key={s.id} color={c} dimColor={false}>
                {GRADIENT[gIdx]}
              </Text>
            );
          })}
        </Box>
        <Box>
          {report.statuses.map((s) => (
            <Text key={`${s.id}-label`} color={colors.textDim} dimColor>
              {s.label.slice(0, 3).padEnd(4, ' ')}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Details */}
      <Box flexDirection="column" gap={0}>
        {report.statuses.map((s) => (
          <Box key={s.id} flexDirection="column" marginBottom={1}>
            <Box justifyContent="space-between">
              <Text color={colors.text} bold>
                {s.label}
              </Text>
              <Text color={scoreColor(s.score, colors)}>
                {s.count} / {s.min}{s.max ? `–${s.max}` : '+'}
              </Text>
            </Box>
            {s.issues.length === 0 ? (
              <Text color={colors.textDim}>Looks coherent.</Text>
            ) : (
              s.issues.map((issue, idx) => (
                <Text key={idx} color={colors.warning}>• {issue}</Text>
              ))
            )}
            {s.matchedGenes.length > 0 && (
              <Text color={colors.textDim} dimColor>
                Genes: {s.matchedGenes.map(g => g.name || g.product || g.locusTag || 'unnamed').slice(0, 6).join(', ')}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
