import React, { useMemo, memo } from 'react';
import { Box, Text } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import {
  buildGrid,
  applyDiff,
  type GridRow,
  type Theme,
  type ViewMode,
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

type ColorLookup = Record<string, { fg: string; bg: string }>;

function buildColorLookup(colors: Record<string, { fg: string; bg: string }>): ColorLookup {
  const lookup: ColorLookup = {};
  for (const [key, value] of Object.entries(colors)) {
    lookup[key] = value;
    lookup[key.toLowerCase()] = value;
  }
  return lookup;
}

function groupCellsByColor(
  row: GridRow,
  theme: Theme,
  viewMode: ViewMode,
  diffEnabled: boolean,
  nucleotideColors: ColorLookup,
  aminoColors: ColorLookup
): ColorSegment[] {
  const segments: ColorSegment[] = [];
  let currentSegment: ColorSegment | null = null;

  // Determine row type for coloring
  // In dual mode, rows have explicit types. In simple modes, infer from viewMode.
  const isAminoRow = row.type === 'aa' || (!row.type && viewMode === 'aa');

  for (const cell of row.cells) {
    // In dual mode, use nucleotide coloring for the primary display
    const colorPair = isAminoRow
      ? (aminoColors[cell.char] ?? theme.aminoAcids['*'])
      : (nucleotideColors[cell.char] ?? theme.nucleotides['N']);

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

function groupStringByColor(
  text: string,
  nucleotideColors: ColorLookup,
  fallback: { fg: string; bg: string }
): ColorSegment[] {
  const segments: ColorSegment[] = [];
  let current: ColorSegment | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const colors = nucleotideColors[ch] ?? fallback;
    if (current && current.fg === colors.fg && current.bg === colors.bg) {
      current.text += ch;
    } else {
      if (current) segments.push(current);
      current = { text: ch, fg: colors.fg, bg: colors.bg };
    }
  }

  if (current) segments.push(current);
  return segments;
}

// Memoized row component - only re-renders when row data changes
interface SequenceRowProps {
  row: GridRow;
  theme: Theme;
  viewMode: ViewMode;
  diffEnabled: boolean;
  width: number;
  nucleotideColors: ColorLookup;
  aminoColors: ColorLookup;
}

const SequenceRow = memo(function SequenceRow({
  row,
  theme,
  viewMode,
  diffEnabled,
  width,
  nucleotideColors,
  aminoColors,
}: SequenceRowProps): React.ReactElement {
  // Memoize segment grouping per row
  const segments = useMemo(
    () => groupCellsByColor(row, theme, viewMode, diffEnabled, nucleotideColors, aminoColors),
    [row, theme, viewMode, diffEnabled, nucleotideColors, aminoColors]
  );

  return (
    <Box>
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
});

interface SequenceRowFastProps {
  text: string;
  width: number;
  nucleotideColors: ColorLookup;
  fallback: { fg: string; bg: string };
}

const SequenceRowFast = memo(function SequenceRowFast({
  text,
  width,
  nucleotideColors,
  fallback,
}: SequenceRowFastProps): React.ReactElement {
  const segments = useMemo(
    () => groupStringByColor(text, nucleotideColors, fallback),
    [text, nucleotideColors, fallback]
  );

  return (
    <Box>
      {segments.map((seg, segIdx) => (
        <Text key={segIdx} color={seg.fg} backgroundColor={seg.bg}>
          {seg.text}
        </Text>
      ))}
      {text.length < width && width > 0 && (
        <Text>{' '.repeat(Math.max(0, width - text.length))}</Text>
      )}
    </Box>
  );
});

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
  const diffReferenceSequence = usePhageStore(s => s.diffReferenceSequence);
  const nucleotideColors = useMemo(() => buildColorLookup(theme.nucleotides), [theme]);
  const aminoColors = useMemo(() => buildColorLookup(theme.aminoAcids), [theme]);
  const fallbackNucleotide = theme.nucleotides['N'];

  const fastRows = useMemo(() => {
    if (!sequence || viewMode !== 'dna' || diffEnabled) return null;
    const rows: string[] = [];
    const startIndex = scrollPosition;
    for (let row = 0; row < height; row++) {
      const rowStart = startIndex + row * width;
      if (rowStart >= sequence.length) break;
      rows.push(sequence.substring(rowStart, rowStart + width));
    }
    return rows;
  }, [sequence, viewMode, diffEnabled, scrollPosition, width, height]);

  // Build the grid based on current scroll position
  const grid = useMemo(() => {
    if (!sequence) return [];
    if (viewMode === 'dna' && !diffEnabled) {
      return [];
    }

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
    const frameOffset = readingFrame >= 0 ? readingFrame : Math.abs(readingFrame) - 1;
    // For AA mode, add extra bases to account for frame offset and partial codons
    const sliceLength = viewMode === 'aa'
      ? charsPerScreen * 3 + frameOffset + 3
      : charsPerScreen;

    const seqSlice = sequence.substring(startIndex, startIndex + sliceLength);

    // Get the character before the slice for correct codon translation at the boundary
    const contextBefore = startIndex > 0 ? sequence[startIndex - 1] : undefined;

    const baseGrid = buildGrid(seqSlice, startIndex, {
      viewportCols: effectiveCols,
      viewportRows: effectiveRows,
      mode: viewMode,
      frame: readingFrame,
      totalLength: genomeLength,
      contextBefore,
    });

    if (diffEnabled && diffReferenceSequence) {
      const refSlice = diffReferenceSequence.substring(startIndex, startIndex + sliceLength);
      const totalLen = genomeLength != null && genomeLength > 0 ? genomeLength : sequence.length;
      return applyDiff(baseGrid, refSlice, viewMode, readingFrame, startIndex, totalLen);
    }

    return baseGrid;
  }, [sequence, scrollPosition, viewMode, readingFrame, width, height, genomeLength, diffEnabled, diffReferenceSequence]);

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
  const renderedRowCount = fastRows ? fastRows.length : grid.length;

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
            <Text color={colors.accent}>
              {readingFrame >= 0 ? `(Frame ${readingFrame + 1})` : `(Rev Frame ${Math.abs(readingFrame)})`}
            </Text>
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
        {fastRows ? (
          fastRows.map((rowText, rowIdx) => (
            <SequenceRowFast
              key={rowIdx}
              text={rowText}
              width={width}
              nucleotideColors={nucleotideColors}
              fallback={fallbackNucleotide}
            />
          ))
        ) : grid.length === 0 ? (
          <Box height={height} alignItems="center" justifyContent="center">
            <Text color={colors.textDim}>No sequence data</Text>
          </Box>
        ) : (
          grid.map((row, rowIdx) => (
            <SequenceRow
              key={rowIdx}
              row={row}
              theme={theme}
              viewMode={viewMode}
              diffEnabled={diffEnabled}
              width={width}
              nucleotideColors={nucleotideColors}
              aminoColors={aminoColors}
            />
          ))
        )}

        {/* Pad with empty rows if needed */}
        {renderedRowCount < height && width > 0 && (
          Array(height - renderedRowCount).fill(0).map((_, i) => (
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
