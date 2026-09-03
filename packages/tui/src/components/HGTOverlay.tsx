import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useOverlayWidth } from './terminal-size';
import { usePhageStore } from '@phage-explorer/state';
import type { HGTAnalysis, PassportStamp } from '@phage-explorer/comparison';

function islandBar(stamps: PassportStamp[], genomeLength: number, width: number) {
  const bar = Array(width).fill('░');
  for (const stamp of stamps) {
    const start = Math.floor((stamp.island.start / genomeLength) * width);
    const end = Math.max(start, Math.floor((stamp.island.end / genomeLength) * width));
    const symbol = stamp.amelioration === 'recent' ? '█' : stamp.amelioration === 'intermediate' ? '▓' : '▒';
    for (let i = start; i <= end && i < width; i++) {
      bar[i] = symbol;
    }
  }
  return bar.join('');
}

export function HGTOverlay(): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const overlayData = usePhageStore(s => s.overlayData.hgt) as HGTAnalysis | undefined;
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const phage = usePhageStore(s => s.currentPhage);
  const colors = theme.colors;

  useInput((input, key) => {
    if (key.escape || input === 'h' || input === 'H') {
      closeOverlay('hgt');
    }
  });

  const summary = useMemo(() => {
    if (!overlayData) return null;
    const recent = overlayData.stamps.filter(s => s.amelioration === 'recent').length;
    const intermediate = overlayData.stamps.filter(s => s.amelioration === 'intermediate').length;
    const ancient = overlayData.stamps.filter(s => s.amelioration === 'ancient').length;
    return { recent, intermediate, ancient };
  }, [overlayData]);

  if (!overlayData || !phage) {
    return (
      <Box borderStyle="double" borderColor={colors.accent} paddingX={2} paddingY={1}>
        <Text color={colors.textDim}>No HGT analysis available</Text>
      </Box>
    );
  }

  const genomeLength = phage.genomeLength ?? Math.max(1, ...overlayData.islands.map(i => i.end));

  const bar = islandBar(overlayData.stamps, genomeLength, 60);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={useOverlayWidth(84)}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>HGT PASSPORT — {phage.name}</Text>
        <Text color={colors.textDim}>Esc/H to close</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={colors.textDim}>Genome GC {overlayData.genomeGC.toFixed(1)}%</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.textDim}>Islands</Text>
        <Text color={colors.warning}>{bar}</Text>
        <Text color={colors.textDim} dimColor>█ recent ▓ intermediate ▒ ancient</Text>
      </Box>

      {summary && (
        <Box gap={2} marginBottom={1}>
          <Text color={colors.text}>Recent: {summary.recent}</Text>
          <Text color={colors.text}>Intermediate: {summary.intermediate}</Text>
          <Text color={colors.text}>Ancient: {summary.ancient}</Text>
        </Box>
      )}

      <Box flexDirection="column">
        {overlayData.stamps.slice(0, 4).map((s, idx) => {
          if (!s || !s.island) return null;
          return (
            <Box key={idx} flexDirection="column" marginBottom={1}>
              <Text color={colors.accent} bold>
                [{idx + 1}] {s.island.start.toLocaleString()}–{s.island.end.toLocaleString()} bp · ΔGC {s.gcDelta.toFixed(1)}%
              </Text>
              <Text color={colors.textDim}>
                Amelioration: {s.amelioration}
                {s.donor ? ` · Donor: ${s.donor.taxon} (${(s.donor.similarity * 100).toFixed(1)}%)` : ' · Donor: unknown'}
              </Text>
              {s.hallmarks?.length ? (
                <Text color={colors.textDim} dimColor>Hallmarks: {s.hallmarks.join(', ')}</Text>
              ) : null}
            </Box>
          );
        })}
        {overlayData.stamps.length > 4 && (
          <Text color={colors.textDim}>…{overlayData.stamps.length - 4} more islands</Text>
        )}
      </Box>
    </Box>
  );
}
