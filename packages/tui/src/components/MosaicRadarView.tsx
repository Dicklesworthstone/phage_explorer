import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import { computeMosaicRadar, type ReferenceSketch } from '@phage-explorer/core';

interface MosaicRadarViewProps {
  sequence: string;
  references: Record<string, string>; // label -> downsampled genome
  currentPhageId?: number;
}

export function MosaicRadarView({ sequence, references, currentPhageId }: MosaicRadarViewProps): React.ReactElement {
  const colors = usePhageStore(s => s.currentTheme.colors);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const terminalCols = usePhageStore(s => s.terminalCols);

  const [k, setK] = useState(5);
  const [windowSize, setWindowSize] = useState(2000);
  const [minSim, setMinSim] = useState(0.05);
  const [showBreakpoints, setShowBreakpoints] = useState(true);

  const referenceList: ReferenceSketch[] = useMemo(() => {
    const entries = Object.entries(references);
    const filtered = currentPhageId
      ? entries.filter(([label]) => !label.trimEnd().endsWith(`#${currentPhageId}`))
      : entries;
    return filtered.map(([label, seq]) => ({ label, sequence: seq }));
  }, [references, currentPhageId]);

  const result = useMemo(
    () => computeMosaicRadar(sequence, referenceList, { k, window: windowSize, step: Math.floor(windowSize / 2), minSimilarity: minSim }),
    [sequence, referenceList, k, windowSize, minSim]
  );

  useInput((input, key) => {
    if (key.escape) {
      closeOverlay('mosaicRadar');
      return;
    }
    if (input === '+' || input === '=') {
      setWindowSize(w => Math.min(sequence.length, Math.round(w * 1.25)));
    } else if (input === '-' || input === '_') {
      setWindowSize(w => Math.max(500, Math.round(w / 1.25)));
    }
    if (input === '[') setK(v => Math.max(3, v - 1));
    if (input === ']') setK(v => Math.min(8, v + 1));
    if (input === 'b' || input === 'B') setShowBreakpoints(v => !v);
    if (input === 'm') setMinSim(s => Math.min(0.3, +(s + 0.02).toFixed(2)));
    if (input === 'M') setMinSim(s => Math.max(0.01, +(s - 0.02).toFixed(2)));
  });

  if (!sequence.length || result.windows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} padding={1}>
        <Text color={colors.textDim}>No sequence or references available for mosaic radar.</Text>
        <Text color={colors.textDim}>Esc to close.</Text>
      </Box>
    );
  }

  const donors = useMemo(() => {
    const unique = new Set<string>();
    for (const seg of result.segments) {
      if (seg.donor) unique.add(seg.donor);
    }
    return Array.from(unique);
  }, [result.segments]);

  const palette = [colors.accent, colors.info, colors.warning, colors.success, colors.secondary, colors.primary];
  const donorColor = useMemo(() => {
    const map = new Map<string, string>();
    donors.forEach((d, i) => map.set(d, palette[i % palette.length]));
    return map;
  }, [donors, palette]);

  const barWidth = Math.max(20, terminalCols - 8);
  const genomeLen = sequence.length;

  const barCells = useMemo(() => {
    const cells: Array<{ char: string; color: string }> = [];
    let segIdx = 0;
    for (let i = 0; i < barWidth; i++) {
      const pos = Math.floor((i / barWidth) * genomeLen);
      while (segIdx < result.segments.length - 1 && pos >= result.segments[segIdx].end) segIdx++;
      const seg = result.segments[segIdx];
      const color = seg?.donor ? (donorColor.get(seg.donor) ?? colors.textDim) : colors.textMuted;
      cells.push({ char: '█', color });
    }
    return cells;
  }, [barWidth, genomeLen, result.segments, donorColor, colors.textDim, colors.textMuted]);

  const breakpointLine = useMemo(() => {
    if (!showBreakpoints) return null;
    const marks = new Array(barWidth).fill(' ');
    for (const bp of result.breakpoints) {
      const idx = Math.floor((bp / genomeLen) * barWidth);
      if (idx >= 0 && idx < marks.length) marks[idx] = '|';
    }
    return marks.join('');
  }, [showBreakpoints, result.breakpoints, genomeLen, barWidth]);

  const donorStats = useMemo(() => {
    const stats: Array<{ donor: string; coverage: number; mean: number }> = [];
    for (const d of donors) {
      const segs = result.segments.filter(s => s.donor === d);
      const cov = segs.reduce((a, s) => a + (s.end - s.start), 0);
      const mean = segs.reduce((a, s) => a + s.meanScore * (s.end - s.start), 0) / Math.max(1, cov);
      stats.push({ donor: d, coverage: cov / genomeLen, mean });
    }
    stats.sort((a, b) => b.coverage - a.coverage);
    return stats;
  }, [donors, result.segments, genomeLen]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.borderFocus} paddingX={1} paddingY={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.primary} bold>🧬 Mosaic / Recombination Radar</Text>
        <Text color={colors.textDim}>ESC to close</Text>
      </Box>

      <Text color={colors.textDim}>
        k={k} · window={windowSize}bp · minSim={minSim} · [+/-] window ±25% · [[/]] k · [b] breakpoints {showBreakpoints ? 'on' : 'off'} · [m/M] minSim ±0.02
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text>
          {barCells.map((c, i) => (
            <Text key={i} color={c.color}>{c.char}</Text>
          ))}
        </Text>
        {breakpointLine && (
          <Text color={colors.textMuted}>{breakpointLine}</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.textDim} bold>Donor segments:</Text>
        {donorStats.length === 0 && (
          <Text color={colors.textMuted}>No confident donors at current minSim.</Text>
        )}
        {donorStats.map((s, idx) => (
          <Text key={idx} color={donorColor.get(s.donor) ?? colors.text}>
            {s.donor} · {(s.coverage * 100).toFixed(1)}% · mean J={s.mean.toFixed(2)}
          </Text>
        ))}
        {result.breakpoints.length > 0 && (
          <Box marginTop={1}>
            <Text color={colors.textDim}>
              Breakpoints: {result.breakpoints.map(b => b.toLocaleString()).join(', ')}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export default MosaicRadarView;
