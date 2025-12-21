/**
 * CocktailCompatibilityOverlay - Phage Cocktail Compatibility Matrix
 *
 * Web MVP: computes an explainable pairwise compatibility score for phage pairs,
 * then runs a simple greedy cocktail selection to maximize selected host coverage
 * subject to a compatibility threshold.
 *
 * Notes:
 * - This implementation is intentionally heuristic (late-2025 data availability).
 * - Uses lifecycle + host string + protein domain similarity as proxy signals.
 * - Enhanced with lysis timing, Sie gene detection, and receptor overlap scoring.
 *
 * Part of: phage_explorer-4ty (Advanced: Phage Cocktail Compatibility Matrix)
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { PhageFull, PhageSummary } from '@phage-explorer/core';
import type { PhageRepository, ProteinDomain } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { HeatmapCanvas } from '../primitives/HeatmapCanvas';
import type { ColorScale, HeatmapHover } from '../primitives/types';

type Lifecycle = 'lytic' | 'temperate' | 'unknown';
type SimilarityMetric = 'weightedJaccard' | 'jaccard';
type LysisTiming = 'early' | 'middle' | 'late' | 'unknown';

interface CompatibilityFactor {
  name: string;
  contribution: number;
  reason: string;
}

interface PairDetails {
  score: number;
  compatible: boolean;
  domainSimilarity: number;
  sharedDistinctDomains: number;
  factors: CompatibilityFactor[];
}

interface GeneAnnotation {
  id: number;
  name: string | null;
  product: string | null;
  startPos: number;
  endPos: number;
}

interface PhageFeatures {
  id: number;
  name: string;
  host: string | null;
  lifecycle: Lifecycle;
  lysisTiming: LysisTiming;
  hasSieGenes: boolean;
  sieGeneCount: number;
  hasImmunityRegion: boolean;
  receptorHints: string[];
  domainCounts: Map<string, number>;
  distinctDomains: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLifecycle(lifecycle: string | null): Lifecycle {
  const v = (lifecycle ?? '').toLowerCase();
  if (v.includes('temperate') || v.includes('lysogen')) return 'temperate';
  if (v.includes('lytic')) return 'lytic';
  return 'unknown';
}

const LYSIS_KEYWORDS = {
  early: ['holin', 'antiholin', 'lysis inhibition'],
  middle: ['endolysin', 'lysozyme', 'muramidase', 'transglycosylase'],
  late: ['spanin', 'rz', 'rz1', 'lysis completion'],
};

const SIE_KEYWORDS = [
  'sie', 'superinfection exclusion', 'exclusion protein',
  'imm', 'immunity', 'repressor', 'anti-repressor',
  'rex', 'rexab', 'old gene', 'tin', 'sp',
];

const RECEPTOR_DOMAIN_KEYWORDS = [
  'tail fiber', 'tail_fiber', 'tailspike', 'receptor',
  'rbp', 'adhesin', 'baseplate', 'gp37', 'gp38', 'gp12',
];

function inferLysisTiming(genes: GeneAnnotation[], genomeLength: number): LysisTiming {
  if (!genes || genes.length === 0 || genomeLength === 0) return 'unknown';
  const lysisGenes: Array<{ timing: LysisTiming; position: number }> = [];
  for (const gene of genes) {
    const text = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
    let timing: LysisTiming = 'unknown';
    for (const keyword of LYSIS_KEYWORDS.early) {
      if (text.includes(keyword)) timing = 'early';
    }
    for (const keyword of LYSIS_KEYWORDS.middle) {
      if (text.includes(keyword)) timing = timing === 'unknown' ? 'middle' : timing;
    }
    for (const keyword of LYSIS_KEYWORDS.late) {
      if (text.includes(keyword)) timing = 'late';
    }
    if (timing !== 'unknown') {
      const midpoint = (gene.startPos + gene.endPos) / 2;
      lysisGenes.push({ timing, position: midpoint / genomeLength });
    }
  }
  if (lysisGenes.length === 0) return 'unknown';
  const avgPosition = lysisGenes.reduce((sum, g) => sum + g.position, 0) / lysisGenes.length;
  if (avgPosition < 0.33) return 'early';
  if (avgPosition < 0.67) return 'middle';
  return 'late';
}

function detectSieGenes(genes: GeneAnnotation[]): { hasSie: boolean; count: number } {
  if (!genes || genes.length === 0) return { hasSie: false, count: 0 };
  let count = 0;
  for (const gene of genes) {
    const text = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
    for (const keyword of SIE_KEYWORDS) {
      if (text.includes(keyword)) {
        count++;
        break;
      }
    }
  }
  return { hasSie: count > 0, count };
}

function detectImmunityRegion(genes: GeneAnnotation[]): boolean {
  if (!genes || genes.length === 0) return false;
  const immunityKeywords = ['immunity', 'imm ', 'ci repressor', 'cro', 'integrase'];
  for (const gene of genes) {
    const text = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
    for (const keyword of immunityKeywords) {
      if (text.includes(keyword)) return true;
    }
  }
  return false;
}

function extractReceptorHints(domains: ProteinDomain[]): string[] {
  const hints = new Set<string>();
  for (const domain of domains) {
    const text = `${domain.domainName ?? ''} ${domain.description ?? ''}`.toLowerCase();
    for (const keyword of RECEPTOR_DOMAIN_KEYWORDS) {
      if (text.includes(keyword)) {
        hints.add(domain.domainName ?? domain.domainId);
      }
    }
  }
  return Array.from(hints);
}

function domainKey(domain: ProteinDomain): string {
  const type = domain.domainType ?? 'Unknown';
  return `${type}:${domain.domainId}`;
}

function buildDomainCounts(domains: ProteinDomain[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of domains) {
    const key = domainKey(d);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function computeDomainSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
  metric: SimilarityMetric
): { similarity: number; sharedDistinct: number } {
  let intersectionPresence = 0;
  let unionPresence = 0;
  let sumMin = 0;
  let sumMax = 0;

  for (const [key, aCount] of a) {
    const bCount = b.get(key) ?? 0;
    if (bCount > 0) intersectionPresence++;
    unionPresence++;
    sumMin += Math.min(aCount, bCount);
    sumMax += Math.max(aCount, bCount);
  }
  for (const [key, bCount] of b) {
    if (a.has(key)) continue; // Skip keys already counted in the first loop
    unionPresence++;
    sumMax += bCount;
  }

  const similarity =
    metric === 'weightedJaccard'
      ? (sumMax > 0 ? sumMin / sumMax : 0)
      : (unionPresence > 0 ? intersectionPresence / unionPresence : 0);
  return { similarity: clamp(similarity, 0, 1), sharedDistinct: intersectionPresence };
}

function computeCompatibility(
  a: PhageFeatures,
  b: PhageFeatures,
  metric: SimilarityMetric,
  threshold: number
): PairDetails {
  const factors: CompatibilityFactor[] = [];
  const { similarity: domainSimilarity, sharedDistinct } = computeDomainSimilarity(
    a.domainCounts,
    b.domainCounts,
    metric
  );

  let score = 0;

  if (a.lifecycle === 'lytic' && b.lifecycle === 'lytic') {
    const contribution = 0.18;
    score += contribution;
    factors.push({ name: 'Both lytic', contribution, reason: 'No lysogeny/immunity conflicts expected.' });
  }
  if (a.lifecycle === 'temperate' || b.lifecycle === 'temperate') {
    const contribution = -0.12;
    score += contribution;
    factors.push({ name: 'Temperate involvement', contribution, reason: 'Temperate phages can introduce immunity / superinfection exclusion effects.' });
  }
  if (a.lifecycle === 'temperate' && b.lifecycle === 'temperate') {
    const contribution = -0.18;
    score += contribution;
    factors.push({ name: 'Both temperate', contribution, reason: 'Higher risk of cross-immunity and interference.' });
  }

  if (a.lysisTiming !== 'unknown' && b.lysisTiming !== 'unknown') {
    if (a.lysisTiming !== b.lysisTiming) {
      const contribution = 0.20;
      score += contribution;
      factors.push({ name: 'Complementary lysis timing', contribution, reason: a.lysisTiming + ' + ' + b.lysisTiming + ' timing provides sustained bacterial killing.' });
    } else {
      const contribution = -0.08;
      score += contribution;
      factors.push({ name: 'Similar lysis timing', contribution, reason: 'Both ' + a.lysisTiming + ' lysis may cause resource competition.' });
    }
  }

  if (a.hasSieGenes && b.hasSieGenes) {
    const contribution = -0.30;
    score += contribution;
    factors.push({ name: 'Both have Sie genes', contribution, reason: 'Superinfection exclusion detected in both (' + a.sieGeneCount + ' + ' + b.sieGeneCount + ' genes); high interference risk.' });
  } else if (a.hasSieGenes || b.hasSieGenes) {
    const contribution = -0.15;
    score += contribution;
    factors.push({ name: 'Sie gene present', contribution, reason: 'One phage has superinfection exclusion genes; may block co-infection.' });
  }

  if (a.hasImmunityRegion && b.hasImmunityRegion && a.lifecycle === 'temperate' && b.lifecycle === 'temperate') {
    const contribution = -0.25;
    score += contribution;
    factors.push({ name: 'Immunity region conflict', contribution, reason: 'Both temperate phages have immunity regions; cross-immunity likely.' });
  }

  const sharedReceptors = a.receptorHints.filter(r => b.receptorHints.includes(r));
  if (sharedReceptors.length > 0) {
    const contribution = -0.20;
    score += contribution;
    factors.push({ name: 'Receptor competition', contribution, reason: 'Shared receptor domains: ' + sharedReceptors.join(', ') + '; may compete for attachment.' });
  } else if (a.receptorHints.length > 0 && b.receptorHints.length > 0) {
    const contribution = 0.15;
    score += contribution;
    factors.push({ name: 'Different receptors', contribution, reason: 'Different receptor-binding domains suggest no attachment competition.' });
  }

  if (a.host && b.host && a.host !== b.host) {
    const contribution = 0.22;
    score += contribution;
    factors.push({ name: 'Complementary host labels', contribution, reason: 'Different host labels increase coverage diversity.' });
  }

  if (domainSimilarity >= 0.35) {
    const contribution = -clamp(domainSimilarity * 0.9, 0.15, 0.75);
    score += contribution;
    factors.push({ name: 'Shared domain architecture', contribution, reason: 'High protein-domain overlap (' + (domainSimilarity * 100).toFixed(0) + '%) suggests functional overlap and potential interference.' });
  } else if (domainSimilarity <= 0.12) {
    const contribution = 0.16;
    score += contribution;
    factors.push({ name: 'Distinct domain architecture', contribution, reason: 'Low protein-domain overlap (' + (domainSimilarity * 100).toFixed(0) + '%) suggests complementary modules.' });
  } else {
    const contribution = 0.04;
    score += contribution;
    factors.push({ name: 'Moderate domain overlap', contribution, reason: 'Moderate protein-domain overlap (' + (domainSimilarity * 100).toFixed(0) + '%).' });
  }

  if ((a.lifecycle === 'temperate' || b.lifecycle === 'temperate') && domainSimilarity >= 0.5) {
    const contribution = -0.2;
    score += contribution;
    factors.push({ name: 'Temperate + high overlap', contribution, reason: 'Temperate-related immunity effects more plausible with high domain similarity.' });
  }

  score = clamp(score, -1, 1);
  const compatible = score >= threshold;
  factors.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));

  return { score, compatible, domainSimilarity, sharedDistinctDomains: sharedDistinct, factors };
}

const compatibilityColorScale: ColorScale = (norm: number): string => {
  const score = clamp(norm, 0, 1) * 2 - 1;
  if (score >= 0.6) return '#22c55e';
  if (score >= 0.25) return '#84cc16';
  if (score >= 0.05) return '#3b82f6';
  if (score >= -0.05) return '#334155';
  if (score >= -0.35) return '#f59e0b';
  return '#ef4444';
};

function formatSigned(x: number): string {
  const v = Number.isFinite(x) ? x : 0;
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function CocktailCompatibilityOverlay({
  repository,
  currentPhage,
}: {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  useHotkey(
    { key: 'k', modifiers: { alt: true } },
    'Cocktail Compatibility Matrix',
    () => toggle('cocktailCompatibility'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'power' }
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phages, setPhages] = useState<PhageSummary[]>([]);
  const [domainsById, setDomainsById] = useState<Record<number, ProteinDomain[]>>({});
  const [genesById, setGenesById] = useState<Record<number, GeneAnnotation[]>>({});
  const [metric, setMetric] = useState<SimilarityMetric>('weightedJaccard');
  const [threshold, setThreshold] = useState(0.0);
  const [maxSize, setMaxSize] = useState(3);
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [hover, setHover] = useState<HeatmapHover | null>(null);
  const [selectedPair, setSelectedPair] = useState<{ row: number; col: number } | null>(null);

  useEffect(() => {
    if (!isOpen('cocktailCompatibility')) return;
    if (!repository) {
      setPhages([]);
      setDomainsById({});
      setGenesById({});
      return;
    }
    if (!repository.listPhages || !repository.getProteinDomains) {
      setError('Cocktail matrix requires listPhages + getProteinDomains in the repository.');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    repository.listPhages().then(async (items) => {
      if (cancelled) return { sorted: [] as PhageSummary[], domainItems: [] as Array<{id: number; domains: ProteinDomain[]}>, geneItems: [] as Array<{id: number; genes: GeneAnnotation[]}> };
      const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
      setPhages(sorted);

      const [domainItems, geneItems] = await Promise.all([
        Promise.all(sorted.map(async (p) => ({ id: p.id, domains: await repository.getProteinDomains!(p.id) }))),
        Promise.all(sorted.map(async (p) => ({
          id: p.id,
          genes: repository.getGenes
            ? (await repository.getGenes(p.id)).map((g) => ({ id: g.id, name: g.name, product: g.product, startPos: g.startPos, endPos: g.endPos }))
            : [],
        }))),
      ]);
      return { sorted, domainItems, geneItems };
    }).then(({ domainItems, geneItems }) => {
      if (cancelled) return;
      const domainRecord: Record<number, ProteinDomain[]> = {};
      for (const d of domainItems) domainRecord[d.id] = d.domains;
      setDomainsById(domainRecord);
      const geneRecord: Record<number, GeneAnnotation[]> = {};
      for (const g of geneItems) geneRecord[g.id] = g.genes;
      setGenesById(geneRecord);
    }).catch(() => {
      if (cancelled) return;
      setError('Failed to load phage list / domain annotations.');
      setPhages([]);
      setDomainsById({});
      setGenesById({});
    }).finally(() => {
      if (cancelled) return;
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [isOpen, repository]);

  const uniqueHosts = useMemo(() => {
    const set = new Set<string>();
    for (const p of phages) { if (p.host) set.add(p.host); }
    return Array.from(set).sort();
  }, [phages]);

  useEffect(() => {
    if (!isOpen('cocktailCompatibility')) return;
    if (uniqueHosts.length === 0) return;
    if (selectedHosts.length > 0) return;
    setSelectedHosts(uniqueHosts);
  }, [isOpen, selectedHosts.length, uniqueHosts]);

  const features = useMemo((): PhageFeatures[] => {
    return phages.map((p) => {
      const domains = domainsById[p.id] ?? [];
      const genes = genesById[p.id] ?? [];
      const domainCounts = buildDomainCounts(domains);
      const genomeLength = p.genomeLength ?? 0;
      const lysisTiming = inferLysisTiming(genes, genomeLength);
      const sieResult = detectSieGenes(genes);
      const hasImmunityRegion = detectImmunityRegion(genes);
      const receptorHints = extractReceptorHints(domains);
      return {
        id: p.id, name: p.name, host: p.host, lifecycle: normalizeLifecycle(p.lifecycle),
        lysisTiming, hasSieGenes: sieResult.hasSie, sieGeneCount: sieResult.count,
        hasImmunityRegion, receptorHints, domainCounts, distinctDomains: domainCounts.size,
      };
    });
  }, [domainsById, genesById, phages]);

  const matrix = useMemo(() => {
    const n = features.length;
    if (n === 0) return null;
    const values = new Float32Array(n * n);
    const details = new Array<PairDetails>(n * n);

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const aFeat = features[r];
        const bFeat = features[c];
        const idx = r * n + c;
        if (!aFeat || !bFeat) {
          values[idx] = 0;
          details[idx] = { score: 0, compatible: true, domainSimilarity: 0, sharedDistinctDomains: 0, factors: [] };
          continue;
        }
        if (r === c) {
          values[idx] = 1;
          details[idx] = { score: 1, compatible: true, domainSimilarity: 1, sharedDistinctDomains: aFeat.distinctDomains, factors: [{ name: 'Self', contribution: 1, reason: 'Same phage (diagonal).' }] };
          continue;
        }
        const cell = computeCompatibility(aFeat, bFeat, metric, threshold);
        values[idx] = cell.score;
        details[idx] = cell;
      }
    }
    return { n, values, details };
  }, [features, metric, threshold]);

  const activePair = useMemo(() => {
    if (!matrix) return null;
    const pair = selectedPair ?? hover;
    if (!pair) return null;
    const row = Math.max(0, Math.min(matrix.n - 1, pair.row));
    const col = Math.max(0, Math.min(matrix.n - 1, pair.col));
    return { row, col };
  }, [hover, matrix, selectedPair]);

  const activeDetails = useMemo(() => {
    if (!matrix || !activePair) return null;
    const idx = activePair.row * matrix.n + activePair.col;
    return matrix.details[idx] ?? null;
  }, [activePair, matrix]);

  const optimizer = useMemo(() => {
    if (!matrix) return null;
    const n = matrix.n;
    if (n === 0) return null;
    const targets = selectedHosts.length > 0 ? selectedHosts : uniqueHosts;
    const targetSet = new Set(targets);
    const hostSetByIndex = features.map((f) => {
      const set = new Set<string>();
      if (f.host && targetSet.has(f.host)) set.add(f.host);
      return set;
    });
    const covered = new Set<string>();
    const chosen: number[] = [];
    const rationale: string[] = [];

    while (chosen.length < maxSize && covered.size < targetSet.size) {
      let bestIdx = -1;
      let bestComposite = -Infinity;
      let bestGain = 0;
      let bestAvgCompat = 0;

      for (let i = 0; i < n; i++) {
        if (chosen.includes(i)) continue;
        const pairScores: number[] = [];
        let ok = true;
        for (const j of chosen) {
          const idx = i * n + j;
          const scr = matrix.values[idx] ?? 0;
          if (scr < threshold) { ok = false; break; }
          pairScores.push(scr);
        }
        if (!ok) continue;
        let gain = 0;
        for (const h of hostSetByIndex[i] ?? []) { if (!covered.has(h)) gain++; }
        if (gain === 0) continue;
        const avgC = pairScores.length > 0 ? average(pairScores) : 0;
        const composite = gain + avgC * 0.5;
        if (composite > bestComposite) {
          bestComposite = composite;
          bestIdx = i;
          bestGain = gain;
          bestAvgCompat = avgC;
        }
      }
      if (bestIdx === -1) break;
      chosen.push(bestIdx);
      for (const h of hostSetByIndex[bestIdx] ?? []) covered.add(h);
      const phageName = features[bestIdx]?.name ?? ('#' + bestIdx);
      rationale.push(phageName + ': +' + bestGain + ' host(s) covered; avg compat vs selected ' + formatSigned(bestAvgCompat));
      if (Array.from(covered).length === targetSet.size) break;
    }

    const coverage = Array.from(covered).sort();
    const coveragePercent = targetSet.size > 0 ? (coverage.length / targetSet.size) * 100 : 0;
    const pairScores: number[] = [];
    for (let ai = 0; ai < chosen.length; ai++) {
      for (let bi = ai + 1; bi < chosen.length; bi++) {
        const ci = chosen[ai] ?? 0;
        const cj = chosen[bi] ?? 0;
        pairScores.push(matrix.values[ci * n + cj] ?? 0);
      }
    }
    const avgCompat = pairScores.length > 0 ? average(pairScores) : 0;
    return { chosen, coverage, coveragePercent, avgCompat, rationale, targetCount: targetSet.size };
  }, [features, matrix, maxSize, selectedHosts, threshold, uniqueHosts]);

  if (!isOpen('cocktailCompatibility')) return null;

  const overlayStyle: React.CSSProperties = { padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem', color: colors.text, fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem' };
  const panelStyle: React.CSSProperties = { padding: '0.75rem', backgroundColor: colors.backgroundAlt, border: '1px solid ' + colors.borderLight, borderRadius: '6px' };
  const selectStyle: React.CSSProperties = { padding: '0.25rem', backgroundColor: colors.backgroundAlt, color: colors.text, border: '1px solid ' + colors.borderLight, borderRadius: '4px' };
  const btnStyle: React.CSSProperties = { padding: '0.25rem 0.5rem', borderRadius: '4px', border: '1px solid ' + colors.borderLight, backgroundColor: colors.background, color: colors.text, cursor: 'pointer', fontSize: '0.75rem' };

  return (
    <Overlay id="cocktailCompatibility" title="Cocktail Compatibility Matrix" hotkey="Alt+K" size="xl">
      <div style={overlayStyle}>
        <div style={{ ...panelStyle, color: colors.textDim }}>
          <div style={{ color: colors.accent, marginBottom: '0.25rem' }}>Enhanced compatibility scoring</div>
          <div>Scores are derived from lifecycle + host labels + protein-domain overlap + lysis timing + Sie genes + receptor hints (not a clinical tool).</div>
        </div>

        {loading ? (
          <AnalysisPanelSkeleton message="Loading phages + domain annotations..." rows={3} />
        ) : error ? (
          <div style={{ ...panelStyle, color: '#ef4444' }}>{error}</div>
        ) : !matrix || phages.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>No phages loaded.</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor="cocktail-metric" style={{ color: colors.textMuted }}>Domain metric</label>
                <select id="cocktail-metric" value={metric} onChange={(e) => setMetric(e.target.value as SimilarityMetric)} style={selectStyle}>
                  <option value="weightedJaccard">Weighted Jaccard</option>
                  <option value="jaccard">Jaccard (presence)</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor="cocktail-threshold" style={{ color: colors.textMuted }}>Compatibility threshold</label>
                <select id="cocktail-threshold" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={selectStyle}>
                  <option value={-0.1}>-0.10 (lenient)</option>
                  <option value={0.0}>0.00 (default)</option>
                  <option value={0.15}>0.15 (strict)</option>
                  <option value={0.3}>0.30 (very strict)</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor="cocktail-maxsize" style={{ color: colors.textMuted }}>Max cocktail size</label>
                <select id="cocktail-maxsize" value={maxSize} onChange={(e) => setMaxSize(Number(e.target.value))} style={selectStyle}>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                </select>
              </div>
            </div>

            <div style={panelStyle}>
              <div style={{ color: colors.primary, marginBottom: '0.5rem' }}>Target hosts</div>
              {uniqueHosts.length === 0 ? (
                <div style={{ color: colors.textMuted }}>No host labels present in the database.</div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <button onClick={() => setSelectedHosts(uniqueHosts)} style={btnStyle}>Select all</button>
                    <button onClick={() => setSelectedHosts([])} style={btnStyle}>Clear</button>
                    <div style={{ color: colors.textMuted, fontSize: '0.75rem', alignSelf: 'center' }}>{selectedHosts.length}/{uniqueHosts.length} selected</div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.35rem 1rem', fontSize: '0.8rem' }}>
                    {uniqueHosts.map((host) => (
                      <label key={host} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input type="checkbox" checked={selectedHosts.includes(host)} onChange={() => { setSelectedPair(null); setHover(null); setSelectedHosts((prev) => prev.includes(host) ? prev.filter((h) => h !== host) : [...prev, host]); }} />
                        <span style={{ color: colors.text }}>{host}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>Pairwise compatibility (click a cell)</div>
                <HeatmapCanvas width={Math.min(520, Math.max(320, matrix.n * 38))} height={Math.min(520, Math.max(320, matrix.n * 38))} matrix={{ rows: matrix.n, cols: matrix.n, values: matrix.values, min: -1, max: 1 }} colorScale={compatibilityColorScale} onHover={setHover} onClick={(info) => setSelectedPair({ row: info.row, col: info.col })} ariaLabel="Cocktail compatibility matrix" />
                <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: colors.textMuted }}>
                  {activePair && activeDetails ? (
                    <>
                      <span style={{ color: colors.text }}>{phages[activePair.row]?.name ?? '—'}</span>{' \u2194 '}
                      <span style={{ color: colors.text }}>{phages[activePair.col]?.name ?? '—'}</span>{' \u2022 score '}
                      <span style={{ color: colors.text }}>{formatSigned(activeDetails.score)}</span>{' \u2022 domain sim '}
                      <span style={{ color: colors.text }}>{activeDetails.domainSimilarity.toFixed(2)}</span>
                    </>
                  ) : 'Hover a cell to see a pair summary'}
                </div>
              </div>
              <div style={{ ...panelStyle, flex: '1 1 340px', minWidth: 320, maxWidth: 520 }}>
                <div style={{ color: colors.primary, marginBottom: '0.5rem' }}>Pair explanation</div>
                {!activePair || !activeDetails ? (<div style={{ color: colors.textMuted }}>Select a cell to see factor breakdown.</div>) : (
                  <>
                    <div style={{ color: colors.text, marginBottom: '0.5rem' }}>
                      {phages[activePair.row]?.name ?? '—'} × {phages[activePair.col]?.name ?? '—'}{' '}
                      <span style={{ color: activeDetails.compatible ? '#22c55e' : '#ef4444' }}>{activeDetails.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE'}</span>
                    </div>
                    <div style={{ color: colors.textMuted, fontSize: '0.75rem', marginBottom: '0.75rem' }}>
                      score {formatSigned(activeDetails.score)} • threshold {formatSigned(threshold)} • shared {activeDetails.sharedDistinctDomains} domains
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      {activeDetails.factors.map((f) => (
                        <div key={f.name} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                          <div style={{ color: colors.text }}>{f.name}<div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>{f.reason}</div></div>
                          <div style={{ color: f.contribution >= 0 ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>{formatSigned(f.contribution)}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div style={panelStyle}>
              <div style={{ color: colors.primary, marginBottom: '0.5rem' }}>Greedy cocktail optimizer</div>
              {!optimizer ? (<div style={{ color: colors.textMuted }}>No solution (check inputs).</div>) : (
                <>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                    <div style={{ color: colors.textMuted }}>Coverage: <span style={{ color: colors.text }}>{optimizer.coverage.length}/{optimizer.targetCount} ({Math.round(optimizer.coveragePercent)}%)</span></div>
                    <div style={{ color: colors.textMuted }}>Avg pair compat: <span style={{ color: colors.text }}>{formatSigned(optimizer.avgCompat)}</span></div>
                    <div style={{ color: colors.textMuted }}>Selected: <span style={{ color: colors.text }}>{optimizer.chosen.length}/{maxSize}</span></div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {optimizer.chosen.length === 0 ? (<div style={{ color: colors.textMuted }}>No compatible phage adds new coverage under current constraints.</div>) : (
                      optimizer.chosen.map((idx) => {
                        const f = features[idx];
                        const isCurrent = currentPhage?.id === f?.id;
                        return (
                          <div key={f?.id ?? idx} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.4rem 0.5rem', borderRadius: '4px', backgroundColor: isCurrent ? colors.background : 'transparent', border: isCurrent ? '1px solid ' + colors.borderLight : '1px solid transparent' }}>
                            <div style={{ color: colors.text }}>{f?.name ?? '—'} {isCurrent ? <span style={{ color: colors.textMuted }}>(current)</span> : null}</div>
                            <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>host: {f?.host ?? '—'} • lifecycle: {f?.lifecycle}</div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div style={{ marginTop: '0.75rem', color: colors.textMuted, fontSize: '0.75rem' }}>
                    <div style={{ marginBottom: '0.35rem', color: colors.text }}>Rationale</div>
                    {optimizer.rationale.length === 0 ? <div>No rationale generated.</div> : <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>{optimizer.rationale.map((line, idx) => <li key={idx}>{line}</li>)}</ul>}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default CocktailCompatibilityOverlay;
