/**
 * EnvironmentalProvenanceOverlay
 *
 * Interactive visualization of phage environmental provenance:
 * - Novelty score and classification
 * - Biome distribution chart
 * - Geographic hit map
 * - Top metagenome hits list
 *
 * Hotkey: Ctrl+Shift+E (environmental)
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useHotkey } from '../../hooks/useHotkey';
import { usePhageStore } from '@phage-explorer/state';
import { SketchCache, initMinHashWasm } from '@phage-explorer/comparison';
import { OverlayProvenance } from './primitives';
import { ActionIds } from '../../keyboard';
import {
  analyzeProvenance,
  generateDemoProvenanceData,
  type ProvenanceResult,
  BIOME_NAMES,
  BIOME_COLORS,
} from '@phage-explorer/core';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import {
  searchPhageRelated,
  fetchSRARunMetadataBatch,
  processProvenanceData,
  getCached,
  setCache,
  generateCacheKey,
} from '../../api';

interface EnvironmentalProvenanceOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

type ViewMode = 'overview' | 'biomes' | 'geography' | 'hits';
type DataSource = 'loading' | 'real' | 'demo' | 'error';

/** Novelty badge color based on classification */
const NOVELTY_COLORS: Record<string, string> = {
  novel: '#e74c3c',
  rare: '#e67e22',
  uncommon: '#f1c40f',
  known: '#3498db',
  well_characterized: '#27ae60',
};

// NOTE: hashString and seededUnit used to live here. They existed for exactly
// one purpose -- turning a phage name into a number that looked like a
// containment score -- and became dead the moment that number was replaced with
// a measured one. Removed rather than left available for the next person who
// needs a plausible-looking value.

