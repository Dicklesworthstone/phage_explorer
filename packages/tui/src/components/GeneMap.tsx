import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { KmerAnomalyOverlay } from '../overlay-computations';

interface GeneMapProps {
  width?: number;
  showDensityHistogram?: boolean;
  showStrandLabels?: boolean;
}

// Characters for gene visualization
const GENE_CHARS = {
  forward: '▶',      // Forward strand gene marker
  reverse: '◀',      // Reverse strand gene marker
  both: '◆',         // Overlapping genes
  empty: '·',        // Empty region (subtle dot)
  current: '▼',      // Current position marker
  boundary: '│',     // Gene boundary
  forwardBar: '▀',   // Top half block for + strand
  reverseBar: '▄',   // Bottom half block for - strand
  bothBar: '█',      // Full block for both strands
} as const;

// Strand labels and decorations
const STRAND_CHARS = {
  plus: '+',
  minus: '−',
  arrow5: '5′',
  arrow3: '3′',
  leftBracket: '⟨',
  rightBracket: '⟩',
} as const;

// Histogram characters (8 levels for gene density)
const HISTOGRAM_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// K-mer gradient characters (5 levels)
const KMER_GRADIENT = ' ░▒▓█';

export function GeneMap({
  width = 80,
  showDensityHistogram = true,
  showStrandLabels = true,
}: GeneMapProps): React.ReactElement {
  const currentPhage = usePhageStore(s => s.currentPhage);
  const scrollPosition = usePhageStore(s => s.scrollPosition);
  const viewMode = usePhageStore(s => s.viewMode);
  const theme = usePhageStore(s => s.currentTheme);
  const kmerOverlay = usePhageStore(s => s.overlayData.kmerAnomaly) as KmerAnomalyOverlay | undefined;

  const colors = theme.colors;
  const genes = currentPhage?.genes ?? [];
  const genomeLength = currentPhage?.genomeLength ?? 1;

  // Map width for the gene bar (minus borders and labels)
  const barWidth = Math.max(1, width - 10);

  // Build the gene bar visualization with strand information
  const geneBar = useMemo(() => {
    if (genes.length === 0 || genomeLength === 0) {
      return {
        chars: Array(barWidth).fill(GENE_CHARS.empty),
        colors: Array(barWidth).fill(colors.textMuted),
        labels: '',
      };
    }

    // Create arrays for characters and colors
    const barChars: string[] = Array(barWidth).fill(GENE_CHARS.empty);
    const barColors: string[] = Array(barWidth).fill(colors.textMuted);

    // Track gene density per pixel for overlap detection
    const density: { forward: number; reverse: number }[] =
      Array(barWidth).fill(null).map(() => ({ forward: 0, reverse: 0 }));

    // Calculate current view position
    const effectivePos = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
    const viewPosInBar = Math.floor((effectivePos / genomeLength) * barWidth);

    // Mark genes with strand information
    for (const gene of genes) {
      const startPos = Math.floor((gene.startPos / genomeLength) * barWidth);
      const endPos = Math.max(startPos + 1, Math.floor((gene.endPos / genomeLength) * barWidth));
      const isForward = gene.strand !== '-';

      for (let i = startPos; i < endPos && i < barWidth; i++) {
        if (i >= 0) {
          if (isForward) {
            density[i].forward++;
          } else {
            density[i].reverse++;
          }
        }
      }
    }

    // Convert density to characters and colors
    for (let i = 0; i < barWidth; i++) {
      const d = density[i];
      if (d.forward > 0 && d.reverse > 0) {
        // Overlapping genes from both strands
        barChars[i] = GENE_CHARS.both;
        barColors[i] = colors.warning;
      } else if (d.forward > 0) {
        // Forward strand only
        barChars[i] = d.forward > 1 ? '▓' : '█';
        barColors[i] = colors.geneForward;
      } else if (d.reverse > 0) {
        // Reverse strand only
        barChars[i] = d.reverse > 1 ? '▓' : '█';
        barColors[i] = colors.geneReverse;
      }
    }

    // Mark current position (overwrites gene marker)
    if (viewPosInBar >= 0 && viewPosInBar < barWidth) {
      barChars[viewPosInBar] = GENE_CHARS.current;
      barColors[viewPosInBar] = colors.highlight;
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
      chars: barChars,
      colors: barColors,
      labels: labelsArr.join(''),
    };
  }, [genes, genomeLength, scrollPosition, viewMode, barWidth, colors]);

  // K-mer anomaly strip with gradient coloring
  const kmerStrip = useMemo(() => {
    if (!kmerOverlay || !kmerOverlay.values || kmerOverlay.values.length === 0 || genomeLength === 0) {
      return null;
    }

    const values = kmerOverlay.values;
    const chars: string[] = Array(barWidth).fill(' ');
    const stripColors: string[] = Array(barWidth).fill(colors.textMuted);

    for (let i = 0; i < barWidth; i++) {
      const pos = (i / barWidth) * genomeLength;
      const idx = Math.min(
        values.length - 1,
        Math.max(0, Math.floor((pos / genomeLength) * values.length))
      );
      const v = values[idx];

      // Use gradient character
      const gIdx = Math.min(KMER_GRADIENT.length - 1, Math.max(0, Math.round(v * (KMER_GRADIENT.length - 1))));
      chars[i] = KMER_GRADIENT[gIdx];

      // Color based on anomaly level
      if (v > 0.7) {
        stripColors[i] = colors.kmerAnomaly;
      } else if (v > 0.4) {
        stripColors[i] = colors.warning;
      } else {
        stripColors[i] = colors.kmerNormal;
      }
    }

    return { chars, colors: stripColors };
  }, [kmerOverlay, genomeLength, barWidth, colors]);

  // Find current gene
  const currentGene = useMemo(() => {
    const effectivePos = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
    return genes.find(g => effectivePos >= g.startPos && effectivePos < g.endPos);
  }, [genes, scrollPosition, viewMode]);

  // Calculate position percentage
  const effectivePos = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
  const posPercent = genomeLength > 0 ? ((effectivePos / genomeLength) * 100).toFixed(1) : '0.0';

  // Gene density histogram - shows overall gene density across genome
  const densityHistogram = useMemo(() => {
    if (!showDensityHistogram || genes.length === 0 || genomeLength === 0) {
      return null;
    }

    // Calculate density at each position
    const density: number[] = Array(barWidth).fill(0);
    for (const gene of genes) {
      const startPos = Math.floor((gene.startPos / genomeLength) * barWidth);
      const endPos = Math.max(startPos + 1, Math.floor((gene.endPos / genomeLength) * barWidth));
      for (let i = startPos; i < endPos && i < barWidth; i++) {
        if (i >= 0) density[i]++;
      }
    }

    // Find max density for normalization
    const maxDensity = Math.max(...density, 1);

    // Generate histogram characters
    const chars = density.map(d => {
      const norm = d / maxDensity;
      const idx = Math.min(HISTOGRAM_CHARS.length - 1, Math.floor(norm * HISTOGRAM_CHARS.length));
      return HISTOGRAM_CHARS[idx];
    });

    return chars;
  }, [showDensityHistogram, genes, genomeLength, barWidth]);

  // Strand counts for labels
  const strandCounts = useMemo(() => {
    let forward = 0;
    let reverse = 0;
    for (const gene of genes) {
      if (gene.strand === '-') {
        reverse++;
      } else {
        // Count null/undefined as forward (default)
        forward++;
      }
    }
    return { forward, reverse };
  }, [genes]);

  // Get enhanced colors from theme
  const glowColor = colors.glow ?? colors.primary;
  const separatorColor = colors.separator ?? colors.textMuted;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      paddingX={1}
    >
      {/* Title row with enhanced position info and strand counts */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={glowColor} bold>◉</Text>
          <Text color={colors.primary} bold>Gene Map</Text>
          <Text color={separatorColor}>│</Text>
          {showStrandLabels && (
            <>
              <Text color={colors.geneForward}>█{STRAND_CHARS.plus}</Text>
              <Text color={colors.textDim}>({strandCounts.forward})</Text>
              <Text color={separatorColor}>·</Text>
              <Text color={colors.geneReverse}>█{STRAND_CHARS.minus}</Text>
              <Text color={colors.textDim}>({strandCounts.reverse})</Text>
              <Text color={separatorColor}>·</Text>
              <Text color={colors.warning}>◆</Text>
              <Text color={colors.textDim}>overlap</Text>
            </>
          )}
        </Box>
        <Box gap={1}>
          <Text color={colors.textMuted}>{STRAND_CHARS.leftBracket}</Text>
          <Text color={colors.accent} bold>
            {effectivePos.toLocaleString()}
          </Text>
          <Text color={colors.textMuted}>/</Text>
          <Text color={colors.text}>
            {genomeLength.toLocaleString()}
          </Text>
          <Text color={colors.textMuted}>{STRAND_CHARS.rightBracket}</Text>
          <Text color={colors.success}>{posPercent}%</Text>
        </Box>
      </Box>

      {/* Forward strand indicator line */}
      {showStrandLabels && (
        <Box gap={1}>
          <Text color={colors.geneForward}>{STRAND_CHARS.arrow5}→</Text>
          <Text color={colors.textMuted}>{'─'.repeat(barWidth - 4)}</Text>
          <Text color={colors.geneForward}>→{STRAND_CHARS.arrow3}</Text>
        </Box>
      )}

      {/* Gene bar with individual character coloring */}
      <Box gap={1}>
        <Text color={colors.textDim}>Genes </Text>
        <Box>
          {geneBar.chars.map((char, i) => (
            <Text key={i} color={geneBar.colors[i]}>{char}</Text>
          ))}
        </Box>
      </Box>

      {/* Density histogram */}
      {densityHistogram && (
        <Box gap={1}>
          <Text color={colors.textDim}>Dens. </Text>
          <Box>
            {densityHistogram.map((char, i) => (
              <Text key={i} color={colors.info}>{char}</Text>
            ))}
          </Box>
        </Box>
      )}

      {/* K-mer anomaly strip */}
      {kmerStrip && (
        <Box gap={1}>
          <Text color={colors.textDim}>K-mer </Text>
          <Box>
            {kmerStrip.chars.map((char, i) => (
              <Text key={i} color={kmerStrip.colors[i]}>{char}</Text>
            ))}
          </Box>
        </Box>
      )}

      {/* Reverse strand indicator line */}
      {showStrandLabels && (
        <Box gap={1}>
          <Text color={colors.geneReverse}>{STRAND_CHARS.arrow3}←</Text>
          <Text color={colors.textMuted}>{'─'.repeat(barWidth - 4)}</Text>
          <Text color={colors.geneReverse}>←{STRAND_CHARS.arrow5}</Text>
        </Box>
      )}

      {/* Gene labels */}
      <Box gap={1}>
        <Text color={colors.textDim}>{'      '}</Text>
        <Text color={colors.textMuted}>{geneBar.labels}</Text>
      </Box>

      {/* Current gene info with enhanced styling */}
      {currentGene && (
        <Box gap={1} marginTop={0}>
          <Text color={colors.info}>▶</Text>
          <Text color={colors.text} bold>
            {currentGene.name || currentGene.locusTag || 'Unknown'}
          </Text>
          <Text color={separatorColor}>│</Text>
          <Text color={colors.textDim}>
            {currentGene.startPos.toLocaleString()}-{currentGene.endPos.toLocaleString()} bp
          </Text>
          <Text color={currentGene.strand !== '-'
            ? colors.geneForward : colors.geneReverse}>
            ({currentGene.strand !== '-' ? '+' : '-'})
          </Text>
          {currentGene.product && (
            <>
              <Text color={colors.textMuted}>│</Text>
              <Text color={colors.textDim}>
                {currentGene.product.substring(0, 50)}{currentGene.product.length > 50 ? '…' : ''}
              </Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}
