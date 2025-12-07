import React, { useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { usePhageStore, type ComparisonTab } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import type { HudTheme } from '@phage-explorer/core';
import {
  compareGenomes,
  createSimilarityBar,
  formatSimilarity,
  getSimilarityColor,
  type GenomeComparisonResult,
} from '@phage-explorer/comparison';

interface ComparisonOverlayProps {
  repository: PhageRepository;
}

export function ComparisonOverlay({ repository }: ComparisonOverlayProps): React.ReactElement {
  const theme = usePhageStore(s => s.currentTheme);
  const phages = usePhageStore(s => s.phages);
  const phageAIndex = usePhageStore(s => s.comparisonPhageAIndex);
  const phageBIndex = usePhageStore(s => s.comparisonPhageBIndex);
  const result = usePhageStore(s => s.comparisonResult);
  const loading = usePhageStore(s => s.comparisonLoading);
  const tab = usePhageStore(s => s.comparisonTab);
  const selectingPhage = usePhageStore(s => s.comparisonSelectingPhage);
  const terminalCols = usePhageStore(s => s.terminalCols);
  const terminalRows = usePhageStore(s => s.terminalRows);

  const closeComparison = usePhageStore(s => s.closeComparison);
  const setComparisonResult = usePhageStore(s => s.setComparisonResult);
  const setComparisonLoading = usePhageStore(s => s.setComparisonLoading);
  const nextComparisonTab = usePhageStore(s => s.nextComparisonTab);
  const prevComparisonTab = usePhageStore(s => s.prevComparisonTab);
  const startSelectingPhage = usePhageStore(s => s.startSelectingPhage);
  const confirmPhageSelection = usePhageStore(s => s.confirmPhageSelection);
  const cancelPhageSelection = usePhageStore(s => s.cancelPhageSelection);
  const swapComparisonPhages = usePhageStore(s => s.swapComparisonPhages);

  const colors = theme.colors;

  const phageA = phageAIndex !== null ? phages[phageAIndex] : null;
  const phageB = phageBIndex !== null ? phages[phageBIndex] : null;

  // Run comparison when phages are selected
  const runComparison = useCallback(async () => {
    if (!phageA || !phageB || phageA.id === phageB.id) return;

    setComparisonLoading(true);
    try {
      // Fetch full data for both phages
      const [fullA, fullB] = await Promise.all([
        repository.getPhageById(phageA.id),
        repository.getPhageById(phageB.id),
      ]);

      if (!fullA || !fullB) {
        setComparisonLoading(false);
        return;
      }

      // Fetch sequences
      const [seqA, seqB] = await Promise.all([
        repository.getSequenceWindow(phageA.id, 0, fullA.genomeLength ?? 0),
        repository.getSequenceWindow(phageB.id, 0, fullB.genomeLength ?? 0),
      ]);

      // Run comparison
      const compResult = await compareGenomes(
        { id: phageA.id, name: phageA.name, accession: phageA.accession },
        { id: phageB.id, name: phageB.name, accession: phageB.accession },
        seqA,
        seqB,
        fullA.genes,
        fullB.genes,
        fullA.codonUsage,
        fullB.codonUsage
      );

      setComparisonResult(compResult);
    } catch (err) {
      console.error('Comparison failed:', err);
    } finally {
      setComparisonLoading(false);
    }
  }, [phageA, phageB, repository, setComparisonResult, setComparisonLoading]);

  // Auto-run comparison when phages change
  useEffect(() => {
    if (phageA && phageB && phageA.id !== phageB.id && !result && !loading) {
      runComparison();
    }
  }, [phageA, phageB, result, loading, runComparison]);

  // Handle keyboard input
  useInput((input, key) => {
    if (selectingPhage) {
      // Phage selection mode
      if (key.escape) {
        cancelPhageSelection();
      } else if (key.upArrow || key.downArrow) {
        // Navigate phage list (handled by number keys for simplicity)
      } else if (/^[0-9]$/.test(input)) {
        const idx = parseInt(input, 10);
        if (idx < phages.length) {
          confirmPhageSelection(idx);
        }
      }
      return;
    }

    // Normal overlay mode
    if (key.escape) {
      closeComparison();
    } else if (key.leftArrow || input === 'h' || input === 'H') {
      prevComparisonTab();
    } else if (key.rightArrow || input === 'l' || input === 'L' || key.tab) {
      nextComparisonTab();
    } else if (input === 'a' || input === 'A') {
      startSelectingPhage('A');
    } else if (input === 'b' || input === 'B') {
      startSelectingPhage('B');
    } else if (input === 'x' || input === 'X') {
      swapComparisonPhages();
    } else if (input === 'r' || input === 'R') {
      runComparison();
    }
  });

  const overlayWidth = Math.min(90, terminalCols - 4);
  const overlayHeight = Math.min(35, terminalRows - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.accent}
      width={overlayWidth}
      height={overlayHeight}
      paddingX={1}
    >
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={colors.accent} bold>
          GENOME COMPARISON
        </Text>
        <Text color={colors.textDim}>
          Tab {(['summary', 'kmer', 'information', 'correlation', 'biological', 'genes'] as ComparisonTab[]).indexOf(tab) + 1}/6
        </Text>
      </Box>

      {/* Phage Selection */}
      <Box marginBottom={1}>
        <Box marginRight={2}>
          <Text color={selectingPhage === 'A' ? colors.accent : colors.primary}>
            [A] {phageA?.name ?? 'Select...'} ({phageA?.genomeLength?.toLocaleString() ?? '?'} bp)
          </Text>
        </Box>
        <Text color={colors.textDim}> vs </Text>
        <Box marginLeft={2}>
          <Text color={selectingPhage === 'B' ? colors.accent : colors.primary}>
            [B] {phageB?.name ?? 'Select...'} ({phageB?.genomeLength?.toLocaleString() ?? '?'} bp)
          </Text>
        </Box>
      </Box>

      {/* Tab Bar */}
      <Box marginBottom={1} gap={1}>
        {(['summary', 'kmer', 'information', 'correlation', 'biological', 'genes'] as ComparisonTab[]).map((t) => (
          <Text
            key={t}
            color={t === tab ? colors.accent : colors.textDim}
            bold={t === tab}
            inverse={t === tab}
          >
            {' '}{t.charAt(0).toUpperCase() + t.slice(1)}{' '}
          </Text>
        ))}
      </Box>

      {/* Loading State */}
      {loading && (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={colors.accent}>Computing comparison metrics...</Text>
        </Box>
      )}

      {/* Phage Selection Mode */}
      {selectingPhage && (
        <Box flexDirection="column" flexGrow={1}>
          <Text color={colors.accent} bold>
            Select Phage {selectingPhage} (press 0-9 or Esc to cancel):
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {phages.slice(0, 10).map((p, i) => (
              <Text key={p.id} color={colors.text}>
                [{i}] {p.name} ({p.genomeLength?.toLocaleString()} bp)
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* Results Content */}
      {!loading && !selectingPhage && result && (
        <Box flexDirection="column" flexGrow={1} overflowY="hidden">
          {tab === 'summary' && <SummaryTab result={result} colors={colors} />}
          {tab === 'kmer' && <KmerTab result={result} colors={colors} />}
          {tab === 'information' && <InformationTab result={result} colors={colors} />}
          {tab === 'correlation' && <CorrelationTab result={result} colors={colors} />}
          {tab === 'biological' && <BiologicalTab result={result} colors={colors} />}
          {tab === 'genes' && <GenesTab result={result} colors={colors} />}
        </Box>
      )}

      {/* No comparison yet */}
      {!loading && !selectingPhage && !result && phageA && phageB && phageA.id !== phageB.id && (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={colors.textDim}>Press R to run comparison</Text>
        </Box>
      )}

      {/* Same phage selected */}
      {phageA && phageB && phageA.id === phageB.id && (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={colors.warning}>Select two different phages to compare</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} justifyContent="center">
        <Text color={colors.textDim}>
          [A/B] Select phages  [X] Swap  [R] Rerun  [←→] Tab  [Esc] Close
        </Text>
      </Box>
    </Box>
  );
}

// Tab Components
interface TabProps {
  result: GenomeComparisonResult;
  colors: HudTheme;
}

function SummaryTab({ result, colors }: TabProps): React.ReactElement {
  const { summary } = result;

  return (
    <Box flexDirection="column">
      {/* Overall Score */}
      <Box marginBottom={1}>
        <Text color={colors.primary} bold>Overall Similarity: </Text>
        <Text color={getSimilarityColor(summary.overallSimilarity)}>
          {summary.overallSimilarity.toFixed(1)}% - {formatSimilarity(summary.overallSimilarity)}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={colors.text}>
          {createSimilarityBar(summary.overallSimilarity, 30)}
        </Text>
      </Box>

      {/* Component Scores */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.textDim}>Component Scores:</Text>
        <MetricRow label="Sequence" value={summary.sequenceSimilarity} colors={colors} />
        <MetricRow label="Composition" value={summary.compositionSimilarity} colors={colors} />
        <MetricRow label="Codon Usage" value={summary.codonUsageSimilarity} colors={colors} />
        <MetricRow label="Gene Content" value={summary.geneContentSimilarity} colors={colors} />
      </Box>

      {/* Insights */}
      <Box flexDirection="column">
        <Text color={colors.primary} bold>Key Insights:</Text>
        {summary.insights.slice(0, 6).map((insight, i) => (
          <Text key={i} color={insight.type === 'similarity' ? '#22c55e' : insight.type === 'difference' ? '#ef4444' : colors.text}>
            {insight.type === 'similarity' ? '+' : insight.type === 'difference' ? '-' : '*'} {insight.message}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function KmerTab({ result, colors }: TabProps): React.ReactElement {
  const { kmerAnalysis } = result;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={colors.primary} bold>K-mer Analysis (Alignment-Free)</Text>
      </Box>

      {kmerAnalysis.map((k) => (
        <Box key={k.k} flexDirection="column" marginBottom={1}>
          <Text color={colors.accent}>k = {k.k}</Text>
          <Box flexDirection="column" paddingLeft={2}>
            <Text color={colors.text}>
              Unique k-mers: {k.uniqueKmersA.toLocaleString()} vs {k.uniqueKmersB.toLocaleString()} | Shared: {k.sharedKmers.toLocaleString()}
            </Text>
            <MetricRow label="Jaccard Index" value={k.jaccardIndex * 100} colors={colors} />
            <MetricRow label="Cosine Similarity" value={k.cosineSimilarity * 100} colors={colors} />
            <Text color={colors.text}>
              Containment: {(k.containmentAinB * 100).toFixed(1)}% / {(k.containmentBinA * 100).toFixed(1)}%
            </Text>
            <Text color={colors.text}>
              Bray-Curtis Dissimilarity: {(k.brayCurtisDissimilarity * 100).toFixed(1)}%
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function InformationTab({ result, colors }: TabProps): React.ReactElement {
  const { informationTheory } = result;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={colors.primary} bold>Information Theory Metrics</Text>
      </Box>

      <Box flexDirection="column" gap={0}>
        <Text color={colors.accent}>Shannon Entropy (bits/base):</Text>
        <Text color={colors.text}>  Phage A: {informationTheory.entropyA.toFixed(4)}</Text>
        <Text color={colors.text}>  Phage B: {informationTheory.entropyB.toFixed(4)}</Text>
        <Text color={colors.text}>  Joint: {informationTheory.jointEntropy.toFixed(4)}</Text>

        <Box marginTop={1}><Text color={colors.accent}>Mutual Information:</Text></Box>
        <Text color={colors.text}>  I(A;B) = {informationTheory.mutualInformation.toFixed(4)} bits</Text>
        <Text color={colors.text}>  Normalized MI = {(informationTheory.normalizedMI * 100).toFixed(1)}%</Text>

        <Box marginTop={1}><Text color={colors.accent}>Divergence Measures:</Text></Box>
        <Text color={colors.text}>  Jensen-Shannon: {informationTheory.jensenShannonDivergence.toFixed(4)}</Text>
        <Text color={colors.text}>  KL(A||B): {informationTheory.kullbackLeiblerAtoB.toFixed(4)}</Text>
        <Text color={colors.text}>  KL(B||A): {informationTheory.kullbackLeiblerBtoA.toFixed(4)}</Text>
        <Text color={colors.text}>  Relative Entropy: {informationTheory.relativeEntropy.toFixed(4)}</Text>
      </Box>
    </Box>
  );
}

function CorrelationTab({ result, colors }: TabProps): React.ReactElement {
  const { rankCorrelation, editDistance } = result;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={colors.primary} bold>Rank Correlation (Codon Usage)</Text>
      </Box>

      <Box flexDirection="column">
        <Text color={colors.accent}>Spearman's Rho:</Text>
        <Text color={colors.text}>  rho = {rankCorrelation.spearmanRho.toFixed(4)} ({rankCorrelation.spearmanStrength})</Text>
        <Text color={colors.text}>  p-value = {rankCorrelation.spearmanPValue.toExponential(2)}</Text>

        <Box marginTop={1}><Text color={colors.accent}>Kendall's Tau:</Text></Box>
        <Text color={colors.text}>  tau = {rankCorrelation.kendallTau.toFixed(4)} ({rankCorrelation.kendallStrength})</Text>
        <Text color={colors.text}>  p-value = {rankCorrelation.kendallPValue.toExponential(2)}</Text>

        <Box marginTop={1}><Text color={colors.accent}>Hoeffding's D:</Text></Box>
        <Text color={colors.text}>  D = {rankCorrelation.hoeffdingD.toFixed(4)}</Text>
        <Text color={colors.textDim}>  (detects non-monotonic dependence)</Text>
      </Box>

      <Box marginTop={1}><Text color={colors.primary} bold>Edit Distance</Text></Box>
      <Box flexDirection="column">
        <Text color={colors.text}>
          Levenshtein: {editDistance.levenshteinDistance.toLocaleString()} edits
          {editDistance.isApproximate && ' (approx)'}
        </Text>
        <MetricRow label="Similarity" value={editDistance.levenshteinSimilarity * 100} colors={colors} />
        <Text color={colors.textDim}>
          Operations: +{editDistance.insertions} -{editDistance.deletions} ~{editDistance.substitutions}
        </Text>
      </Box>
    </Box>
  );
}

function BiologicalTab({ result, colors }: TabProps): React.ReactElement {
  const { biological, codonUsage, aminoAcidUsage } = result;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={colors.primary} bold>Biological Metrics</Text>
      </Box>

      <Box flexDirection="column">
        <Text color={colors.accent}>Average Nucleotide Identity (ANI):</Text>
        <MetricRow label="ANI Score" value={biological.aniScore} colors={colors} />

        <Box marginTop={1}><Text color={colors.accent}>GC Content:</Text></Box>
        <Text color={colors.text}>  Phage A: {biological.gcContentA.toFixed(1)}%</Text>
        <Text color={colors.text}>  Phage B: {biological.gcContentB.toFixed(1)}%</Text>
        <Text color={colors.text}>  Difference: {biological.gcDifference.toFixed(1)}%</Text>

        <Box marginTop={1}><Text color={colors.accent}>Genome Size:</Text></Box>
        <Text color={colors.text}>  Ratio: {(biological.lengthRatio * 100).toFixed(1)}%</Text>
        <Text color={colors.text}>  Difference: {biological.lengthDifference.toLocaleString()} bp</Text>

        <Box marginTop={1}><Text color={colors.accent}>Codon Usage (RSCU):</Text></Box>
        <MetricRow label="Cosine Similarity" value={codonUsage.rscuCosineSimilarity * 100} colors={colors} />
        <Text color={colors.textDim}>
          Chi-square: {codonUsage.chiSquareStatistic.toFixed(1)} (p={codonUsage.chiSquarePValue.toExponential(2)})
        </Text>

        <Box marginTop={1}><Text color={colors.accent}>Amino Acid Usage:</Text></Box>
        <MetricRow label="Cosine Similarity" value={aminoAcidUsage.cosineSimilarity * 100} colors={colors} />
        <Text color={colors.text}>  Correlation: {aminoAcidUsage.correlationCoefficient.toFixed(3)}</Text>
      </Box>
    </Box>
  );
}

function GenesTab({ result, colors }: TabProps): React.ReactElement {
  const { geneContent } = result;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={colors.primary} bold>Gene Content Comparison</Text>
      </Box>

      <Box flexDirection="column">
        <Text color={colors.accent}>Gene Counts:</Text>
        <Text color={colors.text}>  Phage A: {geneContent.genesA} genes ({geneContent.geneDensityA.toFixed(2)} per kb)</Text>
        <Text color={colors.text}>  Phage B: {geneContent.genesB} genes ({geneContent.geneDensityB.toFixed(2)} per kb)</Text>

        <Box marginTop={1}><Text color={colors.accent}>Shared vs Unique:</Text></Box>
        <Text color={'#22c55e'}>  Shared genes: {geneContent.sharedGeneNames}</Text>
        <Text color={colors.text}>  Unique to A: {geneContent.uniqueToA}</Text>
        <Text color={colors.text}>  Unique to B: {geneContent.uniqueToB}</Text>
        <MetricRow label="Gene Jaccard" value={geneContent.geneNameJaccard * 100} colors={colors} />

        <Box marginTop={1}><Text color={colors.accent}>Avg Gene Length:</Text></Box>
        <Text color={colors.text}>  Phage A: {geneContent.avgGeneLengthA.toFixed(0)} bp</Text>
        <Text color={colors.text}>  Phage B: {geneContent.avgGeneLengthB.toFixed(0)} bp</Text>

        {geneContent.topSharedGenes.length > 0 && (
          <>
            <Box marginTop={1}><Text color={colors.accent}>Shared Genes:</Text></Box>
            <Text color={colors.text}>  {geneContent.topSharedGenes.slice(0, 5).join(', ')}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

// Helper component for metric rows with similarity bars
function MetricRow({ label, value, colors }: { label: string; value: number; colors: HudTheme }): React.ReactElement {
  return (
    <Box>
      <Text color={colors.text}>{label.padEnd(18)}</Text>
      <Text color={getSimilarityColor(value)}>{createSimilarityBar(value, 15)}</Text>
      <Text color={getSimilarityColor(value)}> {value.toFixed(1)}%</Text>
    </Box>
  );
}
