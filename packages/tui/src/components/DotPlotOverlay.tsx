import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { computeDotPlot } from '@phage-explorer/core';

interface DotPlotOverlayProps {
  sequence: string;
  threshold?: number; // identity threshold for plotting
  bins?: number;
}

// Braille mapping (2x4)
const DOT_MAP = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80];

function toBraille(grid: { direct: boolean; inverted: boolean }[][], directColor: string, invertedColor: string) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const out: Array<{ char: string; color: string }[]> = [];
  const charRows = Math.ceil(rows / 4);
  const charCols = Math.ceil(cols / 2);

  for (let cy = 0; cy < charRows; cy++) {
    const line: { char: string; color: string }[] = [];
    for (let cx = 0; cx < charCols; cx++) {
      let mask = 0;
      let hasDirect = false;
      let hasInverted = false;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const gy = cy * 4 + dy;
          const gx = cx * 2 + dx;
          if (gy >= rows || gx >= cols) continue;
          const cell = grid[gy][gx];
          const idx = dy * 2 + dx;
          if (cell.direct || cell.inverted) {
            mask |= DOT_MAP[idx];
            hasDirect = hasDirect || cell.direct;
            hasInverted = hasInverted || cell.inverted;
          }
        }
      }
      const char = String.fromCharCode(0x2800 + mask);
      const color = hasDirect ? directColor : hasInverted ? invertedColor : 'white';
      line.push({ char, color });
    }
    out.push(line);
  }
  return out;
}

export function DotPlotOverlay({ sequence, threshold = 0.8, bins = 120 }: DotPlotOverlayProps): React.ReactElement {
  const colors = usePhageStore(s => s.currentTheme.colors);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const [currentThreshold, setCurrentThreshold] = useState(threshold);
  const [currentBins, setCurrentBins] = useState(bins);
  const [manualWindow, setManualWindow] = useState<number | null>(null);
  const [showDirect, setShowDirect] = useState(true);
  const [showInverted, setShowInverted] = useState(true);

  const result = useMemo(
    () => computeDotPlot(sequence, { bins: currentBins, window: manualWindow ?? undefined }),
    [sequence, currentBins, manualWindow]
  );
  const effectiveWindow = manualWindow ?? result.window;

  useInput((input, key) => {
    if (key.escape) {
      closeOverlay('dotPlot');
    }

    // Threshold controls
    if (input === '+' || input === '=') {
      setCurrentThreshold(t => Math.min(0.99, +(t + 0.05).toFixed(2)));
    } else if (input === '-' || input === '_') {
      setCurrentThreshold(t => Math.max(0.5, +(t - 0.05).toFixed(2)));
    }

    // Resolution controls
    if (input === '[') {
      setCurrentBins(b => Math.max(40, b - 10));
    } else if (input === ']') {
      setCurrentBins(b => Math.min(200, b + 10));
    }

    // Window size controls (25% steps)
    if (input === 'w') {
      setManualWindow(w => {
        const current = w ?? result.window;
        return Math.max(5, Math.round(current / 1.25));
      });
    } else if (input === 'W') {
      setManualWindow(w => {
        const current = w ?? result.window;
        return Math.min(sequence.length, Math.round(current * 1.25));
      });
    }

    if (input === 'd' || input === 'D') {
      setShowDirect(v => !v);
    } else if (input === 'i' || input === 'I') {
      setShowInverted(v => !v);
    }
  });

  if (!result.grid.length) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} padding={1}>
        <Text color={colors.textDim}>No sequence loaded for dot plot.</Text>
        <Text color={colors.textDim}>Esc to close.</Text>
      </Box>
    );
  }

  const grid = useMemo(() => {
    return result.grid.map(row =>
      row.map(cell => ({
        direct: showDirect && cell.direct >= currentThreshold,
        inverted: showInverted && cell.inverted >= currentThreshold,
      }))
    );
  }, [result.grid, currentThreshold, showDirect, showInverted]);

  const { directCount, invertedCount } = useMemo(() => {
    let d = 0;
    let inv = 0;
    for (const row of grid) {
      for (const cell of row) {
        if (cell.direct) d++;
        if (cell.inverted) inv++;
      }
    }
    return { directCount: d, invertedCount: inv };
  }, [grid]);

  const braille = useMemo(
    () => toBraille(grid, colors.accent, colors.info),
    [grid, colors.accent, colors.info]
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.borderFocus}
      paddingX={1}
      paddingY={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.primary} bold>
          ◉ Self-Homology Dot Plot
        </Text>
        <Text color={colors.textDim}>ESC to close</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={colors.textDim}>
          Window: {effectiveWindow} bp · Threshold: {Math.round(currentThreshold * 100)}% · Bins: {currentBins} · [+/-] threshold · [[/]] bins · [w/W] window ±25% · [D] direct {showDirect ? 'on' : 'off'} · [I] inverted {showInverted ? 'on' : 'off'} · ● direct ({colors.accent}) ○ inverted ({colors.info})
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={colors.textDim}>
          Dots: {directCount.toLocaleString()} direct · {invertedCount.toLocaleString()} inverted
        </Text>
      </Box>
      <Box flexDirection="column">
        {braille.map((line, idx) => (
          <Text key={idx}>
            {line.map((cell, j) => (
              <Text key={j} color={cell.color}>{cell.char}</Text>
            ))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
