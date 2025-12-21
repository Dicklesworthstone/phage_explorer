/**
 * GCSkewTrack - GC Skew Analysis Track
 *
 * Displays cumulative GC skew as a track synchronized with the SequenceGrid.
 * Highlights origin (minimum) and terminus (maximum) of replication.
 */

import React, { useMemo, memo } from 'react';
import { CanvasTrack, type TrackData } from './CanvasTrack';
import { useTheme } from '../../hooks/useTheme';

interface GCSkewTrackProps {
  /** Sequence to analyze */
  sequence: string;
  /** Window size for GC skew calculation */
  windowSize?: number;
  /** Whether to show cumulative (default) or per-window skew */
  cumulative?: boolean;
  /** Track height */
  height?: number;
  /** Click handler - receives base position */
  onClick?: (basePosition: number) => void;
}

// Calculate GC skew values
function calculateGCSkew(
  sequence: string,
  windowSize: number,
  cumulativeMode: boolean
): { values: number[]; labels: Array<{ position: number; label: string; color?: string }> } {
  if (!sequence || sequence.length === 0) {
    return { values: [], labels: [] };
  }

  const values: number[] = [];
  let cumSum = 0;
  let minIdx = 0;
  let maxIdx = 0;
  let minVal = Infinity;
  let maxVal = -Infinity;

  for (let i = 0; i < sequence.length - windowSize; i += windowSize) {
    const window = sequence.slice(i, i + windowSize).toUpperCase();
    let g = 0;
    let c = 0;

    for (const base of window) {
      if (base === 'G') g++;
      else if (base === 'C') c++;
    }

    const gcSkew = g + c > 0 ? (g - c) / (g + c) : 0;
    if (cumulativeMode) {
      cumSum += gcSkew;
      values.push(cumSum);

      // Track min/max for origin/terminus detection
      if (cumSum < minVal) {
        minVal = cumSum;
        minIdx = values.length - 1;
      }
      if (cumSum > maxVal) {
        maxVal = cumSum;
        maxIdx = values.length - 1;
      }
    } else {
      values.push(gcSkew);
    }
  }

  // Create labels for origin and terminus
  const labels: Array<{ position: number; label: string; color?: string }> = [];

  if (cumulativeMode && values.length > 0) {
    labels.push({
      position: minIdx * windowSize + windowSize / 2,
      label: 'ori',
      color: '#ef4444', // red for origin
    });
    labels.push({
      position: maxIdx * windowSize + windowSize / 2,
      label: 'ter',
      color: '#22c55e', // green for terminus
    });
  }

  return { values, labels };
}

function GCSkewTrackBase({
  sequence,
  windowSize = 500,
  cumulative = true,
  height = 60,
  onClick,
}: GCSkewTrackProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;

  // Calculate GC skew data
  const trackData = useMemo<TrackData | null>(() => {
    if (!sequence || sequence.length < windowSize * 2) {
      return null;
    }

    const { values, labels } = calculateGCSkew(sequence, windowSize, cumulative);

    if (values.length === 0) {
      return null;
    }

    return {
      values,
      windowSize,
      genomeLength: sequence.length,
      labels,
    };
  }, [sequence, windowSize, cumulative]);

  return (
    <CanvasTrack
      label="GC Skew"
      height={height}
      data={trackData}
      loading={false}
      color={colors.primary}
      fillColor={`${colors.primary}22`}
      showGrid={true}
      showCenterLine={true}
      onClick={onClick}
      formatTooltip={(value, position) =>
        `GC Skew: ${value.toFixed(3)} at ${position.toLocaleString()} bp`
      }
    />
  );
}

export const GCSkewTrack = memo(GCSkewTrackBase);
export default GCSkewTrack;
