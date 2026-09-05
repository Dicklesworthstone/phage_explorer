/**
 * AMGPathwayOverlay - Auxiliary Metabolic Gene Visualization
 *
 * Displays AMG annotations mapped to KEGG pathways.
 * Shows how phage genes may modulate host metabolism.
 */

import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
  runAMGFluxAnalysis,
  runDeltaFbaForAmg,
  createStandardHostMetabolicModel,
  parseHostMetabolicModel,
  createAMGFluxRecord,
  restoreAMGFluxRecord,
  serializeAnalysisRecord,
  type AnalysisRecord,
  AMG_KNOWLEDGE_BASE,
  type PhageFull,
  type GeneInfo,
} from '@phage-explorer/core';
import type { PhageRepository, AmgAnnotation } from '../../db';
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
} from './primitives';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment } from './primitives/types';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { copyToClipboard, downloadString } from '../../utils/export';

/**
 * The marker genes the pipeline's AMG scanner actually looks for.
 *
 * Named here so the empty state can tell the user what was searched for rather
 * than implying a genome-wide capability. The previous hint said "AMG detection
 * requires KEGG pathway annotations", which is backwards: the scanner matches
 * these eight names against gene and product strings and ASSIGNS a KEGG
 * ortholog to whatever it finds. A user reading the old hint would conclude the
 * database was missing KEGG data for their phage, when the truth is that none of
 * that phage's genes was named for one of these eight.
 *
 * The list is duplicated from `packages/data-pipeline/src/build-db.ts`, which is
 * a build-time module the browser cannot import. `amg-marker-parity.test.ts`
 * asserts the two agree, so adding a ninth rule to the pipeline fails the suite
 * rather than silently making this message wrong.
 */
export const AMG_MARKER_GENES = [
  'psbA',
  'psbD',
  'phoH',
  'mazG',
  'nrdA',
  'nrdB',
  'thyA',
  'dut',
] as const;

// AMG type colors matching KEGG pathway categories
const AMG_COLORS: Record<string, string> = {
  photosynthesis: '#22c55e',  // Green - photosynthesis
  carbon: '#f59e0b',          // Orange - carbon metabolism
  nucleotide: '#3b82f6',      // Blue - nucleotide metabolism
  amino_acid: '#8b5cf6',      // Purple - amino acid metabolism
  sulfur: '#eab308',          // Yellow - sulfur/nitrogen
  phosphorus: '#14b8a6',      // Teal - phosphorus
  stress: '#ef4444',          // Red - stress response
  lipid: '#ec4899',           // Pink - lipid metabolism
  default: '#6b7280',         // Gray - unknown
};

function getAmgColor(amgType: string): string {
  return AMG_COLORS[amgType] ?? AMG_COLORS.default;
}

