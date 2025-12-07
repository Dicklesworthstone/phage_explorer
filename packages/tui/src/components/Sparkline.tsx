import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { HudTheme } from '@phage-explorer/core';

// Sparkline character sets for different styles
const BARS_8 = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const BRAILLE_DOTS = ['⠀', '⣀', '⣤', '⣶', '⣿']; // 5 levels
const BLOCKS_4 = ['░', '▒', '▓', '█'];
const THIN_BARS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']; // Horizontal thin bars
const DOTS = ['·', '•', '●', '⬤']; // Dot size progression
const WAVES = ['~', '≈', '≋', '⌇']; // Wave patterns

// Unicode markers for sparkline annotations
const MARKERS = {
  peak: '▲',
  valley: '▼',
  threshold: '─',
  start: '├',
  end: '┤',
  current: '│',
  anomaly: '!',
} as const;

export type SparklineStyle = 'bars' | 'braille' | 'blocks' | 'thin' | 'dots' | 'waves';

export interface SparklineProps {
  /** Array of numeric values to visualize */
  values: number[];
  /** Width in characters */
  width: number;
  /** Visual style */
  style?: SparklineStyle;
  /** Whether to use gradient coloring */
  gradient?: boolean;
  /** Theme colors */
  colors: HudTheme;
  /** Min value override (auto-calculated if not provided) */
  min?: number;
  /** Max value override (auto-calculated if not provided) */
  max?: number;
  /** Label to show before sparkline */
  label?: string;
  /** Show min/max values */
  showRange?: boolean;
  /** Highlight positions (indices that should be emphasized) */
  highlights?: number[];
  /** Whether to show peak markers */
  showPeaks?: boolean;
  /** Whether to show valley markers */
  showValleys?: boolean;
  /** Threshold value for anomaly highlighting */
  threshold?: number;
  /** Whether to use extended gradient (5-color) */
  extendedGradient?: boolean;
  /** Show decorative borders */
  bordered?: boolean;
}

// Interpolate between two hex colors
function interpolateColor(color1: string, color2: string, factor: number): string {
  const c1 = parseInt(color1.slice(1), 16);
  const c2 = parseInt(color2.slice(1), 16);

  const r1 = (c1 >> 16) & 0xff;
  const g1 = (c1 >> 8) & 0xff;
  const b1 = c1 & 0xff;

  const r2 = (c2 >> 16) & 0xff;
  const g2 = (c2 >> 8) & 0xff;
  const b2 = c2 & 0xff;

  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);

  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Get color for a normalized value (0-1) using theme gradient (3-color)
function getGradientColor(value: number, colors: HudTheme): string {
  if (value < 0.5) {
    return interpolateColor(colors.gradientLow, colors.gradientMid, value * 2);
  }
  return interpolateColor(colors.gradientMid, colors.gradientHigh, (value - 0.5) * 2);
}

// Get color using extended 5-color gradient from theme
function getExtendedGradientColor(value: number, colors: HudTheme): string {
  const gradient = colors.sparklineGradient;
  if (!gradient || gradient.length < 2) {
    return getGradientColor(value, colors);
  }

  // Map value (0-1) to gradient segments
  const segments = gradient.length - 1;
  const scaledValue = value * segments;
  const segmentIndex = Math.min(Math.floor(scaledValue), segments - 1);
  const segmentFactor = scaledValue - segmentIndex;

  return interpolateColor(
    gradient[segmentIndex],
    gradient[segmentIndex + 1],
    segmentFactor
  );
}

// Get characters for style
function getChars(style: SparklineStyle): string[] {
  switch (style) {
    case 'braille': return BRAILLE_DOTS;
    case 'blocks': return BLOCKS_4;
    case 'thin': return THIN_BARS;
    case 'dots': return DOTS;
    case 'waves': return WAVES;
    default: return BARS_8;
  }
}

// Find local peaks in data
function findPeaks(values: number[], threshold: number = 0.1): Set<number> {
  const peaks = new Set<number>();
  for (let i = 1; i < values.length - 1; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    const next = values[i + 1];
    if (curr > prev && curr > next && curr > threshold) {
      peaks.add(i);
    }
  }
  return peaks;
}

