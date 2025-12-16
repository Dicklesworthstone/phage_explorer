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
  type TropismAnalysis,
  type TailFiberHit,
  type ReceptorCandidate,
  type TropismPredictionInput,
} from '@phage-explorer/comparison';
import { useTheme } from '../../hooks/useTheme';
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

  const breadthLabel = useMemo(() => {
    if (!data) return null;
    if (data.breadth === 'narrow') return { text: 'NARROW: single receptor', color: colors.error };
    if (data.breadth === 'multi-receptor') return { text: 'BROAD: multiple receptor cues', color: colors.success };
    return { text: 'UNKNOWN', color: colors.textMuted };
  }, [data, colors]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === '0' || e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        toggle('tropism');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle]);

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
      hotkey="0 / T"
      size="xl"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
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
            <div style={{ color: colors.textMuted, fontSize: '0.85rem' }}>Tail fiber hits</div>
            <div style={{ color: colors.text, fontWeight: 700 }}>{hits.length}</div>
            <div style={{ color: colors.textDim, fontSize: '0.85rem' }}>Receptor candidates per hit</div>
          </div>
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
            Running tropism analysis...
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

        {status === 'ready' && hits.length === 0 && (
          <div
            style={{
              padding: '1rem',
              borderRadius: '6px',
              border: `1px solid ${colors.borderLight}`,
              color: colors.textMuted,
            }}
          >
            No receptor-binding protein annotations found for this phage.
          </div>
        )}

        {status === 'ready' && hits.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {hits.map(hit => (
              <PredictionRow key={hit.gene.locusTag ?? String(hit.gene.id)} hit={hit} colors={colors} />
            ))}
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default TropismOverlay;
