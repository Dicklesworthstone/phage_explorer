import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useOverlayWidth } from './terminal-size';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import {
  computeDinucleotideFrequencies,
  decomposeBias,
  DINUCLEOTIDES,
  CODONS,
  computeCodonFrequencies,
  type PhageSummary,
} from '@phage-explorer/core';

interface BiasDecompositionOverlayProps {
  repository: PhageRepository;
}

interface LoadedVector {
  id: number;
  name: string;
  vector: number[];
  genomeType: string | null;
  lifecycle: string | null;
  codon: number[];
}
interface CachedVector { sequence: string; vector: number[]; codon: number[] }
interface OwnedVectors {
  repository: PhageRepository;
  phages: PhageSummary[];
  vectors: LoadedVector[];
  loading: boolean;
  error: string | null;
}
const validVector = (value: number[] | null | undefined, dimensions: number): value is number[] => {
  if (!Array.isArray(value) || value.length !== dimensions
    || !value.every(item => Number.isFinite(item) && item >= 0 && item <= 1)) return false;
  const total = value.reduce((sum, item) => sum + item, 0);
  return total === 0 || Math.abs(total - 1) <= 1e-10;
};

export function BiasDecompositionOverlay({ repository }: BiasDecompositionOverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const colors = theme.colors;
  const phages = usePhageStore(s => s.phages);
  const current = usePhageStore(s => s.currentPhage);
  const closeOverlay = usePhageStore(s => s.closeOverlay);

  const [loaded, setLoaded] = useState<OwnedVectors | null>(null);
  const cacheRef = useRef<{ repository: PhageRepository; values: Map<number, CachedVector> } | null>(null);
  const source = useRef({ repository, phages });
  source.current = { repository, phages };
  const owned = loaded?.repository === repository && loaded.phages === phages ? loaded : null;
  const vectors = owned?.vectors ?? [];
  const loading = !owned || owned.loading;
  const error = owned?.error ?? null;
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

  // Repository replacement and catalog changes own a complete new load. Length
  // alone cannot establish that the bases or cached frequency vectors are equal.
  useEffect(() => {
    let cancelled = false;
    const active = () => !cancelled && source.current.repository === repository && source.current.phages === phages;
    if (cacheRef.current?.repository !== repository) cacheRef.current = { repository, values: new Map() };
    const cache = cacheRef.current.values;
    const catalog = phages.map(phage => ({ ...phage }));
    const read = async <T,>(work: Promise<T>): Promise<T> => {
      const value = await work;
      if (!active()) throw new DOMException('Bias analysis superseded.', 'AbortError');
      return value;
    };
    const load = async () => {
      try {
        setLoaded({ repository, phages, vectors: [], loading: true, error: null });
        const items: LoadedVector[] = [];

        for (const p of catalog) {
          const len = await read(repository.getFullGenomeLength(p.id));
          if (!Number.isSafeInteger(len) || len < 0) throw new Error('Invalid genome length for ' + p.name + '.');
          const seq = await read(repository.getSequenceWindow(p.id, 0, len));
          if (seq.length !== len) throw new Error('Incomplete genome sequence for ' + p.name + '; no bias result was produced.');
          const cached = cache.get(p.id);
          const sameBases = cached?.sequence === seq;
          // Native sidecars verify complete sequence hashes. If this mounted
          // source itself changed, recompute rather than trust its old ID cache.
          const storedBias = cached && !sameBases ? null : await read(repository.getBiasVector?.(p.id) ?? Promise.resolve(null));
          const storedCodon = cached && !sameBases ? null : await read(repository.getCodonVector?.(p.id) ?? Promise.resolve(null));
          const cachedBias = sameBases ? cached.vector : validVector(storedBias, DINUCLEOTIDES.length) ? storedBias : null;
          const cachedCodon = sameBases ? cached.codon : validVector(storedCodon, CODONS.length) ? storedCodon : null;
          const vector = cachedBias ?? computeDinucleotideFrequencies(seq);
          const codon = cachedCodon ?? computeCodonFrequencies(seq);
          const meta = await read(repository.getPhageById(p.id));

          const entry: LoadedVector = {
            id: p.id,
            name: p.name,
            vector,
            genomeType: meta?.genomeType ?? null,
            lifecycle: (meta?.lifecycle ?? p.lifecycle) ?? null,
            codon,
          };

          // Persist caches if freshly computed
          if (!cachedBias && repository.setBiasVector) {
            repository.setBiasVector(p.id, vector).catch(() => {});
          }
          if (!cachedCodon && repository.setCodonVector) {
            repository.setCodonVector(p.id, codon).catch(() => {});
          }

          cache.set(p.id, { sequence: seq, vector, codon });
          items.push(entry);
        }
        if (active()) setLoaded({ repository, phages, vectors: items, loading: false, error: null });
      } catch (e) {
        if (active()) setLoaded({ repository, phages, vectors: [], loading: false,
          error: e instanceof Error ? e.message : String(e) });
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
        : vectors.map(v => ({ name: v.name, vector: v.codon }));
    const result = decomposeBias(rows);
    return result ? { ...result, projections: result.projections.map((projection, index) => ({
      ...projection, id: vectors[index].id,
    })) } : null;
  }, [vectors, mode]);

  const currentCoords = useMemo(() => {
    if (!decomposition || !current) return null;
    return decomposition.projections.find(p => p.id === current.id)?.coords ?? null;
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

    const typeColor = (id: number): string => {
      const meta = vectors.find(v => v.id === id);
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
      const color = p.id === current?.id ? colors.accent : typeColor(p.id);
      const ch = p.id === current?.id ? '◆' : '•';
      grid[height - 1 - y][x] = { ch, color };
    });

    return grid.map(row => row.map(cell => cell));
  }, [decomposition, current?.id, vectors, colors.accent, colors.text, colors.textDim]);

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
      width={useOverlayWidth(90)}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          {mode === 'di' ? 'DINUCLEOTIDE' : 'CODON'} BIAS DECOMPOSITION
        </Text>
        <Text color={colors.textDim}>Esc to close · 1=dinucleotide PCA · 2=codon PCA</Text>
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
                <Text key={p.id} color={p.id === current?.id ? colors.accent : colors.text}>
                  {String(idx + 1).padStart(2, ' ')} {p.name.padEnd(10, ' ')}  PC1 {p.coords[0].toFixed(3)}  PC2 {p.coords[1].toFixed(3)}
                </Text>
              ))}
          </Box>

          {/* Loadings summary */}
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.textDim}>Top loadings (PC1)</Text>
            <Text color={colors.text}>
              {decomposition.components[0].loadings
                .map((v, i) => ({ k: mode === 'codon' ? CODONS[i] : DINUCLEOTIDES[i], v: v }))
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
