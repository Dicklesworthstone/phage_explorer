import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import {
  computeDinucleotideFrequencies,
  decomposeBias,
  DINUCLEOTIDES,
  computeCodonFrequencies,
} from '@phage-explorer/core';

interface BiasDecompositionOverlayProps {
  repository: PhageRepository;
}

interface LoadedVector {
  name: string;
  vector: number[];
  genomeType: string | null;
  lifecycle: string | null;
  codon?: number[];
}

export function BiasDecompositionOverlay({ repository }: BiasDecompositionOverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  const phages = usePhageStore(s => s.phages);
  const current = usePhageStore(s => s.currentPhage);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const [loading, setLoading] = useState(false);
  const [vectors, setVectors] = useState<LoadedVector[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Map<number, LoadedVector & { length: number }>>(new Map());
  const [mode, setMode] = useState<'di' | 'codon'>('di');

  useInput((input, key) => {
    if (key.escape) {
      closeOverlay('biasDecomposition');
    } else if (input === '1') {
      setMode('di');
    } else if (input === '2') {
      setMode('codon');
    }
  });

  // Fetch full sequences for all phages once
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        const items: LoadedVector[] = [];

        for (const p of phages) {
          const cached = cacheRef.current.get(p.id);
          const len = await repository.getFullGenomeLength(p.id);
          if (cached && cached.length === len) {
            items.push(cached);
            continue;
          }

          const seq = await repository.getSequenceWindow(p.id, 0, len);
          const vector = computeDinucleotideFrequencies(seq);
          const codon = computeCodonFrequencies(seq);

          // Try to fetch richer metadata if available
          const meta = await repository.getPhageById?.(p.id);

          const entry: LoadedVector & { length: number } = {
            name: p.name,
            vector,
            genomeType: (meta?.genomeType ?? p as any).genomeType ?? null,
            lifecycle: (meta?.lifecycle ?? p.lifecycle) ?? null,
            codon,
            length: len,
          };
          cacheRef.current.set(p.id, entry);
          items.push(entry);
        }
        if (!cancelled) setVectors(items);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [phages, repository]);

  const decomposition = useMemo(() => {
    if (vectors.length < 2) return null;
    const rows =
      mode === 'di'
        ? vectors.map(v => ({ name: v.name, vector: v.vector }))
        : vectors.map(v => ({ name: v.name, vector: v.codon ?? v.vector }));
    return decomposeBias(rows);
  }, [vectors, mode]);

  const currentCoords = useMemo(() => {
    if (!decomposition || !current) return null;
    return decomposition.projections.find(p => p.name === current.name)?.coords ?? null;
  }, [decomposition, current]);

  const scatterLines = useMemo(() => {
    if (!decomposition) return [];

    const width = 42;
    const height = 12;
    const xs = decomposition.projections.map(p => p.coords[0]);
    const ys = decomposition.projections.map(p => p.coords[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;

    // Build grid of glyph/color
    const grid: { ch: string; color: string }[][] = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => ({ ch: ' ', color: colors.textDim }))
    );

    const typeColor = (name: string): string => {
      const meta = vectors.find(v => v.name === name);
      const gt = meta?.genomeType?.toLowerCase() ?? 'unknown';
      if (gt.includes('ssdna')) return '#ff7f0e';
      if (gt.includes('dsrna') || gt.includes('rna')) return '#1f77b4';
      if (gt.includes('ssrna')) return '#2ca02c';
      if (gt.includes('dsdna')) return colors.accent;
      return colors.text;
    };

    decomposition.projections.forEach(p => {
      const x = Math.max(0, Math.min(width - 1, Math.floor(((p.coords[0] - minX) / spanX) * (width - 1))));
      const y = Math.max(0, Math.min(height - 1, Math.floor(((p.coords[1] - minY) / spanY) * (height - 1))));
      const color = p.name === current?.name ? colors.accent : typeColor(p.name);
      const ch = p.name === current?.name ? '◆' : '•';
      grid[height - 1 - y][x] = { ch, color };
    });

    return grid.map(row => row.map(cell => cell));
  }, [decomposition, current?.name, vectors, colors.accent, colors.text, colors.textDim]);

  const legend = [
    { label: 'dsDNA', color: colors.accent },
    { label: 'ssDNA', color: '#ff7f0e' },
    { label: 'ssRNA', color: '#2ca02c' },
    { label: 'RNA/dsRNA', color: '#1f77b4' },
    { label: 'current', color: colors.accent, marker: '◆' },
  ];

  const loadingText = loading ? 'Loading dinucleotide vectors…' : error ?? 'Need ≥2 phages to decompose.';

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={90}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          {mode === 'di' ? 'DINUCLEOTIDE' : 'CODON'} BIAS DECOMPOSITION
        </Text>
        <Text color={colors.textDim}>Esc to close · 1=di 2=codon</Text>
      </Box>

      {!decomposition ? (
        <Text color={colors.textDim}>{loadingText}</Text>
      ) : (
        <>
          <Text color={colors.textDim}>
            PC1 {(decomposition.components[0].explained * 100).toFixed(1)}% · PC2 {(decomposition.components[1].explained * 100).toFixed(1)}%
          </Text>

          {/* Scatter */}
          <Box flexDirection="column" marginTop={1}>
            {scatterLines.map((row, idx) => (
              <Box key={idx} flexDirection="row">
                {row.map((cell, j) => (
                  <Text key={`${idx}-${j}`} color={cell.color}>{cell.ch}</Text>
                ))}
              </Box>
            ))}
            <Box>
              {legend.map((l, i) => (
                <Text key={l.label} color={l.color} dimColor={false}>
                  {l.marker ?? '•'} {l.label}{i < legend.length - 1 ? '  ' : ''}
                </Text>
              ))}
            </Box>
          </Box>

          {/* Projection list */}
          <Box flexDirection="column" marginTop={1}>
            {decomposition.projections
              .slice()
              .sort((a, b) => b.coords[0] - a.coords[0])
              .map((p, idx) => (
                <Text key={p.name} color={p.name === current?.name ? colors.accent : colors.text}>
                  {String(idx + 1).padStart(2, ' ')} {p.name.padEnd(10, ' ')}  PC1 {p.coords[0].toFixed(3)}  PC2 {p.coords[1].toFixed(3)}
                </Text>
              ))}
          </Box>

          {/* Loadings summary */}
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.textDim}>Top loadings (PC1)</Text>
            <Text color={colors.text}>
              {decomposition.components[0].loadings
                .map((v, i) => ({ k: DINUCLEOTIDES[i], v: v }))
                .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
                .slice(0, 6)
                .map(({ k, v }) => `${k}:${v.toFixed(2)}`)
                .join('  ')}
            </Text>
          </Box>

          {currentCoords && (
            <Box marginTop={1}>
              <Text color={colors.textDim}>
                Current ({current?.name}): PC1 {currentCoords[0].toFixed(3)} · PC2 {currentCoords[1].toFixed(3)}
              </Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