export function EnvironmentalProvenanceOverlay({
  // `repository` was declared on the props interface and never destructured,
  // so the overlay had a live database handle available and ignored it while
  // synthesising the number it most needed. It is used now.
  repository,
  currentPhage,
}: EnvironmentalProvenanceOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const biomeCanvasRef = useRef<HTMLCanvasElement>(null);
  const geoCanvasRef = useRef<HTMLCanvasElement>(null);

  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  const [result, setResult] = useState<ProvenanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>('loading');
  const [apiMessage, setApiMessage] = useState<string>('');

  const wasOpenRef = useRef(false);
  const lastAnalyzedKeyRef = useRef<string | null>(null);

  // Hotkey: Ctrl+Shift+E
  useHotkey(
    ActionIds.OverlayEnvironmentalProvenance,
    useCallback(() => toggle('environmentalProvenance'), [toggle]),
    { modes: ['NORMAL'] }
  );

  const phages = usePhageStore(s => s.phages);

  const overlayIsOpen = isOpen('environmentalProvenance');

  /**
   * Catalogue-relative distinctiveness: 1 - (max containment of this genome
   * within any OTHER catalogue genome), computed with real MinHash sketches.
   *
   * This is deliberately a different quantity from the metagenomic novelty the
   * overlay used to claim, and it is labelled as such. It answers "how much of
   * this genome appears elsewhere in the 24 reference phages", which is a
   * question the shipped data can actually answer.
   */
  const [distinctiveness, setDistinctiveness] = useState<{
    score: number;
    nearestId: string;
    containment: number;
  } | null>(null);
  const [distinctivenessState, setDistinctivenessState] =
    useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');

  // Compute catalogue-relative distinctiveness from real sketches.
  //
  // Separate from the SRA fetch above because it needs no network and answers
  // a different question. It replaces the hashed "containment" that used to
  // drive the headline novelty score.
  useEffect(() => {
    if (!overlayIsOpen || !repository || !currentPhage || phages.length === 0) return;

    let cancelled = false;
    setDistinctivenessState('loading');

    void (async () => {
      try {
        await initMinHashWasm();
        const cache = new SketchCache();

        for (const p of phages) {
          if (cancelled) return;
          const length = await repository.getFullGenomeLength(p.id);
          if (!Number.isFinite(length) || length <= 0) continue;
          const seq = await repository.getSequenceWindow(p.id, 0, length);
          if (!seq) continue;
          cache.getOrBuild(String(p.id), seq);
        }
        if (cancelled) return;

        const best = cache.maxContainment(String(currentPhage.id));
        if (!best) {
          // No comparable sketch. Report unavailable rather than 0, which
          // would render as "maximally distinctive" -- a confident wrong answer.
          setDistinctivenessState('unavailable');
          return;
        }
        const nearest = phages.find(p => String(p.id) === best.referenceId);
        setDistinctiveness({
          score: 1 - best.containment,
          nearestId: nearest?.name ?? best.referenceId,
          containment: best.containment,
        });
        setDistinctivenessState('ready');
      } catch {
        if (!cancelled) setDistinctivenessState('unavailable');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [overlayIsOpen, repository, currentPhage, phages]);

  // Run analysis when overlay opens or phage changes
  useEffect(() => {
    const justOpened = overlayIsOpen && !wasOpenRef.current;
    wasOpenRef.current = overlayIsOpen;

    if (!overlayIsOpen) return;

    const phageKey = String(currentPhage?.id ?? 'demo');
    const phageName = currentPhage?.name ?? 'bacteriophage';
    const shouldRun = justOpened || lastAnalyzedKeyRef.current !== phageKey || !result;
    if (!shouldRun) return;

    setLoading(true);
    setError(null);
    setDataSource('loading');
    setApiMessage('');

    let cancelled = false;

    const runAnalysis = async () => {
      try {
        lastAnalyzedKeyRef.current = phageKey;

        // Check cache first
        const cacheKey = generateCacheKey('provenance', { phageKey, phageName });
        const cached = getCached<{ result: ProvenanceResult; source: 'real' | 'demo' }>(cacheKey);
        if (cached) {
          if (cancelled) return;
          setResult(cached.result);
          setDataSource(cached.source);
          setApiMessage(cached.source === 'real' ? 'Data loaded from cache' : '');
          setLoading(false);
          return;
        }

        // Try real API: Search Serratus for phage-related sequences
        let usedRealData = false;
        try {
          setApiMessage('Searching Serratus database...');
          const serratusResult = await searchPhageRelated(phageName, 50);
          if (cancelled) return;

          if (serratusResult.success && serratusResult.data.matches.length > 0) {
            // Extract SRA run IDs
            const runIds = serratusResult.data.matches
              .map(m => m.run_id)
              .filter(id => id && (id.startsWith('SRR') || id.startsWith('ERR') || id.startsWith('DRR')));

            const uniqueRunIds = Array.from(new Set(runIds));
            if (uniqueRunIds.length > 0) {
              setApiMessage(`Fetching metadata for ${uniqueRunIds.length} SRA runs...`);
              // Limit to first 20 runs to avoid rate limiting
              const metadataResult = await fetchSRARunMetadataBatch(uniqueRunIds.slice(0, 20), 3);
              if (cancelled) return;

              if (metadataResult.success && metadataResult.data.length > 0) {
                // Process into provenance format
                const provenanceData = processProvenanceData(metadataResult.data);

                // Convert to hits format for analyzeProvenance.
                //
                // `containment` used to be
                //   0.3 + seededUnit(hashString(`${phageKey}:${loc.name}:...`)) * 0.5
                // i.e. a hash of the phage name and the location string, shown
                // under a green "REAL DATA" banner and driving the headline
                // novelty score (1 - maxContainment). It was the single most
                // misleading number in the app.
                //
                // It cannot be computed here honestly. SRA metadata gives
                // locations, isolation sources and sample counts -- it does not
                // give sequences, and containment is by definition a
                // sequence-to-sequence measure. There is nothing to compare
                // against, so no value is reported per location.
                //
                // It is null, not 0. Setting it to 0 was a first attempt at the
                // same honesty and it made things worse: 0 is a measured claim
                // that the genome shares nothing with the sample, so the
                // headline novelty score (1 - maxContainment) read 100% NOVEL
                // for every phage in the catalogue, under a green REAL DATA
                // banner. Null means not measured, and the analysis now returns
                // no novelty score at all rather than a maximal one.
                //
                // Real, correctly-scoped distinctiveness is computed separately
                // below against the catalogue, where sequences do exist.
                const realHits = provenanceData.locations.map(loc => ({
                  metagenomeId: loc.runIds[0] ?? loc.name,
                  source: 'other' as const, // SRA data doesn't fit other source categories
                  containment: null,
                  biome: mapIsolationSourceToBiome(loc.isolationSources[0]),
                  location: {
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    country: loc.name,
                  },
                  description: `${loc.sampleCount} samples from ${loc.isolationSources.join(', ') || 'various sources'}`,
                }));

                if (realHits.length > 0) {
                  const analysisResult = analyzeProvenance(realHits);
                  if (cancelled) return;
                  setResult(analysisResult);
                  setDataSource('real');
                  setApiMessage(`Found ${provenanceData.totalSamples} real samples from ${provenanceData.locations.length} locations`);
                  usedRealData = true;

                  // Cache the result
                  setCache(cacheKey, { result: analysisResult, source: 'real' as const }, { ttl: 24 * 60 * 60 * 1000 });
                }
              }
            }
          }
        } catch {
          // API failed, will fall back to demo data
        }

        // Fallback to demo data if real API didn't work
        if (!usedRealData) {
          if (cancelled) return;
          setApiMessage('Using demonstration data (API unavailable or no matches found)');
          const hits = generateDemoProvenanceData(phageKey);
          const analysisResult = analyzeProvenance(hits);
          setResult(analysisResult);
          setDataSource('demo');

          // Cache demo result with shorter TTL
          setCache(cacheKey, { result: analysisResult, source: 'demo' as const }, { ttl: 60 * 60 * 1000 });
        }
      } catch (err) {
        if (cancelled) return;
        setResult(null);
        setDataSource('error');
        setError(err instanceof Error ? err.message : 'Provenance analysis failed.');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    runAnalysis();

    return () => {
      cancelled = true;
    };
  }, [overlayIsOpen, result, currentPhage]);

  // Helper to map isolation source to BiomeType
  function mapIsolationSourceToBiome(source?: string): 'gut' | 'marine' | 'freshwater' | 'soil' | 'hot_spring' | 'wastewater' | 'clinical' | 'food' | 'unknown' {
    if (!source) return 'unknown';
    const s = source.toLowerCase();
    if (s.includes('soil') || s.includes('rhizo')) return 'soil';
    if (s.includes('water') || s.includes('ocean') || s.includes('sea') || s.includes('marine')) return 'marine';
    if (s.includes('fresh') || s.includes('lake') || s.includes('river')) return 'freshwater';
    if (s.includes('gut') || s.includes('feces') || s.includes('intestin') || s.includes('oral') || s.includes('saliva')) return 'gut';
    if (s.includes('waste') || s.includes('sewage') || s.includes('sludge')) return 'wastewater';
    if (s.includes('hot') || s.includes('thermal') || s.includes('vent')) return 'hot_spring';
    if (s.includes('hospital') || s.includes('clinical') || s.includes('patient')) return 'clinical';
    if (s.includes('food') || s.includes('dairy') || s.includes('ferment')) return 'food';
    return 'unknown';
  }

  // Draw biome distribution chart
  useEffect(() => {
    if (!isOpen('environmentalProvenance') || viewMode !== 'biomes') return;
    if (!biomeCanvasRef.current || !result) return;

    const canvas = biomeCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);

      const { biomeDistribution } = result;
      if (biomeDistribution.length === 0) {
        ctx.fillStyle = colors.textMuted;
        ctx.textAlign = 'center';
        ctx.font = '14px monospace';
        ctx.fillText('No biome data available', width / 2, height / 2);
        return;
      }

      const padding = 20;
      const barHeight = 30;
      const barGap = 10;
      const labelWidth = 120;
      const barMaxWidth = width - padding * 2 - labelWidth - 60;

      // When containment was never measured -- the usual case, since SRA
      // metadata carries no sequence -- the bars encode how many sampled
      // locations fall in each biome instead, and the axis says so. They used
      // to encode containment 0 for every biome, which divided by zero, drew
      // nothing, and printed "0%" beside every label as if measured.
      const measuredContainment = biomeDistribution.some(b => b.maxContainment !== null);
      const valueOf = (b: (typeof biomeDistribution)[number]) =>
        measuredContainment ? (b.maxContainment ?? 0) : b.hitCount;
      const maxValue = Math.max(...biomeDistribution.map(valueOf), 0);

      biomeDistribution.slice(0, 8).forEach((biome, i) => {
        const y = padding + i * (barHeight + barGap);
        const barWidth = maxValue > 0 ? (valueOf(biome) / maxValue) * barMaxWidth : 0;

        // Label
        ctx.fillStyle = colors.text;
        ctx.font = '12px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(BIOME_NAMES[biome.biome], padding, y + barHeight / 2);

        // Bar background
        ctx.fillStyle = colors.backgroundAlt;
        ctx.fillRect(padding + labelWidth, y, barMaxWidth, barHeight);

        // Bar fill
        ctx.fillStyle = BIOME_COLORS[biome.biome];
        ctx.fillRect(padding + labelWidth, y, barWidth, barHeight);

        // Value
        ctx.fillStyle = colors.text;
        ctx.textAlign = 'left';
        const label =
          measuredContainment && biome.maxContainment !== null
            ? `${Math.round(biome.maxContainment * 100)}%`
            : `${biome.hitCount} loc`;
        ctx.fillText(label, padding + labelWidth + barMaxWidth + 10, y + barHeight / 2);
      });

      // Say which quantity is on the axis, so the bars cannot be misread as
      // containment when they are location counts.
      ctx.fillStyle = colors.textMuted;
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        measuredContainment
          ? 'Bar length = maximum containment in biome'
          : 'Bar length = sampled locations per biome. Containment not measured.',
        padding,
        padding + Math.min(8, biomeDistribution.length) * (barHeight + barGap) + 4
      );
    };

    draw();

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [overlayIsOpen, viewMode, result, colors]);

  // Draw geographic map
  useEffect(() => {
    if (!isOpen('environmentalProvenance') || viewMode !== 'geography') return;
    if (!geoCanvasRef.current || !result) return;

    const canvas = geoCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);

      const { geoHeatmap } = result;

      // Draw simplified world map outline
      ctx.strokeStyle = colors.borderLight;
      ctx.lineWidth = 1;

      // Equirectangular projection helpers
      const latToY = (lat: number) => height / 2 - (lat / 90) * (height / 2);
      const lonToX = (lon: number) => width / 2 + (lon / 180) * (width / 2);

      // Draw grid
      ctx.strokeStyle = colors.borderLight + '40';
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        ctx.moveTo(0, latToY(lat));
        ctx.lineTo(width, latToY(lat));
        ctx.stroke();
      }
      for (let lon = -150; lon <= 150; lon += 30) {
        ctx.beginPath();
        ctx.moveTo(lonToX(lon), 0);
        ctx.lineTo(lonToX(lon), height);
        ctx.stroke();
      }

      // Draw hits.
      //
      // Radius and opacity encode containment. Where containment was not
      // measured they must not vary, or every point renders at the minimum and
      // the map reads as "found everywhere, abundant nowhere". Unmeasured
      // points get one fixed neutral size, and the legend below says what the
      // markers mean in that case.
      for (const hit of geoHeatmap) {
        const x = lonToX(hit.lon);
        const y = latToY(hit.lat);

        const radius = hit.intensity === null ? 7 : 5 + hit.intensity * 15;
        const alpha = hit.intensity === null ? 0.45 : 0.3 + hit.intensity * 0.5;
        ctx.fillStyle = `rgba(231, 76, 60, ${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();

        // Outline
        ctx.strokeStyle = colors.error;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Draw legend
      ctx.fillStyle = colors.textDim;
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(
        geoHeatmap.some(h => h.intensity !== null)
          ? 'Circle size = containment strength'
          : 'Marker = sampled location. Containment not measured, so size carries no meaning.',
        10,
        height - 10
      );
    };

    draw();

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [overlayIsOpen, viewMode, result, colors]);

  if (!overlayIsOpen) return null;

  return (
    <Overlay id="environmentalProvenance" title="ENVIRONMENTAL PROVENANCE MAP" size="xl">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%' }}>
        {/* Data source banner */}
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: dataSource === 'real' ? colors.success + '22' : colors.warning + '22',
            border: `1px solid ${dataSource === 'real' ? colors.success : colors.warning}`,
            borderRadius: '4px',
            color: colors.text,
            fontSize: '0.85rem',
          }}
        >
          {dataSource === 'loading' && (
            <>
              <strong style={{ color: colors.accent }}>LOADING</strong>: {apiMessage || 'Connecting to Serratus and NCBI SRA databases...'}
            </>
          )}
          {dataSource === 'real' && (
            <>
              {/*
                The banner now says exactly which parts are real, because the
                previous unqualified "REAL DATA" sat above a containment score
                that was a hash of the phage name. Geography and sample counts
                come from SRA; per-sample containment does not exist, because
                SRA metadata carries no sequence to compare against.
              */}
              <strong style={{ color: colors.success }}>REAL DATA</strong>:{' '}
              {apiMessage || 'Locations, isolation sources and sample counts from NCBI SRA.'}{' '}
              <span style={{ color: colors.textMuted }}>
                Per-sample containment is not shown: SRA metadata carries no sequence to
                compare against. Sequence-level distinctiveness is measured against the
                24-genome catalogue below.
              </span>
            </>
          )}
          {dataSource === 'demo' && (
            <>
              <strong style={{ color: colors.warning }}>DEMO MODE</strong>: {apiMessage || 'Using synthetic data. Real data requires metagenome containment search results from databases like Serratus/IMG/VR.'}
            </>
          )}
          {dataSource === 'error' && (
            <>
              <strong style={{ color: colors.error }}>ERROR</strong>: Failed to fetch data. Showing demo visualization.
            </>
          )}
        </div>

        {/* Catalogue-relative distinctiveness: real, and labelled for what it is. */}
        {(distinctivenessState === 'ready' || distinctivenessState === 'loading' ||
          distinctivenessState === 'unavailable') && (
          <div
            style={{
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              padding: '0.75rem 1rem',
              marginBottom: '0.75rem',
              fontSize: '0.85rem',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
              Catalogue distinctiveness{' '}
              <OverlayProvenance level="measured" source="MinHash containment, k=16" />
            </div>
            {distinctivenessState === 'loading' && (
              <span style={{ color: colors.textMuted }}>Sketching the catalogue…</span>
            )}
            {distinctivenessState === 'unavailable' && (
              <span style={{ color: colors.textMuted }}>
                Not available for this phage. No score is shown rather than a default,
                because 0 would read as &ldquo;maximally distinctive&rdquo;.
              </span>
            )}
            {distinctivenessState === 'ready' && distinctiveness && (
              <div>
                <span style={{ color: colors.text, fontWeight: 600 }}>
                  {(distinctiveness.score * 100).toFixed(1)}%
                </span>{' '}
                of this genome&rsquo;s 16-mers are absent from every other catalogue
                genome. Closest relative:{' '}
                <span style={{ color: colors.accent }}>{distinctiveness.nearestId}</span>{' '}
                (contains {(distinctiveness.containment * 100).toFixed(1)}% of them).
                <div style={{ color: colors.textMuted, marginTop: '0.35rem' }}>
                  Measured against the 24 reference genomes shipped with the app, not
                  against metagenomes. A phage can be distinctive here and still be
                  common in the environment.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Novelty badge.

            Rendered only when a novelty score exists. It is absent whenever no
            hit carried a containment, which is every result built from SRA
            metadata -- that API returns locations and sample counts, never
            sequences. The badge previously read "Novelty Score: 100% / NOVEL"
            for every phage in the catalogue because containment was being set
            to 0, and it sat directly under the green REAL DATA banner. */}
        {result?.novelty && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.75rem 1rem',
              backgroundColor: NOVELTY_COLORS[result.novelty.classification] + '22',
              border: `1px solid ${NOVELTY_COLORS[result.novelty.classification]}`,
              borderRadius: '4px',
            }}
          >
            <div>
              <strong style={{ color: NOVELTY_COLORS[result.novelty.classification] }}>
                Novelty Score: {(result.novelty.score * 100).toFixed(0)}%
              </strong>
              <span
                style={{
                  marginLeft: '1rem',
                  padding: '0.25rem 0.5rem',
                  backgroundColor: NOVELTY_COLORS[result.novelty.classification],
                  color: '#fff',
                  borderRadius: '4px',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  fontWeight: 'bold',
                }}
              >
                {result.novelty.classification.replace('_', ' ')}
              </span>
            </div>
            <span style={{ color: colors.textDim, fontSize: '0.85rem' }}>
              {result.novelty.totalHits} metagenome hits
            </span>
          </div>
        )}

        {/* Why the novelty score is missing, said explicitly. An absent number
            with no explanation reads as a bug; this says it was not measured
            and what would be needed to measure it. */}
        {result && !result.novelty && (
          <div
            style={{
              padding: '0.75rem 1rem',
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              fontSize: '0.85rem',
              color: colors.textMuted,
            }}
          >
            <strong style={{ color: colors.text }}>No novelty score.</strong> Novelty is
            1 &minus; containment against metagenomes, and containment is a
            sequence-to-sequence measure. The SRA records behind this view carry
            locations, isolation sources and sample counts, but no sequence, so there is
            nothing to compare against. Computing it would need a sketch index of the
            metagenomes themselves. Catalogue distinctiveness above is measured and is a
            different question.
          </div>
        )}

        {/* View mode tabs */}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {(['overview', 'biomes', 'geography', 'hits'] as ViewMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: '0.5rem 1rem',
                border: `1px solid ${viewMode === mode ? colors.accent : colors.borderLight}`,
                borderRadius: '4px',
                backgroundColor: viewMode === mode ? colors.accent + '22' : 'transparent',
                color: viewMode === mode ? colors.accent : colors.text,
                cursor: 'pointer',
                fontFamily: 'monospace',
                fontSize: '0.85rem',
                textTransform: 'uppercase',
              }}
            >
              {mode === 'overview' && 'Overview'}
              {mode === 'biomes' && 'Biomes'}
              {mode === 'geography' && 'Geography'}
              {mode === 'hits' && 'Top Hits'}
            </button>
          ))}
        </div>

        {/* Content area */}
        {loading ? (
          <OverlayLoadingState message={apiMessage || 'Connecting to metagenome databases...'}>
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : error ? (
          <OverlayErrorState
            message="Failed to load provenance data"
            details={error}
          />
        ) : !result ? (
          <OverlayEmptyState
            message="No provenance data available"
            hint="Provenance analysis requires metagenome containment data from Serratus or similar databases."
          />
        ) : (
          <div style={{ flex: 1, overflow: 'auto' }}>
            {viewMode === 'overview' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* Primary habitat */}
                <div
                  style={{
                    padding: '1rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                  }}
                >
                  <div style={{ color: colors.textDim, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                    PRIMARY HABITAT
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    <span
                      style={{
                        width: '12px',
                        height: '12px',
                        borderRadius: '50%',
                        backgroundColor: BIOME_COLORS[result.primaryHabitat],
                      }}
                    />
                    <strong style={{ color: colors.text, fontSize: '1.1rem' }}>
                      {BIOME_NAMES[result.primaryHabitat]}
                    </strong>
                  </div>
                </div>

                {/* Ecological context */}
                <div
                  style={{
                    padding: '1rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                  }}
                >
                  <div style={{ color: colors.textDim, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                    ECOLOGICAL CONTEXT
                  </div>
                  <p style={{ color: colors.text, margin: 0, lineHeight: 1.5 }}>
                    {result.ecologicalContext}
                  </p>
                </div>

                {/* Novelty interpretation */}
                <div
                  style={{
                    padding: '1rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                  }}
                >
                  <div style={{ color: colors.textDim, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                    NOVELTY INTERPRETATION
                  </div>
                  <p style={{ color: colors.text, margin: 0, lineHeight: 1.5 }}>
                    {result.novelty.interpretation}
                  </p>
                </div>

                {/* Quick biome summary */}
                <div
                  style={{
                    padding: '1rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                  }}
                >
                  <div style={{ color: colors.textDim, fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                    BIOME DISTRIBUTION
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {result.biomeDistribution.slice(0, 5).map(b => (
                      <span
                        key={b.biome}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          padding: '0.25rem 0.5rem',
                          backgroundColor: BIOME_COLORS[b.biome] + '33',
                          border: `1px solid ${BIOME_COLORS[b.biome]}`,
                          borderRadius: '4px',
                          fontSize: '0.8rem',
                        }}
                      >
                        <span
                          style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            backgroundColor: BIOME_COLORS[b.biome],
                          }}
                        />
                        {BIOME_NAMES[b.biome]}: {Math.round(b.maxContainment * 100)}%
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {viewMode === 'biomes' && (
              <div
                style={{
                  height: '350px',
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                  overflow: 'hidden',
                }}
              >
                <canvas ref={biomeCanvasRef} role="img" aria-label="Biome distribution chart showing environmental source predictions" style={{ width: '100%', height: '100%', display: 'block' }} />
              </div>
            )}

            {viewMode === 'geography' && (
              <div
                style={{
                  height: '350px',
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                  overflow: 'hidden',
                }}
              >
                <canvas ref={geoCanvasRef} role="img" aria-label="Geographic distribution map showing sample locations" style={{ width: '100%', height: '100%', display: 'block' }} />
              </div>
            )}

            {viewMode === 'hits' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {result.topHits.map((hit, i) => (
                  <div
                    key={hit.metagenomeId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.75rem',
                      backgroundColor: i % 2 === 0 ? colors.backgroundAlt : 'transparent',
                      borderRadius: '4px',
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span
                          style={{
                            width: '10px',
                            height: '10px',
                            borderRadius: '50%',
                            backgroundColor: BIOME_COLORS[hit.biome],
                          }}
                        />
                        <strong style={{ color: colors.text }}>{hit.source}</strong>
                        <span style={{ color: colors.textDim, fontSize: '0.85rem' }}>
                          {hit.metagenomeId}
                        </span>
                      </div>
                      <div style={{ color: colors.textMuted, fontSize: '0.8rem', marginTop: '0.25rem' }}>
                        {hit.description}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ color: colors.accent, fontWeight: 'bold' }}>
                        {Math.round(hit.containment * 100)}%
                      </div>
                      <div style={{ color: colors.textDim, fontSize: '0.8rem' }}>
                        {hit.location.country}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default EnvironmentalProvenanceOverlay;
