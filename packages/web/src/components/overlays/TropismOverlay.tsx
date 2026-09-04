/**
 * TropismOverlay - Host receptor prediction dashboard
 *
 * Uses precomputed tropism predictions when available, otherwise falls back to
 * heuristic tail fiber analysis from @phage-explorer/comparison. Runs on the
 * main thread to avoid extra worker plumbing; fetches the full genome sequence
 * only when heuristics are needed.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { GeneInfo, PhageFull } from '@phage-explorer/core';
import {
  analyzeTailFiberTropism,
  simulateResidueMutation,
  type TropismAnalysis,
  type TailFiberHit,
  type ReceptorCandidate,
  type TropismPredictionInput,
} from '@phage-explorer/comparison';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import type { PhageRepository } from '../../db';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

// Type matching PhageFull.tropismPredictions entries (without phageId)
type TropismPredictionEntry = NonNullable<PhageFull['tropismPredictions']>[number];

interface TropismOverlayProps {
  repository: PhageRepository | null;
  phage: PhageFull | null;
}

function ConfidenceBar({ value, color }: { value: number; color: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        width: '100%',
      }}
    >
      <div
        style={{
          flex: 1,
          height: '10px',
          borderRadius: '6px',
          background: 'linear-gradient(90deg, rgba(34,197,94,0.15), rgba(34,197,94,0.35))',
          overflow: 'hidden',
          border: `1px solid ${color}`,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            backgroundColor: color,
          }}
        />
      </div>
      <span style={{ minWidth: '3ch', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
    </div>
  );
}

function PredictionRow({ hit, colors }: { hit: TailFiberHit; colors: ReturnType<typeof useTheme>['theme']['colors'] }) {
  return (
    <div
      style={{
        border: `1px solid ${colors.borderLight}`,
        borderRadius: '6px',
        padding: '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        backgroundColor: colors.backgroundAlt,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'baseline' }}>
        <div style={{ color: colors.primary, fontWeight: 700 }}>
          {hit.gene.name ?? hit.gene.locusTag ?? 'Tail fiber'}
        </div>
        <div style={{ color: colors.textDim, fontSize: '0.9rem' }}>
          {hit.gene.startPos?.toLocaleString() ?? '?'} – {hit.gene.endPos?.toLocaleString() ?? '?'}{' '}
          {hit.gene.strand ? `(${hit.gene.strand} strand)` : ''}
        </div>
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
        {hit.gene.product ?? 'Receptor-binding protein'}
        {hit.aaLength ? ` · ${hit.aaLength} aa` : ''}
      </div>
      {hit.motifs && hit.motifs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', color: colors.accent, fontSize: '0.85rem' }}>
          {hit.motifs.map(m => (
            <span
              key={m}
              style={{
                padding: '0.15rem 0.4rem',
                borderRadius: '4px',
                border: `1px solid ${colors.borderLight}`,
                backgroundColor: colors.background,
              }}
            >
              {m}
            </span>
          ))}
        </div>
      )}
      {hit.receptorCandidates.length === 0 ? (
        <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>No receptor candidates detected.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {hit.receptorCandidates.map((rc: ReceptorCandidate) => (
            <div key={rc.receptor} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '0.75rem', alignItems: 'center' }}>
              <div style={{ color: colors.success, fontWeight: 600 }}>{rc.receptor}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                <ConfidenceBar value={rc.confidence} color={colors.info} />
                {rc.evidence.length > 0 && (
                  <div style={{ color: colors.textMuted, fontSize: '0.85rem' }}>
                    Evidence: {rc.evidence.join(', ')}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function toPredictionInputs(phage: PhageFull, preds: TropismPredictionEntry[]): TropismPredictionInput[] {
  const genes = phage.genes ?? [];
  const byId = new Map<number, GeneInfo>();
  const byLocus = new Map<string, GeneInfo>();
  for (const g of genes) {
    if (typeof g.id === 'number') byId.set(g.id, g);
    if (g.locusTag) byLocus.set(g.locusTag, g);
  }

  return preds.map(p => {
    const gene =
      (typeof p.geneId === 'number' ? byId.get(p.geneId) : undefined) ??
      (p.locusTag ? byLocus.get(p.locusTag) : undefined);

    return {
      geneId: p.geneId,
      locusTag: p.locusTag,
      receptor: p.receptor,
      confidence: p.confidence,
      evidence: p.evidence,
      startPos: gene?.startPos,
      endPos: gene?.endPos,
      strand: gene?.strand ?? null,
      product: gene?.product ?? null,
    };
  });
}

export function TropismOverlay({ repository, phage }: TropismOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const [status, setStatus] = useState<LoadStatus>('idle');
  const [data, setData] = useState<TropismAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  // View mode: 'candidates' (standard predictions) vs 'structural_clash' (Roadmap #3 biophysical model)
  const [viewMode, setViewMode] = useState<'candidates' | 'structural_clash'>('candidates');

  // In-silico mutation simulator state
  const [simPosition, setSimPosition] = useState<number>(1);
  const [simMutantAa, setSimMutantAa] = useState<string>('W');

  // Filter state for residue epitope table
  const [domainFilter, setDomainFilter] = useState<'all' | 'n_anchor' | 'shaft' | 'distal_rbd'>('all');
  const [riskFilter, setRiskFilter] = useState<'all' | 'hypervariable' | 'essential_anchor' | 'clash_critical'>('all');

  const breadthLabel = useMemo(() => {
    if (!data) return null;
    if (data.breadth === 'narrow') return { text: 'NARROW: single receptor', color: colors.error };
    if (data.breadth === 'multi-receptor') return { text: 'BROAD: multiple receptor cues', color: colors.success };
    return { text: 'UNKNOWN', color: colors.textMuted };
  }, [data, colors]);

  const structural = data?.structuralAnalysis ?? null;

  // Initialize simulator to first hypervariable hotspot when available
  useEffect(() => {
    if (structural && structural.hypervariableHotspots.length > 0) {
      setSimPosition(structural.hypervariableHotspots[0]);
    } else if (structural && structural.residues.length > 0) {
      setSimPosition(structural.residues[0].position);
    }
  }, [structural]);

  // Live in-silico point mutation simulation
  const mutationResult = useMemo(() => {
    if (!structural || structural.residues.length === 0) return null;
    const validPos = Math.max(1, Math.min(structural.sequenceLength, simPosition));
    return simulateResidueMutation(structural, validPos, simMutantAa);
  }, [structural, simPosition, simMutantAa]);

  // Filtered residues for detail table
  const filteredResidues = useMemo(() => {
    if (!structural) return [];
    return structural.residues.filter((r) => {
      if (domainFilter !== 'all' && r.domain !== domainFilter) return false;
      if (riskFilter === 'hypervariable' && !r.isHypervariableEpitope) return false;
      if (riskFilter === 'essential_anchor' && !r.isEssentialAnchor) return false;
      if (riskFilter === 'clash_critical' && r.clashRisk !== 'critical') return false;
      return true;
    });
  }, [structural, domainFilter, riskFilter]);

  useHotkey(
    ActionIds.OverlayTropism,
    () => toggle('tropism'),
    { modes: ['NORMAL'] }
  );

  useEffect(() => {
    if (!isOpen('tropism') || !phage) return;
    let cancelled = false;
    const load = async () => {
      setStatus('loading');
      setError(null);
      try {
        const precomputed = phage.tropismPredictions ?? [];
        if (precomputed.length > 0) {
          const analysis = analyzeTailFiberTropism(phage, '', toPredictionInputs(phage, precomputed));
          if (!cancelled) {
            setData(analysis);
            setStatus('ready');
          }
          return;
        }

        // Fall back to heuristic analysis using full genome sequence if repository is available
        if (!repository) {
          throw new Error('Repository unavailable for tropism analysis');
        }

        const length = phage.genomeLength ?? 0;
        const sequence = length > 0 ? await repository.getSequenceWindow(phage.id, 0, length) : '';
        const analysis = analyzeTailFiberTropism(phage, sequence, []);
        if (!cancelled) {
          setData(analysis);
          setStatus('ready');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to run tropism analysis';
        if (!cancelled) {
          setError(message);
          setStatus('error');
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [isOpen, phage, repository]);

  if (!isOpen('tropism')) {
    return null;
  }

  const hits = data?.hits ?? [];

  return (
    <Overlay
      id="tropism"
      title="TROPISM & RECEPTOR PREDICTIONS"
      hotkey="0"
      size="xl"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Header stats grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '0.75rem',
          }}
        >
          <div style={{ padding: '0.75rem', borderRadius: '6px', border: `1px solid ${colors.borderLight}` }}>
            <div style={{ color: colors.textMuted, fontSize: '0.85rem' }}>Phage</div>
            <div style={{ color: colors.text, fontWeight: 700 }}>{phage?.name ?? 'Unknown'}</div>
            <div style={{ color: colors.textDim, fontSize: '0.85rem' }}>{phage?.host ?? 'Host unknown'}</div>
          </div>
          <div style={{ padding: '0.75rem', borderRadius: '6px', border: `1px solid ${colors.borderLight}` }}>
            <div style={{ color: colors.textMuted, fontSize: '0.85rem' }}>Breadth</div>
            <div style={{ color: breadthLabel?.color ?? colors.text, fontWeight: 700 }}>
              {breadthLabel?.text ?? 'N/A'}
            </div>
            <div style={{ color: colors.textDim, fontSize: '0.85rem' }}>
              Source: {data?.source ?? (phage?.tropismPredictions?.length ? 'precomputed' : 'heuristic')}
            </div>
          </div>
          <div style={{ padding: '0.75rem', borderRadius: '6px', border: `1px solid ${colors.borderLight}` }}>
            <div style={{ color: colors.textMuted, fontSize: '0.85rem' }}>Tail Fiber Hits</div>
            <div style={{ color: colors.text, fontWeight: 700 }}>{hits.length}</div>
            <div style={{ color: colors.textDim, fontSize: '0.85rem' }}>Receptor candidates detected</div>
          </div>
          <div style={{ padding: '0.75rem', borderRadius: '6px', border: `1px solid ${colors.borderLight}` }}>
            <div style={{ color: colors.textMuted, fontSize: '0.85rem' }}>Structural Epitopes</div>
            <div style={{ color: structural ? colors.success : colors.textMuted, fontWeight: 700 }}>
              {structural ? `${structural.hypervariableHotspots.length} Hotspots` : 'None'}
            </div>
            <div style={{ color: colors.textDim, fontSize: '0.85rem' }}>
              {structural ? `${structural.domains.length} modular domains` : 'No fiber gene'}
            </div>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div style={{ display: 'flex', gap: '0.5rem', borderBottom: `1px solid ${colors.borderLight}`, paddingBottom: '0.5rem' }}>
          <button
            type="button"
            onClick={() => setViewMode('candidates')}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: '4px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem',
              backgroundColor: viewMode === 'candidates' ? (colors.primary ?? '#3b82f6') : colors.backgroundAlt,
              color: viewMode === 'candidates' ? '#ffffff' : colors.textMuted,
            }}
          >
            Receptor Candidates & Predictions ({hits.length})
          </button>
          <button
            type="button"
            onClick={() => setViewMode('structural_clash')}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: '4px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem',
              backgroundColor: viewMode === 'structural_clash' ? (colors.primary ?? '#3b82f6') : colors.backgroundAlt,
              color: viewMode === 'structural_clash' ? '#ffffff' : colors.textMuted,
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            <span>Structural Epitope & Clash Map</span>
            <span
              style={{
                fontSize: '0.7rem',
                padding: '0.1rem 0.35rem',
                borderRadius: '3px',
                backgroundColor: viewMode === 'structural_clash' ? 'rgba(255,255,255,0.2)' : 'rgba(59,130,246,0.15)',
                color: viewMode === 'structural_clash' ? '#ffffff' : colors.primary,
              }}
            >
              Roadmap #3
            </span>
          </button>
        </div>

        {status === 'loading' && (
          <div
            style={{
              padding: '1rem',
              borderRadius: '6px',
              border: `1px solid ${colors.borderLight}`,
              color: colors.textMuted,
            }}
          >
            Running tropism and structural epitope analysis...
          </div>
        )}

        {status === 'error' && (
          <div
            style={{
              padding: '1rem',
              borderRadius: '6px',
              border: `1px solid ${colors.error}`,
              color: colors.error,
            }}
          >
            {error ?? 'Failed to compute tropism.'}
          </div>
        )}

        {/* Tab 1: Candidates View */}
        {status === 'ready' && viewMode === 'candidates' && (
          <>
            {hits.length === 0 ? (
              <div
                style={{
                  padding: '1rem',
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                  color: colors.textMuted,
                }}
              >
                {(phage?.genes?.length ?? 0) > 0
                  ? 'No receptor-binding protein candidates for this phage. These predictions are precomputed by protein-embedding similarity to known tail fibre and spike proteins and shipped with the database, so an empty result means either that no protein scored above threshold or that this phage was not covered by that precomputation — the overlay cannot tell the two apart.'
                  : 'No annotation data available for this phage (no CDS features found in database).'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {hits.map(hit => (
                  <PredictionRow key={hit.gene.locusTag ?? String(hit.gene.id)} hit={hit} colors={colors} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Tab 2: Structural Epitope Clash Map View */}
        {status === 'ready' && viewMode === 'structural_clash' && (
          <>
            {!structural ? (
              <div
                style={{
                  padding: '1.5rem',
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                  color: colors.textMuted,
                  backgroundColor: colors.backgroundAlt,
                  textAlign: 'center',
                }}
              >
                No tail fiber or receptor-binding protein was identified in this phage's annotations to model structural domain boundaries and clash profiles.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                {/* Summary Banner */}
                <div
                  style={{
                    padding: '0.85rem 1rem',
                    borderRadius: '6px',
                    border: `1px solid ${colors.borderLight}`,
                    backgroundColor: colors.backgroundAlt,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.35rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, color: colors.primary, fontSize: '0.95rem' }}>
                      Tail Fiber Architecture: {structural.geneName} ({structural.sequenceLength} aa)
                    </span>
                    <span style={{ fontSize: '0.8rem', color: colors.textMuted }}>
                      Mean Shannon Entropy: <strong>{structural.meanEntropy} bits</strong>
                    </span>
                  </div>
                  <div style={{ fontSize: '0.82rem', color: colors.textDim }}>
                    {structural.summary}
                  </div>
                </div>

                {/* Modular Domain Architecture Bar */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', fontSize: '0.82rem', fontWeight: 600, color: colors.text }}>
                    <span>Modular Domain Architecture</span>
                    <span style={{ color: colors.textMuted }}>Total Length: {structural.sequenceLength} aa</span>
                  </div>

                  {/* Horizontal Segmented Bar */}
                  <div
                    style={{
                      display: 'flex',
                      height: '26px',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      border: `1px solid ${colors.borderLight}`,
                      marginBottom: '0.6rem',
                    }}
                  >
                    {structural.domains.map((dom) => {
                      const widthPct = (dom.length / structural.sequenceLength) * 100;
                      const bgColor =
                        dom.type === 'n_anchor'
                          ? '#3b82f6' // Blue
                          : dom.type === 'shaft'
                            ? '#f59e0b' // Amber
                            : '#10b981'; // Emerald
                      return (
                        <div
                          key={dom.name}
                          style={{
                            width: `${widthPct}%`,
                            height: '100%',
                            backgroundColor: bgColor,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#ffffff',
                            fontSize: '0.72rem',
                            fontWeight: 700,
                            overflow: 'hidden',
                            whiteSpace: 'nowrap',
                            textOverflow: 'ellipsis',
                            padding: '0 0.25rem',
                          }}
                          title={`${dom.name} (${dom.startResidue}-${dom.endResidue})`}
                        >
                          {dom.name.split(' ')[0]} ({dom.startResidue}-{dom.endResidue})
                        </div>
                      );
                    })}
                  </div>

                  {/* Domain Cards */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                      gap: '0.6rem',
                    }}
                  >
                    {structural.domains.map((dom) => (
                      <div
                        key={dom.name}
                        style={{
                          padding: '0.6rem 0.75rem',
                          borderRadius: '6px',
                          border: `1px solid ${colors.borderLight}`,
                          backgroundColor: colors.backgroundAlt,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.25rem',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 700, fontSize: '0.82rem', color: colors.text }}>
                            {dom.name}
                          </span>
                          <span style={{ fontSize: '0.72rem', color: colors.accent, fontFamily: 'monospace' }}>
                            {dom.startResidue}–{dom.endResidue}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                          Class: <strong>{dom.structuralClass}</strong>
                        </div>
                        <div style={{ display: 'flex', gap: '0.6rem', fontSize: '0.72rem', color: colors.textDim }}>
                          <span>Entropy: {dom.meanEntropy}</span>
                          <span>SASA: {dom.meanSasa}%</span>
                          <span>ΔΔG: {dom.meanDdg} kcal</span>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: colors.textDim, marginTop: '0.2rem' }}>
                          {dom.description}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Bacterial Surface Receptor Affinity & Clash Matrix */}
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: colors.text, marginBottom: '0.4rem' }}>
                    Bacterial Surface Receptor Affinity & Clash Matrix
                  </div>
                  <div
                    style={{
                      borderRadius: '6px',
                      border: `1px solid ${colors.borderLight}`,
                      overflow: 'hidden',
                      backgroundColor: colors.backgroundAlt,
                    }}
                  >
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${colors.borderLight}`, backgroundColor: colors.background }}>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.6rem', color: colors.textMuted }}>Rank</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.6rem', color: colors.textMuted }}>Receptor</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.6rem', color: colors.textMuted }}>Category</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.6rem', color: colors.textMuted }}>Affinity Score</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.6rem', color: colors.textMuted }}>Electrostatic Fit</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.6rem', color: colors.textMuted }}>Steric Clash</th>
                          <th style={{ textAlign: 'left', padding: '0.45rem 0.6rem', color: colors.textMuted }}>Evidence / Rationale</th>
                        </tr>
                      </thead>
                      <tbody>
                        {structural.receptorScores.map((rc) => (
                          <tr key={rc.receptorId} style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                            <td style={{ padding: '0.4rem 0.6rem', fontWeight: 700, color: colors.accent }}>
                              #{rc.compatibilityRank}
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', fontWeight: 600, color: colors.text }}>
                              {rc.receptorName}
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', color: colors.textMuted }}>
                              {rc.category}
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', minWidth: '130px' }}>
                              <ConfidenceBar value={rc.affinityScore / 100} color={rc.affinityScore >= 70 ? (colors.success ?? '#22c55e') : (colors.warning ?? '#eab308')} />
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', color: rc.electrostaticFit >= 0 ? (colors.success ?? '#22c55e') : (colors.error ?? '#ef4444') }}>
                              {rc.electrostaticFit > 0 ? `+${rc.electrostaticFit.toFixed(2)}` : rc.electrostaticFit.toFixed(2)}
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', color: rc.stericClashScore > 25 ? (colors.error ?? '#ef4444') : (colors.success ?? '#22c55e') }}>
                              {rc.stericClashScore}%
                            </td>
                            <td style={{ padding: '0.4rem 0.6rem', color: colors.textDim, fontSize: '0.75rem' }}>
                              {rc.interactionEvidence.length > 0 ? rc.interactionEvidence.join('; ') : 'Equilibrium binding fit'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* In-Silico Point Mutation Clash Simulator */}
                <div
                  style={{
                    padding: '0.85rem 1rem',
                    borderRadius: '6px',
                    border: `1px solid ${colors.borderLight}`,
                    backgroundColor: colors.backgroundAlt,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 700, fontSize: '0.85rem', color: colors.text }}>
                      In-Silico Point Mutation Clash & Affinity Simulator
                    </div>
                    <span style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                      Evaluate ΔΔG stability perturbation and receptor re-targeting
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <label htmlFor="sim-pos-select" style={{ fontSize: '0.8rem', color: colors.textMuted }}>Position:</label>
                      <select
                        id="sim-pos-select"
                        value={simPosition}
                        onChange={(e) => setSimPosition(Number(e.target.value))}
                        style={{
                          padding: '0.25rem 0.5rem',
                          borderRadius: '4px',
                          border: `1px solid ${colors.borderLight}`,
                          backgroundColor: colors.background,
                          color: colors.text,
                          fontSize: '0.8rem',
                        }}
                      >
                        {structural.residues.slice(0, 150).map((r) => (
                          <option key={r.position} value={r.position}>
                            Residue {r.position} ({r.aminoAcid}) - {r.domain === 'distal_rbd' ? 'RBD' : r.domain} {r.isHypervariableEpitope ? '★' : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <label htmlFor="sim-mut-select" style={{ fontSize: '0.8rem', color: colors.textMuted }}>Target Amino Acid:</label>
                      <select
                        id="sim-mut-select"
                        value={simMutantAa}
                        onChange={(e) => setSimMutantAa(e.target.value)}
                        style={{
                          padding: '0.25rem 0.5rem',
                          borderRadius: '4px',
                          border: `1px solid ${colors.borderLight}`,
                          backgroundColor: colors.background,
                          color: colors.text,
                          fontSize: '0.8rem',
                        }}
                      >
                        {['A', 'R', 'N', 'D', 'C', 'E', 'Q', 'G', 'H', 'I', 'L', 'K', 'M', 'F', 'P', 'S', 'T', 'W', 'Y', 'V'].map((aa) => (
                          <option key={aa} value={aa}>
                            {aa} {aa === 'W' ? '(Tryptophan - Aromatic)' : aa === 'R' ? '(Arginine - Basic)' : aa === 'D' ? '(Aspartate - Acidic)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {mutationResult && (
                    <div
                      style={{
                        padding: '0.65rem 0.75rem',
                        borderRadius: '4px',
                        border: `1px solid ${mutationResult.clashPenalty > 50 ? (colors.error ?? '#ef4444') : colors.borderLight}`,
                        backgroundColor: colors.background,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.4rem',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.82rem', color: colors.text }}>
                          Result: {mutationResult.wildType}{mutationResult.position}{mutationResult.mutant}
                        </span>
                        <div style={{ display: 'flex', gap: '0.6rem', fontSize: '0.78rem' }}>
                          <span style={{ color: mutationResult.ddgDelta > 1.5 ? (colors.warning ?? '#eab308') : (colors.success ?? '#22c55e') }}>
                            ΔΔG: {mutationResult.ddgDelta > 0 ? `+${mutationResult.ddgDelta}` : mutationResult.ddgDelta} kcal/mol
                          </span>
                          <span style={{ color: mutationResult.clashPenalty > 40 ? (colors.error ?? '#ef4444') : (colors.success ?? '#22c55e') }}>
                            Clash Penalty: {mutationResult.clashPenalty}%
                          </span>
                        </div>
                      </div>
                      <div style={{ fontSize: '0.78rem', color: colors.textDim }}>
                        {mutationResult.predictedHostImpact}
                      </div>
                    </div>
                  )}
                </div>

                {/* Residue Epitope Risk Table */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: colors.text }}>
                      Residue Epitope & Biophysical Profile ({filteredResidues.length} displayed)
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <select
                        aria-label="Domain Filter"
                        value={domainFilter}
                        onChange={(e) => setDomainFilter(e.target.value as typeof domainFilter)}
                        style={{
                          padding: '0.2rem 0.4rem',
                          borderRadius: '4px',
                          border: `1px solid ${colors.borderLight}`,
                          backgroundColor: colors.backgroundAlt,
                          color: colors.text,
                          fontSize: '0.75rem',
                        }}
                      >
                        <option value="all">All Domains</option>
                        <option value="n_anchor">N-Anchor</option>
                        <option value="shaft">Shaft</option>
                        <option value="distal_rbd">Distal RBD</option>
                      </select>
                      <select
                        aria-label="Risk Filter"
                        value={riskFilter}
                        onChange={(e) => setRiskFilter(e.target.value as typeof riskFilter)}
                        style={{
                          padding: '0.2rem 0.4rem',
                          borderRadius: '4px',
                          border: `1px solid ${colors.borderLight}`,
                          backgroundColor: colors.backgroundAlt,
                          color: colors.text,
                          fontSize: '0.75rem',
                        }}
                      >
                        <option value="all">All Residues</option>
                        <option value="hypervariable">Hypervariable Hotspots (★)</option>
                        <option value="essential_anchor">Essential Anchors</option>
                        <option value="clash_critical">Critical Packing Risk</option>
                      </select>
                    </div>
                  </div>

                  <div
                    style={{
                      maxHeight: '260px',
                      overflowY: 'auto',
                      borderRadius: '6px',
                      border: `1px solid ${colors.borderLight}`,
                      backgroundColor: colors.backgroundAlt,
                    }}
                  >
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${colors.borderLight}`, backgroundColor: colors.background, position: 'sticky', top: 0 }}>
                          <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: colors.textMuted }}>Pos</th>
                          <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: colors.textMuted }}>AA</th>
                          <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: colors.textMuted }}>Domain</th>
                          <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: colors.textMuted }}>Entropy H(i)</th>
                          <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: colors.textMuted }}>SASA</th>
                          <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: colors.textMuted }}>ΔΔG (kcal)</th>
                          <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: colors.textMuted }}>Charge</th>
                          <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: colors.textMuted }}>Clash Risk</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredResidues.slice(0, 100).map((r) => (
                          <tr key={r.position} style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                            <td style={{ padding: '0.3rem 0.5rem', fontFamily: 'monospace' }}>{r.position}</td>
                            <td style={{ padding: '0.3rem 0.5rem', fontWeight: 700, color: colors.text }}>
                              {r.aminoAcid} {r.isHypervariableEpitope ? '★' : ''}
                            </td>
                            <td style={{ padding: '0.3rem 0.5rem', color: colors.textMuted }}>{r.domain}</td>
                            <td style={{ padding: '0.3rem 0.5rem', color: r.entropy > 2.0 ? (colors.warning ?? '#eab308') : colors.textDim }}>
                              {r.entropy.toFixed(2)}
                            </td>
                            <td style={{ padding: '0.3rem 0.5rem' }}>{r.sasa}%</td>
                            <td style={{ padding: '0.3rem 0.5rem' }}>{r.ddgAlaScan.toFixed(1)}</td>
                            <td style={{ padding: '0.3rem 0.5rem', color: r.charge > 0 ? '#38bdf8' : r.charge < 0 ? '#f43f5e' : colors.textDim }}>
                              {r.charge > 0 ? `+${r.charge}` : r.charge}
                            </td>
                            <td style={{ padding: '0.3rem 0.5rem' }}>
                              <span
                                style={{
                                  fontSize: '0.68rem',
                                  padding: '0.1rem 0.3rem',
                                  borderRadius: '3px',
                                  backgroundColor:
                                    r.clashRisk === 'critical'
                                      ? 'rgba(239,68,68,0.15)'
                                      : r.clashRisk === 'high'
                                        ? 'rgba(234,179,8,0.15)'
                                        : 'rgba(34,197,94,0.15)',
                                  color:
                                    r.clashRisk === 'critical'
                                      ? (colors.error ?? '#ef4444')
                                      : r.clashRisk === 'high'
                                        ? (colors.warning ?? '#eab308')
                                        : (colors.success ?? '#22c55e'),
                                }}
                              >
                                {r.clashRisk}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Modular Chimera Engineering Suggestions */}
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: colors.text, marginBottom: '0.4rem' }}>
                    Modular Chimera Engineering Suggestions (RBD Swaps)
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                      gap: '0.6rem',
                    }}
                  >
                    {structural.chimeraSuggestions.map((chimera) => (
                      <div
                        key={chimera.donorPhage}
                        style={{
                          padding: '0.65rem 0.75rem',
                          borderRadius: '6px',
                          border: `1px solid ${colors.borderLight}`,
                          backgroundColor: colors.backgroundAlt,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.3rem',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 700, fontSize: '0.82rem', color: colors.text }}>
                            {chimera.donorPhage}
                          </span>
                          <span style={{ fontSize: '0.72rem', color: colors.success, fontWeight: 600 }}>
                            {chimera.feasibilityScore}% match
                          </span>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>
                          Donor tip: <strong>{chimera.donorProtein}</strong>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: colors.textDim }}>
                          Crossover Junction: aa <strong>{chimera.junctionResidue}</strong> (shaft/RBD boundary)
                        </div>
                        <div style={{ fontSize: '0.72rem', color: colors.accent }}>
                          Predicted Host: {chimera.predictedHost}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: colors.textDim, marginTop: '0.2rem' }}>
                          {chimera.rationale}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Overlay>
  );
}

export default TropismOverlay;