// Find local valleys in data
function findValleys(values: number[], threshold: number = 0.9): Set<number> {
  const valleys = new Set<number>();
  for (let i = 1; i < values.length - 1; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    const next = values[i + 1];
    if (curr < prev && curr < next && curr < threshold) {
      valleys.add(i);
    }
  }
  return valleys;
}

// Map value to character
function valueToChar(
  value: number,
  min: number,
  max: number,
  chars: string[]
): string {
  if (max === min) return chars[0];
  const norm = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const idx = Math.round(norm * (chars.length - 1));
  return chars[idx];
}

// Downsample values to fit width
function downsample(values: number[], targetWidth: number): number[] {
  if (values.length <= targetWidth) return values;

  const step = values.length / targetWidth;
  const result: number[] = [];

  for (let i = 0; i < targetWidth; i++) {
    const startIdx = Math.floor(i * step);
    const endIdx = Math.floor((i + 1) * step);

    // Take average of values in this bucket
    let sum = 0;
    let count = 0;
    for (let j = startIdx; j < endIdx && j < values.length; j++) {
      sum += values[j];
      count++;
    }
    result.push(count > 0 ? sum / count : 0);
  }

  return result;
}

export function Sparkline({
  values,
  width,
  style = 'bars',
  gradient = true,
  colors,
  min: minOverride,
  max: maxOverride,
  label,
  showRange = false,
  highlights = [],
  showPeaks = false,
  showValleys = false,
  threshold,
  extendedGradient = false,
  bordered = false,
}: SparklineProps): React.ReactElement {
  const processedData = useMemo(() => {
    if (!values || values.length === 0) {
      return { chars: [], colors: [], min: 0, max: 0, peaks: new Set<number>(), valleys: new Set<number>() };
    }

    // Calculate min/max
    const computedMin = minOverride ?? Math.min(...values);
    const computedMax = maxOverride ?? Math.max(...values);

    // Downsample to fit width
    const sampled = downsample(values, width);
    const chartChars = getChars(style);

    // Normalize sampled values for peak/valley detection
    const normalizedSampled = sampled.map(v =>
      computedMax === computedMin ? 0 : (v - computedMin) / (computedMax - computedMin)
    );

    // Find peaks and valleys if requested
    const peaks = showPeaks ? findPeaks(normalizedSampled) : new Set<number>();
    const valleys = showValleys ? findValleys(normalizedSampled) : new Set<number>();

    // Create highlight set for quick lookup
    const highlightSet = new Set(
      highlights.map(h => Math.floor((h / values.length) * sampled.length))
    );

    // Generate characters and colors
    const resultChars: string[] = [];
    const resultColors: string[] = [];

    for (let i = 0; i < sampled.length; i++) {
      const v = sampled[i];
      const norm = computedMax === computedMin ? 0 :
        (v - computedMin) / (computedMax - computedMin);

      // Check for peak/valley markers
      if (peaks.has(i)) {
        resultChars.push(MARKERS.peak);
        resultColors.push(colors.warning);
      } else if (valleys.has(i)) {
        resultChars.push(MARKERS.valley);
        resultColors.push(colors.info);
      } else {
        resultChars.push(valueToChar(v, computedMin, computedMax, chartChars));

        // Determine color
        if (highlightSet.has(i)) {
          resultColors.push(colors.highlight);
        } else if (threshold !== undefined && norm > threshold) {
          resultColors.push(colors.kmerAnomaly ?? colors.error);
        } else if (gradient) {
          resultColors.push(
            extendedGradient
              ? getExtendedGradientColor(norm, colors)
              : getGradientColor(norm, colors)
          );
        } else {
          resultColors.push(colors.text);
        }
      }
    }

    return {
      chars: resultChars,
      colors: resultColors,
      min: computedMin,
      max: computedMax,
      peaks,
      valleys,
    };
  }, [values, width, style, gradient, colors, minOverride, maxOverride, highlights, showPeaks, showValleys, threshold, extendedGradient]);

  if (values.length === 0) {
    return (
      <Box>
        {label && <Text color={colors.textDim}>{label} </Text>}
        <Text color={colors.textMuted}>No data</Text>
      </Box>
    );
  }

  // Build the sparkline content
  const sparklineContent = (
    <Box>
      {processedData.chars.map((char, i) => (
        <Text key={i} color={processedData.colors[i]}>
          {char}
        </Text>
      ))}
    </Box>
  );

  // Stats summary
  const statsLine = showRange ? (
    <Box gap={1}>
      <Text color={colors.textMuted}>
        min: {processedData.min.toFixed(2)} │ max: {processedData.max.toFixed(2)}
        {showPeaks && processedData.peaks.size > 0 && ` │ peaks: ${processedData.peaks.size}`}
        {showValleys && processedData.valleys.size > 0 && ` │ valleys: ${processedData.valleys.size}`}
      </Text>
    </Box>
  ) : null;

  if (bordered) {
    // Bordered mode with decorative frame
    const borderColor = colors.separator ?? colors.border;
    const glowColor = colors.glow ?? colors.primary;

    return (
      <Box flexDirection="column">
        {/* Top border */}
        <Box>
          <Text color={glowColor}>╭</Text>
          <Text color={borderColor}>{'─'.repeat(width + (label ? label.length + 2 : 0))}</Text>
          <Text color={glowColor}>╮</Text>
        </Box>
        {/* Content */}
        <Box>
          <Text color={borderColor}>│</Text>
          {label && <Text color={colors.textDim}>{label} </Text>}
          {sparklineContent}
          <Text color={borderColor}>│</Text>
        </Box>
        {/* Bottom border with optional stats */}
        <Box>
          <Text color={glowColor}>╰</Text>
          {statsLine ? (
            <>
              <Text color={colors.textMuted}> {processedData.min.toFixed(1)}</Text>
              <Text color={borderColor}>{'─'.repeat(Math.max(0, width - 12))}</Text>
              <Text color={colors.textMuted}>{processedData.max.toFixed(1)} </Text>
            </>
          ) : (
            <Text color={borderColor}>{'─'.repeat(width + (label ? label.length + 2 : 0))}</Text>
          )}
          <Text color={glowColor}>╯</Text>
        </Box>
      </Box>
    );
  }

  // Standard mode
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {label && <Text color={colors.textDim}>{label}</Text>}
        {sparklineContent}
      </Box>
      {statsLine}
    </Box>
  );
}