function formatGain(value: number | null): string {
  return value === null ? 'Undefined (zero baseline)' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

// AMG type descriptions
const AMG_DESCRIPTIONS: Record<string, string> = {
  photosynthesis: 'Photosynthesis-related genes that can enhance host photosynthetic capacity during infection',
  carbon: 'Carbon metabolism genes that redirect host carbon flux for viral replication',
  nucleotide: 'Nucleotide biosynthesis genes that boost nucleotide pools for genome replication',
  amino_acid: 'Amino acid metabolism genes for protein synthesis support',
  sulfur: 'Sulfur/nitrogen metabolism genes for nutrient acquisition',
  phosphorus: 'Phosphorus metabolism genes for nucleic acid synthesis',
  stress: 'Stress response genes that help maintain host viability',
  lipid: 'Lipid metabolism genes for membrane synthesis',
};

interface AMGPathwayOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function AMGPathwayOverlay({
  repository,
  currentPhage,
}: AMGPathwayOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('amgPathway');

  const [activeTab, setActiveTab] = useState<'annotations' | 'flux'>('annotations');
  const [boostMultiplier, setBoostMultiplier] = useState<number>(5.0);
  const [showFullFluxTable, setShowFullFluxTable] = useState<boolean>(false);
  const [hostModel, setHostModel] = useState(createStandardHostMetabolicModel);
  const [modelSource, setModelSource] = useState<'illustrative' | 'imported'>('illustrative');
  const [modelError, setModelError] = useState<string | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [experimentNotice, setExperimentNotice] = useState<string | null>(null);
  const open = isOpen('amgPathway');
  const activeInputs = useRef({ phage: currentPhage, hostModel, boostMultiplier, modelSource, open });
  activeInputs.current = { phage: currentPhage, hostModel, boostMultiplier, modelSource, open };
  const [experimentSnapshot, setExperimentSnapshot] = useState<{ record: AnalysisRecord; inputs: typeof activeInputs.current } | null>(null);
  const experiment = experimentSnapshot?.inputs.phage === currentPhage && experimentSnapshot.inputs.hostModel === hostModel &&
    experimentSnapshot.inputs.boostMultiplier === boostMultiplier && experimentSnapshot.inputs.modelSource === modelSource ? experimentSnapshot.record : null;
  const importJob = useRef(0);

  const [amgs, setAmgs] = useState<AmgAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedAmg, setSelectedAmg] = useState<AmgAnnotation | null>(null);
  const [filterType, setFilterType] = useState<string>('all');

  const fluxAnalysis = useMemo(
    () => runAMGFluxAnalysis(currentPhage, { boostFactor: boostMultiplier, hostModel }),
    [currentPhage, boostMultiplier, hostModel]
  );

  const simulatedCandidateGains = useMemo(() => {
    if (fluxAnalysis.detectedAmgs.length > 0) return [];
    return AMG_KNOWLEDGE_BASE.flatMap((kb) => {
      const dummyAmg = {
        geneId: 999,
        geneName: kb.ko.name.split(' ')[0],
        locusTag: kb.ko.ko,
        start: 0,
        end: 1000,
        strand: '+',
        amgClass: kb.amgClass,
        koMapping: kb.ko,
        evidence: 'gene_name' as const,
        boostedReactions: [...kb.reactions],
      };
      const res = runDeltaFbaForAmg(hostModel, dummyAmg, fluxAnalysis.baselineFba, boostMultiplier);
      if (res.status !== 'optimal') return [];
      return [{
        kb,
        res,
      }];
    });
  }, [fluxAnalysis, boostMultiplier, hostModel]);

  useEffect(() => {
    if (!open || activeTab !== 'flux') return;
    let cancelled = false;
    const inputs = activeInputs.current;
    setExperimentSnapshot(null);
    setExperimentError(null);
    void createAMGFluxRecord(currentPhage, { boostFactor: boostMultiplier, hostModel, modelSource }).then(record => {
      if (!cancelled) setExperimentSnapshot({ record, inputs });
    }).catch(error => {
      if (!cancelled) setExperimentError(error instanceof Error ? error.message : 'Could not preserve experiment inputs.');
    });
    return () => { cancelled = true; };
  }, [currentPhage, hostModel, boostMultiplier, modelSource, activeTab, open]);

  useEffect(() => () => { importJob.current++; }, []);
  useEffect(() => { if (!open) importJob.current++; }, [open]);
  useEffect(() => { setExperimentNotice(null); setModelError(null); }, [currentPhage]);

  const importModel = async (file: File | undefined, restoreExperiment = false) => {
    if (!file) return;
    const job = ++importJob.current;
    const inputs = activeInputs.current;
    const isCurrent = () => job === importJob.current && activeInputs.current.open && inputs.phage === activeInputs.current.phage &&
      inputs.hostModel === activeInputs.current.hostModel && inputs.boostMultiplier === activeInputs.current.boostMultiplier && inputs.modelSource === activeInputs.current.modelSource;
    try {
      if (file.size > (restoreExperiment ? 10 * 1024 * 1024 : 1_000_000)) throw new Error(restoreExperiment ? 'Experiment JSON must be smaller than 10 MiB.' : 'Model JSON must be smaller than 1 MB.');
      const content = await file.text();
      const restored = restoreExperiment ? await restoreAMGFluxRecord(content, inputs.phage) : null;
      const model = restored?.hostModel ?? parseHostMetabolicModel(content);
      if (!isCurrent()) return;
      setHostModel(model);
      setModelSource(restored?.modelSource ?? 'imported');
      if (restored) setBoostMultiplier(restored.boostFactor);
      setModelError(null);
      setExperimentNotice(restored ? 'Experiment inputs restored. Results are recomputed with the recorded parameters.' : null);
    } catch (error) {
      if (!isCurrent()) return;
      setModelError(`${error instanceof Error ? error.message : 'Could not read model.'} Previous model retained.`);
    }
  };

  const exportFlux = async (copy = false) => {
    if (!experiment) return;
    try {
      const content = serializeAnalysisRecord(experiment);
      if (copy) { await copyToClipboard(content); setExperimentNotice('Experiment JSON copied.'); }
      else downloadString(content, 'amg-flux.json', 'application/json');
    } catch (error) {
      setExperimentError(error instanceof Error ? error.message : 'Could not export the experiment.');
    }
  };

  // Hotkey (Alt+A for AMG)
  useHotkey(
    ActionIds.OverlayAMGPathway,
    () => toggle('amgPathway'),
    { modes: ['NORMAL'] }
  );

  // Fetch AMGs when overlay opens
  useEffect(() => {
    if (!isOpen('amgPathway')) return;
    if (!repository?.getAmgAnnotations || !currentPhage) {
      setAmgs([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    repository
      .getAmgAnnotations(currentPhage.id)
      .then((annotations) => {
        if (!cancelled) setAmgs(annotations);
      })
      .catch(() => {
        if (!cancelled) setAmgs([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Get unique AMG types
  const amgTypes = useMemo(() => {
    const types = new Set(amgs.map((a) => a.amgType));
    return ['all', ...Array.from(types)];
  }, [amgs]);

  // Filter AMGs
  const filteredAmgs = useMemo(() => {
    if (filterType === 'all') return amgs;
    return amgs.filter((a) => a.amgType === filterType);
  }, [amgs, filterType]);

  // Count by type for summary
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const amg of amgs) {
      counts[amg.amgType] = (counts[amg.amgType] ?? 0) + 1;
    }
    return counts;
  }, [amgs]);

  // Create genome track segments (only include those with valid gene positions)
  const amgSegments = useMemo((): GenomeTrackSegment[] => {
    return filteredAmgs
      .map((amg) => {
        if (!amg.geneId) return null;
        const gene = currentPhage?.genes?.find((g) => g.id === amg.geneId);
        if (!gene) return null;

        return {
          start: gene.startPos,
          end: gene.endPos,
          label: amg.keggOrtholog ?? amg.amgType,
          color: getAmgColor(amg.amgType),
          height: 16,
          data: amg,
        } as GenomeTrackSegment;
      })
      .filter((segment): segment is GenomeTrackSegment => segment !== null);
  }, [filteredAmgs, currentPhage]);

  // Handle AMG selection
  const handleAmgClick = useCallback((amg: AmgAnnotation) => {
    setSelectedAmg((prev) => (prev?.id === amg.id ? null : amg));
  }, []);

  // Find gene for AMG
  const getGeneForAmg = useCallback(
    (amg: AmgAnnotation): GeneInfo | undefined => {
      return currentPhage?.genes?.find((g) => g.id === amg.geneId);
    },
    [currentPhage]
  );

  if (!isOpen('amgPathway')) return null;

  return (
    <Overlay
      id="amgPathway"
      title="AUXILIARY METABOLIC GENES"
      hotkey="Alt+A"
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
            <strong style={{ color: colors.accent }}>AMG Detection (KEGG)</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about AMGs"
                tooltip={
                  overlayHelp?.summary ??
                  'AMGs are host-derived metabolic genes carried by phages that can redirect host metabolism during infection.'
                }
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'auxiliary-metabolic-gene')}
              />
            )}
          </div>
          <div>
            Auxiliary Metabolic Genes (AMGs) are host-derived genes that phages use to
            manipulate host metabolism during infection, particularly for enhancing
            energy production and nucleotide synthesis.
          </div>
        </div>

        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: '0.5rem', borderBottom: `1px solid ${colors.borderLight ?? '#334155'}` }}>
          <button
            type="button"
            onClick={() => setActiveTab('annotations')}
            style={{
              padding: '0.4rem 0.8rem',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              fontWeight: activeTab === 'annotations' ? 'bold' : 'normal',
              color: activeTab === 'annotations' ? (colors.accent ?? '#38bdf8') : (colors.textMuted ?? '#64748b'),
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'annotations' ? `2px solid ${colors.accent ?? '#38bdf8'}` : '2px solid transparent',
              cursor: 'pointer',
            }}
          >
            Annotations & Genome Track
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('flux')}
            style={{
              padding: '0.4rem 0.8rem',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              fontWeight: activeTab === 'flux' ? 'bold' : 'normal',
              color: activeTab === 'flux' ? (colors.accent ?? '#38bdf8') : (colors.textMuted ?? '#64748b'),
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'flux' ? `2px solid ${colors.accent ?? '#38bdf8'}` : '2px solid transparent',
              cursor: 'pointer',
            }}
          >
            Flux Potential (Delta-FBA)
          </button>
        </div>

        {activeTab === 'annotations' && (
          <>
            {loading ? (
              <OverlayLoadingState message="Loading AMG annotations...">
                <AnalysisPanelSkeleton />
              </OverlayLoadingState>
            ) : amgs.length === 0 ? (
              <OverlayEmptyState
                message={
                  !currentPhage
                    ? 'No phage selected'
                    : (currentPhage.genes?.length ?? 0) > 0
                      ? 'No auxiliary metabolic genes named in this genome’s annotations'
                      : 'No annotation data available for this phage'
                }
                hint={
                  !currentPhage
                    ? 'Select a phage to analyze.'
                    : (currentPhage.genes?.length ?? 0) > 0
                      ? `Searched ${currentPhage.genes?.length} CDS features for ${AMG_MARKER_GENES.length} marker genes (${AMG_MARKER_GENES.join(', ')}) in gene and product NAMES. Most phage genes in RefSeq are labelled “hypothetical protein”, so this is absence of evidence rather than evidence of absence.`
                      : 'This phage record has no CDS annotations available in the database.'
                }
              />
            ) : (
              <>
                {/* Summary stats */}
                <div
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    flexWrap: 'wrap',
                    fontSize: '0.8rem',
                  }}
                >
                  {Object.entries(typeCounts).map(([type, count]) => (
                    <div
                      key={type}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        padding: '0.25rem 0.5rem',
                        backgroundColor: colors.backgroundAlt,
                        borderRadius: '4px',
                        border: `1px solid ${getAmgColor(type)}`,
                      }}
                    >
                      <span
                        style={{
                          width: '8px',
                          height: '8px',
                          backgroundColor: getAmgColor(type),
                          borderRadius: '50%',
                        }}
                      />
                      <span style={{ color: colors.text, textTransform: 'capitalize' }}>
                        {type.replace('_', ' ')}: {count}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Filter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <label htmlFor="amg-type-filter" style={{ color: colors.textMuted }}>
                    Filter by type:
                  </label>
                  <select
                    id="amg-type-filter"
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
                    {amgTypes.map((type) => (
                      <option key={type} value={type}>
                        {type === 'all' ? 'All Types' : type.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Genome track */}
                {currentPhage && currentPhage.genomeLength && (
                  <div>
                    <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                      AMG Distribution
                    </div>
                    <GenomeTrack
                      genomeLength={currentPhage.genomeLength}
                      segments={amgSegments}
                      width={540}
                      height={40}
                      ariaLabel="AMG distribution track"
                    />
                  </div>
                )}

                {/* AMG list */}
                <div
                  style={{
                    maxHeight: '250px',
                    overflowY: 'auto',
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '4px',
                  }}
                >
                  {filteredAmgs.map((amg) => {
                    const gene = getGeneForAmg(amg);
                    const isSelected = selectedAmg?.id === amg.id;

                    return (
                      <div
                        key={amg.id}
                        style={{
                          borderBottom: `1px solid ${colors.borderLight}`,
                        }}
                      >
                        <button
                          onClick={() => handleAmgClick(amg)}
                          style={{
                            width: '100%',
                            padding: '0.5rem',
                            backgroundColor: isSelected ? colors.backgroundAlt : 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            textAlign: 'left',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span
                              style={{
                                width: '10px',
                                height: '10px',
                                backgroundColor: getAmgColor(amg.amgType),
                                borderRadius: '2px',
                              }}
                            />
                            <span style={{ color: colors.text, fontWeight: 500 }}>
                              {amg.keggOrtholog ?? amg.locusTag ?? 'Unknown'}
                            </span>
                          </div>
                          <span
                            style={{
                              color: colors.textMuted,
                              fontSize: '0.75rem',
                              textTransform: 'capitalize',
                            }}
                          >
                            {amg.amgType.replace('_', ' ')}
                          </span>
                        </button>

                        {isSelected && (
                          <div
                            style={{
                              padding: '0.75rem',
                              backgroundColor: colors.backgroundAlt,
                              fontSize: '0.8rem',
                            }}
                          >
                            <div style={{ marginBottom: '0.5rem' }}>
                              <strong style={{ color: colors.text }}>Pathway:</strong>{' '}
                              <span style={{ color: colors.textMuted }}>
                                {amg.pathwayName ?? amg.keggPathway ?? 'Unknown'}
                              </span>
                            </div>

                            {gene && (
                              <div style={{ marginBottom: '0.5rem' }}>
                                <strong style={{ color: colors.text }}>Gene:</strong>{' '}
                                <span style={{ color: colors.textMuted }}>
                                  {gene.name ?? gene.locusTag} ({gene.startPos.toLocaleString()}-
                                  {gene.endPos.toLocaleString()} bp)
                                </span>
                              </div>
                            )}

                            {amg.keggReaction && (
                              <div style={{ marginBottom: '0.5rem' }}>
                                <strong style={{ color: colors.text }}>Reaction:</strong>{' '}
                                <span style={{ color: colors.textMuted }}>{amg.keggReaction}</span>
                              </div>
                            )}

                            <div style={{ marginBottom: '0.5rem' }}>
                              <strong style={{ color: colors.text }}>Confidence:</strong>{' '}
                              <span
                                style={{
                                  color:
                                    (amg.confidence ?? 0) >= 0.8
                                      ? '#22c55e'
                                      : (amg.confidence ?? 0) >= 0.5
                                        ? '#f59e0b'
                                        : '#ef4444',
                                }}
                              >
                                {((amg.confidence ?? 0) * 100).toFixed(0)}%
                              </span>
                            </div>

                            <div
                              style={{
                                padding: '0.5rem',
                                backgroundColor: colors.background,
                                borderRadius: '4px',
                                color: colors.textDim,
                                fontSize: '0.75rem',
                                marginTop: '0.5rem',
                              }}
                            >
                              {AMG_DESCRIPTIONS[amg.amgType] ?? 'Metabolic gene of unknown function'}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
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
                  {Object.entries(AMG_COLORS)
                    .filter(([key]) => key !== 'default' && typeCounts[key])
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
                        <span style={{ color: colors.textMuted, textTransform: 'capitalize' }}>
                          {type.replace('_', ' ')}
                        </span>
                      </div>
                    ))}
                </div>
              </>
            )}
          </>
        )}

        {/* Tab 2: Flux Potential (Delta-FBA) */}
        {activeTab === 'flux' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Control bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '1rem',
                padding: '0.6rem 0.8rem',
                backgroundColor: colors.backgroundAlt ?? '#0f172a',
                borderRadius: '6px',
                border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
                <label
                  htmlFor="amg-boost-slider"
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                    color: colors.text ?? '#f8fafc',
                    fontWeight: 600,
                  }}
                >
                  Assumed capacity multiplier: <span style={{ color: colors.accent ?? '#38bdf8' }}>{boostMultiplier.toFixed(1)}x</span>
                </label>
                <input
                  id="amg-boost-slider"
                  type="range"
                  min={Math.min(1.5, boostMultiplier)}
                  max={Math.max(10, boostMultiplier)}
                  step="0.5"
                  value={boostMultiplier}
                  onChange={(e) => setBoostMultiplier(parseFloat(e.target.value))}
                  style={{ width: '140px', cursor: 'pointer' }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: colors.textMuted ?? '#64748b' }}>
                <span>Model:</span>
                <span style={{ color: colors.accent ?? '#38bdf8', fontFamily: 'monospace', fontWeight: 600 }}>{hostModel.name}</span>
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <label>Import model JSON <input aria-label="Import model JSON" type="file" accept=".json,application/json" onChange={event => { void importModel(event.target.files?.[0]); event.target.value = ''; }} /></label>
              <label>Restore experiment JSON <input aria-label="Restore experiment JSON" type="file" accept=".json,application/json" onChange={event => { void importModel(event.target.files?.[0], true); event.target.value = ''; }} /></label>
              <button type="button" onClick={() => { setHostModel(createStandardHostMetabolicModel()); setModelSource('illustrative'); setModelError(null); }}>Use teaching model</button>
              <button type="button" disabled={!experiment} onClick={() => void exportFlux()}>Export model and flux results</button>
              <button type="button" disabled={!experiment} onClick={() => void exportFlux(true)}>Copy experiment JSON</button>
            </div>
            {modelError && <div role="alert">{modelError}</div>}
            {experimentError && <div role="alert">{experimentError}</div>}
            {experimentNotice && <p role="status">{experimentNotice}</p>}
            {experiment && <AnalysisRecordDetails record={experiment} />}
            <p style={{ fontSize: '0.8rem', color: colors.textMuted }}>
              {modelSource === 'illustrative'
                ? 'Explore assumed reaction capacities in a teaching network, in arbitrary flux units. It combines reactions from different organisms and does not predict this phage’s host metabolism or measured fitness.'
                : 'User-supplied model. Flux units and biological interpretation depend on its source, medium and bounds; imported models are not independently validated here.'}
              {' '}{hostModel.description}
            </p>
            {fluxAnalysis.baselineFba.status !== 'optimal' ? (
              <div role="alert">Flux analysis unavailable: {fluxAnalysis.baselineFba.status}. No objective gain is reported.</div>
            ) : <>
            {fluxAnalysis.failedAmgs.length > 0 && (
              <div role="alert">No gain is reported for failed solves: {fluxAnalysis.failedAmgs.map(result => `${result.amg.geneName} (${result.status})`).join(', ')}.</div>
            )}
            {/* Top KPI Metrics Cards */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '0.6rem',
              }}
            >
              <div
                style={{
                  padding: '0.6rem',
                  backgroundColor: colors.backgroundAlt ?? '#0f172a',
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                }}
              >
                <div style={{ fontSize: '0.72rem', color: colors.textMuted ?? '#64748b' }}>Baseline dNTP Flux</div>
                <div style={{ fontSize: '1.05rem', fontWeight: 'bold', fontFamily: 'monospace', color: colors.text ?? '#f8fafc' }}>
                  {fluxAnalysis.baselineFba.objectiveValue.toFixed(3)}
                </div>
                <div style={{ fontSize: '0.68rem', color: colors.textDim ?? '#94a3b8' }}>{modelSource === 'illustrative' ? 'arbitrary flux units' : 'model flux units'}</div>
              </div>

              <div
                style={{
                  padding: '0.6rem',
                  backgroundColor: colors.backgroundAlt ?? '#0f172a',
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                }}
              >
                <div style={{ fontSize: '0.72rem', color: colors.textMuted ?? '#64748b' }}>Max Augmented Flux</div>
                <div style={{ fontSize: '1.05rem', fontWeight: 'bold', fontFamily: 'monospace', color: colors.success ?? '#22c55e' }}>
                  {fluxAnalysis.amgResults.length > 0
                    ? Math.max(...fluxAnalysis.amgResults.map((r) => r.augmentedObjective)).toFixed(3)
                    : fluxAnalysis.baselineFba.objectiveValue.toFixed(3)}
                </div>
                <div style={{ fontSize: '0.68rem', color: colors.textDim ?? '#94a3b8' }}>{modelSource === 'illustrative' ? 'arbitrary flux units' : 'model flux units'}</div>
              </div>

              <div
                style={{
                  padding: '0.6rem',
                  backgroundColor: colors.backgroundAlt ?? '#0f172a',
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                }}
              >
                <div style={{ fontSize: '0.72rem', color: colors.textMuted ?? '#64748b' }}>Max Objective Gain</div>
                <div
                  style={{
                    fontSize: '1.05rem',
                    fontWeight: 'bold',
                    fontFamily: 'monospace',
                    color: fluxAnalysis.amgResults.length > 0 ? (colors.success ?? '#22c55e') : (colors.textMuted ?? '#64748b'),
                  }}
                >
                  {fluxAnalysis.amgResults.length > 0 ? formatGain(fluxAnalysis.amgResults.some(r => r.percentGain === null) ? null : Math.max(...fluxAnalysis.amgResults.map(r => r.percentGain!))) : 'No AMG result'}
                </div>
                <div style={{ fontSize: '0.68rem', color: colors.textDim ?? '#94a3b8' }}>relative to the unmodified model</div>
              </div>

              <div
                style={{
                  padding: '0.6rem',
                  backgroundColor: colors.backgroundAlt ?? '#0f172a',
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                }}
              >
                <div style={{ fontSize: '0.72rem', color: colors.textMuted ?? '#64748b' }}>Primary Target Subsystem</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 'bold', color: colors.accent ?? '#38bdf8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {fluxAnalysis.topOverallImpactedSubsystem}
                </div>
                <div style={{ fontSize: '0.68rem', color: colors.textDim ?? '#94a3b8' }}>pathway bottleneck</div>
              </div>
            </div>

            {/* Results Section */}
            {fluxAnalysis.detectedAmgs.length === 0 ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  padding: '0.9rem',
                  backgroundColor: colors.backgroundAlt ?? '#0f172a',
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: colors.warning ?? '#eab308', fontWeight: 'bold', fontSize: '0.9rem' }}>
                    What-if examples (0 AMG candidates detected)
                  </span>
                </div>
                <div style={{ fontSize: '0.8rem', color: colors.textDim ?? '#94a3b8', lineHeight: 1.4 }}>
                  No AMG candidates matched the available annotations. The selected network has a baseline objective of{' '}
                  <strong style={{ color: colors.text ?? '#f8fafc' }}>{fluxAnalysis.baselineFba.objectiveValue.toFixed(3)} model units</strong>.
                  The examples below add hypothetical reaction capacity; they are not genes detected in this phage.
                </div>

                <div style={{ marginTop: '0.25rem' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: colors.text ?? '#f8fafc', marginBottom: '0.4rem' }}>
                    Projected What-If Flux Gains for Standard AMG Markers:
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${colors.borderLight ?? '#1e293b'}`, textAlign: 'left', color: colors.textMuted ?? '#64748b' }}>
                          <th style={{ padding: '0.35rem' }}>Marker</th>
                          <th style={{ padding: '0.35rem' }}>Class</th>
                          <th style={{ padding: '0.35rem' }}>Target Reaction</th>
                          <th style={{ padding: '0.35rem' }}>Baseline</th>
                          <th style={{ padding: '0.35rem' }}>Augmented</th>
                          <th style={{ padding: '0.35rem' }}>Proj. Gain</th>
                        </tr>
                      </thead>
                      <tbody>
                        {simulatedCandidateGains.map(({ kb, res }) => (
                          <tr key={kb.ko.ko} style={{ borderBottom: `1px solid ${colors.borderLight ?? '#1e293b'}33` }}>
                            <td style={{ padding: '0.35rem', fontWeight: 'bold', color: colors.accent ?? '#38bdf8' }}>
                              {kb.ko.name.split(' ')[0]}
                            </td>
                            <td style={{ padding: '0.35rem', color: getAmgColor(kb.amgClass), textTransform: 'capitalize' }}>
                              {kb.amgClass}
                            </td>
                            <td style={{ padding: '0.35rem', color: colors.textMuted ?? '#64748b' }}>
                              {kb.reactions[0]}
                            </td>
                            <td style={{ padding: '0.35rem', color: colors.text ?? '#f8fafc' }}>
                              {res.baselineObjective.toFixed(3)}
                            </td>
                            <td style={{ padding: '0.35rem', color: colors.success ?? '#22c55e', fontWeight: 'bold' }}>
                              {res.augmentedObjective.toFixed(3)}
                            </td>
                            <td style={{ padding: '0.35rem', color: (res.percentGain ?? 0) > 0 ? (colors.success ?? '#22c55e') : (colors.textMuted ?? '#64748b') }}>
                              {formatGain(res.percentGain)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 'bold', color: colors.text ?? '#f8fafc' }}>
                  Detected Auxiliary Metabolic Genes & Delta-FBA Impacts ({fluxAnalysis.detectedAmgs.length})
                </div>

                {fluxAnalysis.amgResults.map((res) => (
                  <div
                    key={res.amg.geneId}
                    style={{
                      padding: '0.8rem',
                      backgroundColor: colors.backgroundAlt ?? '#0f172a',
                      borderRadius: '6px',
                      border: `1px solid ${getAmgColor(res.amg.amgClass)}66`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.6rem',
                    }}
                  >
                    {/* Header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span
                          style={{
                            width: '10px',
                            height: '10px',
                            borderRadius: '2px',
                            backgroundColor: getAmgColor(res.amg.amgClass),
                          }}
                        />
                        <span style={{ fontWeight: 'bold', fontFamily: 'monospace', fontSize: '0.95rem', color: colors.text ?? '#f8fafc' }}>
                          {res.amg.geneName}
                        </span>
                        <span style={{ fontSize: '0.75rem', color: colors.textMuted ?? '#64748b', fontFamily: 'monospace' }}>
                          ({res.amg.locusTag})
                        </span>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '3px',
                            backgroundColor: `${getAmgColor(res.amg.amgClass)}22`,
                            color: getAmgColor(res.amg.amgClass),
                            textTransform: 'capitalize',
                            fontWeight: 600,
                          }}
                        >
                          {res.amg.amgClass}
                        </span>
                        <span
                          style={{
                            fontSize: '0.68rem',
                            padding: '0.1rem 0.35rem',
                            borderRadius: '3px',
                            backgroundColor: `${colors.borderLight ?? '#334155'}55`,
                            color: colors.textDim ?? '#94a3b8',
                          }}
                        >
                          Evidence: {res.amg.evidence}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span
                          style={{
                            fontFamily: 'monospace',
                            fontWeight: 'bold',
                            fontSize: '0.85rem',
                            padding: '0.2rem 0.5rem',
                            borderRadius: '4px',
                            backgroundColor: `${colors.success ?? '#22c55e'}22`,
                            color: colors.success ?? '#22c55e',
                            border: `1px solid ${colors.success ?? '#22c55e'}44`,
                          }}
                        >
                          {formatGain(res.percentGain)} model objective
                        </span>
                      </div>
                    </div>

                    {/* KO & Reaction Details */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', fontSize: '0.75rem', color: colors.textDim ?? '#94a3b8' }}>
                      <div>
                        <strong>KO:</strong>{' '}
                        <span style={{ fontFamily: 'monospace', color: colors.text ?? '#f8fafc' }}>
                          {res.amg.koMapping.ko}
                        </span>{' '}
                        ({res.amg.koMapping.name})
                      </div>
                      <div>
                        <strong>Reaction:</strong>{' '}
                        <span style={{ fontFamily: 'monospace', color: colors.text ?? '#f8fafc' }}>
                          {res.amg.koMapping.reaction} (EC {res.amg.koMapping.ecNumber})
                        </span>
                      </div>
                    </div>

                    {/* Pathway impacts */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', fontSize: '0.72rem' }}>
                      <span style={{ color: colors.textMuted ?? '#64748b', fontWeight: 600 }}>Impacted Subsystems:</span>
                      {res.pathwayImpacts.map((p) => (
                        <span
                          key={p.pathwayName}
                          style={{
                            padding: '0.15rem 0.4rem',
                            borderRadius: '3px',
                            backgroundColor:
                              p.significance === 'high'
                                ? `${colors.success ?? '#22c55e'}22`
                                : `${colors.accent ?? '#38bdf8'}22`,
                            color:
                              p.significance === 'high'
                                ? (colors.success ?? '#22c55e')
                                : (colors.accent ?? '#38bdf8'),
                            border: `1px solid ${
                              p.significance === 'high'
                                ? `${colors.success ?? '#22c55e'}44`
                                : `${colors.accent ?? '#38bdf8'}44`
                            }`,
                            fontFamily: 'monospace',
                          }}
                        >
                          {p.pathwayName}: +{p.totalDeltaFlux.toFixed(2)} ({p.significance})
                        </span>
                      ))}
                    </div>

                    {/* Reaction deltas table */}
                    {res.topReactionDeltas.length > 0 && (
                      <div style={{ overflowX: 'auto', marginTop: '0.2rem' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', fontFamily: 'monospace' }}>
                          <thead>
                            <tr style={{ borderBottom: `1px solid ${colors.borderLight ?? '#1e293b'}`, textAlign: 'left', color: colors.textMuted ?? '#64748b' }}>
                              <th style={{ padding: '0.25rem 0.35rem' }}>Reaction</th>
                              <th style={{ padding: '0.25rem 0.35rem' }}>Subsystem</th>
                              <th style={{ padding: '0.25rem 0.35rem' }}>Base Flux</th>
                              <th style={{ padding: '0.25rem 0.35rem' }}>Augmented</th>
                              <th style={{ padding: '0.25rem 0.35rem' }}>Δ Flux</th>
                              <th style={{ padding: '0.25rem 0.35rem' }}>% Change</th>
                            </tr>
                          </thead>
                          <tbody>
                            {res.topReactionDeltas.map((rd) => (
                              <tr key={rd.reactionId} style={{ borderBottom: `1px solid ${colors.borderLight ?? '#1e293b'}22` }}>
                                <td style={{ padding: '0.25rem 0.35rem', color: colors.text ?? '#f8fafc' }}>{rd.reactionName}</td>
                                <td style={{ padding: '0.25rem 0.35rem', color: colors.textMuted ?? '#64748b' }}>{rd.subsystem}</td>
                                <td style={{ padding: '0.25rem 0.35rem', color: colors.textDim ?? '#94a3b8' }}>{rd.baselineFlux.toFixed(3)}</td>
                                <td style={{ padding: '0.25rem 0.35rem', color: colors.success ?? '#22c55e', fontWeight: 'bold' }}>{rd.augmentedFlux.toFixed(3)}</td>
                                <td style={{ padding: '0.25rem 0.35rem', color: rd.deltaFlux > 0 ? (colors.success ?? '#22c55e') : colors.textDim ?? '#94a3b8' }}>
                                  {rd.deltaFlux > 0 ? `+${rd.deltaFlux.toFixed(3)}` : rd.deltaFlux.toFixed(3)}
                                </td>
                                <td style={{ padding: '0.25rem 0.35rem', color: rd.percentChange > 0 ? (colors.success ?? '#22c55e') : colors.textDim ?? '#94a3b8' }}>
                                  +{rd.percentChange}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Toggle full stoichiometric model table */}
            <div style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setShowFullFluxTable((prev) => !prev)}
                style={{
                  padding: '0.35rem 0.75rem',
                  fontSize: '0.75rem',
                  fontFamily: 'monospace',
                  backgroundColor: colors.backgroundAlt ?? '#0f172a',
                  color: colors.text ?? '#f8fafc',
                  border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                {showFullFluxTable ? '▼ Hide Stoichiometric Network Fluxes' : `▶ View Full Stoichiometric Network Fluxes (${hostModel.reactions.length} Reactions)`}
              </button>

              {showFullFluxTable && (
                <div
                  style={{
                    marginTop: '0.5rem',
                    maxHeight: '220px',
                    overflowY: 'auto',
                    border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                    borderRadius: '4px',
                    padding: '0.4rem',
                    backgroundColor: colors.backgroundAlt ?? '#0f172a',
                  }}
                >
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', fontFamily: 'monospace' }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${colors.borderLight ?? '#1e293b'}`, textAlign: 'left', color: colors.textMuted ?? '#64748b' }}>
                        <th style={{ padding: '0.25rem 0.35rem' }}>ID</th>
                        <th style={{ padding: '0.25rem 0.35rem' }}>Name</th>
                        <th style={{ padding: '0.25rem 0.35rem' }}>Subsystem</th>
                        <th style={{ padding: '0.25rem 0.35rem' }}>Bounds [lb, ub]</th>
                        <th style={{ padding: '0.25rem 0.35rem' }}>Base Flux</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hostModel.reactions.map((rxn) => (
                        <tr key={rxn.id} style={{ borderBottom: `1px solid ${colors.borderLight ?? '#1e293b'}22` }}>
                          <td style={{ padding: '0.25rem 0.35rem', color: colors.accent ?? '#38bdf8' }}>{rxn.id}</td>
                          <td style={{ padding: '0.25rem 0.35rem', color: colors.text ?? '#f8fafc' }}>{rxn.name}</td>
                          <td style={{ padding: '0.25rem 0.35rem', color: colors.textMuted ?? '#64748b' }}>{rxn.subsystem}</td>
                          <td style={{ padding: '0.25rem 0.35rem', color: colors.textDim ?? '#94a3b8' }}>[{rxn.lowerBound}, {rxn.upperBound}]</td>
                          <td style={{ padding: '0.25rem 0.35rem', color: colors.text ?? '#f8fafc', fontWeight: 'bold' }}>
                            {(fluxAnalysis.baselineFba.fluxes[rxn.id] ?? 0).toFixed(3)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            </>}
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default AMGPathwayOverlay;
