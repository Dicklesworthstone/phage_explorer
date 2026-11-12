import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import {
  computePhasePortrait,
  prepareCdsPhasePortraitInput,
  PHASE_PROPERTY_LABELS,
  type DominantProperty,
  type PhasePortraitResult,
} from '@phage-explorer/core';

interface PhasePortraitOverlayProps {
  sequence: string;
}

const DOMAIN_CHAR: Record<DominantProperty, string> = {
  hydrophobic: '▓',
  charged: '±',
  aromatic: '◆',
  flexible: '~',
  disordered: '?',
  flat: '·',
};

function renderPlot(result: PhasePortraitResult, width = 44, height = 12): string[] {
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(' '));
  if (result.points.length === 0) {
    return ['(no data)'];
  }

  result.points.forEach((p, idx) => {
    const x = Math.max(0, Math.min(width - 1, Math.round(p.coord.x * (width - 1))));
    const y = Math.max(0, Math.min(height - 1, Math.round((1 - p.coord.y) * (height - 1))));
    const ch = idx === 0 ? 'S' : (idx === result.points.length - 1 ? 'E' : '•');
    grid[y][x] = ch;
  });

  return grid.map(row => row.join(''));
}

export function PhasePortraitOverlay({ sequence }: PhasePortraitOverlayProps): React.ReactElement {
  const currentPhage = usePhageStore(s => s.currentPhage);
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const genes = useMemo(() => (currentPhage?.genes ?? []).filter(gene => gene.type === 'CDS'), [currentPhage]);
  const [geneIdx, setGeneIdx] = useState(0);
  const [windowSize, setWindowSize] = useState(30);
  const [stepSize, setStepSize] = useState(5);

  // Clamp gene index when switching phages
  useEffect(() => {
    setGeneIdx(idx => Math.min(idx, Math.max(genes.length - 1, 0)));
  }, [genes.length]);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      closeOverlay('phasePortrait');
      return;
    }
    if (key.leftArrow) setGeneIdx(i => Math.max(0, i - 1));
    if (key.rightArrow) setGeneIdx(i => Math.min(Math.max(genes.length - 1, 0), i + 1));
    if (input === 'w') setWindowSize(w => Math.min(100, w + 5));
    if (input === 's') setWindowSize(w => Math.max(10, w - 5));
    if (input === 'e') setStepSize(s => Math.min(Math.max(1, s + 1), 20));
    if (input === 'd') setStepSize(s => Math.max(1, s - 1));
  });

  const safeIdx = Math.min(geneIdx, Math.max(genes.length - 1, 0));
  const gene = genes[safeIdx];
  const input = useMemo(() => (gene ? prepareCdsPhasePortraitInput(sequence, gene) : null), [gene, sequence]);
  const aaSeq = input?.protein ?? '';

  const portrait = useMemo(
    () => computePhasePortrait(aaSeq, windowSize, stepSize),
    [aaSeq, windowSize, stepSize]
  );

  const colors = theme.colors;
  const plotLines = renderPlot(portrait);
  const domainBar = portrait.points.map(p => DOMAIN_CHAR[p.dominant]).join('') || '·';
  const explainedPct = portrait.explained.map(v => Math.round(v * 100));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      paddingX={1}
      paddingY={0}
      width={80}
    >
      <Text color={colors.accent} bold>
        Phase Portraits — {currentPhage?.name ?? 'No phage loaded'}
      </Text>
      <Text color={colors.textDim}>
        CDS {genes.length === 0 ? 0 : safeIdx + 1}/{Math.max(genes.length, 0)} · {gene?.name || gene?.locusTag || 'Unnamed'} ·{' '}
        {aaSeq.length} aa · window {windowSize} step {stepSize}
      </Text>

      {input && (
        <Text color={colors.textDim}>NCBI table {input.reference.geneticCode} · codon_start {input.reference.codonStart} · joined transcript order</Text>
      )}
      {!gene ? (
        <Text color={colors.warning}>No annotated CDS is available. Import a GenBank record with CDS features.</Text>
      ) : !input?.protein ? (
        <Text color={colors.warning}>CDS unavailable: {input?.reference.reasons.join(' ')}</Text>
      ) : aaSeq.length < windowSize ? (
        <Text color={colors.warning}>Protein is shorter than the selected window; lower the window or choose another CDS.</Text>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {plotLines.map((line, idx) => (
          <Text key={idx} color={colors.text}>{line}</Text>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.textDim}>Window property scores (not inferred domains):</Text>
        <Text color={colors.warning}>{domainBar}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.textDim}>
          PC variance ≈ {explainedPct[0]}% / {explainedPct[1]}% · Dominant score: {portrait.points[0] ? PHASE_PROPERTY_LABELS[portrait.points[0].dominant] : 'n/a'}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.textMuted}>
          Controls: ←/→ CDS · W/S window ±5 · D/E step ±1 · Q/Esc close
        </Text>
      </Box>
    </Box>
  );
}