/**
 * Mini sparkline for inline use - returns just the colored string
 */
export function MiniSparkline({
  values,
  width,
  colors,
  style = 'bars',
  extendedGradient = false,
}: {
  values: number[];
  width: number;
  colors: HudTheme;
  style?: SparklineStyle;
  extendedGradient?: boolean;
}): React.ReactElement {
  // Handle empty array case
  if (!values || values.length === 0) {
    return (
      <Box>
        <Text color={colors.textMuted}>{'─'.repeat(width)}</Text>
      </Box>
    );
  }

  const chars = getChars(style);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const sampled = downsample(values, width);

  return (
    <Box>
      {sampled.map((v, i) => {
        const norm = max === min ? 0 : (v - min) / (max - min);
        const color = extendedGradient
          ? getExtendedGradientColor(norm, colors)
          : getGradientColor(norm, colors);
        return (
          <Text key={i} color={color}>
            {valueToChar(v, min, max, chars)}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Progress bar style visualization
 */
export function ProgressBar({
  value,
  max = 100,
  width = 20,
  colors,
  label,
  showPercent = true,
}: {
  value: number;
  max?: number;
  width?: number;
  colors: HudTheme;
  label?: string;
  showPercent?: boolean;
}): React.ReactElement {
  const percent = Math.min(1, Math.max(0, value / max));
  const filledWidth = Math.round(percent * width);
  const emptyWidth = width - filledWidth;

  const barColor = percent < 0.3 ? colors.error :
                   percent < 0.7 ? colors.warning : colors.success;

  return (
    <Box gap={1}>
      {label && <Text color={colors.textDim}>{label}</Text>}
      <Text color={barColor}>{'█'.repeat(filledWidth)}</Text>
      <Text color={colors.textMuted}>{'░'.repeat(emptyWidth)}</Text>
      {showPercent && (
        <Text color={colors.text}>{Math.round(percent * 100)}%</Text>
      )}
    </Box>
  );
}

/**
 * Dual-tone bar for showing positive/negative or comparison values
 */
export function DualBar({
  valueA,
  valueB,
  width = 40,
  colors,
  labelA,
  labelB,
}: {
  valueA: number;
  valueB: number;
  width?: number;
  colors: HudTheme;
  labelA?: string;
  labelB?: string;
}): React.ReactElement {
  const total = valueA + valueB;
  const widthA = total > 0 ? Math.round((valueA / total) * width) : width / 2;
  const widthB = width - widthA;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.geneForward}>{'█'.repeat(widthA)}</Text>
        <Text color={colors.textMuted}>│</Text>
        <Text color={colors.geneReverse}>{'█'.repeat(widthB)}</Text>
      </Box>
      {(labelA || labelB) && (
        <Box justifyContent="space-between" width={width + 1}>
          <Text color={colors.textDim}>{labelA ?? ''}</Text>
          <Text color={colors.textDim}>{labelB ?? ''}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Heatmap visualization using block characters
 */
const HEATMAP_CHARS = ['░', '▒', '▓', '█'];

export function HeatMap({
  values,
  width,
  height = 1,
  colors,
  label,
  showScale = false,
  extendedGradient = true,
}: {
  values: number[];
  width: number;
  height?: number;
  colors: HudTheme;
  label?: string;
  showScale?: boolean;
  extendedGradient?: boolean;
}): React.ReactElement {
  // Handle empty data
  if (!values || values.length === 0) {
    return (
      <Box flexDirection="column">
        {label && <Text color={colors.textDim}>{label}</Text>}
        <Text color={colors.textMuted}>{'░'.repeat(width)}</Text>
      </Box>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const sampled = downsample(values, width);

  // Generate heatmap rows
  const rows: React.ReactElement[] = [];
  for (let row = 0; row < height; row++) {
    const cells = sampled.map((v, i) => {
      const norm = max === min ? 0 : (v - min) / (max - min);
      const color = extendedGradient
        ? getExtendedGradientColor(norm, colors)
        : getGradientColor(norm, colors);
      const charIdx = Math.min(HEATMAP_CHARS.length - 1, Math.floor(norm * HEATMAP_CHARS.length));
      return (
        <Text key={i} color={color}>
          {HEATMAP_CHARS[charIdx]}
        </Text>
      );
    });
    rows.push(<Box key={row}>{cells}</Box>);
  }

  return (
    <Box flexDirection="column">
      {label && <Text color={colors.textDim}>{label}</Text>}
      {rows}
      {showScale && (
        <Box gap={1}>
          <Text color={colors.textMuted}>{min.toFixed(1)}</Text>
          <Text color={colors.gradientLow}>░</Text>
          <Text color={colors.gradientMid}>▒</Text>
          <Text color={colors.gradientHigh}>█</Text>
          <Text color={colors.textMuted}>{max.toFixed(1)}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Gradient legend for showing color scales
 */
export function GradientLegend({
  width = 20,
  colors,
  labels,
  extendedGradient = true,
}: {
  width?: number;
  colors: HudTheme;
  labels?: { min: string; max: string };
  extendedGradient?: boolean;
}): React.ReactElement {
  const cells = Array.from({ length: width }, (_, i) => {
    const norm = i / (width - 1);
    const color = extendedGradient
      ? getExtendedGradientColor(norm, colors)
      : getGradientColor(norm, colors);
    return (
      <Text key={i} color={color}>
        █
      </Text>
    );
  });

  return (
    <Box flexDirection="column">
      <Box>{cells}</Box>
      {labels && (
        <Box justifyContent="space-between" width={width}>
          <Text color={colors.textMuted}>{labels.min}</Text>
          <Text color={colors.textMuted}>{labels.max}</Text>
        </Box>
      )}
    </Box>
  );
}
