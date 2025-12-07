import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { gzip } from 'pako';
import { calculateGCContent } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';

interface SequenceComplexityOverlayProps {
  sequence: string;
  phageName: string;
  genomeLength: number;
  onClose: () => void;
}

interface WindowStat {
  start: number;
  end: number;
  ratio: number;
  gc: number;
}

const SPARK = '▁▂▃▄▅▆▇█';

function compressionRatio(seq: string): number {
  if (!seq.length) return 0;
  const compressed = gzip(seq);
  return compressed.length / seq.length;
}

function toSparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) {
    return SPARK[0].repeat(values.length);
  }
  return values
    .map(v => {
      const t = (v - min) / (max - min);
      const idx = Math.min(SPARK.length - 1, Math.max(0, Math.round(t * (SPARK.length - 1))));
      return SPARK[idx];
    })
    .join('');
}

function summarize(windows: WindowStat[]) {
  if (windows.length === 0) {
    return {
      meanRatio: 0,
      stdRatio: 0,
      meanGc: 0,
      stdGc: 0,
      sparkline: '',
      high: [] as WindowStat[],
      low: [] as WindowStat[],
      gcOutliers: [] as WindowStat[],
    };
  }

  const ratios = windows.map(w => w.ratio);
  const gcs = windows.map(w => w.gc);
  const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const meanGc = gcs.reduce((a, b) => a + b, 0) / gcs.length;
  const stdRatio = Math.sqrt(
    ratios.reduce((sum, r) => sum + Math.pow(r - meanRatio, 2), 0) / ratios.length
  );
  const stdGc = Math.sqrt(
    gcs.reduce((sum, g) => sum + Math.pow(g - meanGc, 2), 0) / gcs.length
  );

  const high = windows
    .filter(w => w.ratio > meanRatio + stdRatio * 0.75)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 3);

  const low = windows
    .filter(w => w.ratio < meanRatio - stdRatio * 0.75)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 3);

  const gcOutliers = windows
    .filter(w => Math.abs(w.gc - meanGc) > Math.max(2, stdGc * 1.2))
    .sort((a, b) => Math.abs(b.gc - meanGc) - Math.abs(a.gc - meanGc))
    .slice(0, 3);

  return {
    meanRatio,
    stdRatio,
    meanGc,
    stdGc,
    sparkline: toSparkline(ratios),
    high,
    low,
    gcOutliers,
  };
}

function formatWindow(win: WindowStat): string {
  const start = win.start + 1;
  const end = win.end;
  return `${start.toLocaleString()}-${end.toLocaleString()}`;
}

export function SequenceComplexityOverlay({
  sequence,
  phageName,
  genomeLength,
  onClose,
}: SequenceComplexityOverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;

  const WINDOW_SIZE = 2000;
  const STEP = 1500;

  const stats = useMemo(() => {
    if (!sequence) {
      return summarize([]);
    }

    const windows: WindowStat[] = [];
    for (let start = 0; start < sequence.length; start += STEP) {
      const slice = sequence.slice(start, start + WINDOW_SIZE);
      if (!slice.length) break;
      const ratio = compressionRatio(slice);
      const gc = calculateGCContent(slice);
      windows.push({
        start,
        end: Math.min(sequence.length, start + slice.length),
        ratio,
        gc,
      });
    }

    return summarize(windows);
  }, [sequence]);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      width={90}
      height={26}
      paddingX={2}
      paddingY={1}
    >
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          SEQUENCE COMPLEXITY — {phageName}
        </Text>
        <Text color={colors.textDim}>X / Esc to close</Text>
      </Box>

      {sequence.length === 0 ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={colors.textDim}>Sequence not loaded</Text>
        </Box>
      ) : (
        <>
          {/* Summary */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color={colors.text}>
              Genome length: {genomeLength.toLocaleString()} bp · Windows: {stats.sparkline.length}
            </Text>
            <Text color={colors.textDim}>
              Mean compression ratio: {stats.meanRatio.toFixed(3)} (σ {stats.stdRatio.toFixed(3)}) ·
              Mean GC: {stats.meanGc.toFixed(1)}% (σ {stats.stdGc.toFixed(1)}%)
            </Text>
          </Box>

          {/* Sparkline */}
          <Box flexDirection="column" marginBottom={1}>
            <Text color={colors.accent} bold>
              Kolmogorov (gzip) sparkline
            </Text>
            <Text color={colors.text}>{stats.sparkline}</Text>
            <Text color={colors.textDim} dimColor>
              Higher bars = more complex / less compressible. Lower = repeats/low complexity.
            </Text>
          </Box>

          {/* Insights */}
          <Box flexDirection="column" gap={0} flexGrow={1}>
            <Text color={colors.primary} bold>
              Notable regions
            </Text>
            {stats.high.length === 0 && stats.low.length === 0 && stats.gcOutliers.length === 0 ? (
              <Text color={colors.textDim}>No strong complexity outliers detected.</Text>
            ) : (
              <>
                {stats.high.length > 0 && (
                  <Box flexDirection="column" marginBottom={1}>
                    <Text color={colors.accent}>High complexity (possible HGT)</Text>
                    {stats.high.map(win => (
                      <Text key={`high-${win.start}`} color={colors.text}>
                        ▸ {formatWindow(win)} · ratio {win.ratio.toFixed(3)} · GC {win.gc.toFixed(1)}%
                      </Text>
                    ))}
                  </Box>
                )}

                {stats.low.length > 0 && (
                  <Box flexDirection="column" marginBottom={1}>
                    <Text color={colors.accent}>Low complexity (repeats)</Text>
                    {stats.low.map(win => (
                      <Text key={`low-${win.start}`} color={colors.text}>
                        ▸ {formatWindow(win)} · ratio {win.ratio.toFixed(3)} · GC {win.gc.toFixed(1)}%
                      </Text>
                    ))}
                  </Box>
                )}

                {stats.gcOutliers.length > 0 && (
                  <Box flexDirection="column" marginBottom={1}>
                    <Text color={colors.accent}>GC composition outliers</Text>
                    {stats.gcOutliers.map(win => (
                      <Text key={`gc-${win.start}`} color={colors.text}>
                        ▸ {formatWindow(win)} · GC {win.gc.toFixed(1)}%
                      </Text>
                    ))}
                  </Box>
                )}
              </>
            )}
          </Box>

          {/* Footer */}
          <Box marginTop={1} justifyContent="space-between">
            <Text color={colors.textDim} dimColor>
              Window {WINDOW_SIZE} bp · Step {STEP} bp · gzip via pako
            </Text>
            <Text color={colors.textDim} dimColor>
              Use sparkline to spot HGT (high) vs repeats (low)
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

