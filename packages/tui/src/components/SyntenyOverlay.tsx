import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import type { PhageFull, PhageSummary } from '@phage-explorer/core';
import { alignSynteny } from '@phage-explorer/comparison';
import type { SyntenyAnalysis, SyntenyBlock } from '@phage-explorer/comparison';

interface SyntenyOverlayProps {
  repository: PhageRepository;
}

interface OwnedSynteny {
  repository: PhageRepository;
  selectedA: PhageSummary;
  selectedB: PhageSummary;
  revision: number;
  phageA: PhageFull | null;
  phageB: PhageFull | null;
  analysis: SyntenyAnalysis | null;
  loading: boolean;
  error: string | null;
}

export function SyntenyOverlay({ repository }: SyntenyOverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const closeOverlay = usePhageStore(s => s.closeOverlay);
  const setOverlayData = usePhageStore(s => s.setOverlayData);
  const colors = theme.colors;
  const terminalCols = usePhageStore(s => s.terminalCols);
  
  const phages = usePhageStore(s => s.phages);
  // Default to comparing current phage with previous one (or first one)
  const currentPhageIndex = usePhageStore(s => s.currentPhageIndex);
  const comparisonPhageAIndex = usePhageStore(s => s.comparisonPhageAIndex);
  const comparisonPhageBIndex = usePhageStore(s => s.comparisonPhageBIndex);
  const open = usePhageStore(s => s.overlays.includes('synteny'));
  
  const [result, setResult] = useState<OwnedSynteny | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedAIndex, setSelectedAIndex] = useState<number>(() => {
    const remembered = (usePhageStore.getState().overlayData as { synteny?: { a: number; b: number } }).synteny;
    if (remembered && typeof remembered.a === 'number') return remembered.a;
    if (typeof comparisonPhageAIndex === 'number') return comparisonPhageAIndex;
    return currentPhageIndex;
  });
  const [selectedBIndex, setSelectedBIndex] = useState<number>(() => {
    const remembered = (usePhageStore.getState().overlayData as { synteny?: { a: number; b: number } }).synteny;
    if (remembered && typeof remembered.b === 'number') return remembered.b;
    if (typeof comparisonPhageBIndex === 'number') return comparisonPhageBIndex;
    const prev = currentPhageIndex - 1;
    if (prev >= 0) return prev;
    return Math.min(currentPhageIndex + 1, Math.max(0, phages.length - 1));
  });

  const normalizedAIndex = Math.max(0, Math.min(selectedAIndex, phages.length - 1));
  const clampedBIndex = Math.max(0, Math.min(selectedBIndex, phages.length - 1));
  const normalizedBIndex = phages.length > 1 && normalizedAIndex === clampedBIndex
    ? (clampedBIndex + 1) % phages.length : clampedBIndex;
  const selectedA = phages[normalizedAIndex] ?? null;
  const selectedB = phages[normalizedBIndex] ?? null;
  const source = useRef({ repository, selectedA, selectedB, revision, open });
  source.current = { repository, selectedA, selectedB, revision, open };
  const operation = useRef<AbortController | null>(null);
  const owned = open && result?.repository === repository && result.selectedA === selectedA
    && result.selectedB === selectedB && result.revision === revision ? result : null;
  const phageA = owned?.phageA ?? null, phageB = owned?.phageB ?? null;
  const analysis = owned?.analysis ?? null;
  const error = phages.length < 2 ? 'At least two genomes are needed for synteny analysis.' : owned?.error ?? null;
  const loading = Boolean(open && selectedA && selectedB && selectedA !== selectedB && (!owned || owned.loading));

  useEffect(() => {
    setSelectedAIndex(normalizedAIndex);
    setSelectedBIndex(normalizedBIndex);
  }, [normalizedAIndex, normalizedBIndex]);

  // Numeric IDs and list indices are repository-local. Keep just the accepted
  // snapshot and revoke old reads instead of caching across unrelated sources.
  useEffect(() => {
    if (!open || !selectedA || !selectedB || selectedA.id === selectedB.id) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    const owner = { repository, selectedA, selectedB, revision };
    const current = () => {
      const state = usePhageStore.getState();
      return !controller.signal.aborted && operation.current === controller && source.current.open
        && source.current.repository === repository && source.current.selectedA === selectedA
        && source.current.selectedB === selectedB && source.current.revision === revision
        && state.overlays.includes('synteny') && state.phages[normalizedAIndex] === selectedA
        && state.phages[normalizedBIndex] === selectedB;
    };
    setResult({ ...owner, phageA: null, phageB: null, analysis: null, loading: true, error: null });
    void (async () => {
      try {
        const [pA, pB] = await Promise.all([
          repository.getPhageById(selectedA.id),
          repository.getPhageById(selectedB.id),
        ]);
        if (!current()) return;
        if (!pA || !pB) throw new Error('A selected genome is no longer available. Select the genomes again.');
        if (pA.id !== selectedA.id || pB.id !== selectedB.id || pA.accession !== selectedA.accession || pB.accession !== selectedB.accession) {
          throw new Error('The loaded genomes do not match the selected sources.');
        }
        if (!pA.genes?.length || !pB.genes?.length) throw new Error('Both genomes need gene annotations for synteny analysis.');
        const alignment = alignSynteny(pA.genes, pB.genes);
        if (!current()) return;
        setResult({ ...owner, phageA: pA, phageB: pB, analysis: alignment, loading: false, error: null });
        setOverlayData({ ...usePhageStore.getState().overlayData,
          synteny: { a: normalizedAIndex, b: normalizedBIndex } });
      } catch (err) {
        if (current()) setResult({ ...owner, phageA: null, phageB: null, analysis: null, loading: false,
          error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { controller.abort(); if (operation.current === controller) operation.current = null; };
  }, [open, repository, selectedA, selectedB, normalizedAIndex, normalizedBIndex, revision, setOverlayData]);

  const coverageA = useMemo(() => {
    if (!analysis || !phageA?.genes?.length) return 0;
    const totalLen = phageA.genomeLength || 1;
    const covered = analysis.blocks.reduce((sum, block) => {
      const genes = phageA.genes;
      const start = genes[block.startIdxA];
      const end = genes[block.endIdxA];
      if (!start || !end) return sum;
      return sum + Math.max(0, end.endPos - start.startPos + 1);
    }, 0);
    return Math.min(1, covered / totalLen);
  }, [analysis, phageA]);

  const coverageB = useMemo(() => {
    if (!analysis || !phageB?.genes?.length) return 0;
    const totalLen = phageB.genomeLength || 1;
    const covered = analysis.blocks.reduce((sum, block) => {
      const genes = phageB.genes;
      const start = genes[block.startIdxB];
      const end = genes[block.endIdxB];
      if (!start || !end) return sum;
      return sum + Math.max(0, end.endPos - start.startPos + 1);
    }, 0);
    return Math.min(1, covered / totalLen);
  }, [analysis, phageB]);

  const width = useMemo(() => {
    const available = Math.max(40, terminalCols - 20);
    return Math.min(available, 100);
  }, [terminalCols]);

  useInput((input, key) => {
    if (key.escape) {
      operation.current?.abort();
      closeOverlay('synteny');
      return;
    }
    if (key.leftArrow) {
      setSelectedBIndex(idx => (idx - 1 + phages.length) % Math.max(phages.length, 1));
    }
    if (key.rightArrow) {
      setSelectedBIndex(idx => (idx + 1) % Math.max(phages.length, 1));
    }
    if (key.upArrow) {
      setSelectedAIndex(idx => (idx - 1 + phages.length) % Math.max(phages.length, 1));
    }
    if (key.downArrow) {
      setSelectedAIndex(idx => (idx + 1) % Math.max(phages.length, 1));
    }
    if (input === 's' || input === 'S') {
      const a = selectedAIndex;
      const b = selectedBIndex;
      setSelectedAIndex(() => b);
      setSelectedBIndex(() => a);
    }
    if (input === 'r' || input === 'R') {
      operation.current?.abort();
      setRevision(value => value + 1);
    }
  }, { isActive: open });

  if (loading) return <Text>Loading synteny data...</Text>;
  if (error) return <Text color={colors.error}>Error: {error} (R to retry)</Text>;
  if (!phageA || !phageB || !analysis) return <Text>No data available</Text>;
  
  // Render a single gene bar with block coloring
  const renderGeneBar = (phage: PhageFull, blocks: SyntenyBlock[], isGenomeA: boolean) => {
    const totalLen = phage.genomeLength || 1;
    // Create canvas
    const chars = Array(width).fill('░');
    
    // Fill blocks
    const sortedBlocks = [...blocks].sort((a, b) => {
      const genes = phage.genes;
      const lenA = isGenomeA
        ? (genes[a.endIdxA]?.endPos ?? 0) - (genes[a.startIdxA]?.startPos ?? 0)
        : (genes[a.endIdxB]?.endPos ?? 0) - (genes[a.startIdxB]?.startPos ?? 0);
      const lenB = isGenomeA
        ? (genes[b.endIdxA]?.endPos ?? 0) - (genes[b.startIdxA]?.startPos ?? 0)
        : (genes[b.endIdxB]?.endPos ?? 0) - (genes[b.startIdxB]?.startPos ?? 0);
      return lenB - lenA;
    });

    sortedBlocks.forEach((block, blockIdx) => {
      // Determine range in genome
      const genes = phage.genes;
      const startGeneIdx = isGenomeA ? block.startIdxA : block.startIdxB;
      const endGeneIdx = isGenomeA ? block.endIdxA : block.endIdxB;
      
      if (startGeneIdx >= genes.length || endGeneIdx >= genes.length) return;
      
      const startPos = genes[startGeneIdx].startPos;
      const endPos = genes[endGeneIdx].endPos;
      
      const startPixel = Math.floor((startPos / totalLen) * width);
      const endPixel = Math.ceil((endPos / totalLen) * width);
      
      const colorChar = (blockIdx % 2 === 0) ? '█' : '▓'; // Alternating patterns for blocks
      
      for (let i = startPixel; i < Math.min(width, endPixel); i++) {
        chars[i] = colorChar;
      }
    });

    return (
        <Box>
            <Text color={colors.text}>{phage.name.slice(0, 15).padEnd(16)} </Text>
            <Text color={colors.accent}>{chars.join('')}</Text>
        </Box>
    );
  };

  // Render connections
  const renderConnections = () => {
    const lines = Array(3).fill('').map(() => Array(width).fill(' '));
    
    const sortedBlocks = [...analysis.blocks].sort((a, b) => {
      const lenA = (phageA.genes[b.endIdxA]?.endPos ?? 0) - (phageA.genes[b.startIdxA]?.startPos ?? 0);
      const lenB = (phageA.genes[a.endIdxA]?.endPos ?? 0) - (phageA.genes[a.startIdxA]?.startPos ?? 0);
      return lenA - lenB;
    });

    sortedBlocks.forEach((block) => {
        const genesA = phageA.genes;
        const genesB = phageB.genes;
        
        const centerA = (genesA[block.startIdxA].startPos + genesA[block.endIdxA].endPos) / 2;
        const centerB = (genesB[block.startIdxB].startPos + genesB[block.endIdxB].endPos) / 2;
        
        const posA = Math.floor((centerA / (phageA.genomeLength || 1)) * width);
        const posB = Math.floor((centerB / (phageB.genomeLength || 1)) * width);
        
        // Draw line from posA (top) to posB (bottom)
        // Simple Bresenham-like or just direct vertical/diagonal char
        const mid = Math.round((posA + posB) / 2);
        
        if (posA >= 0 && posA < width) lines[0][posA] = '│';
        if (mid >= 0 && mid < width) lines[1][mid] = posA === posB ? '│' : (posA < posB ? '╲' : '╱');
        if (posB >= 0 && posB < width) lines[2][posB] = '│';
    });
    
    return (
        <Box flexDirection="column" marginLeft={16}>
            <Text color={colors.textDim}>{lines[0].join('')}</Text>
            <Text color={colors.textDim}>{lines[1].join('')}</Text>
            <Text color={colors.textDim}>{lines[2].join('')}</Text>
        </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      paddingX={2}
      paddingY={1}
      width={Math.max(70, Math.min(terminalCols - 4, 110))}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>FUNCTIONAL SYNTENY ALIGNMENT</Text>
        <Text color={colors.textDim}>Esc close | ↑/↓ change A | ←/→ change B | S swap | R retry</Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text>
          A: <Text bold color={colors.accent}>{phageA.name}</Text> (#{normalizedAIndex + 1})
          {'  '}B: <Text bold color={colors.accent}>{phageB.name}</Text> (#{normalizedBIndex + 1})
        </Text>
        <Text>
          Score: <Text bold color={colors.success}>{(analysis.globalScore * 100).toFixed(1)}%</Text>
          {' '}| Blocks: {analysis.blocks.length}
          {' '}| DTW Dist: {analysis.dtwDistance.toFixed(1)}
          {' '}| Cov A: {(coverageA * 100).toFixed(1)}%
          {' '}| Cov B: {(coverageB * 100).toFixed(1)}%
        </Text>
      </Box>

      {renderGeneBar(phageA, analysis.blocks, true)}
      {renderConnections()}
      {renderGeneBar(phageB, analysis.blocks, false)}
      
      <Box marginTop={1} borderStyle="single" paddingX={1} flexDirection="column">
          <Text underline>Synteny Blocks (Top 5):</Text>
          {analysis.blocks.slice(0, 5).map((b, i) => (
              <Text key={i}>
                  Block {i+1}: {phageA.genes[b.startIdxA]?.name || '?'}..{phageA.genes[b.endIdxA]?.name || '?'} 
                  {' <--> '} 
                  {phageB.genes[b.startIdxB]?.name || '?'}..{phageB.genes[b.endIdxB]?.name || '?'}
                  {' '}({(b.score * 100).toFixed(0)}%)
              </Text>
          ))}
          {analysis.blocks.length === 0 && (
            <Text color={colors.textDim}>No syntenic blocks detected.</Text>
          )}
      </Box>
    </Box>
  );
}
