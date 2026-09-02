import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { OverlayProvenance } from './OverlayProvenance';
import { usePhageStore } from '@phage-explorer/state';
import { analyzeCRISPRPressure } from '@phage-explorer/core';
import type { CRISPRAnalysisResult, GeneInfo } from '@phage-explorer/core';

interface CRISPROverlayProps {
  sequence: string;
  genes: GeneInfo[];
  /**
   * The phage's real host, so the overlay can name whose spacer data is
   * missing instead of showing an empty list that reads as a measured absence.
   */
  host?: string;
}

export function CRISPROverlay({ sequence, genes, host }: CRISPROverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const colors = theme.colors;

  // Run analysis (memoized)
  const analysis = useMemo<CRISPRAnalysisResult | null>(() => {
    if (!sequence) return null;
    // No `spacers`: the catalogue has no spacer data for any of its hosts.
    // Measured, not assumed -- see the header of packages/core/src/crispr.ts.
    return analyzeCRISPRPressure(sequence, genes, { host });
  }, [sequence, genes, host]);

  const [hotspotIndex, setHotspotIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === 'i' || input === 'I') {
        closeOverlay('crispr');
    }
    if (key.rightArrow) {
        setHotspotIndex(prev => Math.min(prev + 1, (analysis?.acrCandidates.length ?? 0) - 1));
    }
    if (key.leftArrow) {
        setHotspotIndex(prev => Math.max(prev - 1, 0));
    }
  });

  if (!analysis) return <Text>Loading analysis...</Text>;

  const { pressureWindows, spacerHits, acrCandidates, maxPressure, noSpacerDataFor } = analysis;

  // Render Pressure Bar
  // Map 0-10 pressure to characters: ' ', '░', '▒', '▓', '█'
  const renderPressureBar = () => {
    const chars = [' ', '░', '▒', '▓', '█'];
    return pressureWindows.map(w => {
      const level = Math.min(4, Math.floor((w.pressureIndex / 10) * 4));
      return chars[level];
    }).join('').slice(0, 60); // Clamp width
  };

  const selectedAcr = acrCandidates[hotspotIndex];

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={74}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>CRISPR PRESSURE & ANTI-CRISPR (I KEY)</Text>
        <Text color={colors.textDim}>ESC to close</Text>
      </Box>

      <Box marginBottom={1}>
        <OverlayProvenance level="heuristic" source="Acr prediction from gene size and net charge" />
      </Box>

      {/* Pressure Map */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.text}>CRISPR Pressure Map (Genome-wide)</Text>
        <Text color={colors.error}>{renderPressureBar()}</Text>
        <Box justifyContent="space-between">
            <Text color={colors.textDim}>Start</Text>
            <Text color={colors.textDim}>End</Text>
        </Box>
      </Box>

      {/* Stats */}
      <Box marginBottom={1}>
        <Text color={colors.text}>
          Max Pressure: <Text color={colors.error} bold>{maxPressure.toFixed(1)}</Text> | 
          Spacer Hits: <Text color={colors.warning} bold>{spacerHits.length}</Text> | 
          Acr Candidates: <Text color={colors.success} bold>{acrCandidates.length}</Text>
        </Text>
      </Box>

      {/* Acr Candidates / Hotspots */}
      <Box flexDirection="column">
        <Text bold color={colors.success} underline>Top Anti-CRISPR Candidates (Use ←/→)</Text>
        {acrCandidates.length === 0 ? (
          <Text color={colors.textDim}>No strong Acr candidates found.</Text>
        ) : selectedAcr ? (
          <Box flexDirection="column" borderStyle="single" borderColor={colors.success} paddingX={1}>
            <Text color={colors.success}>
              ★ Gene: {selectedAcr.geneName} (ID: {selectedAcr.geneId})
            </Text>
            <Text>
              Confidence: {selectedAcr.confidence.toUpperCase()} | Score: {selectedAcr.score}
            </Text>
            <Text>
              Family: {selectedAcr.family}
            </Text>
          </Box>
        ) : null}
      </Box>

      {/* No spacer data: say so rather than showing an empty list.

          The web overlay carries the full explanation; the TUI has one line of
          room, so it states the fact and names the host. An empty list with no
          note reads as "this phage escapes CRISPR targeting", which is a
          finding, and there is no finding here. */}
      {noSpacerDataFor && (
        <Box marginTop={1}>
          <Text color={colors.warning}>
            No CRISPR spacer data for {noSpacerDataFor} — nothing was searched, so the
            counts above are not a measured absence. Acr candidates are unaffected.
          </Text>
        </Box>
      )}

      {/* Spacer Hits Preview */}
      {spacerHits.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
             <Text bold color={colors.warning} underline>Recent Spacer Hits</Text>
             {spacerHits.slice(0, 3).map((hit, i) => (
                 <Text key={i} color={colors.textDim}>
                     Pos {hit.position}: {hit.host} ({hit.crisprType}) - PAM: {hit.pamStatus}
                 </Text>
             ))}
        </Box>
      )}
    </Box>
  );
}
