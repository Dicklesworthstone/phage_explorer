import React from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { TropismAnalysis, ReceptorCandidate } from '@phage-explorer/comparison';

function ConfidenceBar({ value, width = 10, color }: { value: number; width?: number; color: string }) {
  const filled = Math.round(value * width);
  const empty = width - filled;
  return (
    <Text color={color}>
      {'█'.repeat(filled)}
      {'░'.repeat(Math.max(0, empty))}
      {` ${(value * 100).toFixed(0)}%`}
    </Text>
  );
}

export function TropismOverlay(): React.ReactElement {
  const colors = usePhageStore(s => s.currentTheme.colors);
  const overlayData = usePhageStore(s => s.overlayData);
  const phage = usePhageStore(s => s.currentPhage);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const data = overlayData.tropism as TropismAnalysis | undefined;

  useInput((input, key) => {
    if (key.escape || input === 'e' || input === 'E') {
      closeOverlay('tropism');
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.borderFocus}
      paddingX={2}
      paddingY={1}
      width={80}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.primary} bold>
          ◉ Tail Fiber Tropism & Receptor Atlas
        </Text>
        <Text color={colors.textMuted}>E / ESC to close</Text>
      </Box>

      {!data || data.hits.length === 0 ? (
        <Text color={colors.textMuted}>
          {phage ? `No tail fiber annotations found for ${phage.name}.` : 'No phage loaded.'}
        </Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Text color={colors.accent} bold>
              Breadth:{' '}
            </Text>
            <Text color={colors.text}>
              {data.breadth === 'narrow'
                ? 'NARROW (single primary receptor)'
                : data.breadth === 'multi-receptor'
                  ? 'BROAD (multiple receptor cues)'
                  : 'UNKNOWN'}
            </Text>
          </Box>

          <Box flexDirection="column" gap={1}>
            {data.hits.map(hit => (
              <Box key={hit.gene.id} flexDirection="column" borderStyle="classic" borderColor={colors.borderLight} padding={1}>
                <Box justifyContent="space-between">
                  <Text color={colors.primary} bold>
                    {hit.gene.name ?? hit.gene.locusTag ?? 'Tail fiber'}
                  </Text>
                  <Text color={colors.textDim}>
                    {hit.gene.startPos}–{hit.gene.endPos} ({hit.gene.strand ?? '?'} strand)
                  </Text>
                </Box>
                <Text color={colors.textMuted}>{hit.gene.product ?? 'Unnamed receptor-binding protein'}</Text>

                {hit.receptorCandidates.length === 0 ? (
                  <Text color={colors.textMuted}>No receptor hints in annotation.</Text>
                ) : (
                  hit.receptorCandidates.map((rc: ReceptorCandidate) => (
                    <Box key={rc.receptor} gap={2}>
                      <Text color={colors.success} bold>
                        {rc.receptor}
                      </Text>
                      <ConfidenceBar value={rc.confidence} color={colors.info} />
                      <Text color={colors.textMuted}>
                        Evidence: {rc.evidence.join(', ')}
                      </Text>
                    </Box>
                  ))
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
