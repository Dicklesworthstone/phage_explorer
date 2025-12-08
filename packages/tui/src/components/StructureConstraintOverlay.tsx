import React from 'react';
import { Box, Text } from 'ink';
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

function bar(value: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round(value * width)));
  return '█'.repeat(filled).padEnd(width, '░');
}

export function StructureConstraintOverlay({ proteinReport }: Props): React.ReactElement {
  const noProteins = !proteinReport || proteinReport.proteins.length === 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1} width={92}>
      <Text color="cyan" bold>
        Structure-Informed Constraint Scanner
      </Text>
      <Text color="gray">Fragility: ░ robust → █ fragile</Text>

      {noProteins && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">No capsid/tail proteins detected for this phage.</Text>
        </Box>
      )}

      {!noProteins && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            Structural proteins
          </Text>
          {proteinReport!.proteins.map((protein) => (
            <Box key={protein.geneId} flexDirection="column" marginTop={1}>
              <Text color="yellow" bold>
                {protein.name} {protein.locusTag ? `(${protein.locusTag})` : ''} • {protein.role}
              </Text>
              <Text>
                Avg fragility: {(protein.avgFragility * 100).toFixed(1)}%
              </Text>

              <Text>
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
                  <Text color="cyan">Top hotspot details</Text>
                  {protein.hotspots.slice(0, 5).map((h, idx) => (
                    <Box key={`${protein.geneId}-${h.position}-${idx}`} flexDirection="row" gap={1}>
                      <Text color={h.fragility > 0.7 ? 'red' : h.fragility > 0.5 ? 'yellow' : 'green'}>
                        {fragilityBlock(h.fragility)} {h.position + 1}: {h.aa}
                      </Text>
                      <Text color="gray">
                        • {(h.fragility * 100).toFixed(1)}% {h.warnings.length ? `• ${h.warnings.join(',')}` : ''}
                      </Text>
                    </Box>
                  ))}
                </Box>
              )}

              <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
                {protein.residues.slice(0, 80).map((res) => (
                  <Text key={res.position} color={res.fragility > 0.7 ? 'red' : res.fragility > 0.5 ? 'yellow' : 'green'}>
                    {fragilityBlock(res.fragility)}
                  </Text>
                ))}
                {protein.residues.length > 80 && <Text color="gray"> …</Text>}
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
