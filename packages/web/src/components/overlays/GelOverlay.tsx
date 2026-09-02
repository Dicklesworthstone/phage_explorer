/**
 * GelOverlay - Virtual Gel Electrophoresis Simulation
 *
 * Simulates restriction enzyme digestion and gel electrophoresis
 * for experimental planning and genome verification.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { GelCanvas } from './primitives/GelCanvas';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import type { GelLane, GelBand, GelInteraction } from './primitives/types';

// Restriction enzyme database
interface RestrictionEnzyme {
  name: string;
  site: string; // Recognition sequence (5' to 3')
  cutOffset: number; // Offset from start of recognition site for cut
  color?: string;
}

const RESTRICTION_ENZYMES: RestrictionEnzyme[] = [
  { name: 'EcoRI', site: 'GAATTC', cutOffset: 1, color: '#ef4444' },
  { name: 'HindIII', site: 'AAGCTT', cutOffset: 1, color: '#f59e0b' },
  { name: 'BamHI', site: 'GGATCC', cutOffset: 1, color: '#22c55e' },
  { name: 'PstI', site: 'CTGCAG', cutOffset: 5, color: '#3b82f6' },
  { name: 'SalI', site: 'GTCGAC', cutOffset: 1, color: '#8b5cf6' },
  { name: 'XbaI', site: 'TCTAGA', cutOffset: 1, color: '#ec4899' },
  { name: 'SmaI', site: 'CCCGGG', cutOffset: 3, color: '#14b8a6' },
  { name: 'KpnI', site: 'GGTACC', cutOffset: 5, color: '#f97316' },
  { name: 'NcoI', site: 'CCATGG', cutOffset: 1, color: '#06b6d4' },
  { name: 'NdeI', site: 'CATATG', cutOffset: 2, color: '#a855f7' },
  { name: 'NotI', site: 'GCGGCCGC', cutOffset: 2, color: '#6366f1' },
  { name: 'XhoI', site: 'CTCGAG', cutOffset: 1, color: '#84cc16' },
];

// DNA size ladders
const LADDERS = {
  '1kb': {
    name: '1 kb Ladder',
    sizes: [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500],
  },
  '100bp': {
    name: '100 bp Ladder',
    sizes: [1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100],
  },
  'lambda_hindiii': {
    name: 'Lambda/HindIII',
    sizes: [23130, 9416, 6557, 4361, 2322, 2027, 564],
  },
};

// Find all occurrences of recognition site in sequence
function findCutSites(sequence: string, site: string): number[] {
  const positions: number[] = [];
  const upper = sequence.toUpperCase();
  let idx = 0;
  while ((idx = upper.indexOf(site, idx)) !== -1) {
    positions.push(idx);
    idx++;
  }
  return positions;
}

// Perform in silico digest
function digestSequence(
  sequence: string,
  enzymes: RestrictionEnzyme[]
): { fragments: number[]; cutSites: number[] } {
  if (!sequence || enzymes.length === 0) {
    return { fragments: [sequence.length], cutSites: [] };
  }

  // Collect all cut positions
  const allCuts: number[] = [0];
  for (const enzyme of enzymes) {
    const sites = findCutSites(sequence, enzyme.site);
    for (const pos of sites) {
      allCuts.push(pos + enzyme.cutOffset);
    }
  }
  allCuts.push(sequence.length);

  // Sort and dedupe
  const sortedCuts = [...new Set(allCuts)].sort((a, b) => a - b);

  // Calculate fragment sizes
  const fragments: number[] = [];
  for (let i = 0; i < sortedCuts.length - 1; i++) {
    const size = sortedCuts[i + 1] - sortedCuts[i];
    if (size > 0) {
      fragments.push(size);
    }
  }

  return {
    fragments: fragments.sort((a, b) => b - a),
    cutSites: sortedCuts.slice(1, -1),
  };
}

// Calculate band intensity based on fragment size
function calculateIntensity(size: number, maxSize: number): number {
  // Larger fragments appear brighter (more DNA)
  const sizeRatio = size / maxSize;
  // Apply sigmoid-like curve for realistic appearance
  return Math.min(1, 0.3 + sizeRatio * 0.7);
}

// Convert fragments to gel bands
function fragmentsToGelBands(fragments: number[], maxSize: number): GelBand[] {
  return fragments.map((size) => ({
    size,
    intensity: calculateIntensity(size, maxSize),
    label: formatSize(size),
  }));
}

// Format size for display
function formatSize(bp: number): string {
  if (bp >= 1000) {
    return `${(bp / 1000).toFixed(1)} kb`;
  }
  return `${bp} bp`;
}

interface GelOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Tooltip component for band details
function BandTooltip({
  band,
  colors,
}: {
  band: GelBand;
  colors: { textMuted: string };
}): React.ReactElement {
  return (
    <>
      <div style={{ fontWeight: 'bold' }}>{band.label ?? formatSize(band.size)}</div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        {band.size.toLocaleString()} bp
      </div>
    </>
  );
}

export function GelOverlay({
  repository,
  currentPhage,
}: GelOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [sequenceError, setSequenceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Selected enzymes for digest
  const [selectedEnzymes, setSelectedEnzymes] = useState<string[]>(['EcoRI']);
  const [ladderType, setLadderType] = useState<keyof typeof LADDERS>('1kb');

  // Hover state
  const [hoverInfo, setHoverInfo] = useState<GelInteraction | null>(null);

  // Hotkey to toggle overlay (Alt+G)
  useHotkey(
    ActionIds.OverlayGel,
    () => toggle('gel'),
    { modes: ['NORMAL'] }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('gel')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    // Check cache first
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSequenceError(null);
    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        if (cancelled) return;
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A failed database read used to render as "No sequence loaded", which
        // tells the user this phage has no data rather than that something
        // broke. Surface the real cause.
        setSequence('');
        setSequenceError(
          `Could not load sequence: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Toggle enzyme selection
  const toggleEnzyme = useCallback((name: string) => {
    setSelectedEnzymes((prev) =>
      prev.includes(name) ? prev.filter((e) => e !== name) : [...prev, name]
    );
  }, []);

  // Compute digest
  const digestResult = useMemo(() => {
    if (!sequence) return null;

    const enzymes = RESTRICTION_ENZYMES.filter((e) => selectedEnzymes.includes(e.name));
    const { fragments, cutSites } = digestSequence(sequence, enzymes);

    return {
      fragments,
      cutSites,
      numCuts: cutSites.length,
      enzymes,
    };
  }, [sequence, selectedEnzymes]);

  // Build gel lanes
  const gelLanes = useMemo((): GelLane[] => {
    const lanes: GelLane[] = [];
    const ladder = LADDERS[ladderType];
    const maxSize = Math.max(
      sequence?.length ?? 10000,
      ...ladder.sizes,
      ...(digestResult?.fragments ?? [])
    );

    // Ladder lane
    lanes.push({
      id: 'ladder',
      label: ladder.name,
      bands: ladder.sizes.map((size) => ({
        size,
        intensity: 0.6,
        label: formatSize(size),
      })),
      color: '#888',
    });

    // Uncut lane
    if (sequence) {
      lanes.push({
        id: 'uncut',
        label: 'Uncut',
        bands: [
          {
            size: sequence.length,
            intensity: 1,
            label: formatSize(sequence.length),
          },
        ],
        color: '#a5c9ff',
      });
    }

    // Digest lane
    if (digestResult && digestResult.fragments.length > 0) {
      const enzymeLabel =
        digestResult.enzymes.length > 0
          ? digestResult.enzymes.map((e) => e.name).join('+')
          : 'No enzyme';

      lanes.push({
        id: 'digest',
        label: enzymeLabel,
        bands: fragmentsToGelBands(digestResult.fragments, maxSize),
        color: digestResult.enzymes[0]?.color ?? '#a5c9ff',
      });
    }

    return lanes;
  }, [sequence, digestResult, ladderType]);

  // Handle hover
  const handleHover = useCallback((info: GelInteraction | null) => {
    setHoverInfo(info);
  }, []);

  if (!isOpen('gel')) return null;

  return (
    <Overlay id="gel" title="VIRTUAL GEL ELECTROPHORESIS" hotkey="Alt+G" size="lg">
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
          <strong style={{ color: colors.accent }}>Virtual Gel</strong>: Simulate restriction
          enzyme digestion and visualize fragment patterns. Useful for experimental planning
          and verifying genome assemblies.
        </div>

        {loading ? (
          <OverlayLoadingState message="Loading sequence data...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : sequenceError ? (
          <OverlayErrorState message="Could not load sequence" details={sequenceError} />
        ) : !sequence ? (
          <OverlayEmptyState
            message="No sequence loaded"
            hint="Select a phage to simulate gel electrophoresis."
          />
        ) : (
          <>
            {/* Enzyme selector */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.5rem',
                }}
              >
                Select Restriction Enzymes:
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}
              >
                {RESTRICTION_ENZYMES.map((enzyme) => {
                  const isSelected = selectedEnzymes.includes(enzyme.name);
                  const sites = findCutSites(sequence, enzyme.site);
                  return (
                    <button
                      key={enzyme.name}
                      onClick={() => toggleEnzyme(enzyme.name)}
                      style={{
                        padding: '0.25rem 0.5rem',
                        fontSize: '0.75rem',
                        backgroundColor: isSelected ? enzyme.color : colors.backgroundAlt,
                        color: isSelected ? '#fff' : colors.text,
                        border: `1px solid ${isSelected ? enzyme.color : colors.borderLight}`,
                        borderRadius: '4px',
                        cursor: 'pointer',
                        opacity: sites.length === 0 ? 0.5 : 1,
                      }}
                      title={`${enzyme.name}: ${enzyme.site} (${sites.length} cuts)`}
                    >
                      {enzyme.name} ({sites.length})
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Ladder selector */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                alignItems: 'center',
                fontSize: '0.8rem',
              }}
            >
              <label style={{ color: colors.textMuted }}>
                Ladder:
                <select
                  value={ladderType}
                  onChange={(e) => setLadderType(e.target.value as keyof typeof LADDERS)}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  {Object.entries(LADDERS).map(([key, ladder]) => (
                    <option key={key} value={key}>
                      {ladder.name}
                    </option>
                  ))}
                </select>
              </label>

              {digestResult && (
                <span style={{ color: colors.textMuted }}>
                  {digestResult.numCuts} cut{digestResult.numCuts !== 1 ? 's' : ''} →{' '}
                  {digestResult.fragments.length} fragment
                  {digestResult.fragments.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Gel canvas */}
            <div
              style={{
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <GelCanvas
                lanes={gelLanes}
                width={520}
                height={280}
                onHover={handleHover}
                ariaLabel="Virtual gel electrophoresis visualization"
              />

              {/* Lane labels */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-around',
                  padding: '0.25rem',
                  backgroundColor: colors.backgroundAlt,
                  fontSize: '0.7rem',
                  color: colors.textMuted,
                }}
              >
                {gelLanes.map((lane) => (
                  <span key={lane.id}>{lane.label}</span>
                ))}
              </div>

              {/* Hover tooltip */}
              {hoverInfo && (
                <div
                  style={{
                    position: 'absolute',
                    left: Math.min(hoverInfo.clientX - 50, 400),
                    top: 10,
                    backgroundColor: colors.backgroundAlt,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '4px',
                    padding: '0.5rem',
                    fontSize: '0.75rem',
                    color: colors.text,
                    pointerEvents: 'none',
                    zIndex: 10,
                  }}
                >
                  <BandTooltip band={hoverInfo.band} colors={colors} />
                </div>
              )}
            </div>

            {/* Fragment table */}
            {digestResult && digestResult.fragments.length > 1 && (
              <div>
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: colors.textMuted,
                    marginBottom: '0.25rem',
                  }}
                >
                  Fragments ({digestResult.fragments.length}):
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.25rem',
                    maxHeight: '60px',
                    overflowY: 'auto',
                    fontSize: '0.7rem',
                  }}
                >
                  {digestResult.fragments.map((size, idx) => (
                    <span
                      key={idx}
                      style={{
                        padding: '0.125rem 0.375rem',
                        backgroundColor: colors.backgroundAlt,
                        borderRadius: '3px',
                        color: colors.text,
                        fontFamily: 'monospace',
                      }}
                    >
                      {formatSize(size)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Interpretation */}
            <div
              style={{
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
                fontSize: '0.75rem',
                color: colors.textDim,
              }}
            >
              <strong>Usage:</strong> Select restriction enzymes to simulate digestion.
              Compare predicted band patterns with experimental gels to validate genome
              assemblies. Enzymes showing 0 cuts have no recognition sites in this genome.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default GelOverlay;
