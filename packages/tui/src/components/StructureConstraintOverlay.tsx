import React from 'react';
import { Box, Text } from 'ink';
import { useOverlayWidth } from './terminal-size';
import { usePhageStore } from '@phage-explorer/state';
import type { StructuralConstraintReport } from '@phage-explorer/core';

interface Props {
  proteinReport: StructuralConstraintReport | null;
}

const blocks = ['░', '▒', '▓', '█'] as const;

function fragilityBlock(score: number): string {
  if (score >= 0.8) return blocks[3];
  if (score >= 0.6) return blocks[2];
  if (score >= 0.4) return blocks[1];
  return blocks[0];
}

export function StructureConstraintOverlay({ proteinReport }: Props): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  const noProteins = !proteinReport || proteinReport.proteins.length === 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} padding={1} width={useOverlayWidth(92)}>
      <Text color={colors.primary} bold>
        Structure-Informed Constraint Scanner
      </Text>
      <Text color={colors.textDim}>Fragility: ░ robust → █ fragile</Text>

      {noProteins && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.textMuted}>No capsid/tail proteins detected for this phage.</Text>
        </Box>
      )}

      {!noProteins && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.accent} bold>
            Structural proteins
          </Text>
          {proteinReport!.proteins.map((protein) => (
            <Box key={protein.geneId} flexDirection="column" marginTop={1}>
              <Text color={colors.text} bold>
                {protein.name} {protein.locusTag ? `(${protein.locusTag})` : ''} • {protein.role}
              </Text>
              <Text color={colors.textDim}>
                Avg fragility: {(protein.avgFragility * 100).toFixed(1)}%
              </Text>

              <Text color={colors.text}>
                Hotspots:{' '}
                {protein.hotspots.length === 0
                  ? 'none'
                  : protein.hotspots
                      .map(
                        (h) =>
                          `${h.position + 1}${fragilityBlock(h.fragility)}${
                            h.warnings.length ? `(${h.warnings.join(',')})` : ''
                          }`
                      )
                      .join('  ')}
              </Text>

              {protein.hotspots.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={colors.info}>Top hotspot details</Text>
                  {protein.hotspots.slice(0, 5).map((h, idx) => (
                    <Box key={`${protein.geneId}-${h.position}-${idx}`} flexDirection="row" gap={1}>
                      <Text color={h.fragility > 0.7 ? colors.error : h.fragility > 0.5 ? colors.warning : colors.success}>
                        {fragilityBlock(h.fragility)} {h.position + 1}: {h.aa}
                      </Text>
                      <Text color={colors.textDim}>
                        • {(h.fragility * 100).toFixed(1)}% {h.warnings.length ? `• ${h.warnings.join(',')}` : ''}
                      </Text>
                    </Box>
                  ))}
                </Box>
              )}

              <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
                {protein.residues.slice(0, 80).map((res) => (
                  <Text key={res.position} color={res.fragility > 0.7 ? colors.error : res.fragility > 0.5 ? colors.warning : colors.success}>
                    {fragilityBlock(res.fragility)}
                  </Text>
                ))}
                {protein.residues.length > 80 && <Text color={colors.textDim}> …</Text>}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
