/**
 * ProteinDomainOverlay - Protein Domain Annotations
 *
 * Visualizes InterPro/Pfam domain annotations for genes in the current phage.
 * Shows domain architecture and functional predictions.
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { PhageFull, GeneInfo, PhageSummary } from '@phage-explorer/core';
import type { PhageRepository, ProteinDomain } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import { HeatmapCanvas } from '../primitives/HeatmapCanvas';
import type { ColorScale, HeatmapHover } from '../primitives/types';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment } from './primitives/types';

// Domain type color mapping
const DOMAIN_COLORS: Record<string, string> = {
  Pfam: '#3b82f6',      // Blue
  TIGRFAM: '#8b5cf6',   // Purple
  SUPERFAMILY: '#ec4899', // Pink
  Gene3D: '#f97316',    // Orange
  CDD: '#22c55e',       // Green
  SMART: '#14b8a6',     // Teal
  PANTHER: '#eab308',   // Yellow
  default: '#6b7280',   // Gray
};

function getDomainColor(domainType: string | null): string {
  if (!domainType) return DOMAIN_COLORS.default;
  return DOMAIN_COLORS[domainType] ?? DOMAIN_COLORS.default;
}

// Format E-value for display
function formatEValue(eValue: number | null): string {
  if (eValue === null) return 'N/A';
  if (eValue === 0) return '0';
  if (eValue < 1e-100) return '<1e-100';
  if (eValue < 0.001) return eValue.toExponential(1);
  return eValue.toFixed(3);
}

type ProteinDomainViewMode = 'phage' | 'chord';
type DomainChordMetric = 'weightedJaccard' | 'jaccard';

interface DomainMeta {
  key: string;
  domainId: string;
  domainType: string;
  domainName: string;
}

interface DomainChordLink {
  i: number;
  j: number;
  weight: number; // 0..1 similarity
  shared: number; // shared distinct domains (presence)
}

function domainKey(domain: ProteinDomain): string {
  const type = domain.domainType ?? 'Unknown';
  return `${type}:${domain.domainId}`;
}

function phageColor(index: number, total: number): string {
  const n = Math.max(1, total);
  const hue = Math.round((index / n) * 360);
  return `hsl(${hue} 70% 55%)`;
}

function normalizePair(i: number, j: number): { i: number; j: number } {
  if (i <= j) return { i, j };
  return { i: j, j: i };
}

const similarityColorScale: ColorScale = (value: number): string => {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  if (v >= 0.8) return '#22c55e'; // green
  if (v >= 0.6) return '#84cc16'; // lime
  if (v >= 0.4) return '#eab308'; // yellow
  if (v >= 0.25) return '#f59e0b'; // orange
  if (v >= 0.12) return '#3b82f6'; // blue
  return '#0b1220';
};

function ChordPlot({
  size,
  labels,
  colors,
  links,
  selected,
  onSelect,
  background,
  border,
  text,
}: {
  size: number;
  labels: string[];
  colors: string[];
  links: DomainChordLink[];
  selected: { i: number; j: number } | null;
  onSelect: (pair: { i: number; j: number }) => void;
  background: string;
  border: string;
  text: string;
}): React.ReactElement {
  const n = labels.length;
  const cx = size / 2;
  const cy = size / 2;
  const radius = Math.max(10, size / 2 - 52);
  const labelR = radius + 18;

  const points = useMemo(() => {
    return labels.map((_, idx) => {
      const angle = (Math.PI * 2 * idx) / Math.max(1, n) - Math.PI / 2;
      return {
        angle,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        lx: cx + labelR * Math.cos(angle),
        ly: cy + labelR * Math.sin(angle),
        align: Math.cos(angle) >= 0 ? 'start' : 'end',
      } as const;
    });
  }, [cx, cy, labelR, labels, n, radius]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Protein domain chord plot"
      style={{
        display: 'block',
        background,
        border: `1px solid ${border}`,
        borderRadius: '6px',
      }}
    >
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke={border} strokeWidth={1} />

      {links.map((link, idx) => {
        const a = points[link.i];
        const b = points[link.j];
        if (!a || !b) return null;
        const isSelected =
          selected && ((selected.i === link.i && selected.j === link.j) || (selected.i === link.j && selected.j === link.i));
        const opacity = selected ? (isSelected ? 0.9 : 0.12) : 0.55;
        const width = Math.max(1, 1 + link.weight * 7);
        const stroke = colors[link.i] ?? '#94a3b8';
        const d = `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
        return (
          <path
            key={`${link.i}-${link.j}-${idx}`}
            d={d}
            fill="none"
            stroke={stroke}
            strokeWidth={width}
            strokeOpacity={opacity}
            strokeLinecap="round"
            onClick={() => onSelect(normalizePair(link.i, link.j))}
            style={{ cursor: 'pointer' }}
          />
        );
      })}

      {labels.map((label, idx) => {
        const p = points[idx];
        if (!p) return null;
        const isSelected = selected && (selected.i === idx || selected.j === idx);
        const fill = colors[idx] ?? '#0ea5e9';
        return (
          <g key={label}>
            <circle cx={p.x} cy={p.y} r={6} fill={fill} stroke={border} strokeWidth={1} />
            <text
              x={p.lx}
              y={p.ly}
              fill={text}
              fontSize={10}
              textAnchor={p.align}
              dominantBaseline="middle"
              opacity={isSelected ? 1 : 0.85}
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Group domains by gene
interface GeneDomains {
  gene: GeneInfo;
  domains: ProteinDomain[];
}

interface ProteinDomainOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function ProteinDomainOverlay({
  repository,
  currentPhage,
}: ProteinDomainOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('proteinDomains');

  const [viewMode, setViewMode] = useState<ProteinDomainViewMode>('phage');
  const [domains, setDomains] = useState<ProteinDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedGene, setSelectedGene] = useState<GeneInfo | null>(null);
  const [filterType, setFilterType] = useState<string>('all');

  // Cross-phage chord plot state
  const [allPhages, setAllPhages] = useState<PhageSummary[]>([]);
  const [allDomainsByPhageId, setAllDomainsByPhageId] = useState<Record<number, ProteinDomain[]>>({});
  const [loadingChord, setLoadingChord] = useState(false);
  const [chordError, setChordError] = useState<string | null>(null);
  const [chordDomainType, setChordDomainType] = useState<string>('all');
  const [metric, setMetric] = useState<DomainChordMetric>('weightedJaccard');
  const [minLinkStrength, setMinLinkStrength] = useState(0.15);
  const [maxLinks, setMaxLinks] = useState(32);
  const [hoverPair, setHoverPair] = useState<HeatmapHover | null>(null);
  const [selectedPair, setSelectedPair] = useState<{ i: number; j: number } | null>(null);

  // Hotkey (Alt+D for Domains)
  useHotkey(
    ActionIds.OverlayProteinDomains,
    () => toggle('proteinDomains'),
    { modes: ['NORMAL'] }
  );

  // Fetch domains when overlay opens
  useEffect(() => {
    if (!isOpen('proteinDomains')) return;
    if (!repository?.getProteinDomains || !currentPhage) {
      setDomains([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    repository
      .getProteinDomains(currentPhage.id)
      .then((nextDomains) => {
        if (!cancelled) setDomains(nextDomains);
      })
      .catch(() => {
        if (!cancelled) setDomains([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Fetch all domains across phages when chord view is opened
  useEffect(() => {
    if (!isOpen('proteinDomains')) return;
    if (viewMode !== 'chord') return;
    if (!repository?.listPhages || !repository?.getProteinDomains) {
      setChordError('Chord plot requires domain annotations (protein_domains table) in the database.');
      setAllPhages([]);
      setAllDomainsByPhageId({});
      return;
    }
    if (allPhages.length > 0 && Object.keys(allDomainsByPhageId).length > 0) return;

    let cancelled = false;
    setLoadingChord(true);
    setChordError(null);

    repository
      .listPhages()
      .then((phages) => {
        if (cancelled) return [];
        setAllPhages(phages);
        return Promise.all(
          phages.map(async (p) => ({ id: p.id, domains: await repository.getProteinDomains!(p.id) }))
        );
      })
      .then((items) => {
        if (cancelled) return;
        const record: Record<number, ProteinDomain[]> = {};
        for (const item of items) record[item.id] = item.domains;
        setAllDomainsByPhageId(record);
      })
      .catch(() => {
        if (cancelled) return;
        setChordError('Failed to load domain annotations across phages.');
        setAllPhages([]);
        setAllDomainsByPhageId({});
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingChord(false);
      });

    return () => {
      cancelled = true;
    };
  }, [allDomainsByPhageId, allPhages.length, isOpen, repository, viewMode]);

  const chordPhages = useMemo(() => {
    if (allPhages.length === 0) return [];
    const sorted = [...allPhages];
    if (currentPhage) {
      sorted.sort((a, b) => {
        if (a.id === currentPhage.id) return -1;
        if (b.id === currentPhage.id) return 1;
        return a.name.localeCompare(b.name);
      });
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }, [allPhages, currentPhage]);

  const chordDomainTypes = useMemo(() => {
    const types = new Set<string>();
    for (const domainsList of Object.values(allDomainsByPhageId)) {
      for (const d of domainsList) {
        if (d.domainType) types.add(d.domainType);
      }
    }
    return ['all', ...Array.from(types).sort()] as string[];
  }, [allDomainsByPhageId]);

  const chordCounts = useMemo(() => {
    const meta = new Map<string, DomainMeta>();
    const countsById = new Map<number, Map<string, number>>();
    for (const phage of chordPhages) {
      const domainsList = allDomainsByPhageId[phage.id] ?? [];
      const counts = new Map<string, number>();
      for (const d of domainsList) {
        const type = d.domainType ?? 'Unknown';
        if (chordDomainType !== 'all' && type !== chordDomainType) continue;
        const key = domainKey(d);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!meta.has(key)) {
          meta.set(key, {
            key,
            domainId: d.domainId,
            domainType: type,
            domainName: d.domainName ?? d.domainId,
          });
        }
      }
      countsById.set(phage.id, counts);
    }
    return { countsById, meta };
  }, [allDomainsByPhageId, chordDomainType, chordPhages]);

  const chordMatrix = useMemo(() => {
    const n = chordPhages.length;
    if (n === 0) return null;
    const values = new Float32Array(n * n);
    const shared = new Uint16Array(n * n);

    const countsByIndex = chordPhages.map((p) => chordCounts.countsById.get(p.id) ?? new Map<string, number>());

    for (let i = 0; i < n; i++) {
      values[i * n + i] = 1;
      for (let j = i + 1; j < n; j++) {
        const a = countsByIndex[i] ?? new Map<string, number>();
        const b = countsByIndex[j] ?? new Map<string, number>();
        let intersectionPresence = 0;
        let unionPresence = 0;
        let sumMin = 0;
        let sumMax = 0;

        // Iterate A keys
        for (const [key, aCount] of a) {
          const bCount = b.get(key) ?? 0;
          if (bCount > 0) intersectionPresence++;
          unionPresence++;
          sumMin += Math.min(aCount, bCount);
          sumMax += Math.max(aCount, bCount);
        }
        // Add B-only keys
        for (const [key, bCount] of b) {
          if (a.has(key)) continue;
          unionPresence++;
          sumMax += bCount;
        }

        const score =
          metric === 'weightedJaccard'
            ? (sumMax > 0 ? sumMin / sumMax : 0)
            : (unionPresence > 0 ? intersectionPresence / unionPresence : 0);

        const idx1 = i * n + j;
        const idx2 = j * n + i;
        values[idx1] = score;
        values[idx2] = score;
        shared[idx1] = Math.min(65535, intersectionPresence);
        shared[idx2] = Math.min(65535, intersectionPresence);
      }
    }

    return { n, values, shared };
  }, [chordCounts.countsById, chordPhages, metric]);

  const chordLinks = useMemo(() => {
    if (!chordMatrix) return [];
    const n = chordMatrix.n;
    const links: DomainChordLink[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const idx = i * n + j;
        const weight = chordMatrix.values[idx] ?? 0;
        if (weight < minLinkStrength) continue;
        links.push({
          i,
          j,
          weight,
          shared: chordMatrix.shared[idx] ?? 0,
        });
      }
    }
    links.sort((a, b) => (b.weight - a.weight) || (b.shared - a.shared) || (a.i - b.i));
    return links.slice(0, Math.max(0, maxLinks));
  }, [chordMatrix, maxLinks, minLinkStrength]);

  const chordColors = useMemo(() => {
    return chordPhages.map((_, idx) => phageColor(idx, chordPhages.length));
  }, [chordPhages]);

  const activePair = useMemo(() => {
    if (!chordMatrix) return null;
    if (selectedPair) return selectedPair;
    if (hoverPair) return normalizePair(hoverPair.row, hoverPair.col);
    return null;
  }, [chordMatrix, hoverPair, selectedPair]);

  const activePairDetails = useMemo(() => {
    if (!chordMatrix || !activePair) return null;
    const n = chordMatrix.n;
    const i = activePair.i;
    const j = activePair.j;
    const aPhage = chordPhages[i];
    const bPhage = chordPhages[j];
    if (!aPhage || !bPhage) return null;

    const idx = i * n + j;
    const score = chordMatrix.values[idx] ?? 0;
    const sharedDistinct = chordMatrix.shared[idx] ?? 0;
    const countsA = chordCounts.countsById.get(aPhage.id) ?? new Map<string, number>();
    const countsB = chordCounts.countsById.get(bPhage.id) ?? new Map<string, number>();

    const sharedDomains: Array<{ meta: DomainMeta; a: number; b: number; shared: number }> = [];
    for (const [key, aCount] of countsA) {
      const bCount = countsB.get(key);
      if (!bCount) continue;
      const meta = chordCounts.meta.get(key) ?? {
        key,
        domainId: key.split(':')[1] ?? key,
        domainType: key.split(':')[0] ?? 'Unknown',
        domainName: key,
      };
      sharedDomains.push({ meta, a: aCount, b: bCount, shared: Math.min(aCount, bCount) });
    }
    sharedDomains.sort((x, y) => (y.shared - x.shared) || (x.meta.domainName.localeCompare(y.meta.domainName)));

    return {
      aPhage,
      bPhage,
      score,
      sharedDistinct,
      sharedDomains: sharedDomains.slice(0, 14),
    };
  }, [activePair, chordCounts.countsById, chordCounts.meta, chordMatrix, chordPhages]);

  // Get unique domain types for filter
  const domainTypes = useMemo(() => {
    const types = new Set(domains.map((d) => d.domainType).filter(Boolean));
    return ['all', ...Array.from(types)] as string[];
  }, [domains]);

  // Filter domains by type
  const filteredDomains = useMemo(() => {
    if (filterType === 'all') return domains;
    return domains.filter((d) => d.domainType === filterType);
  }, [domains, filterType]);

  // Group domains by gene
  const geneDomains = useMemo((): GeneDomains[] => {
    if (!currentPhage?.genes) return [];

    const geneMap = new Map<number, ProteinDomain[]>();
    for (const domain of filteredDomains) {
      if (domain.geneId) {
        const existing = geneMap.get(domain.geneId) ?? [];
        existing.push(domain);
        geneMap.set(domain.geneId, existing);
      }
    }

    return currentPhage.genes
      .filter((g) => geneMap.has(g.id))
      .map((gene) => ({
        gene,
        domains: geneMap.get(gene.id) ?? [],
      }))
      .sort((a, b) => a.gene.startPos - b.gene.startPos);
  }, [currentPhage, filteredDomains]);

  // Create genome track segments for domains (only include those with valid gene positions)
  const domainSegments = useMemo((): GenomeTrackSegment[] => {
    return filteredDomains
      .map((domain) => {
        if (!domain.geneId) return null;
        const gene = currentPhage?.genes?.find((g) => g.id === domain.geneId);
        if (!gene) return null;

        return {
          start: gene.startPos,
          end: gene.endPos,
          label: domain.domainName ?? domain.domainId,
          color: getDomainColor(domain.domainType),
          height: 16,
          data: domain,
        } as GenomeTrackSegment;
      })
      .filter((segment): segment is GenomeTrackSegment => segment !== null);
  }, [filteredDomains, currentPhage]);

  // Handle gene click for detail view
  const handleGeneClick = useCallback((gene: GeneInfo) => {
    setSelectedGene((prev) => (prev?.id === gene.id ? null : gene));
  }, []);

  if (!isOpen('proteinDomains')) return null;

  return (
    <Overlay
      id="proteinDomains"
      title="PROTEIN DOMAINS"
      hotkey="Alt+D"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Description */}
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.85rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong style={{ color: colors.accent }}>Protein Domain Annotations</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about protein domains"
                tooltip={overlayHelp?.summary ?? 'Protein domains are conserved functional units that can be identified by sequence similarity.'}
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'protein-domain')}
              />
            )}
          </div>
          <div>
            Conserved protein domains identified via InterProScan. Domains provide
            functional predictions and evolutionary insights for phage proteins.
          </div>
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              onClick={() => setViewMode('phage')}
              style={{
                padding: '0.25rem 0.5rem',
                borderRadius: '4px',
                border: `1px solid ${viewMode === 'phage' ? colors.accent : colors.borderLight}`,
                backgroundColor: viewMode === 'phage' ? colors.accent : 'transparent',
                color: viewMode === 'phage' ? colors.background : colors.textMuted,
                cursor: 'pointer',
                fontSize: '0.75rem',
              }}
            >
              Per-gene view
            </button>
            <button
              onClick={() => setViewMode('chord')}
              style={{
                padding: '0.25rem 0.5rem',
                borderRadius: '4px',
                border: `1px solid ${viewMode === 'chord' ? colors.accent : colors.borderLight}`,
                backgroundColor: viewMode === 'chord' ? colors.accent : 'transparent',
                color: viewMode === 'chord' ? colors.background : colors.textMuted,
                cursor: 'pointer',
                fontSize: '0.75rem',
              }}
            >
              Chord plot (cross-phage)
            </button>
          </div>
        </div>

        {viewMode === 'phage' ? (
          loading ? (
            <OverlayLoadingState message="Loading protein domains...">
              <AnalysisPanelSkeleton />
            </OverlayLoadingState>
          ) : domains.length === 0 ? (
            <OverlayEmptyState
              message={!currentPhage ? 'No phage selected' : 'No protein domain annotations available'}
              hint={!currentPhage ? 'Select a phage to analyze.' : 'Domain annotations are computed via InterProScan.'}
            />
          ) : (
            <>
              {/* Stats and filter */}
              <div
                style={{
                  display: 'flex',
                  gap: '1rem',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  fontSize: '0.8rem',
                }}
              >
                <span style={{ color: colors.textMuted }}>
                  {filteredDomains.length} domain{filteredDomains.length !== 1 ? 's' : ''} in{' '}
                  {geneDomains.length} gene{geneDomains.length !== 1 ? 's' : ''}
                </span>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <label htmlFor="domain-type-filter" style={{ color: colors.textMuted }}>
                    Filter:
                  </label>
                  <select
                    id="domain-type-filter"
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    style={{
                      padding: '0.25rem',
                      backgroundColor: colors.backgroundAlt,
                      color: colors.text,
                      border: `1px solid ${colors.borderLight}`,
                      borderRadius: '3px',
                    }}
                  >
                    {domainTypes.map((type) => (
                      <option key={type} value={type}>
                        {type === 'all' ? 'All Types' : type}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Genome track visualization */}
              {currentPhage && currentPhage.genomeLength && (
                <div>
                  <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                    Domain Distribution
                  </div>
                  <GenomeTrack
                    genomeLength={currentPhage.genomeLength}
                    segments={domainSegments}
                    width={540}
                    height={40}
                    ariaLabel="Protein domain distribution track"
                  />
                </div>
              )}

              {/* Domain list by gene */}
              <div
                style={{
                  maxHeight: '300px',
                  overflowY: 'auto',
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                }}
              >
                {geneDomains.map(({ gene, domains: geneDoms }) => (
                  <div
                    key={gene.id}
                    style={{
                      borderBottom: `1px solid ${colors.borderLight}`,
                    }}
                  >
                    {/* Gene header */}
                    <button
                      onClick={() => handleGeneClick(gene)}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        backgroundColor:
                          selectedGene?.id === gene.id ? colors.backgroundAlt : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: colors.text, fontWeight: 500 }}>
                        {gene.name ?? gene.locusTag ?? `Gene ${gene.id}`}
                      </span>
                      <span style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                        {gene.startPos.toLocaleString()}-{gene.endPos.toLocaleString()} |{' '}
                        {geneDoms.length} domain{geneDoms.length !== 1 ? 's' : ''}
                      </span>
                    </button>

                    {/* Domain details when expanded */}
                    {selectedGene?.id === gene.id && (
                      <div
                        style={{
                          padding: '0.5rem',
                          backgroundColor: colors.backgroundAlt,
                          fontSize: '0.75rem',
                        }}
                      >
                        {geneDoms.map((domain) => (
                          <div
                            key={domain.id}
                            style={{
                              padding: '0.5rem',
                              marginBottom: '0.5rem',
                              borderLeft: `3px solid ${getDomainColor(domain.domainType)}`,
                              paddingLeft: '0.75rem',
                            }}
                          >
                            <div style={{ fontWeight: 500, color: colors.text }}>
                              {domain.domainName ?? domain.domainId}
                            </div>
                            <div style={{ color: colors.textMuted }}>
                              {domain.domainId} ({domain.domainType ?? 'Unknown'})
                            </div>
                            {domain.description && (
                              <div style={{ color: colors.textDim, marginTop: '0.25rem' }}>
                                {domain.description}
                              </div>
                            )}
                            <div style={{ color: colors.textDim, marginTop: '0.25rem' }}>
                              E-value: {formatEValue(domain.eValue)} | Score:{' '}
                              {domain.score?.toFixed(1) ?? 'N/A'}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Legend */}
              <div
                style={{
                  display: 'flex',
                  gap: '1rem',
                  flexWrap: 'wrap',
                  fontSize: '0.75rem',
                }}
              >
                {Object.entries(DOMAIN_COLORS)
                  .filter(([key]) => key !== 'default')
                  .map(([type, color]) => (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span
                        style={{
                          width: '10px',
                          height: '10px',
                          backgroundColor: color,
                          borderRadius: '2px',
                        }}
                      />
                      <span style={{ color: colors.textMuted }}>{type}</span>
                    </div>
                  ))}
              </div>
            </>
          )
        ) : loadingChord ? (
          <OverlayLoadingState message="Loading domain annotations across phages...">
            <AnalysisPanelSkeleton rows={3} />
          </OverlayLoadingState>
        ) : chordError ? (
          <OverlayErrorState
            message="Failed to load chord plot data"
            details={chordError}
          />
        ) : !chordMatrix || chordPhages.length === 0 ? (
          <OverlayEmptyState
            message="No cross-phage domain data available"
            hint="Chord plot requires protein_domains annotations in the database."
          />
        ) : (
          <>
            {/* Controls */}
            <div
              style={{
                display: 'flex',
                gap: '0.75rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                fontSize: '0.8rem',
              }}
            >
              <div style={{ color: colors.textMuted }}>
                {chordPhages.length} phage{chordPhages.length !== 1 ? 's' : ''} •{' '}
                {chordCounts.meta.size.toLocaleString()} unique domain{chordCounts.meta.size !== 1 ? 's' : ''}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor="chord-domain-type" style={{ color: colors.textMuted }}>
                  Domain type:
                </label>
                <select
                  id="chord-domain-type"
                  value={chordDomainType}
                  onChange={(e) => {
                    setChordDomainType(e.target.value);
                    setSelectedPair(null);
                    setHoverPair(null);
                  }}
                  style={{
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  {chordDomainTypes.map((type) => (
                    <option key={type} value={type}>
                      {type === 'all' ? 'All' : type}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor="chord-metric" style={{ color: colors.textMuted }}>
                  Similarity:
                </label>
                <select
                  id="chord-metric"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value as DomainChordMetric)}
                  style={{
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value="weightedJaccard">Weighted Jaccard (copies)</option>
                  <option value="jaccard">Jaccard (presence)</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor="chord-threshold" style={{ color: colors.textMuted }}>
                  Min link:
                </label>
                <select
                  id="chord-threshold"
                  value={minLinkStrength}
                  onChange={(e) => setMinLinkStrength(Number(e.target.value))}
                  style={{
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value={0.1}>0.10</option>
                  <option value={0.15}>0.15</option>
                  <option value={0.2}>0.20</option>
                  <option value={0.3}>0.30</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor="chord-maxlinks" style={{ color: colors.textMuted }}>
                  Max links:
                </label>
                <select
                  id="chord-maxlinks"
                  value={maxLinks}
                  onChange={(e) => setMaxLinks(Number(e.target.value))}
                  style={{
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value={16}>16</option>
                  <option value={24}>24</option>
                  <option value={32}>32</option>
                  <option value={48}>48</option>
                </select>
              </div>
            </div>

            {/* Visualizations */}
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <ChordPlot
                size={420}
                labels={chordPhages.map((p) => p.name)}
                colors={chordColors}
                links={chordLinks}
                selected={selectedPair}
                onSelect={(pair) => setSelectedPair(pair)}
                background={colors.background}
                border={colors.borderLight}
                text={colors.text}
              />

              <div>
                <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                  Pairwise similarity matrix (click a cell)
                </div>
                <HeatmapCanvas
                  width={Math.min(420, Math.max(280, chordMatrix.n * 34))}
                  height={Math.min(420, Math.max(280, chordMatrix.n * 34))}
                  matrix={{
                    rows: chordMatrix.n,
                    cols: chordMatrix.n,
                    values: chordMatrix.values,
                    min: 0,
                    max: 1,
                  }}
                  colorScale={similarityColorScale}
                  onHover={setHoverPair}
                  onClick={(info) => setSelectedPair(normalizePair(info.row, info.col))}
                  ariaLabel="Protein domain similarity matrix"
                />
                <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: colors.textMuted }}>
                  {activePairDetails ? (
                    <>
                      <span style={{ color: colors.text }}>{activePairDetails.aPhage.name}</span> ↔{' '}
                      <span style={{ color: colors.text }}>{activePairDetails.bPhage.name}</span> • score{' '}
                      <span style={{ color: colors.text }}>{activePairDetails.score.toFixed(3)}</span> • shared{' '}
                      <span style={{ color: colors.text }}>{activePairDetails.sharedDistinct}</span> domains
                    </>
                  ) : (
                    'Hover a cell to see pair details'
                  )}
                </div>
              </div>
            </div>

            {/* Pair details */}
            <div
              style={{
                padding: '0.75rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '6px',
                border: `1px solid ${colors.borderLight}`,
              }}
            >
              <div style={{ color: colors.primary, marginBottom: '0.5rem' }}>Shared domains</div>
              {!activePairDetails ? (
                <div style={{ color: colors.textMuted }}>
                  Select a pair from the matrix or chord plot to list shared domains.
                </div>
              ) : activePairDetails.sharedDomains.length === 0 ? (
                <div style={{ color: colors.textMuted }}>No shared domains under current filter.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.8rem' }}>
                  {activePairDetails.sharedDomains.map((d) => (
                    <div
                      key={d.meta.key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '1rem',
                        alignItems: 'baseline',
                      }}
                    >
                      <div style={{ color: colors.text }}>
                        {d.meta.domainName}{' '}
                        <span style={{ color: colors.textMuted }}>
                          ({d.meta.domainType}:{d.meta.domainId})
                        </span>
                      </div>
                      <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                        {activePairDetails.aPhage.name}: {d.a} • {activePairDetails.bPhage.name}: {d.b} • shared {d.shared}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default ProteinDomainOverlay;
