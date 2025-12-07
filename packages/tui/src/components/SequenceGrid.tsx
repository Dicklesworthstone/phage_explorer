import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import {
  buildGrid,
  getNucleotideColor,
  getAminoAcidColor,
  type GridRow,
  type Theme,
} from '@phage-explorer/core';
import type { KmerAnomalyOverlay } from '../overlay-computations';

interface SequenceGridProps {
  sequence: string;
  width?: number;
  height?: number;
  genomeLength?: number;
  kmerOverlay?: KmerAnomalyOverlay | null;
}

// Group consecutive cells with same color for efficient rendering
interface ColorSegment {
  text: string;
  fg: string;
  bg: string;
}

function groupCellsByColor(
  row: GridRow,
  theme: Theme,
  viewMode: 'dna' | 'aa',
  diffEnabled: boolean
): ColorSegment[] {
  const segments: ColorSegment[] = [];
  let currentSegment: ColorSegment | null = null;

  for (const cell of row.cells) {
    const colorPair = viewMode === 'dna'
      ? getNucleotideColor(theme, cell.char)
      : getAminoAcidColor(theme, cell.char);

    // Modify colors for diff highlighting
    const fg = colorPair.fg;
    let bg = colorPair.bg;

    if (diffEnabled && cell.diff === 'different') {
      bg = theme.colors.diffHighlight;
    } else if (diffEnabled && cell.diff === 'same') {
      // Dim same bases
      bg = theme.colors.background;
    }

    // Check if we can extend current segment
    if (currentSegment && currentSegment.fg === fg && currentSegment.bg === bg) {
      currentSegment.text += cell.char;
    } else {
      if (currentSegment) {
        segments.push(currentSegment);
      }
      currentSegment = { text: cell.char, fg, bg };
    }
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments;
}

export function SequenceGrid({
  sequence,
  width = 60,
  height = 15,
  genomeLength,
  kmerOverlay = null,
}: SequenceGridProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const viewMode = usePhageStore(s => s.viewMode);
  const readingFrame = usePhageStore(s => s.readingFrame);
  const scrollPosition = usePhageStore(s => s.scrollPosition);
  const diffEnabled = usePhageStore(s => s.diffEnabled);

  // Build the grid based on current scroll position
  const grid = useMemo(() => {
    if (!sequence) return [];

    // Calculate effective start based on scroll position
    const effectiveCols = width;
    const effectiveRows = height;
    const charsPerScreen = effectiveCols * effectiveRows;

    // For AA mode, convert amino acid position to DNA position
    // Note: We don't add readingFrame here - buildGrid handles frame offset via translateSequence
    let startIndex = scrollPosition;
    if (viewMode === 'aa') {
      startIndex = scrollPosition * 3;
    }

    // Get the slice of sequence we need
    // For AA mode, add extra bases to account for reading frame offset and partial codons
    const sliceLength = viewMode === 'aa'
      ? charsPerScreen * 3 + readingFrame + 3
      : charsPerScreen;

    const seqSlice = sequence.substring(startIndex, startIndex + sliceLength);

    return buildGrid(seqSlice, startIndex, {
      viewportCols: effectiveCols,
      viewportRows: effectiveRows,
      mode: viewMode,
      frame: readingFrame,
    });
  }, [sequence, scrollPosition, viewMode, readingFrame, width, height]);

  // K-mer anomaly mini-strip aligned to current viewport
  const kmerStrip = useMemo(() => {
    if (!kmerOverlay || !kmerOverlay.values || kmerOverlay.values.length === 0 || !genomeLength) {
      return null;
    }

    // approximate visible base range
    const charsPerScreen = width * height;
    const startBase = viewMode === 'aa'
      ? scrollPosition * 3
      : scrollPosition;
    const endBase = Math.min(genomeLength, startBase + (viewMode === 'aa' ? charsPerScreen * 3 : charsPerScreen));

    const gradient = ' .:-=+*#%@';
    const strip: string[] = Array(width).fill(' ');

    for (let col = 0; col < width; col++) {
      const pos = startBase + (viewMode === 'aa' ? col * 3 : col);
      const idx = Math.min(
        kmerOverlay.values.length - 1,
        Math.max(0, Math.floor((pos / genomeLength) * kmerOverlay.values.length))
      );
      const v = kmerOverlay.values[idx] ?? 0; // Default to 0 if undefined
      const gIdx = Math.min(gradient.length - 1, Math.max(0, Math.round(v * (gradient.length - 1))));
      strip[col] = gradient[gIdx];
    }

    const coverage = ((endBase - startBase) / genomeLength) * 100;
    return { strip: strip.join(''), coverage };
  }, [kmerOverlay, genomeLength, viewMode, scrollPosition, width, height]);

  const colors = theme.colors;

  // Calculate position info
  const totalLength = sequence?.length ?? 0;
  const effectiveLength = viewMode === 'aa' ? Math.floor(totalLength / 3) : totalLength;
  const positionPercent = effectiveLength > 0
    ? ((scrollPosition / effectiveLength) * 100).toFixed(1)
    : '0.0';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      width={width + 2}
    >
      {/* Title bar with better styling */}
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text color={colors.primary} bold>◉</Text>
          <Text color={colors.primary} bold>
            {viewMode === 'dna' ? 'DNA Sequence' : 'Amino Acids'}
          </Text>
          {viewMode === 'aa' && (
            <Text color={colors.accent}>(Frame {readingFrame + 1})</Text>
          )}
        </Box>
        <Box gap={1}>
          <Text color={colors.textMuted}>
            {scrollPosition.toLocaleString()}
          </Text>
          <Text color={colors.textMuted}>/</Text>
          <Text color={colors.text}>
            {effectiveLength.toLocaleString()}
          </Text>
          <Text color={colors.accent}>({positionPercent}%)</Text>
        </Box>
      </Box>

      {/* Sequence grid */}
      <Box flexDirection="column" paddingX={0}>
        {grid.length === 0 ? (
          <Box height={height} alignItems="center" justifyContent="center">
            <Text color={colors.textDim}>No sequence data</Text>
          </Box>
        ) : (
          grid.map((row, rowIdx) => {
            const segments = groupCellsByColor(row, theme, viewMode, diffEnabled);

            return (
              <Box key={rowIdx}>
                {segments.map((seg, segIdx) => (
                  <Text
                    key={segIdx}
                    color={seg.fg}
                    backgroundColor={seg.bg}
                  >
                    {seg.text}
                  </Text>
                ))}
                {/* Pad row to full width */}
                {row.cells.length < width && width > 0 && (
                  <Text>{' '.repeat(Math.max(0, width - row.cells.length))}</Text>
                )}
              </Box>
            );
          })
        )}

        {/* Pad with empty rows if needed */}
        {grid.length < height && width > 0 && (
          Array(height - grid.length).fill(0).map((_, i) => (
            <Text key={`empty-${i}`}>{' '.repeat(Math.max(0, width))}</Text>
          ))
        )}

        {/* K-mer anomaly inline strip */}
        {kmerStrip && (
          <Box>
            <Text color={colors.textDim}>K-mer </Text>
            <Text color={colors.warning}>{kmerStrip.strip}</Text>
            <Text color={colors.textDim}> · {kmerStrip.coverage.toFixed(1)}% of genome window</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}