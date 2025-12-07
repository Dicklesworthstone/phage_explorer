import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { KmerAnomalyOverlay } from '../overlay-computations';

interface GeneMapProps {
  width?: number;
}

export function GeneMap({ width = 80 }: GeneMapProps): React.ReactElement {
  const currentPhage = usePhageStore(s => s.currentPhage);
  const scrollPosition = usePhageStore(s => s.scrollPosition);
  const viewMode = usePhageStore(s => s.viewMode);
  const theme = usePhageStore(s => s.currentTheme);
  const kmerOverlay = usePhageStore(s => s.overlayData.kmerAnomaly) as KmerAnomalyOverlay | undefined;

  const colors = theme.colors;
  const genes = currentPhage?.genes ?? [];
  const genomeLength = currentPhage?.genomeLength ?? 1;

  // Map width for the gene bar (minus borders and labels)
  const barWidth = Math.max(1, width - 4);

  // Build the gene bar visualization
  const geneBar = useMemo(() => {
    if (genes.length === 0 || genomeLength === 0) {
      return { bar: '░'.repeat(barWidth), labels: '' };
    }

    // Create bar array
    const bar: string[] = Array(barWidth).fill('░');

    // Calculate current view position
    const effectivePos = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
    const viewPosInBar = Math.floor((effectivePos / genomeLength) * barWidth);

    // Mark genes
    for (const gene of genes) {
      const startPos = Math.floor((gene.startPos / genomeLength) * barWidth);
      const endPos = Math.floor((gene.endPos / genomeLength) * barWidth);

      for (let i = startPos; i <= endPos && i < barWidth; i++) {
        if (i >= 0) {
          bar[i] = '█';
        }
      }
    }

    // Mark current position
    if (viewPosInBar >= 0 && viewPosInBar < barWidth) {
      bar[viewPosInBar] = '▼';
    }

    // Generate labels for notable genes
    const labels: { pos: number; name: string }[] = [];
    const usedPositions = new Set<number>();

    for (const gene of genes) {
      if (!gene.name && !gene.locusTag) continue;

      const midPos = Math.floor(((gene.startPos + gene.endPos) / 2 / genomeLength) * barWidth);
      const name = gene.name || gene.locusTag || '';

      // Check if position is available (with some spacing)
      let available = true;
      for (let i = midPos - 3; i <= midPos + name.length + 3; i++) {
        if (usedPositions.has(i)) {
          available = false;
          break;
        }
      }

      if (available && labels.length < 10) {
        labels.push({ pos: midPos, name: name.substring(0, 8) });
        for (let i = midPos; i < midPos + name.length; i++) {
          usedPositions.add(i);
        }
      }
    }

    // Build labels string
    const labelsArr: string[] = Array(barWidth).fill(' ');
    for (const label of labels) {
      for (let i = 0; i < label.name.length && label.pos + i < barWidth; i++) {
        labelsArr[label.pos + i] = label.name[i];
      }
    }

    return {
      bar: bar.join(''),
      labels: labelsArr.join(''),
    };
  }, [genes, genomeLength, scrollPosition, viewMode, barWidth]);

  // K-mer anomaly strip aligned to genome
  const kmerStrip = useMemo(() => {
    if (!kmerOverlay || !kmerOverlay.values || kmerOverlay.values.length === 0 || genomeLength === 0) {
      return null;
    }
    const gradient = ' .:-=+*#%@';
    const values = kmerOverlay.values;
    const stripChars: string[] = Array(barWidth).fill(' ');

    for (let i = 0; i < barWidth; i++) {
      const pos = (i / barWidth) * genomeLength;
      const idx = Math.min(
        values.length - 1,
        Math.max(0, Math.floor((pos / genomeLength) * values.length))
      );
      const v = values[idx];
      const gIdx = Math.min(gradient.length - 1, Math.max(0, Math.round(v * (gradient.length - 1))));
      stripChars[i] = gradient[gIdx];
    }

    return stripChars.join('');
  }, [kmerOverlay, genomeLength, barWidth]);

  // Find current gene
  const currentGene = useMemo(() => {
    const effectivePos = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
    return genes.find(g => effectivePos >= g.startPos && effectivePos <= g.endPos);
  }, [genes, scrollPosition, viewMode]);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.border}
      paddingX={1}
    >
      {/* Gene bar */}
      <Box gap={1}>
        <Text color={colors.textDim}>Genes:</Text>
        <Text color={colors.accent}>{geneBar.bar}</Text>
      </Box>

      {/* K-mer anomaly strip */}
      {kmerStrip && (
        <Box gap={1}>
          <Text color={colors.textDim}>K-mer:</Text>
          <Text color={colors.warning}>{kmerStrip}</Text>
        </Box>
      )}

      {/* Gene labels */}
      <Box gap={1}>
        <Text color={colors.textDim}>      </Text>
        <Text color={colors.textDim} dimColor>{geneBar.labels}</Text>
      </Box>

      {/* Current gene info */}
      {currentGene && (
        <Box gap={1}>
          <Text color={colors.textDim}>Current:</Text>
          <Text color={colors.text} bold>
            {currentGene.name || currentGene.locusTag || 'Unknown'}
          </Text>
          <Text color={colors.textDim}>
            ({currentGene.startPos.toLocaleString()}-{currentGene.endPos.toLocaleString()})
          </Text>
          {currentGene.product && (
            <Text color={colors.textDim} dimColor>
              - {currentGene.product.substring(0, 40)}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
