import React from 'react';
import { Box, Text } from 'ink';
import type { StructuralConstraintReport } from '@phage-explorer/core';

interface Props {
  data: StructuralConstraintReport | null;
}

const blocks = ['░', '▒', '▓', '█'] as const;

function fragilityBlock(score: number): string {
  if (score >= 0.8) return blocks[3];
  if (score >= 0.6) return blocks[2];
  if (score >= 0.4) return blocks[1];
  return blocks[0];
}

export function StructureConstraintOverlay({ data }: Props): React.ReactElement {
  if (!data || data.proteins.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1} width={70}>
        <Text color="cyan" bold>
          Structure-Informed Constraint Scanner
        </Text>
        <Text color="gray">No capsid/tail proteins detected for this phage.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1} width={86}>
      <Text color="cyan" bold>
        Structure-Informed Constraint Scanner
      </Text>
      <Text color="gray">Fragility: ░ robust → █ fragile</Text>

      {data.proteins.map((protein) => (
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
                      `${h.position + 1}${fragilityBlock(h.fragility)}${h.warnings.length ? `(${h.warnings.join(',')})` : ''}`
                  )
                  .join('  ')}
          </Text>

          <Box flexDirection="row" flexWrap="wrap">
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
  );
}
