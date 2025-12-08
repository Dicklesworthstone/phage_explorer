import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { computeHilbertGC } from '@phage-explorer/core';

// Gradient for GC content (Blue -> White -> Red)
// 0.0 (AT-rich) -> 0.5 (Balanced) -> 1.0 (GC-rich)
const GRADIENT = ['🟦', '🔵', '⬜', '🟠', '🟥']; // Simplified emojis for terminal
// Or block characters with colors
const BLOCKS = ['░', '▒', '▓', '█'];

export function HilbertView({ sequence }: { sequence: string }): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  const [order, setOrder] = useState(6); // Start with 64x64 grid

  useInput((input, key) => {
    if (input === '+' || input === '=') setOrder(o => Math.min(o + 1, 8));
    if (input === '-') setOrder(o => Math.max(o - 1, 4));
  });

  const { grid, size } = useMemo(() => {
    return computeHilbertGC(sequence, order);
  }, [sequence, order]);

  // Render grid
  // Terminal pixels are non-square (roughly 1x2 chars).
  // We can use ▀ (upper block) and ▄ (lower block) to pack 2 vertical pixels per char.
  
  const renderWidth = size;
  const renderHeight = Math.ceil(size / 2);
  
  const rows: React.ReactElement[] = [];
  
  for (let y = 0; y < renderHeight; y++) {
    const cells: React.ReactElement[] = [];
    for (let x = 0; x < renderWidth; x++) {
      const idx1 = (y * 2) * size + x;
      const idx2 = (y * 2 + 1) * size + x;
      
      const val1 = grid[idx1];
      const val2 = idx2 < grid.length ? grid[idx2] : -1;
      
      // Determine colors
      const getColor = (v: number) => {
        if (v === -1) return colors.background;
        // Map 0-1 to Low-High gradient
        if (v < 0.4) return colors.gradientLow; // AT-rich
        if (v > 0.6) return colors.gradientHigh; // GC-rich
        return colors.textDim; // Balanced
      };
      
      const c1 = getColor(val1);
      const c2 = getColor(val2);
      
      cells.push(
        <Text key={x} color={c1} backgroundColor={c2}>
          ▀
        </Text>
      );
    }
    rows.push(<Box key={y}>{cells}</Box>);
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.border} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={colors.accent} bold>HILBERT ATLAS (GC)</Text>
        <Text color={colors.textDim}>Order: {order} ({size}x{size})</Text>
      </Box>
      
      <Box flexDirection="column" marginY={1}>
        {rows}
      </Box>
      
      <Box justifyContent="space-between">
        <Text color={colors.gradientLow}>■ AT-rich</Text>
        <Text color={colors.textDim}>■ Balanced</Text>
        <Text color={colors.gradientHigh}>■ GC-rich</Text>
      </Box>
      
      <Text color={colors.textDim} dimColor>
        [+/-] Change Resolution
      </Text>
    </Box>
  );
}
