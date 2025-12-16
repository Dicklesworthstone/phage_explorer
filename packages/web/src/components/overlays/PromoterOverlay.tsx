/**
 * PromoterOverlay - Promoter/RBS Site Prediction
 *
 * Displays predicted promoter and ribosome binding sites.
 */

import React, { useEffect, useMemo, useState, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';

interface PromoterOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

interface PredictedSite {
  type: 'promoter' | 'rbs';
  position: number;
  sequence: string;
  score: number;
  motif: string;
}

// Simple motif scanning for promoter-like sequences
function findPromoters(sequence: string): PredictedSite[] {
  const sites: PredictedSite[] = [];
  const seq = sequence.toUpperCase();

  // Look for -10 box (TATAAT-like)
  const tatBox = /T[AT]T[AT][AT]T/g;
  let match;
  while ((match = tatBox.exec(seq)) !== null) {
    // Look for -35 box upstream (TTGACA-like)
    const upstream = seq.slice(Math.max(0, match.index - 25), match.index);
    const has35 = /TT[GC][AC][CG][AT]/.test(upstream);

    sites.push({
      type: 'promoter',
      position: match.index,
      sequence: seq.slice(match.index, match.index + 6),
      score: has35 ? 0.9 : 0.6,
      motif: '-10 box' + (has35 ? ' + -35 box' : ''),
    });
  }

  // Look for Shine-Dalgarno/RBS (AGGAGG-like)
  const rbsPattern = /[AG]GG[AG]GG/g;
  while ((match = rbsPattern.exec(seq)) !== null) {
    sites.push({
      type: 'rbs',
      position: match.index,
      sequence: seq.slice(match.index, match.index + 6),
      score: 0.8,
      motif: 'Shine-Dalgarno',
    });
  }

  return sites.sort((a, b) => a.position - b.position).slice(0, 50);
}

export function PromoterOverlay({
  repository,
  currentPhage,
}: PromoterOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Hotkey to toggle overlay
  useHotkey(
    { key: 'p' },
    'Promoter & RBS Sites',
    () => toggle('promoter'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'intermediate' }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('promoter')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      return;
    }

    const phageId = currentPhage.id;

    // Check cache
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      return;
    }

    setLoading(true);
    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => setSequence(''))
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  const sites = useMemo(() => findPromoters(sequence), [sequence]);
  const promoters = sites.filter(s => s.type === 'promoter');
  const rbsSites = sites.filter(s => s.type === 'rbs');

  if (!isOpen('promoter')) {
    return null;
  }

  return (
    <Overlay
      id="promoter"
      title="PROMOTER & RBS SITES"
      hotkey="p"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Loading State */}
        {loading && (
          <AnalysisPanelSkeleton message="Loading sequence data..." rows={3} />
        )}

        {/* Description */}
        {!loading && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.9rem',
          }}>
            <strong style={{ color: colors.primary }}>Promoter & RBS Prediction</strong> identifies potential
            transcription start sites (-10/-35 boxes) and ribosome binding sites (Shine-Dalgarno sequences).
          </div>
        )}

        {/* Stats */}
        {!loading && sequence.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '1rem',
          }}>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.success, fontSize: '0.75rem' }}>Predicted Promoters</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{promoters.length}</div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.info, fontSize: '0.75rem' }}>RBS Sites</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{rbsSites.length}</div>
            </div>
          </div>
        )}

        {/* Sites table */}
        {!loading && sequence.length > 0 && (
          <div style={{
            maxHeight: '300px',
            overflowY: 'auto',
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '4px',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ backgroundColor: colors.backgroundAlt, position: 'sticky', top: 0 }}>
                  <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Type</th>
                  <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Position</th>
                  <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Sequence</th>
                  <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Motif</th>
                  <th style={{ padding: '0.5rem', textAlign: 'right', color: colors.textDim }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site, idx) => (
                  <tr
                    key={idx}
                    style={{
                      borderTop: `1px solid ${colors.borderLight}`,
                      backgroundColor: idx % 2 === 0 ? 'transparent' : colors.backgroundAlt,
                    }}
                  >
                    <td style={{ padding: '0.5rem' }}>
                      <span style={{
                        color: site.type === 'promoter' ? colors.success : colors.info,
                        fontWeight: 'bold',
                      }}>
                        {site.type === 'promoter' ? '◉ Promoter' : '◎ RBS'}
                      </span>
                    </td>
                    <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: colors.text }}>
                      {site.position.toLocaleString()}
                    </td>
                    <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: colors.accent }}>
                      {site.sequence}
                    </td>
                    <td style={{ padding: '0.5rem', color: colors.textDim }}>
                      {site.motif}
                    </td>
                    <td style={{ padding: '0.5rem', textAlign: 'right' }}>
                      <span style={{
                        padding: '0.2rem 0.5rem',
                        borderRadius: '4px',
                        backgroundColor: `rgba(${site.score > 0.7 ? '92, 184, 92' : '240, 173, 78'}, 0.2)`,
                        color: site.score > 0.7 ? colors.success : colors.warning,
                        fontSize: '0.8rem',
                      }}>
                        {(site.score * 100).toFixed(0)}%
                      </span>
                    </td>
                  </tr>
                ))}
                {sites.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
                      No sites found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && sequence.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem', color: colors.textMuted }}>
            No sequence data available. Select a phage to analyze.
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default PromoterOverlay;
