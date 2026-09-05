import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { FoldEmbedding } from '@phage-explorer/core';
import {
  buildEmbeddingMap,
  computeNovelty,
  computeProteinSelfSimilarityMatrix,
  reverseComplement,
  translateSequence,
} from '@phage-explorer/core';

interface FoldQuickviewProps {
  embeddings: FoldEmbedding[];
  genomeSequence?: string;
  loading?: boolean;
  error?: string | null;
  corpusSource?: 'db' | 'computed';
  onReload?: () => void;
}

function bar(value: number, width = 20): string {
  const fill = Math.round(value * width);
  return '█'.repeat(fill).padEnd(width, '░');
}

function heatmap(
  matrix: Float32Array,
  bins: number,
  gradient = ' .:-=+*#%@'
): string[] {
  if (bins <= 0) return [];
  const lines: string[] = [];
  for (let y = 0; y < bins; y++) {
    let line = '';
    for (let x = 0; x < bins; x++) {
      const v = matrix[y * bins + x] ?? 0;
      const idx = Math.min(
        gradient.length - 1,
        Math.max(0, Math.round(v * (gradient.length - 1)))
      );
      line += gradient[idx];
    }
    lines.push(line);
  }
  return lines;
}

export function FoldQuickview({
  embeddings,
  genomeSequence,
  loading = false,
  error = null,
  corpusSource = 'db',
  onReload,
}: FoldQuickviewProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const phage = usePhageStore(s => s.currentPhage);
  const [selectedGeneIdx, setSelectedGeneIdx] = useState(0);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const { stdout } = useStdout();

  const genesWithEmbeddings = useMemo(() => {
    // Imported gene IDs are local to their record, so an equal numeric ID in
    // the curated corpus is not evidence for this protein's structure.
    if (phage?.localGenome) return [];
    const map = buildEmbeddingMap(embeddings);
    return (phage?.genes ?? []).filter(g => map.has(g.id)).map(g => ({
      ...g,
      embedding: map.get(g.id)!,
    }));
  }, [phage, embeddings]);

  useInput((input, key) => {
    if (key.escape || input === 'f' || input === 'F') {
      closeOverlay('foldQuickview');
      return;
    }
    if ((input === 'r' || input === 'R') && onReload && !loading) {
      onReload();
      return;
    }
    if (key.upArrow) {
      setSelectedGeneIdx(i => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedGeneIdx(i => Math.min(Math.max(0, genesWithEmbeddings.length - 1), i + 1));
    }
  });

  // Keep selection in-bounds when data loads/changes.
  useEffect(() => {
    setSelectedGeneIdx((idx) => Math.min(idx, Math.max(0, genesWithEmbeddings.length - 1)));
  }, [genesWithEmbeddings.length]);

  const selected = genesWithEmbeddings[selectedGeneIdx];
  const result = useMemo(() => {
    if (!selected) return null;
    return computeNovelty(selected.embedding!, embeddings, 8);
  }, [selected, embeddings]);

  const selectedAa = useMemo(() => {
    if (!selected || !genomeSequence) return null;
    const window = genomeSequence.slice(selected.startPos, selected.endPos);
    const dna = selected.strand === '-' ? reverseComplement(window) : window;
    return translateSequence(dna, 0);
  }, [genomeSequence, selected]);

  const selfSim = useMemo(() => {
    if (!selectedAa) return null;
    const sim = computeProteinSelfSimilarityMatrix(selectedAa, { k: 3 });
    if (sim.bins <= 0) return null;
    return {
      bins: sim.bins,
      lines: heatmap(sim.matrix, sim.bins),
    };
  }, [selectedAa]);

  const windowStart = Math.max(0, selectedGeneIdx - 3);
  const window = genesWithEmbeddings.slice(windowStart, windowStart + 8);

  const colors = theme.colors;
  const width = stdout.columns ?? 80;

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={Math.min(90, width - 4)}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          FOLD QUICKVIEW — {phage?.name ?? 'No phage'}
        </Text>
        <Text color={colors.textDim}>Esc/F to close</Text>
      </Box>

      {phage?.localGenome ? (
        <Text color={colors.textDim}>Fold reference data was not supplied for this local genome.</Text>
      ) : error ? (
        <Box flexDirection="column" gap={1}>
          <Text color={colors.error}>{error}</Text>
          {onReload && (
            <Text color={colors.textDim}>Press R to retry.</Text>
          )}
        </Box>
      ) : loading ? (
        <Text color={colors.textDim}>Loading fold embeddings…</Text>
      ) : genesWithEmbeddings.length === 0 ? (
        <Text color={colors.textDim}>No embeddings available for this phage.</Text>
      ) : (
        <>
          {corpusSource === 'computed' && (
            <Box marginBottom={1}>
              <Text color={colors.textDim}>Using computed embeddings (fallback). Neighbors may be noisier than DB-backed embeddings.</Text>
            </Box>
          )}
          <Box marginBottom={1}>
            <Text color={colors.textDim}>Use ↑/↓ to pick a gene with an embedding.</Text>
          </Box>

          {/* Gene list */}
          <Box flexDirection="column" marginBottom={1}>
            {window.map((g, idx) => {
              const absoluteIdx = windowStart + idx;
              const selectedRow = absoluteIdx === selectedGeneIdx;
              return (
                <Box key={g.id}>
                  <Text color={selectedRow ? colors.accent : colors.textDim}>
                    {selectedRow ? '▶' : ' '} {g.name || g.product || g.locusTag || 'unnamed'}
                  </Text>
                </Box>
              );
            })}
          </Box>

          {/* Result */}
          {selected && result && (
            <Box flexDirection="column">
              <Text color={colors.text}>Novelty: {(result.novelty * 100).toFixed(1)}%</Text>
              <Text color={colors.textDim}>{bar(result.novelty)}</Text>
              <Box marginTop={1}>
                <Text color={colors.accent} bold>Nearest folds</Text>
              </Box>
              {result.neighbors.map(n => (
                <Text key={n.geneId} color={colors.text}>
                  • {(1 - n.distance).toFixed(2)} sim — {n.name || n.product || 'neighbor'}
                </Text>
              ))}

              {selfSim && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={colors.accent} bold>Self-similarity thumbnail</Text>
                  <Text color={colors.textDim}>k-mer similarity across the protein (not a physical contact map)</Text>
                  {selfSim.lines.map((line, idx) => (
                    <Text key={idx} color={colors.textDim}>{line}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
